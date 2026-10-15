import {Fault,json,getCookie,cookie} from './security.mjs';import {authCall} from './tasks.mjs';
import {release} from './release.mjs';
export {AuthDirectory} from './auth.mjs';export {UserTasks} from './tasks.mjs';
const securityHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
async function body(request){if(Number(request.headers.get('Content-Length'))>3000000)throw new Fault('请求数据过大',413);const s=await request.text();if(new TextEncoder().encode(s).length>3000000)throw new Fault('请求数据过大',413);try{const b=JSON.parse(s);if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b;}catch{throw new Fault('请求格式错误');}}
export async function route(request,env){
 const url=new URL(request.url),path=url.pathname,mutation=request.method==='POST';if(!['GET','POST'].includes(request.method))throw new Fault('不支持该请求方法',405);
 if(path==='/api/health'&&!mutation)return json({ok:true,...release});
 if(path.startsWith('/api/')){
  if(mutation&&(request.headers.get('Origin')!==url.origin||!request.headers.get('Content-Type')?.startsWith('application/json')))throw new Fault('请求来源或格式不正确',403);
  const i={userToken:getCookie(request,'qs_session'),adminToken:getCookie(request,'qs_admin'),csrf:request.headers.get('X-CSRF-Token')||'',ip:request.headers.get('CF-Connecting-IP')||'local',mutation,body:mutation?await body(request):{}};
  const publicRoutes={'/api/auth/register':'/register','/api/auth/login':'/login','/api/auth/reset/request':'/reset/request','/api/auth/reset/confirm':'/reset/confirm','/api/admin/login':'/admin/login'};
  const authRoutes={'/api/auth/session':'/session','/api/auth/logout':'/logout','/api/admin/session':'/admin/session','/api/admin/logout':'/admin/logout','/api/admin/users':'/admin/users','/api/admin/access':'/admin/access','/api/admin/quota':'/admin/quota','/api/admin/reset':'/admin/reset'};
  if(publicRoutes[path]||authRoutes[path]){
   const internal=publicRoutes[path]||authRoutes[path];if(['/session','/admin/session','/admin/users'].includes(internal)?mutation:!mutation)throw new Fault('请求方法错误',405);
   const value=await authCall(env,internal,i.body,i),headers={};if(value.token){headers['Set-Cookie']=cookie(value.token,path.startsWith('/api/admin/'),value.seconds);delete value.token;delete value.seconds;}
   if(path.endsWith('/logout'))headers['Set-Cookie']=cookie('',path.startsWith('/api/admin/'),0);if(path==='/api/auth/session')value.scope={server:env.DASHEN_SERVER,dts:env.DASHEN_DTS};return json(value,200,headers);
  }
  const auth=await authCall(env,'/authorize',{},i),task=env.TASKS.get(env.TASKS.idFromName(auth.user.id));let internal,b=i.body;
  if(path==='/api/query'&&mutation)internal='/query';
  else if(path==='/api/ai-review'&&mutation)internal='/ai-review';
  else if(path==='/api/history'&&mutation)internal='/history';
  else if(path==='/api/latest'&&!mutation){const r=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path:'/active',user:auth.user.id,version:auth.version})});const v=await r.json();if(!r.ok)throw new Fault(v.error,r.status);return json({activeJob:v.tasks.find(t=>t.kind==='query')?.id||null,activeAI:v.tasks.find(t=>t.kind==='ai')?.id||null,result:null});}
  else if(/^\/api\/job\/[a-f0-9]{64}(\/(cancel|resume|cache))?$/.test(path)){const parts=path.split('/');internal=parts[4]?'/'+parts[4]:'/status';if(internal==='/status'?mutation:!mutation)throw new Fault('请求方法错误',405);b={...i.body,id:parts[3],compact:url.searchParams.get('compact')==='1'};}
  else throw new Fault('接口不存在',404);
  const r=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path:internal,body:b,user:auth.user.id,version:auth.version})});return r;
 }
 // Only the explicitly built public directory is published; configuration and secrets are never assets.
 if(path==='/admin'||path==='/login'||path==='/reset'){url.pathname=path==='/admin'?'/admin.html':'/login.html';return env.ASSETS.fetch(new Request(url,request));}
 if(path==='/'||path==='/index.html'||path.startsWith('/tools/')){
  try{await authCall(env,'/authorize',{}, {userToken:getCookie(request,'qs_session')});}catch{return Response.redirect(url.origin+'/login'+(path.startsWith('/tools/')?'?next='+encodeURIComponent(path):''),302);}
  const pages={'/':'/index.html','/index.html':'/index.html','/tools/strength':'/tools/strength.html','/tools/strength/':'/tools/strength.html','/tools/draw':'/tools/draw.html','/tools/draw/':'/tools/draw.html'};
  url.pathname=pages[path]||path;return env.ASSETS.fetch(new Request(url,request));
 }
 return env.ASSETS.fetch(request);
}
export default {async fetch(request,env){let r;try{r=await route(request,env);}catch(e){r=json({error:e instanceof Fault?e.message:'服务暂不可用'},e.status||500);}const response=new Response(r.body,r);for(const [k,v] of Object.entries(securityHeaders))response.headers.set(k,v);if(response.headers.get('Content-Type')?.startsWith('text/html'))response.headers.set('Cache-Control','no-store');return response;}};
