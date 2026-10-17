import './shared/core.js';
import './shared/benchmarks.js';
import './shared/rating-rules.js';
import './shared/resource-rating.js';
import './shared/performance.js';
import {heroes} from './shared/data.mjs';

const RANGES=new Set(['all','5','10','20']);
const SIDES=new Set(['all','T','E']);
const STRATEGIES=new Set(['legacy','role','highest']);

// The public Bot API reports the same analysis the cloud chart builds: the
// visible window stays fixed at 10 matches, while the statistics range can be
// widened to all retained matches or narrowed to 5/10/20.
export function analyzeResult(data,options={}){
 const QS=globalThis.QS,performance=globalThis.QS_PERFORMANCE;
 if(!QS?.build||!QS?.summarize||!performance?.evaluate)throw new Error('分析模块未加载');
 const raw=QS.normalize(data),common={side:SIDES.has(options.side)?options.side:'all',strategy:STRATEGIES.has(options.strategy)?options.strategy:'legacy',estimate:options.estimate!==false};
 const evaluate=(p,m)=>performance.evaluate(p,m,heroes,globalThis.QS_BENCHMARKS);
 const all=QS.build(raw,{...common,limit:50},heroes,evaluate).matches,end=all.length;
 const selection=RANGES.has(String(options.statisticsRange))?String(options.statisticsRange):'all';
 const start=selection==='all'?0:Math.max(0,end-Number(selection)),statsMatches=all.slice(start,end);
 const shown=new Set(statsMatches.map(m=>m.mid)),context={...raw,matches:raw.matches.filter(m=>shown.has(m.mid))};
 const analysis=QS.summarize(context,statsMatches,{...common,limit:statsMatches.length},heroes,evaluate);
 const windowStart=Math.max(0,end-10),chartMatches=all.slice(windowStart,end);
 return {version:analysis.algorithmVersion,options:analysis.options,summary:analysis.summary,confidence:analysis.confidence,personalPrediction:analysis.personalPrediction,matches:chartMatches,statsMatches,windowOffset:windowStart,displayLimit:10,statisticsRange:selection,statisticsLabel:(selection==='all'?'全部历史':'窗口末尾向前')+' · '+statsMatches.length+' 场'};
}
