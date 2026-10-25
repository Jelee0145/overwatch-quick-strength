import {ServiceError as Fault} from '../services/errors.mjs';
const enc=new TextEncoder();
export const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
export const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
export const digest=async text=>hex(await crypto.subtle.digest('SHA-256',enc.encode(text)));
// Match JSON transport: absent object values are omitted; array holes become null.
// Signing an undefined field that JSON later drops makes genuine cached data invalid.
export const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+Array.from(v,x=>canonical(x)??'null').join(',')+']':'{'+Object.keys(v).filter(k=>!['undefined','function','symbol'].includes(typeof v[k])).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export async function mac(value,key){if(!key)throw new Fault('服务端签名凭证尚未配置',503);const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(canonical(value))));}
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
export async function passwordHash(password,pepper,salt=token()){if(!pepper)throw new Fault('登录服务尚未配置',503);if(typeof password!=='string'||password.length<10||password.length>128)throw new Fault('密码需要 10—128 个字符');const k=await crypto.subtle.importKey('raw',enc.encode(password+'\0'+pepper),'PBKDF2',false,['deriveBits']);return {salt,iterations:100000,hash:hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},k,256))};}
export async function passwordOK(password,record,pepper){if(!record||typeof password!=='string')return false;try{return equal((await passwordHash(password,pepper,record.salt)).hash,record.hash);}catch(e){if(e.status===503)throw e;return false;}}
export function email(v){if(typeof v!=='string'||v.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(v.trim()))throw new Fault('请输入有效邮箱');return v.trim().toLowerCase();}
export const day=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
