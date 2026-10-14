'use strict';
// Reuse the established IndexedDB schema and per-user cache keys, including changelog reads.
window.Cloud=(()=>{
 let session,db,bootPromise;
 const login=()=>location.replace('/login?next='+encodeURIComponent(location.pathname));
 async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?undefined:{'Content-Type':'application/json','X-CSRF-Token':session?.csrf||''},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();if(!response.ok){if(response.status===401)login();throw Error(value.error||'连接失败，请刷新重试');}return value;
 }
 async function verify(){const value=await api('/api/auth/session');if(value.user.status!=='approved'){login();throw Error('账号等待授权');}return value;}
 async function initialize(){
  session=await verify();db=await CloudCache.initialize(session);
  document.getElementById('cloudIdentity').textContent=session.user.email;
  document.getElementById('cloudLogout').onclick=async()=>{try{await api('/api/auth/logout',{});location.replace('/login');}catch(e){showError(e);}};
  document.body.classList.remove('cloud-pending');return session;
 }
 function showError(error){const notice=document.getElementById('sessionError');notice.hidden=false;notice.textContent=error.message;}
 const boot=()=>bootPromise||(bootPromise=initialize().catch(error=>{bootPromise=null;showError(error);throw error;}));
 async function storage(key,value){await boot();return new Promise((resolve,reject)=>{const tx=db.transaction('cache',value===undefined?'readonly':'readwrite'),request=value===undefined?tx.objectStore('cache').get(session.user.id+'|'+key):tx.objectStore('cache').put(value,session.user.id+'|'+key);tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(Error('本地记录保存失败'));});}
 window.addEventListener('focus',()=>{if(session)verify().catch(showError);});
 return {boot,storage,verify,api};
})();
Cloud.boot().catch(()=>{});
