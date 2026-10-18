import {test} from 'node:test';import assert from 'node:assert/strict';import {createQuery,runQuery,queryStep,queryCheckpoint,restoreQuery,upgradeQuery,accountRecords} from '../src/query.mjs';import {Fault} from '../src/security.mjs';
import {service} from './query-fixture.mjs';
async function finish(s,mock){for(let n=0;s.phase!=='done'&&n<100;n++)await runQuery(s,{}, {call:mock.call,budgetMs:30,minIntervalMs:0});assert.equal(s.phase,'done');return s.result;}
test('three requests overlap; dense ranks skip all supplementary histories; warm cache only lists',async()=>{
 const mock=service({delay:8}),s=createQuery('Main#100',10),result=await finish(s,mock);assert.equal(mock.active.max,3);assert.equal(mock.details.length,10);assert.equal(result.historyStatus.requests,0);assert.equal(mock.counts['/customer/queryCountInfo'],10);assert.ok(!JSON.stringify(result).includes('-private'));
 const cached=service(),again=createQuery('Main#100',10,result,accountRecords(s));await finish(again,cached);assert.deepEqual(cached.counts,{'/customer/queryMatchList':1});assert.equal(again.result.syncStatus.cachedOnly,true);
});

test('paced launches stop queued requests after a rate limit and respect burst deadline',async()=>{
 const s=createQuery('Main#100',10),mock=service(),raw=mock.call;
 await runQuery(s,{}, {call:raw,budgetMs:10,minIntervalMs:0});
 const inDetails=createQuery('Main#100',10);await queryStep(inDetails,{},raw,{deadline:Date.now()+1000});await queryStep(inDetails,{},raw,{deadline:Date.now()+1000});
 inDetails.minIntervalMs=40;inDetails.nextStartAt=0;let started=0;
 await assert.rejects(()=>queryStep(inDetails,{},async()=>{started++;throw new Fault('limit',429);}),e=>e.status===429);assert.equal(started,1);
 const deadline=createQuery('Main#100',10);deadline.nextStartAt=Date.now()+100;await runQuery(deadline,{}, {call:raw,budgetMs:5});assert.equal(deadline.requests,0);assert.equal(deadline.yielded,true);
 const paced=createQuery('Main#100',10);await queryStep(paced,{},raw);await queryStep(paced,{},raw);paced.nextStartAt=0;paced.minIntervalMs=30;const times=[];
 await queryStep(paced,{},async(e,path,p,b)=>{times.push(Date.now());return raw(e,path,p,b);});assert.equal(times.length,3);assert.ok(times[1]-times[0]>=25);assert.ok(times[2]-times[1]>=25);
});
test('five added plus five cached fetches exactly five details; existing player ranks are reused',async()=>{
 const first=createQuery('Main#100',5),prior=await finish(first,service({newGames:5}));const mock=service({newGames:10}),s=createQuery('Main#100',10,prior,accountRecords(first));await finish(s,mock);assert.deepEqual(mock.details,['m5','m6','m7','m8','m9']);assert.equal(s.result.syncStatus.reusedMatches,5);assert.equal(mock.counts['/customer/queryCountInfo']||0,0);
});
test('overlapping recent lists fetch one battle and reproject each side, score and result',async()=>{
 const mock=service({dense:false}),s=createQuery('Main#100',10);await finish(s,mock);assert.equal(mock.details.filter(id=>id==='shared-history').length,1);assert.ok(s.histories.some(h=>h.name.startsWith('E')));assert.ok(s.histories.some(h=>h.name.startsWith('T')));
 for(const h of s.histories){const m=h.matches[0];assert.equal(m.players.find(p=>p.name===h.name).side,'T');assert.equal(m.teamScore,h.name.startsWith('E')?0:3);assert.equal(m.ret,h.name.startsWith('E')?-1:1);}
 const cached=service({dense:false}),again=createQuery('Main#100',10,s.result,accountRecords(s));await finish(again,cached);assert.deepEqual(cached.counts,{'/customer/queryMatchList':1});assert.ok(again.histories.length>0);
});
test('one overlapping cached history keeps its other valid game instead of discarding all',async()=>{
 const mock=service({dense:false}),s=createQuery('Main#100',10);await finish(s,mock);const prior=structuredClone(s.result);const h=prior.recentHistory[0];h.matches.push({...structuredClone(h.matches[0]),mid:'m0'});const again=createQuery('Main#100',10,prior,accountRecords(s));await finish(again,service({dense:false}));assert.equal(again.histories.find(x=>x.name===h.name).matches.length,1);assert.equal(again.histories.find(x=>x.name===h.name).matches[0].mid,'shared-history');
});

test('hot sampling plan does not query the next batch of recent peers on every refresh',async()=>{
 const mock=service({dense:false}),raw=mock.call;mock.call=async(e,path,p,b)=>{const v=await raw(e,path,p,b);if(path==='/customer/queryMatchInfo'&&p.matchId==='shared-history')for(const key of ['teammateList','enemyList'])for(let i=0;i<10;i++)v[key].push({...v[key][0],name:key+i+'#101',customerToken:key+i+'-private'});return v;};
 const s=createQuery('Main#100',10);await finish(s,mock);assert.equal(s.historyRanks,16);
 const cached=service({dense:false}),again=createQuery(s.tag,10,s.result,accountRecords(s));await finish(again,cached);assert.deepEqual(cached.counts,{'/customer/queryMatchList':1});
});
test('rate limit checkpoints successes; resumed single-request execution does not refetch',async()=>{
 const s=createQuery('Main#100',10),mock=service(),base=mock.call;let failed=false;const call=async(e,path,p,b)=>{if(path==='/customer/queryMatchInfo'&&p.matchId==='m1'&&!failed){failed=true;throw new Fault('limited',429);}return base(e,path,p,b);};let saved;
 await assert.rejects(()=>runQuery(s,{}, {call,minIntervalMs:0,checkpoint:x=>{saved=structuredClone(queryCheckpoint(x));}}),e=>e.status===429);assert.ok(saved.mainDone.m0);const resumed=restoreQuery(saved,s.prior);resumed.concurrency=1;await finish(resumed,mock);assert.equal(mock.details.filter(m=>m==='m0').length,1);assert.equal(mock.details.length,10);
});
test('expired ranks refresh, empty recent results are cached, transient errors are never empty evidence',async()=>{
 const s=createQuery('Main#100',10);await finish(s,service({dense:false,historyEmpty:true}));const mock=service({dense:false,historyEmpty:true}),again=createQuery('Main#100',10,s.result,accountRecords(s));await finish(again,mock);assert.deepEqual(mock.counts,{'/customer/queryMatchList':1});
 const prior=structuredClone(s.result);for(const m of prior.matches)for(const p of m.players)p.res.rankQueriedAt='2000-01-01';for(const p of prior.queryCache.profiles)p.res.rankQueriedAt='2000-01-01';const expired=service({dense:false,historyEmpty:true}),renew=createQuery('Main#100',10,prior,accountRecords(s));await finish(renew,expired);assert.equal(expired.counts['/customer/queryCountInfo'],10);
 const broken=createQuery('Main#100',10),fail=service({dense:false});const raw=fail.call;fail.call=async(e,path,p,b)=>{if(path==='/customer/queryMatchList'&&!['main-private','T0-private'].includes(p.token))throw new Fault('timeout',504);return raw(e,path,p,b);};await assert.rejects(()=>finish(broken,fail),e=>e.status===504);assert.equal(broken.phase,'history-start');assert.ok(Object.values(broken.actors).some(h=>h.phase==='list'));assert.ok(!broken.result);
});
test('old snapshot cache and checkpoint recovery do not expose tokens',async()=>{
 const s=createQuery('Main#100',10),mock=service({dense:false});await queryStep(s,{},mock.call);await queryStep(s,{},mock.call);await queryStep(s,{},mock.call);const recovered=restoreQuery(structuredClone(queryCheckpoint(s)),s.prior);await finish(recovered,mock);assert.ok(!JSON.stringify(recovered.result).includes('private'));assert.equal(recovered.result.matches.length,10);
});

test('version-one browser snapshots and in-flight jobs retain completed games during migration',async()=>{
 const first=createQuery('Main#100',10);await finish(first,service());const old=structuredClone(first.result);delete old.queryCache;old.schemaVersion=1;
 const mock=service(),warm=createQuery(first.tag,10,old);await finish(warm,mock);assert.deepEqual(mock.counts,{'/searchBnetAccount':1,'/customer/queryMatchList':1});
 const migrated=upgradeQuery({tag:first.tag,limit:10,now:first.now,prior:{matches:[]},out:[old.matches[0]],histories:[],tokens:first.tokens}),fetch=service();await finish(migrated,fetch);assert.equal(fetch.details.includes(old.matches[0].mid),false);assert.equal(fetch.details.length,9);assert.ok(!JSON.stringify(migrated.result).includes('private'));
});

test('successful empty rank objects are cached; unknown shapes and network failures remain errors',async()=>{
 for(const response of [{},null,{unexpected:true},{guideCountData:null}]){
  const mock=service({dense:false,historyEmpty:true}),raw=mock.call;
  mock.call=async(e,path,p,b)=>path==='/customer/queryCountInfo'?response:raw(e,path,p,b);
  const s=createQuery('Main#100',10);await finish(s,mock);
  const res=s.result.matches[0].players[0].res;
  assert.equal(!!res.error,response!==null&&Object.keys(response).length===0?false:true);
  if(response&&Object.keys(response).length===0){const again=service({dense:false,historyEmpty:true});await finish(createQuery(s.tag,10,s.result,accountRecords(s)),again);assert.deepEqual(again.counts,{'/customer/queryMatchList':1});}
 }
 const mock=service({dense:false,historyEmpty:true}),raw=mock.call;mock.call=async(e,path,p,b)=>{if(path==='/customer/queryCountInfo')throw new Fault('network failure',502);return raw(e,path,p,b);};
 const s=createQuery('Main#100',10);await finish(s,mock);assert.ok(s.result.matches[0].players[0].res.error);
});


test('main account lookup repairs ASCII case only after provider confirms the complete canonical ID, and survives restart',async()=>{
 const mock=service({newGames:5}),original=mock.call,lookups=[];
 mock.call=async(e,p,q,b)=>{
  if(p==='/searchBnetAccount' && b.name.toLowerCase()==='main#100'){
   lookups.push(b.name);return b.name==='Main#100'?{name:'Main#100',customerToken:'main-private'}:null;
  }
  return original(e,p,q,b);
 };
 const s=createQuery('main#100',5);s.minIntervalMs=0;await queryStep(s,{},mock.call);
 assert.equal(s.accountCaseAttempt,1);assert.equal(s.phase,'account');
 const resumed=restoreQuery(queryCheckpoint(s),s.prior);resumed.minIntervalMs=0;resumed.nextStartAt=0;
 const result=await finish(resumed,mock);
 assert.equal(result.battletag,'Main#100');assert.deepEqual(lookups,['main#100','Main#100']);assert.equal(result.matches.length,5);
});

test('case fallback rejects a different discriminator and bounds requests for unknown players',async()=>{
 const s=createQuery('wrong#100',5),lookups=[];
 const call=async(e,p,q,b)=>{lookups.push(b.name);return b.name==='wrong#100'?null:{name:'Wrong#101',customerToken:'wrong-player-private'};};
 await assert.rejects(finish(s,{call}),/未找到可查询玩家/);
 assert.equal(s.phase,'account');assert.ok(lookups.length<=4);assert.ok(lookups.every(n=>n.endsWith('#100')));
 assert.equal(s.mainToken,undefined);
});
