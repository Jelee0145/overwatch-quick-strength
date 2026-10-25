import {Fault} from '../security.mjs';

// The page only draws one ten-match window at a time, so the wire carries that window's
// detail plus a light index of the whole archive (for the strength line, the axis and the
// rank histogram). API consumers keep the documented full view.
const LIGHT=['mid','t','ret','duration','mapGuid','mapName','mean','observedMean','estimateSource','estimateRange','roleRange','allRoleRange','allRoleScores','scores','confidenceEvidence'];
const light=(match)=>{const out={light:true,known:[],players:[]};for(const key of LIGHT)if(match&&match[key]!==undefined)out[key]=match[key];return out;};
const windowTag=(match)=>{const copy={...match};delete copy.players;return copy;};

export function webAnalysisView(view){
 const out={...view};
 delete out.chartView;
 // Per-match personal evidence is for API consumers; the page renders the server summary.
 delete out.personalRecords;delete out.personalExcluded;
 const matches=Array.isArray(view.matches)?view.matches:[];
 const start=view.window?.start??0,end=view.window?.end??matches.length;
 // One light row per analysed match keeps totals, window maths and the histogram intact.
 out.series=matches.map(light);
 // Only the visible window ships full detail; `players` is the side-filtered view of
 // `combatPlayers`, so keep one copy whenever no side filter removed anyone.
 out.matches=matches.slice(start,end).map(match=>{
  if(!match||!Array.isArray(match.players)||!Array.isArray(match.combatPlayers))return match;
  if(match.players.length!==match.combatPlayers.length)return match;
  return windowTag(match);
 });
 if(out.model&&Array.isArray(out.model.matches)){const model={...out.model};delete model.matches;out.model=model;}
 if(out.raw&&Array.isArray(out.raw.matches)){
  const ids=new Set(out.matches.map(match=>match.mid));
  out.raw={...out.raw,matches:out.raw.matches.filter(match=>ids.has(match.mid))};
 }
 return out;
}

export function requireSlimFlag(input){
 if(input.slim!==undefined&&typeof input.slim!=='boolean')throw new Fault('slim 参数无效');
 return input.slim===true;
}