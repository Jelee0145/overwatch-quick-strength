import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {createAnalysisEncoder,negotiateEncoding} from '../server/analysis-encoding.mjs';
import {analyzeArchive,analyzeCachedArchive,historyComputationCache,selectArchiveMatch} from '../src/application/history-analysis.mjs';
import {createResponseCache} from '../src/application/history-cache.mjs';
import {webAnalysisView} from '../src/application/history-view.mjs';
import {archiveFixture} from './services-fixture.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('slim keeps visible stats, numeric rank ticks, selected roster and exact histogram without source evidence',async()=>{
 const full=await analyzeArchive(archiveFixture(),{side:'E',statisticsRange:'5'}),before=JSON.stringify(full),slim=webAnalysisView(full);
 assert.equal(slim.matchRefs.length,10);assert.ok(slim.series.every(m=>!('scores' in m)&&!('allRoleScores' in m)));
 assert.deepEqual(slim.model.histogram,full.model.matches.flatMap(m=>m.scores).reduce((bins,v)=>{bins[Math.min(44,Math.max(0,Math.floor((v-500)/100)))]++;return bins;},Array(45).fill(0)));
 for(const [i,m] of slim.matches.entries()){
  const original=full.matches[full.window.start+i];
  assert.deepEqual(m.known,original.known.map(p=>p.score));
  assert.deepEqual(m.playerIndices.map(i=>m.combatPlayers[i].name),original.players.map(p=>p.name));
  for(const p of m.combatPlayers){assert.equal(p.res,undefined);assert.equal(p.performance.metrics,undefined);assert.equal(Object.keys(p.stats).length,11);}
 }
 assert.equal(JSON.stringify(full),before);
});

test('object cache reuses scoring across windows and ranges but isolates identities, revisions and scoring options',async()=>{
 historyComputationCache.clear();const archive=archiveFixture();let loads=0;
 const load=async()=>{loads++;return archive;};
 for(const options of [{start:0,statisticsRange:'5'},{start:5,statisticsRange:'10'},{start:10,statisticsRange:'20'}]){
  const actual=await analyzeCachedArchive(load,options,'owner|scope|revision'),expected=await analyzeArchive(archive,options);assert.deepEqual(actual,expected);
 }
 assert.equal(loads,1);
 await analyzeCachedArchive(load,{side:'E'},'owner|scope|revision');assert.equal(loads,2);
 await analyzeCachedArchive(load,{},'other-owner|scope|revision');assert.equal(loads,3);
 for(let i=0;i<20;i++)await analyzeCachedArchive(load,{},'revision-'+i);
 assert.ok(historyComputationCache.stats().entries<=4);assert.ok(historyComputationCache.stats().bytes<=32*1024*1024);
 await assert.rejects(analyzeCachedArchive(load,{revision:'0'.repeat(64)},'revision-19'),e=>e.status===409);
 historyComputationCache.clear();
});

test('compact object cache produces the same web summary and evidence as full analysis',async()=>{
 historyComputationCache.clear();const archive=archiveFixture();
 for(const options of [{strategy:'role',side:'all',statisticsRange:'all'},{strategy:'role',side:'all',statisticsRange:'5',start:0},{strategy:'role',side:'E',statisticsRange:'20',start:5}]){
  const cached=webAnalysisView(await analyzeCachedArchive(async()=>archive,options,'compact-owner',{slim:true})),full=webAnalysisView(await analyzeArchive(archive,options));
  assert.deepEqual(cached,full);
 }
 historyComputationCache.clear();
});

test('on-demand web detail evaluates only its source batch and keeps the complete player evidence',async()=>{
 const archive=archiveFixture(),options={strategy:'role',side:'E'},full=await selectArchiveMatch(archive,'fixture-9',options),slim=await selectArchiveMatch(archive,'fixture-9',options,{slim:true});
 assert.deepEqual(slim.match,full.match);assert.deepEqual(slim.ref,full.ref);assert.equal(slim.raw,undefined);assert.equal(slim.detail,undefined);
 assert.ok(slim.match.players[0].performance.metrics.length>0);
});

test('encoded cache honors quality/identity exclusions and round trips gzip and brotli with bounded LRU',async()=>{
 for(const [header,expected] of [['','identity'],['gzip','gzip'],['br, gzip','br'],['gzip;q=0,br;q=0','identity'],['gzip;q=.8,br;q=.2','gzip'],['br;q=.5,identity;q=1','identity'],['*;q=0',null],['identity;q=0,gzip;q=0,br;q=0',null],['*;q=.5','br'],['gzip;q=bad','identity']])assert.equal(negotiateEncoding(header),expected,header);
 const body=Buffer.from(JSON.stringify({text:'历史数据'.repeat(100)})),cache=createAnalysisEncoder({bytes:4000,entries:2});
 for(const encoding of ['gzip','br']){
  const first=await cache.encode(body,encoding),again=await cache.encode(body,encoding);assert.equal(first,again);
  assert.deepEqual(encoding==='gzip'?gunzipSync(first):brotliDecompressSync(first),body);
 }
 for(let i=0;i<20;i++)await cache.encode(Buffer.from('response-'+i),'gzip');
 assert.ok(cache.stats().entries<=2);assert.ok(cache.stats().bytes<=4000);
 const unicode=createResponseCache({bytes:6});unicode.set('a','中文');unicode.set('b','字');assert.equal(unicode.get('a'),null);assert.equal(unicode.stats().bytes,3);
});

test('desktop/mobile share in-flight analysis and detail; twenty windows retain a bounded offline/memory set',async()=>{
 const wire=webAnalysisView(await analyzeArchive(archiveFixture())),stored=new Map();let calls=0,detailCalls=0;
 const window={addEventListener(){}},context=vm.createContext({window,Cloud:{boot:async()=>({user:{id:'u'},scope:{server:'1',dts:'2026'}}),storage:async(key,value)=>value===undefined?stored.get(key):stored.set(key,structuredClone(value)),api:async(path)=>{
  if(path.endsWith('/detail')){detailCalls++;return {match:{players:[]}};}
  calls++;return structuredClone(wire);
 }}});
 vm.runInContext(await readFile(new URL('../web/server-analysis.js',import.meta.url),'utf8'),context);
 const client=window.OWQS_SERVER_ANALYSIS,[desktop,mobile]=await Promise.all([client.load(wire.tag),client.load(wire.tag)]);
 assert.equal(calls,1);assert.equal(desktop,mobile);assert.equal(desktop.matches.length,wire.series.length);
 assert.equal(desktop.matches.at(-1).players[0],desktop.matches.at(-1).combatPlayers[0]);
 await Promise.all([client.detail(wire.matchRefs[0]),client.detail(wire.matchRefs[0])]);assert.equal(detailCalls,1);
 for(let start=0;start<20;start++)await client.load(wire.tag,{start});
 assert.equal(Object.keys([...stored.values()][0].entries).length,3);
 const before=calls;await client.load(wire.tag,{start:19});assert.equal(calls,before);
 await client.load(wire.tag,{start:0});assert.equal(calls,before+1,'evicted windows are no longer retained in memory');
});
