(function(root){
 'use strict';let db,session,scope;
 const key=tag=>scope+'|'+QS_HISTORY_MODEL.tag(tag);
 function read(id){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(Error('历史读取失败'));});}
 function write(id,value){return new Promise((resolve,reject)=>{const tx=db.transaction('historyAccounts','readwrite');tx.objectStore('historyAccounts').put(value,id);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(Error('历史归档未保存：浏览器空间不足或存储不可用，旧历史已保留'));});}
 async function save(envelope){
  if(envelope?.content?.user!==session.user.id||envelope.content.scope?.server!==session.scope.server||envelope.content.scope?.dts!==session.scope.dts)throw Error('历史归档签名范围不匹配');
  const batchId=await Cloud.key(envelope),id=key(envelope.content.data.battletag),previous=await read(id);
  const merged=QS_HISTORY_MODEL.merge(previous,envelope,batchId,scope);
  if(!previous||JSON.stringify(previous)!==JSON.stringify(merged))await write(id,merged);
 }
 async function initialize(database,value){db=database;session=value;scope=session.user.id+'|'+session.scope.server+'|'+session.scope.dts;
  const old=await new Promise((resolve,reject)=>{const r=db.transaction('cache').objectStore('cache').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
  for(const envelope of old){const c=envelope?.content;if(c?.data?.matches&&c.user===session.user.id&&c.scope?.server===session.scope.server&&c.scope?.dts===session.scope.dts)await save(envelope);}
 }
 async function list(){return new Promise((resolve,reject)=>{const r=db.transaction('historyAccounts').objectStore('historyAccounts').getAll();r.onsuccess=()=>resolve(r.result.filter(a=>a.scope===scope).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(({tag,updatedAt,matches})=>({tag,updatedAt,matches})));r.onerror=()=>reject(Error('历史列表读取失败'));});}
 async function load(tag){return read(key(tag));}
 async function envelope(tag,mid){const a=await load(tag),row=a?.matches.find(m=>m.mid===mid);return row?a.batches[row.batchId]:null;}
 root.CloudHistory={initialize,save,list,load,envelope};
})(window);
