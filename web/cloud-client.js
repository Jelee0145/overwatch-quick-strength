'use strict';
window.Cloud=(()=>{
 let session=null,db=null,csrf='',lastTag='',bootPromise=null;
 async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});let value;try{value=await response.json();}catch{throw Error('服务返回格式异常');}if(!response.ok){if(response.status===401&&session)location.assign('/login');throw Error(value.error||'请求失败');}return value;}
 const initialize=async()=>{session=await api('/api/auth/session');csrf=session.csrf;if(session.user.status!=='approved'){location.assign('/login');throw Error('等待授权');}
  document.body.classList.remove('cloud-pending');document.getElementById('cloudIdentity').textContent=session.user.email;
  document.getElementById('cloudLogout').onclick=async()=>{try{await api('/api/auth/logout',{});location.assign('/login');}catch(e){alert(e.message);}};
  db=await CloudCache.initialize(session);await CloudHistory.initialize(db,session);return session;
 };
 const boot=()=>bootPromise||(bootPromise=initialize().catch(e=>{bootPromise=null;throw e;}));
 async function storage(key,value){await boot();key=session.user.id+'|'+key;return new Promise((resolve,reject)=>{const tx=db.transaction('cache',value===undefined?'readonly':'readwrite'),r=value===undefined?tx.objectStore('cache').get(key):tx.objectStore('cache').put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(Error('本地缓存读取或保存失败'));});}
 const scope=()=>session.scope.server+'|'+session.scope.dts;
 const snapshot=async tag=>{await boot();return storage('snapshot|'+scope()+'|'+tag);};
 async function save(envelope,records=[],queryIndex=null){if(!envelope?.content?.data)throw Error('查询结果缺少可信签名');await CloudHistory.save(envelope);lastTag=envelope.content.data.battletag;await storage('snapshot|'+scope()+'|'+lastTag,envelope);await storage('latest',lastTag);await CloudCache.save(envelope,records,queryIndex);}
 async function latest(){await boot();const remote=await api('/api/latest'),tag=await storage('latest');const value=tag?await snapshot(tag):null;await CloudCache.render(value?.content?.data?.syncStatus);return {...remote,historyTag:tag,result:value?.content?.data||null};}
 async function startQuery(tag,limit,supplementOtherMatches=false){await boot();return api('/api/query',{battletag:tag,limit,supplementOtherMatches,cacheManifest:await CloudCache.manifest(),queryIndex:await CloudCache.queryIndex(tag),requestId:crypto.randomUUID()});}
 const key=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');
 return {api,boot,snapshot,save,latest,startQuery,storage,key};
})();
