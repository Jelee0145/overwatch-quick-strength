import {Fault,canonical,digest,verifySnapshot,putBlob,getBlob} from './security.mjs';

// Limits cover all seasons/servers for this user. Full signed batches remain intact
// because a match extracted and re-signed here would change the AI trust boundary.
export const HISTORY_LIMITS=Object.freeze({accounts:30,matches:500,bytes:32*1024*1024,envelopeBytes:2700000,pageBytes:2800000,pushBatches:8});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const compare=(a,b)=>a<b?-1:a>b?1:0;
export class CloudHistory{
 constructor(storage,env,limits={}){this.storage=storage;this.env=env;this.limits={...HISTORY_LIMITS,...limits};this.chain=Promise.resolve();}
 async handle(user,body={}){const work=this.chain.then(()=>this.run(user,body));this.chain=work.catch(()=>{});return work;}
 async run(user,b){
  if(!['list','pull','push'].includes(b.action))throw new Fault('历史同步操作无效');
  const root='history:v1:'+await digest(String(user)),scope=await digest(canonical({server:this.env.DASHEN_SERVER,dts:this.env.DASHEN_DTS}));
  const catalogKey=root+':catalog';
  if(b.action==='list'){
   const catalog=await getBlob(this.storage,catalogKey)||{accounts:[]};
   return {accounts:catalog.accounts.filter(a=>a.scope===scope).map(({tag,updatedAt,count,batchIds,revision})=>({tag,updatedAt,count,batchIds,revision})).sort((a,b)=>compare(a.tag,b.tag))};
  }
  if(b.action==='pull'){
   if(typeof b.tag!=='string'||!b.tag||b.tag.length>150||b.cursor!==undefined&&(!Number.isSafeInteger(b.cursor)||b.cursor<0))throw new Fault('历史分页参数无效');
   const key=root+':account:'+await digest(canonical({scope,tag:b.tag.normalize('NFC').trim()})),account=await getBlob(this.storage,key),ids=Object.keys(account?.batches||{}).sort(),cursor=b.cursor||0;
   const envelopes=[];let next=cursor,size=bytes({envelopes:[],nextCursor:Number.MAX_SAFE_INTEGER,revision:'0'.repeat(64)});
   while(next<ids.length){const envelope=account.batches[ids[next]],n=bytes(envelope)+1;if(size+n>this.limits.pageBytes)break;envelopes.push(envelope);size+=n;next++;}
   if(next===cursor&&next<ids.length)throw new Fault('云端历史包过大，请稍后重试',413);
   return {envelopes,nextCursor:next<ids.length?next:null,revision:await digest(ids.join(','))};
  }
  if(!Array.isArray(b.envelopes)||b.envelopes.length<1||b.envelopes.length>this.limits.pushBatches)throw new Fault('历史同步每次需要 1—'+this.limits.pushBatches+' 个签名包');
  const incoming=[];
  // Validate every batch before any writes; ignore all client-supplied indexes.
  for(const envelope of b.envelopes){
   if(bytes(envelope)>this.limits.envelopeBytes)throw new Fault('历史签名包过大，已保留本地记录',413);
   const data=await verifySnapshot(envelope,user,this.env),tag=data.battletag;
   if(typeof tag!=='string'||!tag||tag.length>150||!Array.isArray(data.matches)||data.matches.length>50||!Number.isFinite(Date.parse(data.queriedAt)))throw new Fault('历史签名包内容无效');
   for(const m of data.matches)if(!m||typeof m.mid!=='string'||!m.mid||m.mid.length>150||!Array.isArray(m.players)||!Number.isFinite(Number(m.t)))throw new Fault('历史对局内容无效');
   const normalizedTag=tag.normalize('NFC').trim();if(!normalizedTag)throw new Fault('历史签名包账号无效');
   incoming.push({tag:normalizedTag,envelope,id:await digest(JSON.stringify(envelope)),key:root+':account:'+await digest(canonical({scope,tag:normalizedTag}))});
  }
  await this.storage.transaction(async storage=>{
   const catalog=await getBlob(storage,catalogKey)||{accounts:[]},updates=new Map();
   for(const item of incoming){
    let account=updates.get(item.key);if(!account){account=await getBlob(storage,item.key)||{tag:item.tag,batches:{}};updates.set(item.key,account);}
    account.batches[item.id]=item.envelope;
   }
   for(const [key,account] of updates){
    const index=new Map();let updatedAt=null;
    // Rebuild only from previously verified, server-stored envelopes and newly verified input.
    for(const [id,envelope] of Object.entries(account.batches)){
     const data=envelope.content.data,stamp=Date.parse(data.queriedAt);
     if(updatedAt===null||stamp>Date.parse(updatedAt))updatedAt=data.queriedAt;
     for(const m of data.matches){const old=index.get(m.mid);if(!old||stamp>old.stamp||stamp===old.stamp&&compare(id,old.batchId)>0)index.set(m.mid,{mid:m.mid,t:Number(m.t),stamp,batchId:id});}
    }
    account.matches=[...index.values()].sort((a,b)=>a.t-b.t||compare(a.mid,b.mid)).slice(-this.limits.matches);
    const used=new Set(account.matches.map(m=>m.batchId));for(const id of Object.keys(account.batches))if(!used.has(id))delete account.batches[id];
    const batchIds=Object.keys(account.batches).sort();
    // Empty query results do not consume account slots.
    if(!batchIds.length){updates.delete(key);continue;}
    const summary={key,scope,tag:account.tag,updatedAt,count:account.matches.length,batchIds,revision:await digest(batchIds.join(',')),bytes:bytes(account)};
    const at=catalog.accounts.findIndex(a=>a.key===key);if(at<0)catalog.accounts.push(summary);else catalog.accounts[at]=summary;
   }
   if(catalog.accounts.length>this.limits.accounts)throw new Fault('云端历史账号数量已达上限，已保留本地记录',413);
   if(catalog.accounts.reduce((n,a)=>n+a.bytes,bytes(catalog))>this.limits.bytes)throw new Fault('云端历史空间已满，已保留本地记录',413);
   for(const [key,account] of updates)await putBlob(storage,key,account);
   await putBlob(storage,catalogKey,catalog);
  });
  return {ok:true};
 }
}
