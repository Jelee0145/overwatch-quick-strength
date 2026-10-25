import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createDataService} from '../src/services/data.mjs';
import * as historyGeometry from '../src/services/history-geometry.mjs';
import {webAnalysisView,requireSlimFlag} from '../src/history/view.mjs';

const source=await readFile(new URL('../web/history-model.js',import.meta.url),'utf8');
const context=vm.createContext({OWQS_SERVICES:{data:createDataService(),historyGeometry}});
vm.runInContext(source,context);
const H=context.QS_HISTORY_MODEL;

const match=(mid)=>({mid,t:1,players:[],known:[]});
const view=(statisticsRange='all')=>({
 version:1,revision:'a'.repeat(64),tag:'Main#100',scope:{server:'1',dts:'2026'},options:{statisticsRange},window:{start:1,end:2},
 matches:[match('a'),match('b')],
 model:{schemaVersion:1,battletag:'Main#100',matches:[match('a'),match('b')]},
 chartView:{matches:[match('b')],statsMatches:[match('a'),match('b')]},
 statisticsRange,statisticsLabel:'全部历史 · 2 场',raw:{matches:[]}
});

test('slim views ship one window of detail plus a light index of the archive',()=>{
 const full=view();const slim=webAnalysisView(full);
 assert.equal(JSON.stringify(slim).includes('chartView'),false);
 assert.equal(slim.series.length,2,'one light row per analysed match');
 assert.deepEqual(slim.series.map(row=>row.mid),['a','b']);
 assert.equal(slim.series[0].players.length,0);
 assert.equal(slim.matches.length,1,'only the visible window ships detail');
 assert.equal(slim.matches[0].mid,'b');
 assert.equal(slim.matches[0].light,undefined,'window rows are detailed');
 assert.equal(slim.model.matches,undefined,'the page attaches the analysed slice itself');
 assert.equal(full.model.matches.length,2,'the analysed view itself is not mutated');
 assert.equal(full.chartView.matches.length,1);
 const short=webAnalysisView(view('5'));
 assert.equal(short.matches.length,1);
 assert.equal(JSON.stringify(short).includes('chartView'),false);
});

test('slim is opt-in and must be boolean',()=>{
 assert.equal(requireSlimFlag({}),false);
 assert.equal(requireSlimFlag({slim:true}),true);
 assert.throws(()=>requireSlimFlag({slim:'yes'}),/slim 参数无效/);
 assert.throws(()=>requireSlimFlag({slim:1}),/slim 参数无效/);
});

test('a window step asks the server only for windows whose detail is missing',()=>{
 const detailed=(mid)=>({mid,players:[],known:[]});
 const light=(mid)=>({mid,players:[],known:[],light:true});
 const analysis={tag:'Main#100',statisticsRange:'all',window:{start:0,end:10},matches:Array.from({length:118},(_,i)=>detailed('m'+i))};
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','all',analysis.matches,0),false,'the window is already detailed');
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','all',analysis.matches,10),false,'any loaded window is reused');
 const sparse=analysis.matches.map((match,index)=>index<10?match:light(match.mid));
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','all',sparse,10),true,'detail for another window is fetched');
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','all',sparse,0),false);
 assert.equal(H.windowNeedsAnalysis(analysis,'Other#1','all',analysis.matches,0),true,'another account needs its own analysis');
 assert.equal(H.windowNeedsAnalysis(null,'Main#100','all',[],0),true);
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100','20',analysis.matches,0),true,'a window-end range still needs the server');
 assert.equal(H.windowNeedsAnalysis(analysis,'Main#100',undefined,analysis.matches,0),false);
});
