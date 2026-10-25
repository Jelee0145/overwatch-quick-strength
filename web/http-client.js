(function(root){
 'use strict';
 function create({csrf=()=>'',unauthorized=()=>{},fetch:transport=root.fetch.bind(root)}={}){
  return async function request(path,body,settings={}){
   const method=settings.method||(body===undefined?'GET':'POST'),headers={Accept:'application/json',...settings.headers};
   if(body!==undefined){headers['Content-Type']='application/json';const token=csrf();if(token)headers['X-CSRF-Token']=token;}
   const response=await transport(path,{...settings,method,credentials:'same-origin',cache:'no-store',headers,body:body===undefined?undefined:JSON.stringify(body)});
   let value;try{value=await response.json();}catch{const error=Error('服务返回格式异常');error.status=response.status;throw error;}
   if(!response.ok){const error=Error(value.error?.message||value.error||value.message||'请求失败');error.status=response.status;error.code=value.code||value.error?.code;error.response=value;if(response.status===401)unauthorized(error);throw error;}
   return value;
  };
 }
 function memoryDatabase(){
  const stores=new Map();
  return {transaction(name){
   const tx={error:null};
   tx.objectStore=store=>{
    if(!stores.has(store))stores.set(store,new Map());const rows=stores.get(store);
    const request=work=>{const result={};queueMicrotask(()=>{try{result.result=structuredClone(work());result.onsuccess?.();}catch(error){tx.error=error;result.onerror?.();tx.onerror?.();}});return result;};
    return {get:key=>request(()=>rows.get(key)),getAll:()=>request(()=>[...rows.values()]),openCursor:range=>{
     const keys=[...rows.keys()].filter(key=>!range||range.includes(key)).sort(),r={};let index=0;
     const next=()=>queueMicrotask(()=>{const key=keys[index++];r.result=key===undefined?null:{key,value:structuredClone(rows.get(key)),continue:next};r.onsuccess?.();});next();return r;
    },put:(value,key)=>request(()=>{rows.set(key,structuredClone(value));return key;})};
   };
   queueMicrotask(()=>queueMicrotask(()=>tx.oncomplete?.()));return tx;
  }};
 }
 root.OWQS_HTTP=Object.freeze({create,memoryDatabase});
})(window);
