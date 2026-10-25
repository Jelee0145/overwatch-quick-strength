import {Fault} from '../security.mjs';

// The page draws the timeline from the analysed series it already receives, so the
// duplicate chart view and the archive copy of that series need not cross the wire.
// API consumers keep the documented view unless they explicitly ask for the slim one.
export function webAnalysisView(view){
 const out={...view};
 delete out.chartView;
 // Whole-history statistics are computed from every match, so the page can attach the
 // series it already has; a shorter range keeps its own window slice.
 if(out.statisticsRange==='all'&&out.model&&Array.isArray(out.model.matches)){
  const model={...out.model};delete model.matches;out.model=model;
 }
 // `players` is the side-filtered view of `combatPlayers`; only keep both when a side
 // filter actually removed someone, because the page can read the roster from either.
 if(Array.isArray(out.matches))out.matches=out.matches.map(match=>{
  if(!match||!Array.isArray(match.players)||!Array.isArray(match.combatPlayers))return match;
  if(match.players.length!==match.combatPlayers.length)return match;
  const copy={...match};delete copy.players;return copy;
 });
 return out;
}
export function requireSlimFlag(input){
 if(input.slim!==undefined&&typeof input.slim!=='boolean')throw new Fault('slim 参数无效');
 return input.slim===true;
}
