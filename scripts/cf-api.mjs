import {readFile} from 'node:fs/promises';import path from 'node:path';
export const account='a465bf991d4135a352704cb405b0a538';
export async function cf(endpoint,body,method){
 if(!endpoint.startsWith('/accounts/'+account+'/'))throw Error('Unexpected Cloudflare account');
 const file=path.resolve(import.meta.dirname,'../.private/config/.wrangler/config/default.toml');const source=await readFile(file,'utf8'),auth=source.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];if(!auth)throw Error('Cloudflare login missing');
 const r=await fetch('https://api.cloudflare.com/client/v4'+endpoint,{method:method||(body?'POST':'GET'),redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+auth,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});let data;try{data=await r.json();}catch{return {ok:false,status:r.status};}return {ok:r.ok&&data.success!==false,status:r.status,result:data.result,errorCodes:(data.errors||[]).map(e=>e.code)};
}
