import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseArgs,ladder,peakInWindow,USAGE} from '../scripts/upstream-scan-rate.mjs';
import {ServiceError as Fault} from '../backend/src/services/errors.mjs';

const settings={DASHEN_TOKEN:'t',DASHEN_ROLE_ID:'r',DASHEN_DTS:'2026',DASHEN_SERVER:'1'};
const immediate=async()=>{};

test('the ladder refuses configurations that could outrun a real ceiling',()=>{
 const fail=(argv,pattern)=>assert.throws(()=>parseArgs(argv),pattern);
 fail(['--battletag=A#1','--config=/x','--rates=2,4,6,8,10,12,14,16,18,20','--hold=120'],/超过 --budget/);
 fail(['--battletag=A#1','--config=/x','--rates=4,2'],/严格递增/);
 fail(['--battletag=A#1','--config=/x','--rates=2,2'],/严格递增/);
 fail(['--battletag=A#1','--config=/x','--rates=0,4'],/0—20/);
 fail(['--battletag=A#1','--config=/x','--rates=2,25'],/0—20/);
 fail(['--battletag=A#1','--config=/x','--hold=5'],/10—120/);
 fail(['--battletag=A#1','--config=/x','--hold=200'],/10—120/);
 fail(['--config=/x'],/--battletag/);
 fail(['--battletag=A#1','--config=relative'],/绝对路径/);
 const parsed=parseArgs(['--battletag=A#1','--config=/x']);
 assert.deepEqual([parsed.rates,parsed.hold,parsed.budget],[[2,4,6,8],20,460]);
 assert.match(USAGE,/首次 429 立即停止/);
});

test('the burst window is measured, not assumed',()=>{
 // An evenly paced 8/s schedule never puts more than 8 launches in a second.
 assert.equal(peakInWindow([0,125,250,375,500,625,750,875,1000],1000),8);
 // Catch-up after a slow response can bunch launches; that is what the upstream sees.
 assert.equal(peakInWindow([0,10,20,30,1000,1010],1000),4);
 assert.equal(peakInWindow([],1000),0);
 assert.equal(peakInWindow([500],1000),1);
});

// A fake upstream whose clock advances with each request, so the ladder's
// wall-clock loop terminates without real waiting.
function fakeUpstream({limitAt,latency=5,details=40}){
 const calls=[];
 let served=0;
 const upstream=async (env,pathname)=>{
  calls.push(pathname);
  if(pathname==='/searchBnetAccount')return {customerToken:'secret-ct'};
  if(pathname==='/customer/queryMatchList')return {matchList:Array.from({length:details},(_,i)=>({matchId:'mid-'+i}))};
  if(limitAt!==undefined&&++served>limitAt)throw new Fault('大神接口限流',429);
  return {gameTimeSec:600};
 };
 return {upstream,calls,served:()=>served};
}

/** Clock: each call to now() is the single source of time, advanced by the fake sleep. */
function clock(){let t=0;return {now:()=>t,async sleep(ms){t+=Math.max(0,ms);}};}

test('a clean ladder reports the realized rate, not just the target',async()=>{
 const {upstream,calls}=fakeUpstream({});
 const time=clock();
 // Every request takes 5ms, charged inside the probe by advancing the same clock.
 const counted={upstream:async (env,pathname)=>{time.sleep(5);return upstream(env,pathname);}};
 const report=await ladder({settings,tag:'Real#1234',rates:[2,4],hold:10,budget:400,call:counted.upstream,now:time.now,sleep:time.sleep});
 assert.equal(report.rateLimited,false);
 assert.equal(report.concurrency,1);
 assert.equal(report.stages.length,2);
 for(const stage of report.stages){
  assert.equal(stage.completed,true);
  assert.equal(stage.limited,false);
  // Realized rate can never exceed the target, and must stay close to it.
  assert.ok(stage.realizedPerSecond<=stage.ratePerSecond,`${stage.realizedPerSecond} > ${stage.ratePerSecond}`);
  assert.ok(stage.realizedPerSecond>=stage.ratePerSecond*0.8,`${stage.realizedPerSecond} far below ${stage.ratePerSecond}`);
  // A paced ladder never banks lateness into a burst larger than its own target.
  assert.ok(stage.peakPerSecond<=stage.ratePerSecond+1,`burst ${stage.peakPerSecond} at ${stage.ratePerSecond}/s`);
 }
 assert.equal(report.safeRatePerSecond,4);
 assert.equal(report.limitedRatePerSecond,null);
 // Only the account search and list precede the ladder.
 assert.equal(calls[0],'/searchBnetAccount');
 assert.equal(calls[1],'/customer/queryMatchList');
 assert.ok(calls.slice(2).every(path=>path==='/customer/queryMatchInfo'));
});

test('the first 429 ends the ladder and marks that stage, never a later one',async()=>{
 const {upstream}=fakeUpstream({limitAt:5});
 const time=clock();
 const counted={upstream:async (env,pathname)=>{time.sleep(5);return upstream(env,pathname);}};
 const report=await ladder({settings,tag:'Real#1234',rates:[2,4,6,8],hold:10,budget:400,call:counted.upstream,now:time.now,sleep:time.sleep});
 assert.equal(report.rateLimited,true);
 const limitedStages=report.stages.filter(s=>s.limited);
 assert.equal(limitedStages.length,1);
 // The ladder stops at the stage that hit the limit: nothing runs after it.
 assert.equal(report.stages.at(-1).limited,true);
 assert.equal(report.limitedRatePerSecond,report.stages.at(-1).ratePerSecond);
 assert.ok(report.safeRatePerSecond===null||report.safeRatePerSecond<report.limitedRatePerSecond);
 assert.equal(report.stages.at(-1).realizedPerSecond,null);
});

test('an idempotent 429 on the account search aborts before any ladder stage',async()=>{
 const upstream=async ()=> {throw new Fault('大神接口限流',429);};
 const time=clock();
 const report=await ladder({settings,tag:'Real#1234',rates:[2],hold:10,budget:400,call:upstream,now:time.now,sleep:time.sleep}).catch(e=>e);
 // locate() surfaces the limit rather than returning a token, so the ladder never starts.
 assert.ok(report instanceof Error||report.rateLimited===true);
});

test('reports never carry credentials, customer tokens or match identifiers',async()=>{
 const {upstream}=fakeUpstream({});
 const time=clock();
 const counted={upstream:async (env,pathname)=>{time.sleep(5);return upstream(env,pathname);}};
 const report=await ladder({settings,tag:'RealPlayer#1234',rates:[2],hold:10,budget:400,call:counted.upstream,now:time.now,sleep:time.sleep});
 const serialized=JSON.stringify(report);
 for(const secret of ['secret-ct','mid-','DASHEN','datamsapi','RealPlayer'])assert.equal(serialized.includes(secret),false,secret);
 assert.equal(report.account,'R***#1234');
});
