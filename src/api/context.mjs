import {Fault,getCookie} from '../security.mjs';
import {authCall} from '../tasks.mjs';

export async function readBody(request){
 if(Number(request.headers.get('Content-Length'))>3000000)throw new Fault('请求数据过大',413);
 const text=await request.text();if(new TextEncoder().encode(text).length>3000000)throw new Fault('请求数据过大',413);
 try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new Fault('请求格式错误');}
}
export function sessionInput(request){return {userToken:getCookie(request,'qs_session'),adminToken:getCookie(request,'qs_admin'),csrf:request.headers.get('X-CSRF-Token')||'',ip:request.headers.get('CF-Connecting-IP')||'local',mutation:request.method==='POST'};}
export function checkCookieWrite(request){if(request.method==='POST'&&(request.headers.get('Origin')!==new URL(request.url).origin||!request.headers.get('Content-Type')?.startsWith('application/json')))throw new Fault('请求来源或格式不正确',403);}
export async function authenticate(request,env){
 const header=request.headers.get('Authorization'),input=sessionInput(request);
 if(header){
  if(!/^Bearer owqs_[a-f0-9]{64}$/.test(header))throw new Fault('API 密钥无效',401);
  const auth=await authCall(env,'/api-key-auth',{key:header.slice(7)});
  if(input.userToken){checkCookieWrite(request);const session=await authCall(env,'/authorize',{},input);if(session.user.id!==auth.user.id)throw new Fault('请求包含冲突的账号身份',403);}
  return {...auth,credential:'bearer'};
 }
 if(!input.userToken)throw new Fault('请先登录或提供 Bearer API 密钥',401);
 checkCookieWrite(request);return {...await authCall(env,'/authorize',{},input),credential:'cookie',tier:'standard'};
}
export function taskClient(env,auth){return async(path,body={})=>{
 const task=env.TASKS.get(env.TASKS.idFromName(auth.user.id));
 const response=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path,body,user:auth.user.id,version:auth.version})});const value=await response.json();if(!response.ok)throw new Fault(value.error,response.status);return value;
};}
export function requireMethod(request,method){if(request.method!==method)throw new Fault('请求方法错误',405);}
export async function jsonInput(request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new Fault('Content-Type 必须为 application/json',415);return readBody(request);}
export function operationKey(request,input){const header=request.headers.get('Idempotency-Key'),keys=[header,input.requestId,input.idempotencyKey].filter(value=>value!==undefined&&value!==null);if(keys.some(value=>typeof value!=='string'||!value||value.length>100))throw new Fault('请求标识无效');if(new Set(keys).size>1)throw new Fault('请求标识冲突',409);return keys[0];}
