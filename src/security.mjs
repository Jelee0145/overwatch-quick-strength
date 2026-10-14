const enc=new TextEncoder();
export class Fault extends Error{constructor(message,status=400){super(message);this.status=status;}}
export const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
export const digest=async text=>hex(await crypto.subtle.digest('SHA-256',enc.encode(text)));
// Match JSON transport: absent object values are omitted; array holes become null.
// Signing an undefined field that JSON later drops makes genuine cached data invalid.
export const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+Array.from(v,x=>canonical(x)??'null').join(',')+']':'{'+Object.keys(v).filter(k=>!['undefined','function','symbol'].includes(typeof v[k])).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export async function mac(value,key){if(!key)throw new Fault('服务端签名凭证尚未配置',503);const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(canonical(value))));}
export function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
export async function passwordHash(password,pepper,salt=token()){if(!pepper)throw new Fault('登录服务尚未配置',503);if(typeof password!=='string'||password.length<10||password.length>128)throw new Fault('密码需要 10—128 个字符');const k=await crypto.subtle.importKey('raw',enc.encode(password+'\0'+pepper),'PBKDF2',false,['deriveBits']);return {salt,iterations:100000,hash:hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},k,256))};}
export async function passwordOK(password,record,pepper){if(!record||typeof password!=='string')return false;try{return equal((await passwordHash(password,pepper,record.salt)).hash,record.hash);}catch(e){if(e.status===503)throw e;return false;}}
export function email(v){if(typeof v!=='string'||v.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(v.trim()))throw new Fault('请输入有效邮箱');return v.trim().toLowerCase();}
export function json(data,status=200,extra={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}});}
export function cookie(value,admin=false,seconds=0){return `${admin?'qs_admin':'qs_session'}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;}
export function getCookie(request,name){return request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';}
export async function signSnapshot(user,data,env){const content={version:1,user,scope:{battletag:data.battletag,server:env.DASHEN_SERVER,dts:env.DASHEN_DTS},data};return {content,signature:await mac(content,env.CACHE_SIGNING_KEY)};}
export async function verifySnapshot(value,user,env,tag){if(!value?.content||value.content.user!==user||value.content.version!==1||!equal(value.signature,await mac(value.content,env.CACHE_SIGNING_KEY)))throw new Fault('记录校验失败，请重新查询此账号。');const c=value.content;if(c.scope.server!==env.DASHEN_SERVER||c.scope.dts!==env.DASHEN_DTS||(tag&&c.scope.battletag!==tag)||c.data.battletag!==c.scope.battletag)throw new Fault('缓存账号或赛季不匹配');return c.data;}
export const day=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export async function putBlob(storage,key,value){await deleteBlob(storage,key);const s=JSON.stringify(value),chunks=[];for(let i=0;i<s.length;i+=12000){chunks.push(s.slice(i,i+12000));}await storage.put(key+':count',chunks.length);for(let i=0;i<chunks.length;i++)await storage.put(key+':'+i,chunks[i]);}
export async function getBlob(storage,key){const n=await storage.get(key+':count');if(n===undefined)return null;let s='';for(let i=0;i<n;i++)s+=await storage.get(key+':'+i);return JSON.parse(s);}
export async function deleteBlob(storage,key){const n=await storage.get(key+':count')||0;await storage.delete([key+':count',...Array.from({length:n},(_,i)=>key+':'+i)]);}
