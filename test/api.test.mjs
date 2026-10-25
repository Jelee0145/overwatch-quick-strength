import {test} from 'node:test';import assert from 'node:assert/strict';
import {AuthDirectory} from '../src/actors/auth.mjs';import {UserTasks} from '../src/actors/tasks.mjs';import worker from '../src/worker.mjs';
import {passwordHash,putBlob,getBlob} from '../src/security.mjs';import {service} from './query-fixture.mjs';
import {MemoryStorage} from './helpers/storage.mjs';
async function setup(){
 const storage=new MemoryStorage(),env={PASSWORD_PEPPER:'test-only-pepper',CACHE_SIGNING_KEY:'test-only-signing-key',API_KEY_ENCRYPTION_KEY:'test-only-api-key-secret',DASHEN_DTS:'2026',DASHEN_SERVER:'1',DASHEN_ROLE_ID:'test-role',DASHEN_TOKEN:'test-token'};
 env.ADMIN_PASSWORD_HASH=JSON.stringify(await passwordHash('admin-password',env.PASSWORD_PEPPER));
 const dir=new AuthDirectory({storage},env);env.AUTH={idFromName:n=>n,get:()=>({fetch:(input,init)=>dir.fetch(new Request(input,init))})};
 const tasks=new Map();env.TASKS={idFromName:n=>n,get:id=>{if(!tasks.has(id))tasks.set(id,new UserTasks({storage:new MemoryStorage()},env));return {fetch:(input,init)=>tasks.get(id).fetch(new Request(input,init))};}};
 env.ASSETS={fetch:()=>new Response('static')};return {storage,env,dir,tasks};
}
async function internal(obj,path,body={},rest={}){const r=await obj.fetch(new Request('https://internal/',{method:'POST',body:JSON.stringify({path,body,ip:'test-ip',...rest})}));const v=await r.json();return {r,v};}
async function approve(ctx,address='api@example.test'){
 const register=(await internal(ctx.dir,'/register',{email:address,password:'player-password'})).v;
 const login=(await internal(ctx.dir,'/admin/login',{password:'admin-password'})).v;
 const result=await internal(ctx.dir,'/admin/access',{id:register.user.id,status:'approved'},{adminToken:login.token,csrf:login.csrf,mutation:true});
 assert.equal(result.r.status,200);return register;
}
async function createKey(ctx,register){
 const result=await internal(ctx.dir,'/api-key',{action:'regenerate'},{userToken:register.token,csrf:register.csrf,mutation:true});
 assert.equal(result.r.status,200);return result.v.key;
}
test('API key login issues a normal secure cookie session without exposing the key',async()=>{
 const ctx=await setup(),user=await approve(ctx),key=await createKey(ctx,user);
 for(const path of ['/api/auth/login','/api/v1/auth/login']){
  const response=await api(ctx,path,{method:'POST',body:{apiKey:key},headers:{Origin:'https://site.test'}}),value=await response.json();
  assert.equal(response.status,200);assert.equal(value.user.id,user.user.id);assert.ok(value.csrf);assert.equal(value.token,undefined);assert.ok(!JSON.stringify(value).includes(key));
  const cookie=response.headers.get('set-cookie');assert.match(cookie,/^qs_session=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);
  const session=await api(ctx,'/api/auth/session',{headers:{Cookie:cookie.split(';')[0]}});assert.equal(session.status,200);assert.equal((await session.json()).user.id,user.user.id);
  const logout=await api(ctx,'/api/auth/logout',{method:'POST',body:{},headers:{Cookie:cookie.split(';')[0],Origin:'https://site.test','X-CSRF-Token':value.csrf}});assert.equal(logout.status,200);
  assert.equal((await api(ctx,'/api/auth/session',{headers:{Cookie:cookie.split(';')[0]}})).status,401);
 }
 assert.equal((await api(ctx,'/api/auth/login',{method:'POST',body:{apiKey:key},headers:{Origin:'https://evil.test'}})).status,403);
});
test('API key login rejects invalid, rotated, and unauthorized credentials and preserves password login',async()=>{
 const ctx=await setup(),user=await approve(ctx),old=await createKey(ctx,user),key=await createKey(ctx,user);
 for(const apiKey of ['',null,123,{},'x'.repeat(101),'owqs_invalid',old])assert.equal((await internal(ctx.dir,'/login',{apiKey})).r.status,401);
 assert.equal((await internal(ctx.dir,'/login',{email:user.user.email,password:'player-password'})).r.status,200);
 const record=await ctx.storage.get('user:'+user.user.id);
 for(const status of ['pending','rejected','revoked']){await ctx.storage.put('user:'+record.id,{...record,status});assert.equal((await internal(ctx.dir,'/login',{apiKey:key})).r.status,403);}
 await ctx.storage.put('user:'+record.id,record);
 assert.equal((await internal(ctx.dir,'/login',{apiKey:key})).v.user.id,record.id);
});
test('rotating an API key invalidates its browser sessions but preserves password sessions',async()=>{
 const ctx=await setup(),user=await approve(ctx),key=await createKey(ctx,user);
 const login=await internal(ctx.dir,'/login',{apiKey:key});assert.equal(login.r.status,200);
 await createKey(ctx,user);
 assert.equal((await internal(ctx.dir,'/session',{}, {userToken:login.v.token})).r.status,401);
 assert.equal((await internal(ctx.dir,'/session',{}, {userToken:user.token})).r.status,200);
});

test('API key login is rate limited by account and source IP',async()=>{
 const ctx=await setup(),user=await approve(ctx),key=await createKey(ctx,user);
 for(let n=0;n<8;n++)assert.equal((await internal(ctx.dir,'/login',{apiKey:key},{ip:'account-'+n})).r.status,200);
 assert.equal((await internal(ctx.dir,'/login',{apiKey:key},{ip:'another-ip'})).r.status,429);
 for(let n=0;n<20;n++)assert.equal((await internal(ctx.dir,'/login',{apiKey:'invalid'},{ip:'abusive-ip'})).r.status,401);
 assert.equal((await internal(ctx.dir,'/login',{apiKey:key},{ip:'abusive-ip'})).r.status,429);
});

const api=(ctx,path,{method='GET',key,body,headers={}}={})=>worker.fetch(new Request('https://site.test'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{Authorization:'Bearer '+key}:{}),...headers},body:body?JSON.stringify(body):undefined}),ctx.env);
async function start(ctx,key,body={battletag:'Main#100',limit:5}){const response=await api(ctx,'/api/v1/query',{method:'POST',key,body}),value=await response.json();assert.equal(response.status,200);return value.id;}
const taskFor=(ctx,user)=>{if(!ctx.tasks.has(user))ctx.tasks.set(user,new UserTasks({storage:new MemoryStorage()},ctx.env));return ctx.tasks.get(user);};
async function speed(task,id){const data=await getBlob(task.storage,'data:'+id);data.minIntervalMs=0;await putBlob(task.storage,'data:'+id,data);}
async function finish(task,id){for(let i=0;i<30;i++){await task.alarm();const job=await task.storage.get('job:'+id);if(!job||!['running','paused','awaiting-cache'].includes(job.state))return job;}throw Error('query did not finish');}
test('API key is hidden until revealed, encrypted at rest, and regeneration revokes the old key',async()=>{
 const ctx=await setup(),register=await approve(ctx);
 const session=await internal(ctx.dir,'/session',{}, {userToken:register.token});
 assert.deepEqual(session.v.user.apiKey,{exists:false});
 assert.equal((await internal(ctx.dir,'/api-key',{action:'reveal'},{userToken:register.token,csrf:register.csrf,mutation:true})).r.status,404);
 const routed=await worker.fetch(new Request('https://site.test/api/auth/api-key',{method:'POST',headers:{Origin:'https://site.test',Cookie:'qs_session='+register.token,'Content-Type':'application/json','X-CSRF-Token':register.csrf},body:JSON.stringify({action:'regenerate'})}),ctx.env);
 assert.equal(routed.status,200);const key=(await routed.json()).key;assert.match(key,/^owqs_[a-f0-9]{64}$/);
 assert.equal((await worker.fetch(new Request('https://site.test/api/auth/api-key',{headers:{Cookie:'qs_session='+register.token}}),ctx.env)).status,405);
 const stored=[...ctx.storage.map.values()].map(v=>JSON.stringify(v)).join('\n');assert.ok(!stored.includes(key));
 const revealed=await internal(ctx.dir,'/api-key',{action:'reveal'},{userToken:register.token,csrf:register.csrf,mutation:true});assert.equal(revealed.v.key,key);
 const live=await internal(ctx.dir,'/session',{}, {userToken:register.token});assert.equal(live.v.user.apiKey.exists,true);assert.ok(live.v.user.apiKey.createdAt);
 assert.equal((await internal(ctx.dir,'/api-key-auth',{key})).r.status,200);
 const second=await createKey(ctx,register);assert.notEqual(second,key);
 assert.equal((await internal(ctx.dir,'/api-key-auth',{key})).r.status,401);
 assert.equal((await internal(ctx.dir,'/api-key-auth',{key:second})).r.status,200);
 const original=ctx.env.API_KEY_ENCRYPTION_KEY;ctx.env.API_KEY_ENCRYPTION_KEY='';
 assert.equal((await internal(ctx.dir,'/api-key',{action:'regenerate'},{userToken:register.token,csrf:register.csrf,mutation:true})).r.status,503);
 ctx.env.API_KEY_ENCRYPTION_KEY=original;
 const admin=(await internal(ctx.dir,'/admin/login',{password:'admin-password'})).v;
 await internal(ctx.dir,'/admin/access',{id:register.user.id,status:'revoked'},{adminToken:admin.token,csrf:admin.csrf,mutation:true});
 assert.equal((await internal(ctx.dir,'/api-key-auth',{key:second})).r.status,403);
});
test('Bot API authenticates by key, validates options, isolates jobs and caps unfinished work at five',async()=>{
 const ctx=await setup(),a=await approve(ctx),b=await approve(ctx,'b@example.test'),keyA=await createKey(ctx,a),keyB=await createKey(ctx,b),userA=a.user.id,userB=b.user.id;
 assert.equal((await api(ctx,'/api/v1/query',{method:'POST',body:{battletag:'Main#100',limit:5}})).status,401);
 assert.equal((await api(ctx,'/api/v1/query',{method:'POST',key:'owqs_'+'0'.repeat(64),body:{battletag:'Main#100',limit:5}})).status,401);
 const options=await api(ctx,'/api/v1/query',{method:'OPTIONS',key:keyA});assert.equal(options.status,405);assert.equal(options.headers.get('Access-Control-Allow-Origin'),null);
 assert.equal((await api(ctx,'/api/v1/query',{key:keyA})).status,405);
 assert.equal((await worker.fetch(new Request('https://site.test/api/v1/query',{method:'POST',headers:{Authorization:'Bearer '+keyA},body:JSON.stringify({battletag:'Main#100',limit:5})}),ctx.env)).status,415);
 for(const body of [{battletag:'Main#100',limit:7},{battletag:'bad-tag',limit:5},{battletag:'Main#100',limit:5,mode:'turbo'},{battletag:'Main#100',limit:5,statisticsRange:'7'},{battletag:'Main#100',limit:5,side:'X'},{battletag:'Main#100',limit:5,strategy:'x'}])assert.equal((await api(ctx,'/api/v1/query',{method:'POST',key:keyA,body})).status,400,JSON.stringify(body));
 const first=await start(ctx,keyA,{battletag:'Main#100',limit:5});
 assert.equal((await api(ctx,'/api/v1/jobs/'+first,{key:keyB})).status,404);
 const running=await api(ctx,'/api/v1/jobs/'+first,{key:keyA});assert.equal(running.status,200);assert.equal((await running.json()).state,'running');
 for(let i=2;i<=5;i++)await start(ctx,keyA,{battletag:'Task'+i+'#100',limit:5});
 const limit=await api(ctx,'/api/v1/query',{method:'POST',key:keyA,body:{battletag:'Six#100',limit:5}});assert.equal(limit.status,429);
 assert.equal((await api(ctx,'/api/v1/query',{method:'POST',key:keyB,body:{battletag:'Other#100',limit:5}})).status,200);
 const cancelling=await api(ctx,'/api/v1/jobs/'+first+'/cancel',{method:'POST',key:keyA});assert.equal(cancelling.status,200);
 await taskFor(ctx,userA).alarm();
 const cancelled=await taskFor(ctx,userA).storage.get('job:'+first);assert.equal(cancelled.state,'cancelled');
 const cancelledStatus=await api(ctx,'/api/v1/jobs/'+first,{key:keyA});assert.equal(cancelledStatus.status,200);const cancelledValue=await cancelledStatus.json();assert.equal(cancelledValue.quota,'released');
 assert.equal((await ctx.storage.get('usage:'+userA)).query,4);
 assert.equal((await api(ctx,'/api/v1/query',{method:'POST',key:keyA,body:{battletag:'Seventh#100',limit:5}})).status,200);
 assert.equal((await ctx.storage.get('usage:'+userA)).query,5);
 assert.equal((await ctx.storage.get('usage:'+userB)).query,1);
});
test('API result contains raw matches plus analysis with a fixed ten-match window and archives history',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id);
 const mock=service({newGames:12}),original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const u=new URL(url),path=u.pathname.replace('/v1/a19ld5tool',''),body=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(ctx.env,path,Object.fromEntries(u.searchParams),body)});};
 try{
  const id=await start(ctx,key,{battletag:'Main#100',limit:20,mode:'fast',statisticsRange:'all'});
  await speed(task,id);
  const job=await finish(task,id);assert.equal(job.state,'done');
  const response=await api(ctx,'/api/v1/jobs/'+id,{key}),value=await response.json();
  assert.equal(response.status,200);assert.equal(value.state,'done');assert.equal(value.quota,'charged');
  assert.equal(value.result.matches.length,12);assert.equal(value.analysis.matches.length,10);
  assert.equal(value.analysis.statsMatches.length,12);assert.equal(value.analysis.displayLimit,10);
  assert.equal(value.analysis.statisticsRange,'all');assert.ok(value.analysis.summary.total>0);
  assert.ok(value.analysis.personalPrediction);assert.equal(value.analysisError,undefined);
  assert.equal(value.chart,undefined);
  const picture=await api(ctx,'/api/v1/jobs/'+id+'?render=svg&compact=1',{key}),image=await picture.json();
  assert.equal(picture.status,200);assert.equal(image.result,undefined);assert.equal(image.chart.format,'svg');assert.equal(image.chart.displayed,10);
  assert.equal(image.chart.statisticsRange,'10');assert.match(image.chart.svg,/<svg[^>]*width="1440"/);
  assert.equal(image.analysis.statsMatches,undefined);assert.ok(image.analysis.matches.every(m=>!('players' in m)));
  assert.equal((await api(ctx,'/api/v1/jobs/'+id+'?render=png',{key})).status,400);
  const other=await approve(ctx,'other-picture@example.test'),otherKey=await createKey(ctx,other);
  assert.equal((await api(ctx,'/api/v1/jobs/'+id+'?render=svg&compact=1',{key:otherKey})).status,404);
  const history=await internal(task,'/history',{action:'list'},{user:register.user.id,version:1});
  assert.ok(history.v.accounts.some(account=>account.tag==='Main#100'));
  assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,1);
 }finally{globalThis.fetch=original;}
});
test('indexed match data and AI review share the displayed left-to-right window, isolate owners and reuse signed reviews',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id),original=globalThis.fetch;
 ctx.env.DEEPSEEK_KEY='test-only-ai-key';const mock=service({newGames:12});let requests=0,failAI=false;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(url);if(u.hostname==='api.deepseek.com'){requests++;const payload=JSON.parse(init.body);assert.ok(!payload.messages[1].content.includes('T1#100'));return failAI?Response.json({error:'unavailable'},{status:503}):Response.json({choices:[{message:{content:'测试复盘：这局可以更注意站位。'}}]});}
  const p=u.pathname.replace('/v1/a19ld5tool',''),b=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(ctx.env,p,Object.fromEntries(u.searchParams),b)});
 };
 try{
  const id=await start(ctx,key,{battletag:'Main#100',limit:20});await speed(task,id);await finish(task,id);
  const base='/api/v1/jobs/'+id+'/matches/';
  const left=await (await api(ctx,base+'1',{key})).json(),right=await (await api(ctx,base+'10',{key})).json();
  assert.equal(left.match.mid,'m9');assert.equal(right.match.mid,'m0');assert.equal(left.match.count,10);assert.equal(left.match.players.length,10);assert.equal(left.match.players[0].stats.kill,20);
  assert.equal(left.match.webView.match.mid,left.match.mid);assert.equal(left.match.webView.match.players.length,10);assert.deepEqual(Object.keys(left.match.webView.raw).sort(),['battletag','queriedAt']);assert.deepEqual(Object.keys(left.match.webView.match.players[0].res),['rankQueriedAt']);assert.ok(!JSON.stringify(left).includes('private'));assert.equal((await api(ctx,base+'0',{key})).status,400);assert.equal((await api(ctx,base+'11',{key})).status,400);
  const other=await approve(ctx,'match-other@example.test'),otherKey=await createKey(ctx,other);
  assert.equal((await api(ctx,base+'1',{key:otherKey})).status,404);
  assert.equal((await api(ctx,base+'1/review',{key:otherKey,method:'POST',body:{requestId:'other'}})).status,404);
  const first=await api(ctx,base+'1/review',{key,method:'POST',body:{requestId:'review-first'}}),created=await first.json();assert.equal(first.status,200);
  await finish(task,created.id);const status=await api(ctx,'/api/v1/reviews/'+created.id,{key}),report=await status.json();
  assert.equal(report.state,'done');assert.equal(report.match.mid,'m9');assert.equal(report.review.text,'测试复盘：这局可以更注意站位。');assert.equal(report.reviewEnvelope,undefined);assert.equal(requests,1);
  const cached=await (await api(ctx,base+'1/review',{key,method:'POST',body:{requestId:'review-again'}})).json();assert.equal(cached.cached,true);assert.equal(cached.review.cached,true);assert.equal(requests,1);
  assert.equal((await api(ctx,'/api/v1/reviews/'+created.id,{key:otherKey})).status,404);
  let usage=await ctx.storage.get('usage:'+register.user.id);assert.equal(usage.query,1);assert.equal(usage.ai,1);
  failAI=true;const failed=await(await api(ctx,base+'2/review',{key,method:'POST',body:{requestId:'review-fail'}})).json();await finish(task,failed.id);
  assert.equal((await (await api(ctx,'/api/v1/reviews/'+failed.id,{key})).json()).state,'failed');usage=await ctx.storage.get('usage:'+register.user.id);assert.equal(usage.ai,1);
  const shortTask=taskFor(ctx,other.user.id),short=await start(ctx,otherKey,{battletag:'Main#100',limit:5});await speed(shortTask,short);await finish(shortTask,short);
  assert.equal((await api(ctx,'/api/v1/jobs/'+short+'/matches/6',{key:otherKey})).status,400);
  assert.equal((await api(ctx,'/api/v1/jobs/'+short+'/matches/6/review',{key:otherKey,method:'POST',body:{requestId:'out-of-window'}})).status,400);assert.equal(requests,2);
  const expired=await shortTask.storage.get('job:'+short);expired.until=Date.now()-1;await shortTask.storage.put('job:'+short,expired);
  assert.equal((await api(ctx,'/api/v1/jobs/'+short+'/matches/1',{key:otherKey})).status,404);
 }finally{globalThis.fetch=original;}
});
test('API warm query reuses archived history and releases the cached-only reservation',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id),original=globalThis.fetch;
 const mock=service({newGames:5});globalThis.fetch=async(url,init)=>{const u=new URL(url),path=u.pathname.replace('/v1/a19ld5tool',''),body=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(ctx.env,path,Object.fromEntries(u.searchParams),body)});};
 try{
  const first=await start(ctx,key,{battletag:'Main#100',limit:5});await speed(task,first);const one=await finish(task,first);assert.equal(one.state,'done');assert.equal(mock.details.length,5);
  const second=await start(ctx,key,{battletag:'Main#100',limit:5});await speed(task,second);const two=await finish(task,second);assert.equal(two.state,'done');
  const status=await api(ctx,'/api/v1/jobs/'+second,{key}),value=await status.json();
  assert.equal(value.result.syncStatus.cachedOnly,true);assert.equal(mock.details.length,5);assert.equal(value.quota,'released');
  assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,1);
 }finally{globalThis.fetch=original;}
});
test('cached-only API success releases its reservation exactly once',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id);
 const id=await start(ctx,key,{battletag:'Cache#100',limit:5});
 const result={battletag:'Cache#100',queriedAt:new Date().toISOString(),matches:[],recentHistory:[],syncStatus:{fetchedMatches:0,rankFetches:0},historyStatus:{requests:0},queryCache:{}};
 await putBlob(task.storage,'data:'+id,{version:2,tag:'Cache#100',limit:5,phase:'done',selected:[],mainDone:{},result});
 const job=await finish(task,id);assert.equal(job.state,'done');
 assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,0);
 const status=await api(ctx,'/api/v1/jobs/'+id,{key}),value=await status.json();assert.equal(value.quota,'released');
 await task.alarm();assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,0);
});
test('API failure and timeout release the reserved quota',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id),user=register.user.id;
 const failed=await start(ctx,key,{battletag:'Fail#100',limit:5});
 await putBlob(task.storage,'data:'+failed,{version:2});
 const failedJob=await finish(task,failed);assert.equal(failedJob.state,'failed');
 assert.equal((await ctx.storage.get('usage:'+user)).query,0);
 const failedStatus=await api(ctx,'/api/v1/jobs/'+failed,{key}),failedValue=await failedStatus.json();assert.equal(failedValue.quota,'released');
 const timed=await start(ctx,key,{battletag:'Timeout#100',limit:5});
 const timedJob=await task.storage.get('job:'+timed);await task.storage.put('job:'+timed,{...timedJob,until:Date.now()-1});
 await task.alarm();assert.equal(await task.storage.get('job:'+timed),undefined);
 assert.equal((await ctx.storage.get('usage:'+user)).query,0);
});
test('API pause keeps the reservation and retries without charging again',async()=>{
 const ctx=await setup(),register=await approve(ctx),key=await createKey(ctx,register),task=taskFor(ctx,register.user.id),original=globalThis.fetch;
 const id=await start(ctx,key,{battletag:'Retry#100',limit:5});
 globalThis.fetch=async()=>Response.json({code:429},{status:429});
 try{await task.alarm();}finally{globalThis.fetch=original;}
 let job=await task.storage.get('job:'+id);assert.equal(job.state,'paused');
 assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,1);
 job.resumeAfter=0;await task.storage.put('job:'+id,job);await speed(task,id);
 const mock=service({newGames:5});globalThis.fetch=async(url,init)=>{const u=new URL(url),path=u.pathname.replace('/v1/a19ld5tool',''),body=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(ctx.env,path,Object.fromEntries(u.searchParams),body)});};
 try{const done=await finish(task,id);assert.equal(done.state,'done');}finally{globalThis.fetch=original;}
 assert.equal((await ctx.storage.get('usage:'+register.user.id)).query,1);
});


test('account validates Keys without charging; history opt-out leaves no synchronized history or default ID',async()=>{
 const ctx=await setup(),user=await approve(ctx),key=await createKey(ctx,user),task=taskFor(ctx,user.user.id),original=globalThis.fetch;
 assert.equal((await api(ctx,'/api/v1/account')).status,401);
 const account=await(await api(ctx,'/api/v1/account',{key})).json();assert.deepEqual({valid:account.valid,lastBattletag:account.lastBattletag,tier:account.tier},{valid:true,lastBattletag:null,tier:'standard'});assert.equal(account.apiVersion,'1.1');assert.equal(account.capabilities.sharedQuota,true);
 assert.equal((await api(ctx,'/api/v1/account',{key,method:'POST'})).status,405);
 assert.equal((await api(ctx,'/api/v1/query',{key,method:'POST',body:{battletag:'Free#100',limit:5,syncHistory:'false'}})).status,400);
 const mock=service({newGames:5});
 globalThis.fetch=async(url,init)=>{const u=new URL(url),p=u.pathname.replace('/v1/a19ld5tool',''),b=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(ctx.env,p,Object.fromEntries(u.searchParams),b)});};
 try{
  const first=await start(ctx,key,{battletag:'Bound#100',limit:5});await speed(task,first);await finish(task,first);
  assert.equal((await(await api(ctx,'/api/v1/account',{key})).json()).lastBattletag,'Bound#100');
  const history=await internal(task,'/history',{action:'list'},{user:user.user.id,version:1});
  const spy=task.priorFromHistory.bind(task);task.priorFromHistory=()=>{throw Error('Opt-out must not read synchronized history');};
  const free=await start(ctx,key,{battletag:'Free#100',limit:5,syncHistory:false});await speed(task,free);await finish(task,free);task.priorFromHistory=spy;
  assert.equal((await(await api(ctx,'/api/v1/jobs/'+free+'/matches/1',{key})).json()).match.battletag,'Free#100');
  assert.deepEqual((await internal(task,'/history',{action:'list'},{user:user.user.id,version:1})).v,history.v);
  assert.equal((await(await api(ctx,'/api/v1/account',{key})).json()).lastBattletag,'Bound#100');
  assert.equal((await ctx.storage.get('usage:'+user.user.id)).query,2);
 }finally{globalThis.fetch=original;}
});


test('dedicated free-tier provisioning isolates personal quota and forces history opt-out',async()=>{
 const {provisionFree}=await import('../server/provision-free.mjs');
 const ctx=await setup(),personal=await approve(ctx),personalKey=await createKey(ctx,personal);
 const original=await ctx.storage.get('user:'+personal.user.id);
 const free=await provisionFree(ctx.storage,ctx.env),again=await provisionFree(ctx.storage,ctx.env);
 assert.equal(free.key,again.key);assert.notEqual(free.key,personalKey);assert.notEqual(free.id,personal.user.id);
 assert.ok(!JSON.stringify(await ctx.storage.get('user:'+free.id)).includes(free.key));
 const freeAccount=await(await api(ctx,'/api/v1/account',{key:free.key})).json();assert.deepEqual({valid:freeAccount.valid,lastBattletag:freeAccount.lastBattletag,tier:freeAccount.tier},{valid:true,lastBattletag:null,tier:'free'});assert.equal(freeAccount.capabilities.history,false);
 const id=await start(ctx,free.key,{battletag:'Free#100',limit:5,syncHistory:true});
 assert.equal((await taskFor(ctx,free.id).storage.get('job:'+id)).apiOptions.syncHistory,false);
 assert.equal((await ctx.storage.get('usage:'+free.id)).query,1);
 assert.equal(await ctx.storage.get('usage:'+personal.user.id),undefined);
 assert.deepEqual(await ctx.storage.get('user:'+personal.user.id),original);
 assert.equal((await(await api(ctx,'/api/v1/account',{key:personalKey})).json()).tier,'standard');
 const conflicting=await setup();const {digest}=await import('../src/security.mjs');
 await conflicting.storage.put('user:'+await digest('bot-free@owqs.invalid'),{tier:'standard'});
 await assert.rejects(provisionFree(conflicting.storage,conflicting.env),/another tier/);
});
