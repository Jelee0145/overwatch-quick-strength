import {Fault,json,getCookie,cookie} from './security.mjs';import {authCall} from './tasks.mjs';
import {release} from './release.mjs';import {analyzeResult} from './api-analysis.mjs';
import {renderApiChart,compactAnalysis} from './api-chart.mjs';
import {filterEvents} from './events-filter.mjs';
export {AuthDirectory} from './auth.mjs';export {UserTasks} from './tasks.mjs';
export {EventCenter} from './events.mjs';
const securityHeaders={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
async function body(request){if(Number(request.headers.get('Content-Length'))>3000000)throw new Fault('请求数据过大',413);const s=await request.text();if(new TextEncoder().encode(s).length>3000000)throw new Fault('请求数据过大',413);try{const b=JSON.parse(s);if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b;}catch{throw new Fault('请求格式错误');}}
function apiOptions(b){
 if(!b||typeof b!=='object'||Array.isArray(b))throw new Fault('请求格式错误');
 const rawTag=b.battletag??b.playerId??b.player;if(typeof rawTag!=='string')throw new Fault('缺少玩家 ID');
 const battletag=rawTag.trim();if(!battletag||battletag.length>80||!/^.+#\d+$/.test(battletag))throw new Fault('请输入完整战网昵称（昵称#编号）');
 const limit=b.limit===undefined?10:Number(b.limit);if(!Number.isInteger(limit)||![5,10,20].includes(limit))throw new Fault('查询场次只能是 5、10 或 20');
 let slow=false;
 if(b.mode!==undefined){if(!['fast','slow'].includes(b.mode))throw new Fault('查询模式只能是 fast 或 slow');slow=b.mode==='slow';}
 if(b.fast!==undefined){if(typeof b.fast!=='boolean')throw new Fault('快查询选项格式错误');if(b.mode!==undefined&&b.fast!==!slow)throw new Fault('查询模式与快查询选项冲突');slow=!b.fast;}
 if(b.supplementOtherMatches!==undefined){if(typeof b.supplementOtherMatches!=='boolean')throw new Fault('补充对局选项格式错误');if((b.mode!==undefined||b.fast!==undefined)&&b.supplementOtherMatches!==slow)throw new Fault('查询模式与补充对局选项冲突');slow=b.supplementOtherMatches;}
 const statisticsRange=b.statisticsRange===undefined?'all':String(b.statisticsRange);if(!['all','5','10','20'].includes(statisticsRange))throw new Fault('统计范围只能是 all、5、10 或 20');
 const side=b.side===undefined?'all':String(b.side);if(!['all','T','E'].includes(side))throw new Fault('玩家范围只能是 all、T 或 E');
 const strategy=b.strategy===undefined?'legacy':String(b.strategy);if(!['legacy','role','highest'].includes(strategy))throw new Fault('段位选取方式无效');
 if(b.estimate!==undefined&&typeof b.estimate!=='boolean')throw new Fault('估算选项格式错误');
 if(b.syncHistory!==undefined&&typeof b.syncHistory!=='boolean')throw new Fault('历史同步选项格式错误');
 return {battletag,limit,supplementOtherMatches:slow,mode:slow?'slow':'fast',statisticsRange,side,strategy,estimate:b.estimate!==false,syncHistory:b.syncHistory!==false};
}
async function apiV1(request,env,url){
 if(request.method==='OPTIONS')throw new Fault('接口不开放浏览器跨域调用',405);
 if(!['GET','POST'].includes(request.method))throw new Fault('不支持该请求方法',405);
 const header=request.headers.get('Authorization')||'';if(!header.startsWith('Bearer '))throw new Fault('缺少 Bearer API 密钥',401);
 const key=header.slice(7).trim();if(!/^owqs_[a-f0-9]{64}$/.test(key))throw new Fault('API 密钥无效',401);
 const auth=await authCall(env,'/api-key-auth',{key});
 if(url.pathname==='/api/v1/events'){
  if(request.method!=='GET')throw new Fault('请求方法错误',405);
  filterEvents({matches:[]},url.searchParams);
  const response=await env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal/?'+url.searchParams);
  if(response.status!==200)return response;
  return json(filterEvents(await response.json(),url.searchParams),200,{'Cache-Control':'private, no-store'});
 }
 const task=env.TASKS.get(env.TASKS.idFromName(auth.user.id));
 const call=async(path,payload={})=>{const r=await task.fetch('https://internal/',{method:'POST',body:JSON.stringify({path,body:payload,user:auth.user.id,version:auth.version})});const v=await r.json();if(!r.ok)throw new Fault(v.error,r.status);return v;};
 if(url.pathname==='/api/v1/account'){
  if(request.method!=='GET')throw new Fault('请求方法错误',405);
  return json({...await call('/api-profile'),tier:auth.tier||'standard'});
 }
 if(url.pathname==='/api/v1/query'){
  if(request.method!=='POST')throw new Fault('请求方法错误',405);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new Fault('Content-Type 必须为 application/json',415);
  const options=apiOptions(await body(request));
  if(auth.tier==='free')options.syncHistory=false;
  const created=await call('/api-query',options);
  return json({id:created.id,state:created.state,status:'/api/v1/jobs/'+created.id});
 }
 const selected=/^\/api\/v1\/jobs\/([a-f0-9]{64})\/matches\/([0-9]+)(\/review)?$/.exec(url.pathname);
 if(selected){
  const review=!!selected[3];if(request.method!==(review?'POST':'GET'))throw new Fault('请求方法错误',405);
  let input={};if(review){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new Fault('Content-Type 必须为 application/json',415);input=await body(request);}
  return json(await call(review?'/api-match-review':'/api-match',{id:selected[1],index:Number(selected[2]),requestId:input.requestId}));
 }
 const reviewId=/^\/api\/v1\/reviews\/([a-f0-9]{64})$/.exec(url.pathname);
 if(reviewId){
  if(request.method!=='GET')throw new Fault('请求方法错误',405);
  const status=await call('/status',{id:reviewId[1]});if(status.kind!=='ai'||!status.reviewMatch)throw new Fault('锐评任务不存在',404);
  return json({id:status.id,state:status.state,message:status.message,match:status.reviewMatch,review:status.state==='done'?status.review:undefined,quota:status.state==='done'?'charged':status.state==='failed'?'released':'reserved'});
 }
 const match=/^\/api\/v1\/jobs\/([a-f0-9]{64})(\/cancel)?$/.exec(url.pathname);
 if(match){
  const id=match[1];
  if(match[2]){if(request.method!=='POST')throw new Fault('请求方法错误',405);return json(await call('/cancel',{id}));}
  if(request.method!=='GET')throw new Fault('请求方法错误',405);
  const rendering=url.searchParams.get('render');if(rendering!==null&&rendering!=='svg')throw new Fault('图片格式仅支持 svg');
  const status=await call('/status',{id,compact:false});if(status.kind!=='query')throw new Fault('任务不存在',404);
  const out={id:status.id,state:status.state,message:status.message,progress:status.progress||null,createdAt:status.createdAt||null,finishedAt:status.finishedAt||null,options:status.apiOptions||null};
  if(status.state==='done'){out.quota='charged';out.battletag=status.result.battletag;out.archiveWarning=status.archiveWarning||null;out.result=status.result;try{out.analysis=analyzeResult(status.result,status.apiOptions||{});}catch(e){out.analysis=null;out.analysisError='分析生成失败';}}
  else out.quota=['failed','cancelled'].includes(status.state)?'released':'reserved';
  if(status.state==='done'&&rendering==='svg'){
   try{out.chart=await renderApiChart(status.result,status.apiOptions||{},env.ASSETS);}catch{out.chart=null;out.chartError='图表生成失败，可使用已有分析结果';}
  }
  if(status.state==='done'&&url.searchParams.get('compact')==='1'){
   delete out.result;if(out.analysis)out.analysis=compactAnalysis(out.analysis);
  }
  return json(out);
 }
 throw new Fault('接口不存在',404);
}
export async function route(request,env){
 const url=new URL(request.url),path=url.pathname,mutation=request.method==='POST';if(!['GET','POST'].includes(request.method))throw new Fault('不支持该请求方法',405);
 if(path==='/api/health'&&!mutation)return json({ok:true,...release});
 if(path.startsWith('/api/v1/'))return apiV1(request,env,url);
 if(path.startsWith('/api/')){
  if(mutation&&(request.headers.get('Origin')!==url.origin||!request.headers.get('Content-Type')?.startsWith('application/json')))throw new Fault('请求来源或格式不正确',403);
  const i={userToken:getCookie(request,'qs_session'),adminToken:getCookie(request,'qs_admin'),csrf:request.headers.get('X-CSRF-Token')||'',ip:request.headers.get('CF-Connecting-IP')||'local',mutation,body:mutation?await body(request):{}};
  const publicRoutes={'/api/auth/register':'/register','/api/auth/login':'/login','/api/auth/reset/request':'/reset/request','/api/auth/reset/confirm':'/reset/confirm','/api/admin/login':'/admin/login'};
  const authRoutes={'/api/auth/session':'/session','/api/auth/logout':'/logout','/api/auth/api-key':'/api-key','/api/admin/session':'/admin/session','/api/admin/logout':'/admin/logout','/api/admin/users':'/admin/users','/api/admin/access':'/admin/access','/api/admin/quota':'/admin/quota','/api/admin/reset':'/admin/reset'};
  if(publicRoutes[path]||authRoutes[path]){
   const internal=publicRoutes[path]||authRoutes[path];if(['/session','/admin/session','/admin/users'].includes(internal)?mutation:!mutation)throw new Fault('请求方法错误',405);
   const value=await authCall(env,internal,i.body,i),headers={};if(value.token){headers['Set-Cookie']=cookie(value.token,path.startsWith('/api/admin/'),value.seconds);delete value.token;delete value.seconds;}
   if(path.endsWith('/logout'))headers['Set-Cookie']=cookie('',path.startsWith('/api/admin/'),0);if(path==='/api/auth/session')value.scope={server:env.DASHEN_SERVER,dts:env.DASHEN_DTS};return json(value,200,headers);
  }
  const auth=await authCall(env,'/authorize',{},i);
  if(path==='/api/events'||path==='/api/events/refresh'){
   if(path.endsWith('/refresh')?!mutation:mutation)throw new Fault('请求方法错误',405);
   const params=new URLSearchParams(url.searchParams);if(!params.has('status'))params.set('status','all');
   filterEvents({matches:[]},params,{paginate:false});
   const response=await env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal/'+(mutation?'refresh':'')+'?'+params,{method:mutation?'POST':'GET'});
   if(response.status!==200)return response;
   return json(filterEvents(await response.json(),params,{paginate:false}),200,{'Cache-Control':'private, no-store'});
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
export default {async scheduled(event,env,ctx){ctx.waitUntil(env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal/sync',{method:'POST'}));},async fetch(request,env){let r;try{r=await route(request,env);}catch(e){r=json({error:e instanceof Fault?e.message:'服务暂不可用'},e.status||500);}const response=new Response(r.body,r);for(const [k,v] of Object.entries(securityHeaders))response.headers.set(k,v);if(response.headers.get('Content-Type')?.startsWith('text/html'))response.headers.set('Cache-Control','no-store');return response;}};
