import {createDataService} from '../services/data.mjs';
import {Fault,canonical,digest,verifySnapshot,putBlob,getBlob,deleteBlob} from '../security.mjs';
const dataService=createDataService();

// Limits cover all seasons/servers for this user. Full signed batches remain intact
// because a match extracted and re-signed here would change the AI trust boundary.
export const HISTORY_LIMITS=Object.freeze({accounts:30,matches:500,bytes:32*1024*1024,envelopeBytes:2700000,pageBytes:2800000,pushBatches:8});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const compare=(a,b)=>a<b?-1:a>b?1:0;
const batchKey=(key,id)=>key+':batch:'+id;
const batchMetadata=envelope=>({bytes:bytes(envelope),queriedAt:envelope.content.data.queriedAt,rows:envelope.content.data.matches.map(({mid,t,mapGuid,mapName,gameMode,ret})=>({mid,t,mapGuid,mapName,gameMode,ret}))});
const indexMetadata=account=>dataService.indexHistory(Object.fromEntries(Object.entries(account.batchMeta).map(([id,meta])=>[id,{content:{data:{queriedAt:meta.queriedAt,matches:meta.rows}}}])));
const accountBytes=account=>bytes(account)+Object.values(account.batchMeta).reduce((n,m)=>n+m.bytes,0);
// Upgrade one account atomically. A failed migration retains the complete legacy blob.
async function accountMetadata(storage,key){
 const old=await getBlob(storage,key);if(!old?.batches)return old;
 const account={version:2,tag:old.tag,matches:dataService.indexHistory(old.batches),batchMeta:{}};
 for(const [id,envelope] of Object.entries(old.batches)){
  await putBlob(storage,batchKey(key,id),envelope);
  account.batchMeta[id]=batchMetadata(envelope);
 }
 await putBlob(storage,key,account);
 const catalogKey=key.slice(0,key.indexOf(':account:'))+':catalog',catalog=await getBlob(storage,catalogKey),summary=catalog?.accounts.find(a=>a.key===key);
 if(summary){summary.bytes=accountBytes(account);await putBlob(storage,catalogKey,catalog);}
 return account;
}
export class CloudHistory{
 constructor(storage,env,limits={}){this.storage=storage;this.env=env;this.limits={...HISTORY_LIMITS,...limits};this.chain=Promise.resolve();}
 async handle(user,body={}){const work=this.chain.then(()=>this.run(user,body));this.chain=work.catch(()=>{});return work;}
 async latest(user,tag){
  const root='history:v1:'+await digest(String(user)),scope=await digest(canonical({server:this.env.DASHEN_SERVER,dts:this.env.DASHEN_DTS}));
  const key=root+':account:'+await digest(canonical({scope,tag:tag.normalize('NFC').trim()}));
  return this.storage.transaction(async storage=>{
   const account=await accountMetadata(storage,key),id=Object.keys(account?.batchMeta||{}).sort((a,b)=>Date.parse(account.batchMeta[b].queriedAt)-Date.parse(account.batchMeta[a].queriedAt)||compare(b,a))[0];
   return id?(await getBlob(storage,batchKey(key,id)))?.content?.data:null;
  });
 }
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
   const key=root+':account:'+await digest(canonical({scope,tag:b.tag.normalize('NFC').trim()}));
   return this.storage.transaction(async storage=>{
   const account=await accountMetadata(storage,key),ids=Object.keys(account?.batchMeta||{}).sort(),cursor=b.cursor||0;
   const envelopes=[];let next=cursor,size=bytes({envelopes:[],nextCursor:Number.MAX_SAFE_INTEGER,revision:'0'.repeat(64)});
   while(next<ids.length){const id=ids[next],n=account.batchMeta[id].bytes+1;if(size+n>this.limits.pageBytes)break;const envelope=await getBlob(storage,batchKey(key,id));if(!envelope)throw new Fault('历史批次暂不可用',503);envelopes.push(envelope);size+=n;next++;}
   if(next===cursor&&next<ids.length)throw new Fault('云端历史包过大，请稍后重试',413);
   return {envelopes,nextCursor:next<ids.length?next:null,revision:await digest(ids.join(','))};
   });
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
    let account=updates.get(item.key);if(!account){account=await accountMetadata(storage,item.key)||{version:2,tag:item.tag,matches:[],batchMeta:{}};updates.set(item.key,account);}
    if(!account.batchMeta[item.id])await putBlob(storage,batchKey(item.key,item.id),item.envelope);
    account.batchMeta[item.id]=batchMetadata(item.envelope);
   }
   for(const [key,account] of updates){
    account.matches=indexMetadata(account).slice(-this.limits.matches);
    let updatedAt=null;
    for(const meta of Object.values(account.batchMeta)){const queriedAt=meta.queriedAt;if(updatedAt===null||Date.parse(queriedAt)>Date.parse(updatedAt))updatedAt=queriedAt;}
    const used=new Set(account.matches.map(m=>m.batchId));for(const id of Object.keys(account.batchMeta))if(!used.has(id)){delete account.batchMeta[id];await deleteBlob(storage,batchKey(key,id));}
    const batchIds=Object.keys(account.batchMeta).sort();
    // Empty query results do not consume account slots.
    if(!batchIds.length){updates.delete(key);continue;}
    const summary={key,scope,tag:account.tag,updatedAt,count:account.matches.length,batchIds,revision:await digest(batchIds.join(',')),bytes:accountBytes(account)};
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
