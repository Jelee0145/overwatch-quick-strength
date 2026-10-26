import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import os from 'node:os';import path from 'node:path';
import {describe,inFlightTable,maskedTag,parseArgs,loadConfig,scan,USAGE} from '../scripts/upstream-limit-scan.mjs';
import {ServiceError as Fault} from '../src/services/errors.mjs';

test('phase 0 arguments are bounded and a tag is mandatory',()=>{
 assert.throws(()=>parseArgs([]),/缺少 --battletag/);
 assert.throws(()=>parseArgs(['--battletag=nobody']),/完整昵称/);
 assert.throws(()=>parseArgs(['--battletag=Abc#1']),/OWQS_CONFIG/);
 assert.throws(()=>parseArgs(['--battletag=Abc#1','--config=relative.json']),/绝对路径/);
 assert.throws(()=>parseArgs(['--battletag=Abc#1','--config=/x','--probes=31']),/1—30/);
 assert.throws(()=>parseArgs(['--battletag=Abc#1','--config=/x','--gap=100']),/至少 200/);
 assert.throws(()=>parseArgs(['--battletag=Abc#1','--config=/x','--budget=2']),/至少 3/);
 const parsed=parseArgs(['--battletag=Abc#1','--config=/x']);
 assert.deepEqual([parsed.probes,parsed.gap,parsed.budget],[10,600,16]);
 assert.match(USAGE,/只读/);
});

test('latency summary and the in-flight table expose the real constraint',()=>{
 assert.equal(describe([]),null);
 assert.deepEqual(describe([100,200,300,400,500]),{n:5,min:100,p50:300,p90:500,p95:500,max:500,mean:300});
 // A fast upstream never needs more than a couple of concurrent requests.
 assert.ok(inFlightTable(180).every(r=>r.note==='速率是约束'));
 // A slow one turns concurrency into the real ceiling.
 const slow=inFlightTable(1500);
 assert.equal(slow.find(r=>r.ratePerSecond===6).inFlightNeeded,9);
 assert.equal(slow.find(r=>r.ratePerSecond===6).note,'并发是约束');
});

test('only the account identifier is masked, never the credentials',()=>{
 assert.equal(maskedTag('SomePlayer#1234'),'S***#1234');
 assert.equal(maskedTag('SomePlayer#1234').includes('Player'),false);
});

test('config loading rejects directories, symlinks and incomplete credentials',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'owqs-scan-'));
 try{
  assert.equal(await loadConfig(path.join(directory,'missing.json')).catch(e=>e.message),'--config 必须指向已存在的普通文件（不能是目录或符号链接）');
  assert.match(await loadConfig(directory).catch(e=>e.message),/普通文件/);
  const target=path.join(directory,'real.json'),link=path.join(directory,'link.json');
  const complete={DASHEN_TOKEN:'t',DASHEN_ROLE_ID:'r',DASHEN_DTS:'2026',DASHEN_SERVER:'1',UNRELATED:'keep-out'};
  await writeFile(target,JSON.stringify(complete));
  await symlink(target,link);
  assert.match(await loadConfig(link).catch(e=>e.message),/普通文件/);
  await writeFile(path.join(directory,'partial.json'),JSON.stringify({DASHEN_TOKEN:'t'}));
  assert.match(await loadConfig(path.join(directory,'partial.json')).catch(e=>e.message),/缺少 DASHEN_ROLE_ID/);
  // Unrelated fields in the real file are not forwarded to the adapter.
  assert.deepEqual(Object.keys(await loadConfig(target)).sort(),['DASHEN_DTS','DASHEN_ROLE_ID','DASHEN_SERVER','DASHEN_TOKEN']);
  await writeFile(path.join(directory,'broken.json'),'{not json');
  assert.match(await loadConfig(path.join(directory,'broken.json')).catch(e=>e.message),/有效 JSON/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

function stubUpstream({detailCount=4,status=200,body='{}'}){
 const calls=[];
 const upstream=async (env,pathname,params,requestBody)=>{
  calls.push({pathname,params,requestBody});
  if(status===429)throw Object.assign(new Error('大神接口限流'),{status:429});
  if(pathname==='/searchBnetAccount')return {name:requestBody.name,customerToken:'secret-customer-token'};
  if(pathname==='/customer/queryMatchList')return {matchList:Array.from({length:detailCount},(_,i)=>({matchId:'mid-'+i,beginTs:100-i}))};
  return {gameTimeSec:600,teammateList:[],enemyList:[]};
 };
 return {upstream,calls};
}

const immediate=async()=>{};

test('phase 0 runs serially, respects the budget and leaks nothing into the report',async()=>{
 const {upstream,calls}=stubUpstream({detailCount:4});
 let clock=0;
 const report=await scan({settings:{DASHEN_TOKEN:'token-value',DASHEN_ROLE_ID:'role-value',DASHEN_DTS:'2026',DASHEN_SERVER:'1'},tag:'RealPlayer#1234',probes:3,gap:600,budget:16,call:upstream,now:()=>clock+=25,sleep:immediate});
 assert.equal(calls.length,1+1+3);
 assert.deepEqual(calls.map(c=>c.pathname),['/searchBnetAccount','/customer/queryMatchList','/customer/queryMatchInfo','/customer/queryMatchInfo','/customer/queryMatchInfo']);
 assert.equal(report.probes.completed,3);
 assert.equal(report.rateLimited,false);
 assert.equal(report.account,'R***#1234');
 // The egress host is recorded so local numbers cannot be read as production ones.
 assert.equal(report.host,os.hostname());
 const serialized=JSON.stringify(report);
 // Credentials, customer tokens and request URLs never appear in the artifact.
 for(const secret of ['token-value','role-value','secret-customer-token','mid-','datamsapi'])assert.equal(serialized.includes(secret),false,secret);
});

test('a 429 indicated only in the body still stops the run immediately',async()=>{
 // HTTP 200 plus code 429 is one of the two ways this upstream reports the limit.
 const calls=[];
 const upstream=async (env,pathname)=>{
  calls.push(pathname);
  // Mirrors the adapter's HTTP-200-with-code-429 path once unwrapped.
  if(pathname==='/searchBnetAccount')throw new Fault('大神接口限流',429);
  return {customerToken:'secret-customer-token'};
 };
 const report=await scan({settings:{DASHEN_TOKEN:'t',DASHEN_ROLE_ID:'r',DASHEN_DTS:'2026',DASHEN_SERVER:'1'},tag:'RealPlayer#1234',probes:10,gap:600,budget:16,call:upstream,sleep:immediate});
 assert.equal(report.rateLimited,true);
 assert.equal(report.probes.completed,0);
 assert.equal(report.latencyMs,null);
 assert.equal(report.implied.length,0);
 assert.deepEqual(calls,['/searchBnetAccount']);
});

test('a mid-run 429 keeps the samples already collected and never retries',async()=>{
 let details=0;
 const upstream=async (env,pathname)=>{
  if(pathname==='/searchBnetAccount')return {customerToken:'ct'};
  if(pathname==='/customer/queryMatchList')return {matchList:[{matchId:'a'},{matchId:'b'},{matchId:'c'}]};
  if(pathname==='/customer/queryMatchInfo'){
   if(++details===2)throw Object.assign(new Error('限流'),{status:429});
   return {gameTimeSec:600};
  }
 };
 let clock=0;
 const report=await scan({settings:{DASHEN_TOKEN:'t',DASHEN_ROLE_ID:'r',DASHEN_DTS:'2026',DASHEN_SERVER:'1'},tag:'RealPlayer#1234',probes:3,gap:600,budget:16,call:upstream,now:()=>clock+=20,sleep:immediate});
 assert.equal(report.rateLimited,true);
 assert.equal(report.probes.completed,1);
 assert.equal(report.latencyMs.n,1);
 assert.equal(details,2);
});

test('the request budget is a hard ceiling, not a suggestion',async()=>{
 const {upstream,calls}=stubUpstream({detailCount:30});
 await assert.rejects(scan({settings:{DASHEN_TOKEN:'t',DASHEN_ROLE_ID:'r',DASHEN_DTS:'2026',DASHEN_SERVER:'1'},tag:'RealPlayer#1234',probes:30,gap:600,budget:3,call:upstream,sleep:immediate}),/请求预算/);
 // Exactly the budget reaches upstream; the fourth probe is refused before it is sent.
 assert.equal(calls.length,3);
});
