import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const baseline=JSON.parse(await readFile(new URL('../test/services-baseline.json',import.meta.url),'utf8'));
const entry=`import {analyzeResult} from './api-analysis.mjs';
import {renderApiChart} from './api-chart.mjs';
import {selectApiMatch} from './api-match.mjs';
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
const compiled=await build({stdin:{contents:entry,resolveDir:path.resolve(import.meta.dirname,'../src')},bundle:true,format:'esm',platform:'neutral',write:false});
const mf=new Miniflare({workers:[{config:{name:'analysis-runtime-check',compatibilityDate:'2026-10-12',manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:compiled.outputFiles[0].text}}}}}]});
try{const response=await mf.dispatchFetch('http://analysis'),value=await response.json();assert.deepEqual(value,{display:10,stats:12,total:120,displayLimit:10,range:'all',version:'2.6',personal:true,hashes:baseline.cases.map(c=>c.hash),history:baseline.history,historySummary:baseline.historySummary});console.log('Native analysis runtime passed: workerd analysis, fixed 10-match window, statistics range, pre-refactor batch/history baselines.');}finally{await mf.dispose();}
