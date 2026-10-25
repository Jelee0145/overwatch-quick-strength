import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=async name=>readFile(new URL('../web/'+name,import.meta.url),'utf8');
const httpSource=await source('http-client.js'),analysisSource=await source('server-analysis.js');
function httpRuntime(fetch){const context={window:{fetch},queueMicrotask,structuredClone};vm.runInNewContext(httpSource,context);return context.window.OWQS_HTTP;}

test('web HTTP transport binds same-origin credentials and CSRF without redirect policy or automatic retries',async()=>{
 const calls=[],runtime=httpRuntime(async(path,options)=>{calls.push({path,options});return {ok:true,status:200,json:async()=>({ok:true})};});
 const request=runtime.create({csrf:()=> 'synthetic-csrf'});await request('/api/v1/query',{requestId:'one'});await request('/api/v1/jobs/one');
 assert.equal(calls.length,2);assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');assert.equal(calls[0].options.headers['X-CSRF-Token'],'synthetic-csrf');assert.equal(JSON.parse(calls[0].options.body).requestId,'one');assert.equal(calls[1].options.headers['X-CSRF-Token'],undefined);
 let unauthorized=0;const denied=runtime.create({fetch:async()=>({ok:false,status:401,json:async()=>({error:'session expired'})}),unauthorized:()=>unauthorized++});
 await assert.rejects(denied('/x'),e=>e.status===401&&e.message==='session expired');assert.equal(unauthorized,1);
 const malformed=runtime.create({fetch:async()=>({ok:false,status:503,json:async()=>{throw Error('html');}})});await assert.rejects(malformed('/x'),e=>e.status===503);
});

test('memory database fallback preserves session records with asynchronous clone boundaries',async()=>{
 const db=httpRuntime(async()=>{}).memoryDatabase();
 const access=(key,value)=>new Promise((resolve,reject)=>{const tx=db.transaction('cache'),r=value===undefined?tx.objectStore('cache').get(key):tx.objectStore('cache').put(value,key);tx.oncomplete=()=>resolve(r.result);tx.onerror=reject;});
 const value={a:1};await access('fixture',value);value.a=2;const loaded=await access('fixture');assert.equal(loaded.a,1);loaded.a=3;assert.equal((await access('fixture')).a,1);
 const values=await new Promise(resolve=>{const r=db.transaction('cache').objectStore('cache').getAll();r.onsuccess=()=>resolve(r.result);});assert.equal(values.length,1);
});

function analysisRuntime(Cloud){const context={window:{},Cloud,Map,JSON};vm.runInNewContext(analysisSource,context);return context.window.OWQS_SERVER_ANALYSIS;}
const dto=()=>({version:1,revision:'r1',matches:[],model:{matches:[]},raw:{battletag:'Fixture#1',matches:[]},window:{start:0,end:0}});

test('server analysis deduplicates requests, restores exact offline summaries and isolates scopes and authorization failures',async()=>{
 const storage=new Map();let count=0,failure=null,server='1';
 const Cloud={boot:async()=>({user:{id:'u'},scope:{server,dts:'2026'}}),storage:async(k,v)=>{if(v!==undefined)storage.set(k,v);return storage.get(k);},api:async(path,body)=>{assert.equal(path,'/api/v1/history/analysis');assert.equal(body.battletag,'Fixture#1');count++;if(failure)throw failure;return dto();}};
 let service=analysisRuntime(Cloud);const [a,b]=await Promise.all([service.load('Fixture#1',{start:0}),service.load('Fixture#1',{start:0})]);assert.equal(count,1);assert.equal(a,b);
 service.invalidate('Fixture#1');await service.load('Fixture#1',{start:0});assert.equal(count,2);
 failure=Error('offline');service=analysisRuntime(Cloud);assert.equal((await service.load('Fixture#1',{start:0})).offline,true);await assert.rejects(service.load('Fixture#1',{start:1}),/offline/);
 server='2';await assert.rejects(service.load('Fixture#1',{start:0}),/offline/);
 server='1';failure=Object.assign(Error('forbidden'),{status:403});service=analysisRuntime(Cloud);await assert.rejects(service.load('Fixture#1',{start:0}),/forbidden/);
});

test('server analysis keeps a small memory cache and requests slim views',async()=>{
 let requests=0,bodies=[];
 const Cloud={boot:async()=>({user:{id:'u'},scope:{server:'1',dts:'2026'}}),storage:async()=>undefined,api:async(path,body)=>{requests++;bodies.push(body);return dto();}};
 const service=analysisRuntime(Cloud);
 for(let start=0;start<4;start++)await service.load('Fixture#1',{start});
 assert.equal(requests,4);
 assert.equal(bodies[0].slim,true,'slim views keep the archive copy off the wire');
 await service.load('Fixture#1',{start:3});assert.equal(requests,4,'the newest view is cached');
 await service.load('Fixture#1',{start:0});assert.equal(requests,5,'older views are dropped so memory stays bounded');
 service.invalidate('Fixture#1');await service.load('Fixture#1',{start:0});assert.equal(requests,6);
});

test('main web client adapts legacy app paths and starts v1 queries without browser cache handshake',async()=>{
 const paths=[],context={window:{},OWQS_HTTP:httpRuntime(async()=>{}),crypto:{randomUUID:()=> 'request-one'},location:{assign(){}},document:{body:{classList:{remove(){}}},getElementById:()=>({})},CloudHistory:{initialize:async()=>{}},CloudCache:{initialize:async()=>{throw Error('disabled');}}};
 context.OWQS_HTTP={...context.OWQS_HTTP,create:()=>async(path,body)=>{paths.push({path,body});return path.endsWith('/session')?{csrf:'csrf',user:{id:'u',status:'approved'},scope:{server:'1',dts:'2026'}}:{};}};
 vm.runInNewContext(await source('cloud-client.js'),context);const Cloud=context.window.Cloud;
 await Cloud.api('/api/events?series=owl');await Cloud.api('/api/job/123?compact=1');await Cloud.startQuery('Fixture#1',10,false,'55');
 assert.equal(paths[0].path,'/api/v1/events?series=owl');assert.equal(paths[1].path,'/api/v1/jobs/123?compact=1');
 const query=paths.find(row=>row.path==='/api/v1/query');assert.equal(query.body.requestId,'request-one');assert.equal(query.body.cacheManifest,undefined);assert.equal(query.body.queryIndex,undefined);
 await Cloud.storage('fixture',{saved:true});assert.equal((await Cloud.storage('fixture')).saved,true);
});

test('completed query with archive warning shows its job view even when local persistence fails',async()=>{
 const text=await source('app/query.js'),opened=[],messages=[],job={state:'done',message:'完成',archiveWarning:'历史空间已满',envelope:{content:{data:{battletag:'New#100'}}}};
 const elements={resumeQuery:{},query:{},cancel:{}};const context={activeJob:'fixture-job',pollTimer:null,clearTimeout(){},$:id=>elements[id],status:value=>messages.push(value),Cloud:{api:async()=>job,save:async()=>{throw Error('IDB unavailable');}},OWQS_SERVER_ANALYSIS:{invalidate(){}},openHistory:async(...args)=>opened.push(args)};
 vm.runInNewContext(text,context);await context.poll();assert.deepEqual(opened,[['New#100',null,'fixture-job']]);assert.match(messages.at(-1),/历史空间已满/);assert.match(messages.at(-1),/本次查询结果/);assert.match(messages.at(-1),/IDB unavailable/);
 job.archiveWarning=null;context.activeJob='second-job';opened.length=0;context.openHistory=async(...args)=>{opened.push(args);if(!args[2])throw Error('archive offline');};await context.poll();assert.deepEqual(opened,[['New#100'],['New#100',null,'second-job']]);assert.match(messages.at(-1),/archive offline/);
});
