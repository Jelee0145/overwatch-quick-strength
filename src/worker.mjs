import {Fault,json,getCookie} from './security.mjs';import {authCall} from './actors/tasks.mjs';
import {release} from './release.mjs';
import {apiV1,apiVersion} from './api/v1.mjs';
import {legacyApi} from './api/legacy.mjs';
export {AuthDirectory} from './actors/auth.mjs';export {UserTasks} from './actors/tasks.mjs';
export {EventCenter} from './events/center.mjs';
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
 if(path.startsWith('/api/'))return legacyApi(request,env,url,path);
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
