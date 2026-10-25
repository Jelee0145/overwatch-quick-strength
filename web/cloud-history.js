(function(root){
 'use strict';let db,session,scope,syncPromise=null,writeChain=Promise.resolve(),syncMessage='历史尚未同步';
 const key=tag=>scope+'|'+QS_HISTORY_MODEL.tag(tag);
 function read(id){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(Error('历史读取失败'));});}
 function write(id,value){return new Promise((resolve,reject)=>{const tx=db.transaction('historyAccounts','readwrite');tx.objectStore('historyAccounts').put(value,id);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(Error('历史归档未保存：浏览器空间不足或存储不可用，旧历史已保留'));});}
 function saveMany(envelopes){
  const work=writeChain.then(async()=>{
   const updates=new Map(),originals=new Map();
   for(const envelope of envelopes){
   if(envelope?.content?.user!==session.user.id||envelope.content.scope?.server!==session.scope.server||envelope.content.scope?.dts!==session.scope.dts)throw Error('历史归档签名范围不匹配');
   const batchId=await Cloud.key(envelope),id=key(envelope.content.data.battletag);
   if(!originals.has(id))originals.set(id,await read(id));
   const previous=originals.get(id);
   if(previous?.batches[batchId])continue;
   if(!updates.has(id))updates.set(id,{});updates.get(id)[batchId]=envelope;
   }
   for(const [id,batches] of updates){
    const previous=originals.get(id),merged=QS_HISTORY_MODEL.mergeMany(previous,batches,scope),before=Object.keys(previous?.batches||{}).sort().join(','),after=Object.keys(merged.batches).sort().join(',');
    if(!previous||before!==after||previous.updatedAt!==merged.updatedAt){await write(id,merged);root.OWQS_SERVER_ANALYSIS?.invalidate(merged.tag);}
   }
  });writeChain=work.catch(()=>{});return work;
 }
 const save=envelope=>saveMany([envelope]);
 async function initialize(database,value){db=database;session=value;scope=session.user.id+'|'+session.scope.server+'|'+session.scope.dts;
  if(await acknowledgement('migration-v2'))return;
  const prefix=session.user.id+'|snapshot|'+session.scope.server+'|'+session.scope.dts+'|',old=[];
  if(db.objectStoreNames?.contains('cacheIndex')){
   const keys=new Set();
   await new Promise((resolve,reject)=>{
    const r=db.transaction('cacheIndex').objectStore('cacheIndex').openCursor(IDBKeyRange.bound(scope+'|',scope+'|\uffff'));
    r.onsuccess=()=>{const cursor=r.result;if(!cursor){resolve();return;}if(cursor.value.scope===scope&&cursor.value.legacyKey)keys.add(cursor.value.legacyKey);cursor.continue();};r.onerror=()=>reject(Error('旧缓存索引读取失败'));
   });
   for(const key of keys){const envelope=await new Promise((resolve,reject)=>{const r=db.transaction('cache').objectStore('cache').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=reject;});if(envelope)old.push(envelope);}
  }
  // Scan only this scope's legacy snapshot keys, once. Never deserialize all cache values.
  await new Promise((resolve,reject)=>{
   const range=IDBKeyRange.bound(prefix,prefix+'\uffff'),r=db.transaction('cache').objectStore('cache').openCursor(range);
   r.onsuccess=()=>{const cursor=r.result;if(!cursor){resolve();return;}const envelope=cursor.value,c=envelope?.content;if(c?.data?.matches&&c.user===session.user.id&&c.scope?.server===session.scope.server&&c.scope?.dts===session.scope.dts)old.push(envelope);cursor.continue();};r.onerror=()=>reject(Error('旧历史迁移失败'));
  });
  await saveMany(old);await acknowledge('migration-v2');
 }
 async function list(){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').getAll();r.onsuccess=()=>resolve(r.result.filter(a=>a.scope===scope).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(({tag,updatedAt,matches})=>({tag,updatedAt,matches})));r.onerror=()=>reject(Error('历史列表读取失败'));});}
 async function load(tag){return read(key(tag));}
 async function envelope(tag,mid){const a=await load(tag),row=a?.matches.find(m=>m.mid===mid);return row?a.batches[row.batchId]:null;}
 function notice(message){syncMessage=message;const el=root.document?.getElementById('historySyncStatus');if(el)el.textContent=message;}
 async function synchronize(){
  notice('正在同步云端历史…');
  const remote=await Cloud.api('/api/v1/history',{action:'list'}),known=new Map(remote.accounts.map(a=>[a.tag,new Set(a.batchIds||[])])),errors=[];
  // Only upload signed batches absent from the server; acknowledgements survive reloads.
  for(const row of await list()){
   const account=await load(row.tag),ids=known.get(row.tag)||new Set();
   const groups=[];let group=[],size=40;
   for(const [id,batch] of Object.entries(account.batches)){
    if(ids.has(id)||await acknowledged(id))continue;
    const length=new TextEncoder().encode(JSON.stringify(batch)).length+1;
    if(group.length&&(group.length===8||size+length>2800000)){groups.push(group);group=[];size=40;}
    group.push([id,batch]);size+=length;
   }
   if(group.length)groups.push(group);
   for(const group of groups)try{await Cloud.api('/api/v1/history',{action:'push',envelopes:group.map(([,batch])=>batch)});for(const [id] of group)await acknowledge(id);}catch(e){if(!errors.includes(e.message))errors.push(e.message);}
  }
  const current=await Cloud.api('/api/v1/history',{action:'list'});
  for(const row of current.accounts){
   const local=await load(row.tag);
   if(row.batchIds?.every(id=>local?.batches[id]))continue;
   let cursor=0;const seen=new Set(),received=[];let revision=null;
   do{
    if(seen.has(cursor))throw Error('云端历史分页异常');seen.add(cursor);
    const page=await Cloud.api('/api/v1/history',{action:'pull',tag:row.tag,cursor});
    if(revision!==null&&page.revision!==revision)throw Error('另一设备更新了历史，请再次同步');
    received.push(...page.envelopes);
    revision=page.revision??null;cursor=page.nextCursor;
   }while(cursor!==null&&cursor!==undefined);
   await saveMany(received);
  }
  if(errors.length)throw Error(errors.join('；'));
  notice('历史已同步 · '+new Date().toLocaleTimeString('zh-CN'));return {ok:true};
 }
 function acknowledgement(id,value){return new Promise((resolve,reject)=>{const tx=db.transaction('cache',value===undefined?'readonly':'readwrite'),store=tx.objectStore('cache'),r=value===undefined?store.get(scope+'|history-upload|'+id):store.put(value,scope+'|history-upload|'+id);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(Error('同步标记保存失败'));});}
 const acknowledged=id=>acknowledgement(id),acknowledge=id=>acknowledgement(id,true);
 function sync(){if(!syncPromise)syncPromise=synchronize().catch(e=>{notice('云端同步未完成：'+e.message+'；本地历史仍可查看，可稍后重试');return {ok:false,error:e.message};}).finally(()=>{syncPromise=null;});return syncPromise;}
 root.CloudHistory={initialize,save,list,load,envelope,sync,status:()=>syncMessage};
})(window);
