import {Fault,json,getCookie,cookie} from './security.mjs';import {authCall} from './tasks.mjs';
import {release} from './release.mjs';
import {apiV1,apiVersion} from './api/v1.mjs';
import {readBody as body,sessionInput,checkCookieWrite} from './api/context.mjs';
import {listEvents,handleReminder} from './application/events.mjs';
export {AuthDirectory} from './auth.mjs';export {UserTasks} from './tasks.mjs';
export {EventCenter} from './events.mjs';
const securityHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
export async function route(request,env){
 const url=new URL(request.url);let path=url.pathname;const mutation=request.method==='POST';if(!['GET','POST'].includes(request.method))throw new Fault('不支持该请求方法',405);
 if((path==='/api/health'||path==='/api/v1/health')&&!mutation)return json({ok:true,...release,apiVersion});
 if(path==='/api/internal/page-session'){
  if(mutation)throw new Fault('请求方法错误',405);
  await authCall(env,'/authorize',{}, {userToken:getCookie(request,'qs_session')});return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 }
 if(/^\/api\/v1\/(auth|admin)\//.test(path)){path=path.replace('/api/v1/','/api/');url.pathname=path;}
 else if(path.startsWith('/api/v1/'))return apiV1(request,env,url);
 if(path.startsWith('/api/')){
  checkCookieWrite(request);
  const i={...sessionInput(request),body:mutation?await body(request):{}};
  const publicRoutes={'/api/auth/register':'/register','/api/auth/login':'/login','/api/auth/reset/request':'/reset/request','/api/auth/reset/confirm':'/reset/confirm','/api/admin/login':'/admin/login'};
  const authRoutes={'/api/auth/session':'/session','/api/auth/logout':'/logout','/api/auth/api-key':'/api-key','/api/admin/session':'/admin/session','/api/admin/logout':'/admin/logout','/api/admin/users':'/admin/users','/api/admin/access':'/admin/access','/api/admin/quota':'/admin/quota','/api/admin/reset':'/admin/reset'};
  if(publicRoutes[path]||authRoutes[path]){
   const internal=publicRoutes[path]||authRoutes[path];if(['/session','/admin/session','/admin/users'].includes(internal)?mutation:!mutation)throw new Fault('请求方法错误',405);
   const value=await authCall(env,internal,i.body,i),headers={};if(value.token){headers['Set-Cookie']=cookie(value.token,path.startsWith('/api/admin/'),value.seconds);delete value.token;delete value.seconds;}
   if(path.endsWith('/logout'))headers['Set-Cookie']=cookie('',path.startsWith('/api/admin/'),0);if(path==='/api/auth/session')value.scope={server:env.DASHEN_SERVER,dts:env.DASHEN_DTS};return json(value,200,headers);
  }
  const auth=await authCall(env,'/authorize',{},i);
  if(path==='/api/events/reminders'||path.startsWith('/api/events/reminders/')){
   const action=path==='/api/events/reminders'?'list':path.slice('/api/events/reminders/'.length);
   if(action==='list'?mutation:!mutation)throw new Fault('请求方法错误',405);
   return json(await handleReminder(env,auth.user.id,action,i.body));
  }
  if(path==='/api/events'||path==='/api/events/refresh'){
   if(path.endsWith('/refresh')?!mutation:mutation)throw new Fault('请求方法错误',405);
   const params=new URLSearchParams(url.searchParams);if(!params.has('status'))params.set('status','all');
   const {response,value}=await listEvents(env,auth.user.id,params,{refresh:mutation,paginate:false});
   return response||json(value,200,{'Cache-Control':'private, no-store'});
  }
  const task=env.TASKS.get(env.TASKS.idFromName(auth.user.id));let internal,b=i.body;
  if(path==='/api/query'&&mutation)internal='/query';
  else if(path==='/api/ai-review'&&mutation)internal='/ai-review';
  else if(path==='/api/history'&&mutation)internal='/history';
  else if(path==='/api/latest'&&!mutation){const r=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path:'/active',user:auth.user.id,version:auth.version})});const v=await r.json();if(!r.ok)throw new Fault(v.error,r.status);return json({activeJob:v.tasks.find(t=>t.kind==='query')?.id||null,activeAI:v.tasks.find(t=>t.kind==='ai')?.id||null,result:null});}
  else if(/^\/api\/job\/[a-f0-9]{64}(\/(cancel|resume|cache))?$/.test(path)){const parts=path.split('/');internal=parts[4]?'/'+parts[4]:'/status';if(internal==='/status'?mutation:!mutation)throw new Fault('请求方法错误',405);b={...i.body,id:parts[3],compact:url.searchParams.get('compact')==='1'};}
  else throw new Fault('接口不存在',404);
  const r=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path:internal,body:b,user:auth.user.id,version:auth.version})});return r;
 }
 if(env.BACKEND_ONLY)return json({error:'接口不存在'},404);
 // Only the explicitly built public directory is published; configuration and secrets are never assets.
 if(path==='/admin'||path==='/login'||path==='/reset'){url.pathname=path==='/admin'?'/admin.html':'/login.html';return env.ASSETS.fetch(new Request(url,request));}
 if(path==='/'||path==='/index.html'||path.startsWith('/tools/')){
  try{await authCall(env,'/authorize',{}, {userToken:getCookie(request,'qs_session')});}catch{return Response.redirect(url.origin+'/login'+(path.startsWith('/tools/')?'?next='+encodeURIComponent(path):''),302);}
  const pages={'/':'/index.html','/index.html':'/index.html','/tools/strength':'/tools/strength.html','/tools/strength/':'/tools/strength.html','/tools/draw':'/tools/draw.html','/tools/draw/':'/tools/draw.html'};
  pages['/tools/events']=pages['/tools/events/']='/tools/events.html';
  url.pathname=pages[path]||path;return env.ASSETS.fetch(new Request(url,request));
 }
 return env.ASSETS.fetch(request);
}
export default {async scheduled(event,env,ctx){ctx.waitUntil(env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal/sync',{method:'POST'}));},async fetch(request,env){let r;try{r=await route(request,env);}catch(e){const status=e instanceof Fault?e.status||400:500,code=({400:'INVALID_REQUEST',401:'UNAUTHENTICATED',403:'FORBIDDEN',404:'NOT_FOUND',405:'METHOD_NOT_ALLOWED',409:'CONFLICT',410:'EXPIRED',413:'PAYLOAD_TOO_LARGE',415:'UNSUPPORTED_MEDIA_TYPE',429:'RATE_LIMITED',503:'UNAVAILABLE'})[status]||'INTERNAL_ERROR';r=json({error:e instanceof Fault?e.message:'服务暂不可用',code,requestId:crypto.randomUUID()},status);}const response=new Response(r.body,r);for(const [k,v] of Object.entries(securityHeaders))response.headers.set(k,v);if(response.headers.get('Content-Type')?.startsWith('text/html'))response.headers.set('Cache-Control','no-store');return response;}};
