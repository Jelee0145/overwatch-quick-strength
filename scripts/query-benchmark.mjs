import {createQuery,queryStep,accountRecords} from '../src/query/query.mjs';import {service} from '../test/query-fixture.mjs';import {mkdir,writeFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const baseline=process.argv.find(x=>x.startsWith('--baseline='))?.slice(11)||'571a7df';
await mkdir(new URL('../.private/query-baseline/',import.meta.url),{recursive:true});
for(const name of ['query.mjs','security.mjs'])await writeFile(new URL('../.private/query-baseline/'+name,import.meta.url),execFileSync('git',['show',baseline+':src/'+name],{cwd:new URL('..',import.meta.url),encoding:'utf8',maxBuffer:5000000}));
const before=await import('../.private/query-baseline/query.mjs');
const results=[];const delay=50,measuredScheduler=process.argv.includes('--scheduler');
async function measure(dense,version,run){
 const engine=version==='before'?before:{createQuery,queryStep};let accounts=[],prior;
 for(const scenario of ['cold','warm','five-new']){
  const s=engine.createQuery('Main#100',10,prior,accounts),start=performance.now();let steps=0;
  // --scheduler measures the old one-second alarm gaps as real waits.
  const calls=service({dense,delay,added:scenario==='five-new'?5:0});
  let engineMs=0;
  for(;s.phase!=='done'&&steps<300;steps++){if(version==='before'&&measuredScheduler&&steps)await new Promise(r=>setTimeout(r,1000));const at=performance.now();await engine.queryStep(s,{},calls.call);engineMs+=performance.now()-at;}
  if(s.phase!=='done')throw Error('Benchmark did not finish');
  const entry={version,dense,scenario,run,engineMs:Math.round(engineMs),wallMs:Math.round(performance.now()-start),requests:Object.values(calls.counts).reduce((a,b)=>a+b,0),detailCalls:calls.counts['/customer/queryMatchInfo']||0,maxConcurrent:calls.active.max,schedulerWaitMs:version==='before'?Math.max(0,steps-1)*1000:0};
  results.push(entry);prior=s.result;if(version==='after')accounts=accountRecords(s);
 }
}
const work=[];for(const dense of [true,false])for(const version of ['before','after'])for(let run=1;run<=5;run++)work.push(measure(dense,version,run));await Promise.all(work);
await writeFile(new URL('../.private/query-benchmark.json',import.meta.url),JSON.stringify({latencyMs:delay,runs:5,newRequestIntervalMs:500,measuredScheduler,notes:measuredScheduler?'wallMs includes measured old alarm gaps and new request pacing; each run has an independent mocked provider, runs are concurrent':'engineMs includes real request pacing; schedulerWaitMs is calculated, not a real wait',results},null,2));
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
for(const dense of [true,false])for(const scenario of ['cold','warm','five-new']){const summary={dense,scenario};for(const v of ['before','after']){const rows=results.filter(r=>r.dense===dense&&r.scenario===scenario&&r.version===v);summary[v]={requests:median(rows.map(r=>r.requests)),engineMs:median(rows.map(r=>r.engineMs)),wallMs:median(rows.map(r=>r.wallMs)),schedulerWaitMs:median(rows.map(r=>r.schedulerWaitMs))};}console.log(JSON.stringify(summary));}
