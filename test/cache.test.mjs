import {test} from 'node:test';import assert from 'node:assert/strict';
import {createQuery,runQuery,ingestCache,accountRecords} from '../src/query/query.mjs';import {cacheEntries,mintCacheRecords,verifyCacheRecord,cleanManifest} from '../src/query/cache-records.mjs';import {service} from './query-fixture.mjs';
const env={CACHE_SIGNING_KEY:'test-only',DASHEN_SERVER:'1',DASHEN_DTS:'2026'};
const manifest=records=>records.map(r=>({type:r.content.type,key:r.content.key,names:r.content.names,updatedAt:r.content.updatedAt}));
async function finish(s,mock,records=[]){for(let i=0;s.phase!=='done'&&i<150;i++){await runQuery(s,env,{call:mock.call,minIntervalMs:0,budgetMs:50});if(s.cacheRequest){const wanted=new Set(s.cacheRequest.keys.map(k=>k.type+'|'+k.key));const entries=[];for(const r of records)if(wanted.has(r.content.type+'|'+r.content.key))entries.push(await verifyCacheRecord(r,'u',env));ingestCache(s,entries);}}assert.equal(s.phase,'done');return s.result;}
function thirty(){const mock=service(),base=mock.call;mock.call=async(e,path,p,b)=>{const v=await base(e,path,p,b);if(path==='/customer/queryMatchInfo'){const n=Number(p.matchId.slice(1));let index=0;for(const key of ['teammateList','enemyList'])for(const person of v[key]){const i=index++===0?0:1+(n*3+index-2)%29;person.name=i?'P'+i+'#100':'Main#100';person.customerToken='player-'+i+'-private';}}return v;};return mock;}
test('query count bounds latest list range; three new games within ten fetch only three, fully cached five fetch none',async()=>{
 const first=createQuery('Main#100',20,undefined,[],{supplementOtherMatches:false});await finish(first,service({newGames:20}));const oldRecords=await mintCacheRecords('u',first.result,env);
 const second=createQuery(first.tag,10,undefined,accountRecords(first),{supplementOtherMatches:false,cacheManifest:manifest(oldRecords)}),next=service({newGames:20,added:3});await finish(second,next,oldRecords);
 assert.equal(second.result.matches.length,10);assert.equal(next.details.length,3);assert.ok(next.details.every(mid=>mid.startsWith('added')));assert.equal(second.result.syncStatus.reusedMatches,7);assert.equal(next.counts['/customer/queryCountInfo']||0,0);assert.equal(second.historyCalls,0);
 const records=await mintCacheRecords('u',second.result,env),third=createQuery(first.tag,5,undefined,accountRecords(second),{supplementOtherMatches:false,cacheManifest:manifest(records)}),hot=service({newGames:20,added:3});await finish(third,hot,records);assert.equal(third.result.matches.length,5);assert.equal(hot.details.length,0);assert.equal(third.result.syncStatus.reusedMatches,5);assert.equal(hot.counts['/customer/queryCountInfo']||0,0);
});
test('fast ten games have 100 slots, 30 unique players and exactly 30 rank requests; twenty cached leaves ten',async()=>{
 const first=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false}),mock=thirty();await finish(first,mock);assert.equal(first.result.syncStatus.playerSlots,100);assert.equal(first.result.syncStatus.uniquePlayers,30);assert.equal(mock.counts['/customer/queryCountInfo'],30);assert.equal(first.historyCalls,0);
 const records=(await mintCacheRecords('u',first.result,env)).filter(r=>r.content.type==='profile').slice(0,20),again=createQuery(first.tag,10,undefined,[],{supplementOtherMatches:false,cacheManifest:manifest(records)}),next=thirty();await finish(again,next,records);assert.equal(next.counts['/customer/queryCountInfo'],10);assert.equal(again.rankReused,20);assert.equal(next.details.length,10);
});
test('fast never supplements; slow references are reused by fast without querying any outside player',async()=>{
 const slow=createQuery('Main#100',10),mock=service({dense:false});await finish(slow,mock);assert.ok(slow.historyCalls>0);const fast=createQuery(slow.tag,10,slow.result,accountRecords(slow),{supplementOtherMatches:false}),next=service({dense:false});await finish(fast,next);assert.deepEqual(next.counts,{'/customer/queryMatchList':1});assert.ok(fast.result.recentHistory.length>0);assert.equal(fast.historyCalls,0);
 const empty=createQuery(slow.tag,10,undefined,[],{supplementOtherMatches:false}),cold=service({dense:false});await finish(empty,cold);assert.equal(cold.details.length,10);assert.equal(empty.historyCalls,0);assert.equal(empty.histories.length,0);
});
test('cross-account signed battles reuse all details despite metadata changes and convert perspective',async()=>{
 const s=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false});await finish(s,service());const records=await mintCacheRecords('u',s.result,env),mock=service(),base=mock.call;
 mock.call=async(e,path,p,b)=>{if(path==='/customer/queryMatchList')return {matchList:s.result.matches.map(m=>({matchId:m.mid,beginTs:m.t*1000,matchRet:-1,mapGuid:'renamed-map'}))};return base(e,path,p,b);};
 const next=createQuery('E0#100',10,undefined,accountRecords(s),{supplementOtherMatches:false,cacheManifest:manifest(records)});await finish(next,mock,records);assert.equal(mock.details.length,0);assert.equal(next.reused,10);assert.equal(mock.counts['/customer/queryCountInfo']||0,0);for(const m of next.result.matches){assert.equal(m.players.find(p=>p.name==='E0#100').side,'T');assert.equal(m.teamScore,0);assert.equal(m.ret,-1);assert.equal(m.mapGuid,'renamed-map');}
});
test('same provider identity with different display names and heroes still only queries ranks once',async()=>{
 const mock=service(),base=mock.call;mock.call=async(e,path,p,b)=>{const v=await base(e,path,p,b);if(path==='/customer/queryMatchInfo'&&Number(p.matchId.slice(1))%2){v.teammateList[1].name='Renamed#101';v.teammateList[1].heroGuid='another-hero';}return v;};const s=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false});await finish(s,mock);assert.equal(mock.counts['/customer/queryCountInfo'],10);assert.equal(s.result.syncStatus.uniquePlayers,10);assert.ok(!JSON.stringify(s.result).includes('-private'));
});

test('rotating customer tokens for one exact tag do not inflate unique players or independent profile records',async()=>{
 const mock=service(),base=mock.call;mock.call=async(e,path,p,b)=>{const v=await base(e,path,p,b);if(path==='/customer/queryMatchInfo')for(const person of [...v.teammateList,...v.enemyList])person.customerToken+='-'+p.matchId;return v;};const s=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false});await finish(s,mock);assert.equal(s.result.syncStatus.uniquePlayers,10);assert.equal(s.rankRequests,10);assert.equal(s.rankReused,0);const records=await mintCacheRecords('u',s.result,env);assert.equal(records.filter(r=>r.content.type==='profile').length,10);
});
test('signed cache binds user, season, server, type and payload; manifest never grants trust',async()=>{
 const s=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false});await finish(s,service());const record=(await mintCacheRecords('u',s.result,env))[0];await assert.rejects(()=>verifyCacheRecord(record,'other',env));await assert.rejects(()=>verifyCacheRecord(record,'u',{...env,DASHEN_SERVER:'2'}));await assert.rejects(()=>verifyCacheRecord(record,'u',{...env,DASHEN_DTS:'2025'}));const changed=structuredClone(record);changed.content.value.game.players[0].stats.kill=999;await assert.rejects(()=>verifyCacheRecord(changed,'u',env));assert.deepEqual(cleanManifest([{type:'match',key:'__proto__'}]),[]);
 const expired=await mintCacheRecords('u',{...s.result,matches:[],queryCache:{profiles:[{name:'Main#100',res:{rows:[],rankQueriedAt:'2000-01-01'}}]}},env),next=createQuery(s.tag,10,undefined,[],{supplementOtherMatches:false,cacheManifest:manifest(expired)}),mock=service();await finish(next,mock,expired);assert.equal(mock.counts['/customer/queryCountInfo'],10);
});
test('quick-play pool keeps only the chosen roster size and records the mode',async()=>{
 const mock=service({mixedModes:true}),s=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false,pool:'66'});await finish(s,mock);
 assert.ok(s.result.matches.length>0);
 assert.ok(s.result.matches.every(m=>m.gameMode==='Leisure6v6'),JSON.stringify(s.result.matches.map(m=>m.gameMode)));
 assert.ok(mock.details.every(mid=>Number(mid.slice(1))%2===1),JSON.stringify(mock.details));
 const five=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false,pool:'55'}),again=service({mixedModes:true});await finish(five,again);
 assert.ok(five.result.matches.every(m=>m.gameMode==='LeisurePreset'));
 assert.ok(again.details.every(mid=>Number(mid.slice(1))%2===0));
 const all=createQuery('Main#100',10,undefined,[],{supplementOtherMatches:false}),both=service({mixedModes:true});await finish(all,both);
 assert.equal(all.result.matches.length,10);
});
