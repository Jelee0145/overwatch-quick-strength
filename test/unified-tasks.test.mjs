import {test} from 'node:test';import assert from 'node:assert/strict';
import {UserTasks} from '../src/actors/tasks.mjs';import {AuthDirectory} from '../src/actors/auth.mjs';
import {getBlob,putBlob,mac} from '../src/security.mjs';
import {mintQueryIndex,verifyQueryIndex} from '../src/query/cache-records.mjs';
import {normalizeQueryOptions,legacyQueryOptions} from '../src/query/options.mjs';
import {service} from './query-fixture.mjs';
import {MemoryStorage} from './helpers/storage.mjs';
import {setup,request,start,speed,finish,fixture} from './helpers/tasks.mjs';

test('shared normalization preserves defaults and rejects conflicting query aliases',()=>{
 assert.equal(normalizeQueryOptions({player:' Main#100 '}).supplementOtherMatches,false);assert.equal(legacyQueryOptions({battletag:'Main#100',limit:1}).supplementOtherMatches,true);
 assert.throws(()=>normalizeQueryOptions({player:'Main#100',mode:'fast',supplementOtherMatches:true}));
});
test('persisted idempotency reuses API and unified web jobs and rejects pool/scope conflicts',async()=>{
 const ctx=await setup(),a=await start(ctx.task,{requestId:'one',pool:'55'});assert.equal(a.status,200);
 ctx.task=new UserTasks({storage:ctx.storage},ctx.env);
 const replay=await request(ctx.task,'/unified-query',{player:'Main#100',limit:5,idempotencyKey:'one',pool:55});assert.equal(replay.id,a.id);
 assert.equal((await start(ctx.task,{requestId:'one',pool:'66'})).status,409);
 assert.equal((await start(ctx.task,{requestId:'one',idempotencyKey:'other',pool:'55'})).status,400);
 ctx.env.DASHEN_DTS='2027';assert.equal((await start(ctx.task,{requestId:'one',pool:'55'})).status,409);
 assert.equal((await ctx.ledger.get('usage:u')).query,1);
 await ctx.task.alarm();assert.equal((await ctx.storage.get('job:'+a.id)).quota,'released');assert.equal((await ctx.ledger.get('usage:u')).query,0);
});
test('API and unified web jobs share five unfinished slots and active tasks includes API jobs',async()=>{
 const ctx=await setup();for(let n=0;n<5;n++)assert.equal((await request(ctx.task,n%2?'/unified-query':'/api-query',{battletag:'Main#100',limit:5,requestId:'slot'+n})).status,200);
 const active=await request(ctx.task,'/active');assert.equal(active.tasks.length,5);assert.equal(active.tasks.filter(t=>t.api).length,3);
 assert.equal((await start(ctx.task,{requestId:'six'})).status,429);assert.equal((await request(ctx.task,'/query',{battletag:'Main#100',limit:5})).status,429);assert.equal((await start(ctx.task,{requestId:'slot0'})).id,active.tasks[0].id);
});
test('fixture-backed pool query restarts, archives server history and refunds a cache-only API replay',async()=>{
 const ctx=await setup();await fixture(async mock=>{
  const first=await start(ctx.task,{requestId:'cold',pool:'55'});await speed(ctx,first.id);assert.equal((await finish(ctx.task,first.id)).state,'done');assert.equal(mock.details.length,5);
  ctx.task=new UserTasks({storage:ctx.storage},ctx.env);
  const warm=await request(ctx.task,'/unified-query',{battletag:'Main#100',limit:5,pool:'55',requestId:'warm-web',cacheManifest:[{type:'match',key:'m0'}]});await speed(ctx,warm.id);
  const warmed=await finish(ctx.task,warm.id);assert.equal(warmed.state,'done');assert.equal(warmed.quota,'released');assert.equal(warmed.billingReason,'cache-only');assert.equal(mock.details.length,5);
  const api=await start(ctx.task,{requestId:'warm-api',pool:'55'});await speed(ctx,api.id);await finish(ctx.task,api.id);
  const status=await request(ctx.task,'/status',{id:api.id});assert.equal(status.quota,'released');assert.equal(status.billingReason,'cache-only');assert.equal(status.cacheRequest,null);assert.equal((await ctx.ledger.get('usage:u')).query,1);
  assert.equal(status.result.matches.every(m=>m.gameMode==='LeisurePreset'),true);
  assert.equal((await start(ctx.task,{requestId:'warm-api',pool:'66'})).status,409);
 },{newGames:10,mixedModes:true});
});
test('failure and cancellation refunds survive namespace outage and restart without double refund',async()=>{
 const ctx=await setup(),a=await start(ctx.task,{requestId:'cancel'});let j=await ctx.storage.get('job:'+a.id);j.state='paused';j.resumeAfter=Date.now()+60000;await ctx.storage.put('job:'+a.id,j);
 ctx.fault.refund=true;await request(ctx.task,'/cancel',{id:a.id});j=await ctx.storage.get('job:'+a.id);assert.equal(j.refundPending,'cancelled');assert.equal(j.quota,'reserved');
 ctx.task=new UserTasks({storage:ctx.storage},ctx.env);ctx.fault.refund=false;await ctx.task.alarm();await ctx.task.alarm();assert.equal((await ctx.ledger.get('usage:u')).query,0);assert.equal((await request(ctx.task,'/status',{id:a.id})).quota,'released');
 const broken=await start(ctx.task,{requestId:'failed'});await putBlob(ctx.storage,'data:'+broken.id,{version:2});assert.equal((await finish(ctx.task,broken.id)).state,'failed');assert.equal((await ctx.ledger.get('usage:u')).query,0);
});
test('expired and interrupted creation intents retain compensation until AUTH recovers',async()=>{
 const ctx=await setup(),a=await start(ctx.task),b=await start(ctx.task);let j=await ctx.storage.get('job:'+a.id);j.until=Date.now()-1;await ctx.storage.put('job:'+a.id,j);j=await ctx.storage.get('job:'+b.id);j.state='creating';await ctx.storage.put('job:'+b.id,j);
 ctx.fault.refund=true;ctx.task=new UserTasks({storage:ctx.storage},ctx.env);await ctx.task.alarm();assert.ok(await ctx.storage.get('job:'+a.id));assert.equal((await ctx.ledger.get('usage:u')).query,2);
 ctx.fault.refund=false;await ctx.task.alarm();assert.equal(await ctx.storage.get('job:'+a.id),undefined);assert.equal((await ctx.storage.get('job:'+b.id)).quota,'released');assert.equal((await ctx.ledger.get('usage:u')).query,0);
});
test('creation persistence failure compensates the reservation and retry keeps one failed job',async()=>{
 const ctx=await setup(),write=ctx.storage.put.bind(ctx.storage);let failed=false;
 ctx.storage.put=async(k,v)=>{if(!failed&&k.startsWith('job:')&&v.state==='running'){failed=true;throw Error('fixture disk failure');}return write(k,v);};
 const a=await start(ctx.task,{requestId:'storage-failure'});assert.equal(a.status,500);assert.equal((await ctx.ledger.get('usage:u')).query,0);
 ctx.task=new UserTasks({storage:ctx.storage},ctx.env);const replay=await start(ctx.task,{requestId:'storage-failure'});assert.equal(replay.state,'failed');assert.equal((await ctx.ledger.get('usage:u')).query,0);
});
test('completed cache-only refund remains pending through outage without rerunning upstream',async()=>{
 const ctx=await setup(),a=await start(ctx.task),result={battletag:'Main#100',queriedAt:new Date().toISOString(),matches:[],recentHistory:[],syncStatus:{fetchedMatches:0,rankFetches:0},historyStatus:{requests:0},queryCache:{}};
 await putBlob(ctx.storage,'data:'+a.id,{version:2,tag:'Main#100',limit:5,phase:'done',selected:[],mainDone:{},result});ctx.fault.refund=true;
 await finish(ctx.task,a.id);let status=await request(ctx.task,'/status',{id:a.id});assert.equal(status.state,'done');assert.equal(status.quota,'charged');
 ctx.task=new UserTasks({storage:ctx.storage},ctx.env);ctx.fault.refund=false;await ctx.task.alarm();status=await request(ctx.task,'/status',{id:a.id});assert.equal(status.quota,'released');assert.equal(status.billingReason,'cache-only');assert.equal((await ctx.ledger.get('usage:u')).query,0);
});
test('legacy persisted API cache hits remain charged and old signed indexes verify',async()=>{
 const ctx=await setup(),a=await start(ctx.task),j=await ctx.storage.get('job:'+a.id);delete j.policyVersion;await ctx.storage.put('job:'+a.id,j);
 const result={battletag:'Main#100',queriedAt:new Date().toISOString(),matches:[],recentHistory:[],syncStatus:{fetchedMatches:0,rankFetches:0},historyStatus:{requests:0},queryCache:{}};
 await putBlob(ctx.storage,'data:'+a.id,{version:2,tag:'Main#100',limit:5,phase:'done',selected:[],mainDone:{},result});await finish(ctx.task,a.id);assert.equal((await ctx.ledger.get('usage:u')).query,1);
 const index=await mintQueryIndex('u',{...result,matches:[{mid:'m',t:1,ret:1,mapGuid:'map',gameMode:'Leisure6v6'}]},ctx.env);assert.equal((await verifyQueryIndex(index,'u','Main#100',ctx.env))[0].gameMode,'Leisure6v6');
 delete index.content.matches[0].gameMode;index.signature=await mac(index.content,ctx.env.CACHE_SIGNING_KEY);assert.equal((await verifyQueryIndex(index,'u','Main#100',ctx.env))[0].mid,'m');
});
