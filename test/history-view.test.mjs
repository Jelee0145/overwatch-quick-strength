import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createDataService} from '../src/services/data.mjs';
import * as historyGeometry from '../src/services/history-geometry.mjs';
import {webAnalysisView,requireSlimFlag} from '../src/application/history-view.mjs';

const source=await readFile(new URL('../web/history-model.js',import.meta.url),'utf8');
const context=vm.createContext({OWQS_SERVICES:{data:createDataService(),historyGeometry}});
vm.runInContext(source,context);
const H=context.QS_HISTORY_MODEL;

const match=(mid)=>({mid,t:1,players:[],known:[]});
const view=(statisticsRange='all')=>({
 version:1,revision:'a'.repeat(64),tag:'Main#100',scope:{server:'1',dts:'2026'},options:{statisticsRange},
 matches:[match('a'),match('b')],
 model:{schemaVersion:1,battletag:'Main#100',matches:[match('a'),match('b')]},
 chartView:{matches:[match('b')],statsMatches:[match('a'),match('b')]},
 statisticsRange,statisticsLabel:'全部历史 · 2 场',raw:{matches:[]}
});

test('slim views drop the duplicated chart view and the archive copy of the series',()=>{
 const full=view();const slim=webAnalysisView(full);
 assert.equal(JSON.stringify(slim).includes('chartView'),false);
 assert.equal(slim.matches.length,2);
 assert.equal(slim.model.matches,undefined,'whole-history statistics reuse the analysed series');
 assert.equal(full.model.matches.length,2,'the analysed view itself is not mutated');
 assert.equal(full.chartView.matches.length,1);
 const short=webAnalysisView(view('5'));
 assert.equal(short.model.matches.length,2,'a shorter range keeps its own window slice');
 assert.equal(JSON.stringify(short).includes('chartView'),false);
});

test('slim is opt-in and must be boolean',()=>{
 assert.equal(requireSlimFlag({}),false);
 assert.equal(requireSlimFlag({slim:true}),true);
 assert.throws(()=>requireSlimFlag({slim:'yes'}),/slim 参数无效/);
 assert.throws(()=>requireSlimFlag({slim:1}),/slim 参数无效/);
});

test('window moves reuse the loaded analysis only for whole-history statistics',()=>{
 const analysis={tag:'Main#100',statisticsRange:'all',window:{start:0,end:10},matches:Array.from({length:118},(_,i)=>match('m'+i))};
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','all'),false);
 assert.equal(H.windowNeedsAnalysis(analysis,'Other#1','all'),true,'another account needs its own analysis');
 assert.equal(H.windowNeedsAnalysis(null,'Main#100','all'),true);
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','20'),true,'a window-end range still needs the server');
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100',undefined),false);
});