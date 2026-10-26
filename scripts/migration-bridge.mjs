// Factory only: never part of the normal website entry point.
export function migrationBridge({ original = 'worker.js', expiresAt }) {
  return `import original,{AuthDirectory,UserTasks} from './${original}';
const expiresAt=${Number(expiresAt)};
const valid=(request,env)=>Date.now()<expiresAt&&env.OWQS_MIGRATION_KEY&&request.headers.get('Authorization')==='Bearer '+env.OWQS_MIGRATION_KEY;
for(const Class of [AuthDirectory,UserTasks]){
 const fetch=Class.prototype.fetch,alarm=Class.prototype.alarm;
 Class.prototype.fetch=async function(request){
  if(valid(request,this.env)){
   const url=new URL(request.url),prefix=Class===AuthDirectory?'':'history:v1:',after=url.searchParams.get('after');
   const records=[...await this.storage.list({prefix,limit:80,...(after?{startAfter:after}:{})})];
   return Response.json({records,next:records.length===80?records.at(-1)[0]:null},{headers:{'Cache-Control':'no-store'}});
  }
  return fetch.call(this,request);
 };
 Class.prototype.alarm=async function(){if(Date.now()<expiresAt){await this.storage.setAlarm(Date.now()+30000);return;}return alarm.call(this);};
}
export {AuthDirectory,UserTasks};
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/__owqs_migration'){
  if(!valid(request,env))return new Response('Not found',{status:404});
  const op=url.searchParams.get('op');
  if(op==='secrets')return Response.json(Object.fromEntries(['DASHEN_SERVER','DASHEN_DTS','DASHEN_ROLE_ID','DASHEN_TOKEN','DEEPSEEK_KEY','PASSWORD_PEPPER','CACHE_SIGNING_KEY','API_KEY_ENCRYPTION_KEY','ADMIN_PASSWORD_HASH'].map(k=>[k,env[k]])),{headers:{'Cache-Control':'no-store'}});
  if(op==='auth')return env.AUTH.get(env.AUTH.idFromName('directory')).fetch(request);
  if(op==='tasks'&&/^[a-f0-9]{64}$/.test(url.searchParams.get('user')||''))return env.TASKS.get(env.TASKS.idFromName(url.searchParams.get('user'))).fetch(request);
  return new Response('Invalid operation',{status:400});
 }
 if(Date.now()<expiresAt&&url.pathname.startsWith('/api/')&&request.method==='POST')return Response.json({error:'数据迁移中，请稍后重试'},{status:503});
 return original.fetch(request,env,ctx);
}};`;
}
