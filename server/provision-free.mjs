// Explicit local administrator command. Never exposed as an HTTP route.
import {readFile,writeFile,rename,chmod} from 'node:fs/promises';
import path from 'node:path';
import {SqliteDatabase} from './storage.mjs';
import {digest,token,passwordHash,encryptSecret,decryptSecret} from '../src/security.mjs';

export async function provisionFree(storage,env){
 const address='bot-free@owqs.invalid',id=await digest(address),now=new Date().toISOString();
 let user=await storage.get('user:'+id);
 if(user&&user.tier!=='free')throw Error('Service account identity already belongs to another tier');
 if(!user)user={id,email:address,password:await passwordHash(token(),env.PASSWORD_PEPPER),status:'approved',tier:'free',version:1,createdAt:now,updatedAt:now,queryDaily:1000,aiDaily:1000};
 let key;
 if(user.apiKey)key=await decryptSecret(user.apiKey,env.API_KEY_ENCRYPTION_KEY);
 else{key='owqs_'+token();user.apiKey={...await encryptSecret(key,env.API_KEY_ENCRYPTION_KEY),digest:await digest(key),createdAt:now,updatedAt:now};}
 await storage.transaction(async tx=>{
  await tx.put('user:'+id,user);await tx.put('apikey:'+user.apiKey.digest,id);
 });
 return {key,id};
}

if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
 const pluginPath=process.argv[2];if(!pluginPath||!path.isAbsolute(pluginPath))throw Error('Pass an absolute private plugin configuration path');
 const config=JSON.parse(await readFile(process.env.OWQS_CONFIG||'/etc/owqs/config.json','utf8'));
 const database=new SqliteDatabase(path.join(process.env.OWQS_DATA||'/var/lib/owqs','state.sqlite3'));
 try{
  const {key}=await provisionFree(database.store('auth'),config);
  const plugin=JSON.parse(await readFile(pluginPath,'utf8'));
  plugin.free_api_key=key;delete plugin.api_key;
  const temporary=pluginPath+'.next';
  await writeFile(temporary,JSON.stringify(plugin,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,pluginPath);
  console.log('Independent free-tier service Key configured; personal account unchanged.');
 }finally{await database.close();}
}
