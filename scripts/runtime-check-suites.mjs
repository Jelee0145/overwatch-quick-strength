import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const resolveDir=path.resolve(import.meta.dirname,'../src');

async function compile(entry){
 const compiled=await build({stdin:{contents:entry,resolveDir},bundle:true,format:'esm',platform:'neutral',write:false});
 return compiled.outputFiles[0].text;
}

async function runWorker(entry,{name,env,exports,dev},run){
 const worker={config:{name,compatibilityDate:'2026-10-12',manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:await compile(entry)}}}}};
 if(env)worker.config.env=env;
 if(exports)worker.config.exports=exports;
 if(dev)worker.dev=dev;
 const mf=new Miniflare({workers:[worker]});
 try{return await run(mf);}finally{await mf.dispose();}
}

export async function fetchSuite(){
 const entry=`import {upstream} from './query/query.mjs';import {callReview} from './adapters/review.mjs';export default {async fetch(){const results={};try{const v=await upstream({DASHEN_TOKEN:'fake-token',DASHEN_ROLE_ID:'fake-role',DASHEN_DTS:'2026',DASHEN_SERVER:'1'},'/searchBnetAccount',null,{name:'Test#123'});results.upstreamOK=!!v.customerToken;}catch(e){results.upstreamError=e.message;}try{const r=await callReview({DEEPSEEK_KEY:'fake-key'},{players:[]},'fingerprint');results.reviewOK=r.text==='native-ok';}catch(e){results.reviewError=e.message;}return Response.json(results);}}`;
 const result=await runWorker(entry,{name:'fetch-test',dev:{outboundService:{type:'fetcher',handler:request=>Response.json(new URL(request.url).hostname==='api.deepseek.com'?{choices:[{message:{content:'native-ok'}}]}:{code:0,data:{customerToken:'fake-token'}})}}},async mf=>{const r=await mf.dispatchFetch('http://test');return r.json();});
 assert.deepEqual(result,{upstreamOK:true,reviewOK:true});
 console.log('Native workerd test passed: Dashen and DeepSeek requests, manual redirect mode.');
}

export async function historySuite(){
 const entry=`import {CloudHistory} from './history/cloud-history.mjs';import {signSnapshot} from './security.mjs';
export class HistoryCheck{constructor(ctx,env){this.history=new CloudHistory(ctx.storage,env);}async fetch(r){const b=await r.json();return Response.json(await this.history.handle('runtime-user',b));}}
export default {async fetch(r,env){const stub=env.HISTORY.get(env.HISTORY.idFromName('runtime-user'));const call=async b=>{const r=await stub.fetch('https://internal/',{method:'POST',body:JSON.stringify(b)});if(!r.ok)throw Error(await r.text());return r.json();};const envelope=await signSnapshot('runtime-user',{battletag:'Runtime#100',queriedAt:'2026-10-15T00:00:00Z',matches:[{mid:'runtime-match',t:1,players:[],payload:'x'.repeat(180000)}]},env);await call({action:'push',envelopes:[envelope]});const list=await call({action:'list'}),page=await call({action:'pull',tag:'Runtime#100'});return Response.json({accounts:list.accounts.length,count:list.accounts[0].count,match:page.envelopes[0].content.data.matches[0].mid,signaturePreserved:page.envelopes[0].signature===envelope.signature,nextCursor:page.nextCursor});}};`;
 const value=await runWorker(entry,{name:'history-runtime-check',env:{CACHE_SIGNING_KEY:{type:'text',value:'synthetic-runtime-key'},DASHEN_SERVER:{type:'text',value:'1'},DASHEN_DTS:{type:'text',value:'2026'},HISTORY:{type:'durable-object',worker:'history-runtime-check',exportName:'HistoryCheck'}},exports:{HistoryCheck:{type:'durable-object',storage:'sqlite'}}},async mf=>{const response=await mf.dispatchFetch('http://runtime/history');return response.json();});
 assert.deepEqual(value,{accounts:1,count:1,match:'runtime-match',signaturePreserved:true,nextCursor:null});
 console.log('Native history runtime passed: SQLite DO transaction, chunked signed archive, HTTP upload/list/pull.');
}

export async function analysisSuite(){
 const baseline=JSON.parse(await readFile(new URL('../test/services-baseline.json',import.meta.url),'utf8'));
 const entry=`import {analyzeResult} from './api/analysis.mjs';
import {renderApiChart} from './api/chart.mjs';
import {selectApiMatch} from './api/match.mjs';
import {analysisService} from './services/runtime.mjs';
import {digest,canonical} from './security.mjs';
import {analysisFixture,archiveFixture} from '../test/services-fixture.mjs';
export default {async fetch(){
 const data={battletag:'Test#123',queriedAt:'2026-10-17T00:00:00Z',matches:[],recentHistory:[]};
 for(let i=0;i<12;i++)data.matches.push({mid:'m'+i,t:100+i,mapGuid:'map',duration:600,hasGameData:true,resourceDataChecked:true,players:Array.from({length:10},(_,j)=>({name:j?'P'+j+'#100':'Test#123',side:j<5?'T':'E',hero:'207165582859042818',stats:{kill:20,assist:8,death:4,heroDamage:10000,cure:0,resistDamage:0,finalHit:10,soloKill:2,targetCompetingTime:20,healingTaken:3000,damageTaken:8000},res:{rows:[{r:'dps',n:'白金',d:3}],rankQueriedAt:'2026-10-17T00:00:00Z'}}))});
 const analysis=analyzeResult(data,{statisticsRange:'all'});
 const picture=await renderApiChart(data,{statisticsRange:'10'},{fetch:async()=>new Response('',{status:404})});
 if(picture.displayed!==10||picture.width!==1440||!picture.svg.startsWith('<svg'))throw Error('Native chart rendering failed');
 if(selectApiMatch(data,1).detail.mid!=='m2'||selectApiMatch(data,10).detail.mid!=='m11')throw Error('Native match selection order failed');
 const hashes=await Promise.all(${JSON.stringify(baseline.cases.map(c=>c.options))}.map(options=>digest(JSON.stringify(analyzeResult(analysisFixture(),options)))));
 const history=analysisService.analyzeHistory(archiveFixture()),summary=analysisService.summarize(history.raw,history.matches,{}, {records:history.personalRecords,excluded:history.personalExcluded});
 return Response.json({display:analysis.matches.length,stats:analysis.statsMatches.length,total:analysis.summary.total,displayLimit:analysis.displayLimit,range:analysis.statisticsRange,version:analysis.version,personal:!!analysis.personalPrediction,hashes,history:await digest(JSON.stringify(history)),historySummary:await digest(JSON.stringify(canonical(summary)))});
}};`;
 const value=await runWorker(entry,{name:'analysis-runtime-check'},async mf=>{const response=await mf.dispatchFetch('http://analysis');return response.json();});
 assert.deepEqual(value,{display:10,stats:12,total:120,displayLimit:10,range:'all',version:'2.6',personal:true,hashes:baseline.cases.map(c=>c.hash),history:baseline.history,historySummary:baseline.historySummary});
 console.log('Native analysis runtime passed: workerd analysis, fixed 10-match window, statistics range, pre-refactor batch/history baselines.');
}

export async function eventsSuite(){
 const {page}=await import('../test/events-fixture.mjs');
 const entry=`export {EventCenter} from './events/center.mjs';export default {async fetch(request,env){const url=new URL(request.url),path=url.pathname,sync=['/sync','/refresh'].includes(path);return env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal'+(sync?path:'/')+url.search,{method:sync?'POST':'GET'});}};`;
 let calls=0;
 await runWorker(entry,{name:'events-runtime-check',env:{EVENTS_CONTACT:{type:'text',value:'https://events.example.test'},EVENTS:{type:'durable-object',worker:'events-runtime-check',exportName:'EventCenter'}},exports:{EventCenter:{type:'durable-object',storage:'sqlite'}},dev:{outboundService:{type:'fetcher',handler:request=>{calls++;assert.equal(new URL(request.url).hostname,'liquipedia.net');assert.match(request.headers.get('User-Agent'),/events\.example\.test/);return Response.json({parse:{text:{'*':page()}}});}}}},async mf=>{
  assert.equal((await mf.dispatchFetch('https://runtime/events')).status,503);assert.equal(calls,0);
  assert.equal((await mf.dispatchFetch('https://runtime/sync')).status,200);
  const responses=await Promise.all(Array.from({length:3},()=>mf.dispatchFetch('https://runtime/events')));
  for(const response of responses){assert.equal(response.status,200);const value=await response.json();assert.equal(value.matches.length,2);assert.equal(value.matches[1].scores[1],0);assert.equal(value.stale,false);}
  await mf.dispatchFetch('https://runtime/sync');assert.equal(calls,1);
  const manual=await mf.dispatchFetch('https://runtime/refresh');assert.equal(manual.status,200);assert.equal((await manual.json()).matches.length,2);assert.equal(calls,1);
  const queued=await mf.dispatchFetch('https://runtime/events?from=2026-10-01&to=2026-10-18');assert.equal(queued.status,202);assert.equal((await queued.json()).state,'pending');assert.equal(calls,1);
 });
 console.log('Native events runtime passed: adaptive background sync, shared manual refresh, read-only GET, durable alarms and bundled parser.');
}

const suites={fetch:fetchSuite,history:historySuite,analysis:analysisSuite,events:eventsSuite};

if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
 const names=process.argv.slice(2),selected=names.length?names:Object.keys(suites);
 for(const name of selected){
  const suite=suites[name];
  if(!suite)throw new Error(`Unknown runtime check suite: ${name}`);
  await suite();
 }
}
