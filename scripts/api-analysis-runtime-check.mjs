import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
const entry=`import {analyzeResult} from './api-analysis.mjs';
export default {async fetch(){
 const data={battletag:'Test#123',queriedAt:'2026-10-17T00:00:00Z',matches:[],recentHistory:[]};
 for(let i=0;i<12;i++)data.matches.push({mid:'m'+i,t:100+i,mapGuid:'map',duration:600,hasGameData:true,resourceDataChecked:true,players:Array.from({length:10},(_,j)=>({name:j?'P'+j+'#100':'Test#123',side:j<5?'T':'E',hero:'207165582859042818',stats:{kill:20,assist:8,death:4,heroDamage:10000,cure:0,resistDamage:0,finalHit:10,soloKill:2,targetCompetingTime:20,healingTaken:3000,damageTaken:8000},res:{rows:[{r:'dps',n:'白金',d:3}],rankQueriedAt:'2026-10-17T00:00:00Z'}}))});
 const analysis=analyzeResult(data,{statisticsRange:'all'});
 return Response.json({display:analysis.matches.length,stats:analysis.statsMatches.length,total:analysis.summary.total,displayLimit:analysis.displayLimit,range:analysis.statisticsRange,version:analysis.version,personal:!!analysis.personalPrediction});
}};`;
const compiled=await build({stdin:{contents:entry,resolveDir:path.resolve(import.meta.dirname,'../src')},bundle:true,format:'esm',platform:'neutral',write:false});
const mf=new Miniflare({workers:[{config:{name:'analysis-runtime-check',compatibilityDate:'2026-10-12',manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:compiled.outputFiles[0].text}}}}}]});
try{const response=await mf.dispatchFetch('http://analysis'),value=await response.json();assert.deepEqual(value,{display:10,stats:12,total:120,displayLimit:10,range:'all',version:'2.6',personal:true});console.log('Native analysis runtime passed: workerd analysis, fixed 10-match window, statistics range.');}finally{await mf.dispose();}
