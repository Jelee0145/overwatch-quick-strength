(function(root){
 'use strict';let db,session,scope,syncPromise=null,writeChain=Promise.resolve(),syncMessage='历史尚未同步';
 const key=tag=>scope+'|'+QS_HISTORY_MODEL.tag(tag);
 function read(id){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(Error('历史读取失败'));});}
 function write(id,value){return new Promise((resolve,reject)=>{const tx=db.transaction('historyAccounts','readwrite');tx.objectStore('historyAccounts').put(value,id);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(Error('历史归档未保存：浏览器空间不足或存储不可用，旧历史已保留'));});}
 function save(envelope){
  const work=writeChain.then(async()=>{
   if(envelope?.content?.user!==session.user.id||envelope.content.scope?.server!==session.scope.server||envelope.content.scope?.dts!==session.scope.dts)throw Error('历史归档签名范围不匹配');
   const batchId=await Cloud.key(envelope),id=key(envelope.content.data.battletag),previous=await read(id);
   const merged=QS_HISTORY_MODEL.merge(previous,envelope,batchId,scope);
   if(!previous||JSON.stringify(previous)!==JSON.stringify(merged))await write(id,merged);
  });writeChain=work.catch(()=>{});return work;
 }
 async function initialize(database,value){db=database;session=value;scope=session.user.id+'|'+session.scope.server+'|'+session.scope.dts;
  const old=await new Promise((resolve,reject)=>{const r=db.transaction('cache').objectStore('cache').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
  for(const envelope of old){const c=envelope?.content;if(c?.data?.matches&&c.user===session.user.id&&c.scope?.server===session.scope.server&&c.scope?.dts===session.scope.dts)await save(envelope);}
 }
 async function list(){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').getAll();r.onsuccess=()=>resolve(r.result.filter(a=>a.scope===scope).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(({tag,updatedAt,matches})=>({tag,updatedAt,matches})));r.onerror=()=>reject(Error('历史列表读取失败'));});}
 async function load(tag){return read(key(tag));}
 async function envelope(tag,mid){const a=await load(tag),row=a?.matches.find(m=>m.mid===mid);return row?a.batches[row.batchId]:null;}
 function notice(message){syncMessage=message;const el=root.document?.getElementById('historySyncStatus');if(el)el.textContent=message;}
 async function synchronize(){
  notice('正在同步云端历史…');
  const remote=await Cloud.api('/api/history',{action:'list'}),known=new Map(remote.accounts.map(a=>[a.tag,new Set(a.batchIds||[])])),errors=[];
  // Only upload signed batches absent from the server; acknowledgements survive reloads.
  for(const row of await list()){
   const account=await load(row.tag),ids=known.get(row.tag)||new Set();
   for(const [id,batch] of Object.entries(account.batches)){
    if(ids.has(id)||await acknowledged(id))continue;
    try{await Cloud.api('/api/history',{action:'push',envelopes:[batch]});await acknowledge(id);}catch(e){if(!errors.includes(e.message))errors.push(e.message);}
   }
  }
  const current=await Cloud.api('/api/history',{action:'list'});
  for(const row of current.accounts){
   const local=await load(row.tag);
   if(row.batchIds?.every(id=>local?.batches[id]))continue;
   let cursor=0;const seen=new Set();let revision=null;
   do{
    if(seen.has(cursor))throw Error('云端历史分页异常');seen.add(cursor);
    const page=await Cloud.api('/api/history',{action:'pull',tag:row.tag,cursor});
    for(const batch of page.envelopes)await save(batch);
    if(revision!==null&&page.revision!==revision)throw Error('另一设备更新了历史，请再次同步');
    revision=page.revision??null;cursor=page.nextCursor;
   }while(cursor!==null&&cursor!==undefined);
  }
  if(errors.length)throw Error(errors.join('；'));
  notice('历史已同步 · '+new Date().toLocaleTimeString('zh-CN'));return {ok:true};
 }
 function acknowledgement(id,value){return new Promise((resolve,reject)=>{const tx=db.transaction('cache',value===undefined?'readonly':'readwrite'),store=tx.objectStore('cache'),r=value===undefined?store.get(scope+'|history-upload|'+id):store.put(value,scope+'|history-upload|'+id);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(Error('同步标记保存失败'));});}
 const acknowledged=id=>acknowledgement(id),acknowledge=id=>acknowledgement(id,true);
 function sync(){if(!syncPromise)syncPromise=synchronize().catch(e=>{notice('云端同步未完成：'+e.message+'；本地历史仍可查看，可稍后重试');return {ok:false,error:e.message};}).finally(()=>{syncPromise=null;});return syncPromise;}
 root.CloudHistory={initialize,save,list,load,envelope,sync,status:()=>syncMessage};
})(window);
