(function(root){
'use strict';
const bands=['青铜','白银','黄金','白金','翡翠','钻石','大师','宗师','英杰'];
const bases={0:500,1:1000,2:1500,3:2000,8:2500,4:3000,5:3500,6:4000,7:4500};
const roles={tank:'重装',dps:'输出',healer:'支援',open:'开放职责'};
const states={no_record:'无竞技记录',not_ranked:'未定级',role_missing:'缺少对应职责',unknown_role:'英雄职责未知',invalid_score:'段位格式未识别',query_error:'查询失败',known:'当前赛季',previous:'回退赛季',imported:'导入强度值'};
const statKeys=['kill','assist','death','heroDamage','cure','resistDamage','finalHit','soloKill','targetCompetingTime','healingTaken','damageTaken'];
const nonnegative=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
const role=r=>r==='support'?'healer':String(r||'').toLowerCase();
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function compact(v){if(v===null||v===''||typeof v==='boolean')return null;const n=Number(v);if(!Number.isInteger(n)||n<=0)return null;const id=Math.floor(n/100),s=n%100;return bases[id]!==undefined&&s>=95&&s<=99?bases[id]+(s-95)*100:null;}
const namedBases={bronze:500,'青铜':500,silver:1000,'白银':1000,gold:1500,'黄金':1500,platinum:2000,platium:2000,'白金':2000,'铂金':2000,emerald:2500,'翡翠':2500,diamond:3000,'钻石':3000,master:3500,'大师':3500,grandmaster:4000,gm:4000,'宗师':4000,champion:4500,'英杰':4500,'冠军':4500};
function rowStrength(row){
 const name=String(row.n||'').trim().toLowerCase(),base=Object.hasOwn(namedBases,name)?namedBases[name]:undefined,d=row.d;
 if(base!==undefined&&d!==null&&d!==undefined&&d!==''&&typeof d!=='boolean'&&Number.isInteger(Number(d))&&Number(d)>=1&&Number(d)<=5)return base+(5-Number(d))*100;
 const s=row.s,n=Number(s);
 if(base===2500&&s!==null&&s!==''&&typeof s!=='boolean'&&Number.isInteger(n)&&n>=445&&n<=449)return 2500+(n-445)*100;
 return compact(s);
}
function rank(v){if(!Number.isFinite(v)||v<500)return '无有效样本';const i=Math.min(8,Math.floor((v-500)/500));return bands[i]+Math.max(1,5-Math.floor((v-(500+i*500))/100));}
function normalize(raw){
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.matches)||raw.matches.length>50)throw Error('JSON 必须包含 matches 数组，最多 50 场');
 const matches=raw.matches.map((m,i)=>{
  const list=m.players??m.rows;if(!Array.isArray(list)||list.length>30)throw Error(`第 ${i+1} 场缺少 players/rows 数组，或人数超过 30`);
  const players=list.map(p=>{
   if(!p||typeof p!=='object')throw Error('玩家记录必须为对象');
   const cleanRows=rows=>(Array.isArray(rows)?rows:[]).slice(0,20).map(r=>({r:role(r.r??r.roleType),s:r.s??r.lastRankInfo?.rankScore??null,n:String(r.n??r.lastRankInfo?.rankName??'').slice(0,40),d:nonnegative(r.d??r.rankSubTier??r.lastRankInfo?.rankSubTier),season:String(r.season??'').slice(0,20)}));
   const score=p.score!==null&&p.score!==undefined?Number(p.score):null;
   return {name:String(p.name??'匿名玩家').slice(0,100),side:p.side==='E'?'E':'T',hero:String(p.hero??p.heroGuid??'').slice(0,80),role:role(p.role),stats:Object.fromEntries(statKeys.map(k=>[k,nonnegative(p.stats?.[k])])),score:score!==null&&Number.isFinite(score)&&score>=500&&score<=4900?score:null,res:{rows:cleanRows(p.res?.rows),previousRows:cleanRows(p.res?.previousRows),sourceSeason:String(p.res?.sourceSeason||'').slice(0,20),error:!!p.res?.error||p.status==='query_error',previousError:!!p.res?.previousError,rankQueriedAt:String(p.res?.rankQueriedAt||'').slice(0,80)}};
  });
  return {dataQueriedAt:String(m.dataQueriedAt||'').slice(0,80),hasGameData:!!m.hasGameData,resourceDataChecked:!!m.resourceDataChecked,duration:nonnegative(m.duration),teamScore:nonnegative(m.teamScore),opponentScore:nonnegative(m.opponentScore),mid:String(m.mid??m.matchId??`import-${i}`).slice(0,100),t:Number(m.t??m.beginTs)||0,ret:[-1,0,1].includes(Number(m.ret??m.matchRet))?Number(m.ret??m.matchRet):0,mapGuid:String(m.mapGuid??'').slice(0,80),mapName:String(m.mapName??'').slice(0,100),players};
 });
 const recentHistory=(Array.isArray(raw.recentHistory)?raw.recentHistory:[]).slice(0,12).map(h=>({name:String(h.name||'').slice(0,100),queriedAt:String(h.queriedAt||'').slice(0,80),cached:!!h.cached,matches:normalize({matches:(Array.isArray(h.matches)?h.matches:[]).slice(0,2)}).matches}));
 const historyStatus=raw.historyStatus?Object.fromEntries(['sampledPlayers','playersWithGames','games','cacheHits','requests','requestBudget','errors','maxPlayers','gamesPerPlayer'].map(k=>[k,nonnegative(raw.historyStatus[k])])):null;
 const syncStatus=raw.syncStatus?{...Object.fromEntries(['fetchedMatches','reusedMatches','totalMatches','listedMatches','rankFetches','rankReuses'].map(k=>[k,nonnegative(raw.syncStatus[k])])),cachedOnly:!!raw.syncStatus.cachedOnly}:null;
 return {schemaVersion:1,battletag:String(raw.battletag??'导入玩家').slice(0,100),source:String(raw.source??'导入数据').slice(0,140),queriedAt:String(raw.queriedAt??'未知').slice(0,80),used_previous_season_fallback:!!raw.used_previous_season_fallback,matches,recentHistory,historyStatus,syncStatus,historyQueriedAt:String(raw.historyQueriedAt||'').slice(0,80)};
}
function pick(p,strategy,heroes){
 const want=p.role||role(heroes[p.hero]?.role),res=p.res||{},rows=res.rows||[],prev=res.previousRows||[];
 if(p.score!==null&&p.score!==undefined)return {...p,role:want,score:p.score,status:'imported',rawScore:null};
 const missing={...p,role:want,score:null,rawScore:null};
 if(res.error)return {...missing,status:'query_error'};
 if(strategy==='role'&&!want)return {...missing,status:'unknown_role'};
 const choose=rs=>{const legacy=rs.find(r=>role(r.r)===want)||rs[0];const eligible=strategy==='legacy'?(legacy?[legacy]:[]):strategy==='highest'?rs:rs.filter(r=>role(r.r)===want);const valid=eligible.map(r=>({row:r,score:rowStrength(r)})).filter(x=>x.score!==null);return valid.sort((a,b)=>b.score-a.score)[0];};
 const current=choose(rows),prior=choose(prev);
 if(current)return {...missing,score:current.score,status:res.sourceSeason?'previous':'known',season:res.sourceSeason,rawScore:current.row.s,rankRole:current.row.r,crossRole:current.row.r!==want};
 if(prior)return {...missing,score:prior.score,status:'previous',rawScore:prior.row.s,season:prior.row.season,rankRole:prior.row.r,crossRole:prior.row.r!==want};
 const eligible=[...rows,...prev].filter(r=>strategy==='highest'||role(r.r)===want);
 const invalid=eligible.find(r=>r.s!==null&&r.s!==''&&Number(r.s)!==0&&rowStrength(r)===null);
 if(invalid)return {...missing,status:'invalid_score',rawScore:invalid.s};
 if(res.previousError)return {...missing,status:'query_error'};
 return {...missing,status:eligible.length?'not_ranked':rows.length||prev.length?'role_missing':'no_record'};
}
// Missing ranks remain missing. These helpers only estimate a match trend.
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const average=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
function weightedMedian(items){
 const sorted=[...items].sort((a,b)=>a.value-b.value),half=sorted.reduce((s,x)=>s+x.weight,0)/2;
 let weight=0;for(let i=0;i<sorted.length;i++){weight+=sorted[i].weight;if(weight>=half)return weight===half&&sorted[i+1]?(sorted[i].value+sorted[i+1].value)/2:sorted[i].value;}return null;
}
function weightedQuantile(items,q){
 const sorted=[...items].sort((a,b)=>a.value-b.value),threshold=sorted.reduce((s,x)=>s+x.weight,0)*q;
 let weight=0;for(const item of sorted){weight+=item.weight;if(weight>=threshold)return item.value;}return null;
}
function rankEvidence(p){
 if(p.res.error)return null;
 if(p.score!==null)return {value:p.score,weight:(p.status==='previous'?.7:1)*(p.crossRole?.5:1),previous:p.status==='previous',crossRole:!!p.crossRole};
 const rows=new Map();
 for(const [list,previous] of [[p.res.rows,!!p.res.sourceSeason],[p.res.previousRows,true]])for(const r of list||[]){
  const value=rowStrength(r);if(value!==null&&!rows.has(r.r))rows.set(r.r,{value,weight:previous?.35:.5,previous,crossRole:true});
 }
 const values=[...rows.values()];
 return values.length?{value:weightedMedian(values),weight:Math.max(...values.map(x=>x.weight)),previous:values.every(x=>x.previous),crossRole:true}:null;
}
function performanceSignal(m){
 if(!m.duration||m.hasSubstitutes||['T','E'].some(s=>m.players.filter(p=>p.side===s).length>5))return null;
 const players=m.combatPlayers||m.players,usable=players.filter(p=>p.performance?.calibrationEligible===true&&p.performance.coverage>=.8&&Number.isFinite(p.performance.score));
 const teams=['T','E'].map(side=>{
  const roster=players.filter(p=>p.side===side),valid=usable.filter(p=>p.side===side),roles=[...new Set(roster.map(p=>p.role))];
  if(valid.length<Math.max(3,Math.ceil(roster.length*.6))||!roles.length||roles.some(r=>!['tank','dps','healer'].includes(r)||!valid.some(p=>p.role===r)))return null;
  const score=average(roles.map(r=>weightedMedian(valid.filter(p=>p.role===r).map(p=>({value:p.performance.score,weight:1})))));
  const dispersion=average(roles.map(r=>average(valid.filter(p=>p.role===r).map(p=>Math.abs(p.performance.score-score)))));
  return {side,score,dispersion,players:valid.length,coverage:valid.length/roster.length};
 });
 if(teams.some(t=>!t))return null;
 const gap=Math.abs(teams[0].score-teams[1].score),dispersion=average(teams.map(t=>t.dispersion));
 return {score:average(teams.map(t=>t.score)),players:usable.length,coverage:Math.min(...teams.map(t=>t.coverage)),teams,
  gap,dispersion,balanceFactor:clamp(1-gap/30,.15,1),consistencyFactor:clamp(1-dispersion/50,.35,1)};
}
// A score-only scale is explicitly a rule reference, never a rank observation.
const performanceReference=score=>clamp(500+4400*Math.pow(clamp(score,0,100)/100,1.6),500,4900);
function recentReferences(raw,heroes,evaluatePerformance,strategy){
 const excluded=new Set(raw.matches.map(m=>m.mid));
 return (raw.recentHistory||[]).map(h=>{
  const games=h.matches.filter(m=>!excluded.has(m.mid)).map(m=>{
   const players=m.players.map(p=>pick(p,strategy,heroes));
   if(evaluatePerformance)players.forEach(p=>p.performance=evaluatePerformance(p,m));
   const owner=players.find(p=>p.name===h.name),substitutes=['T','E'].some(s=>players.filter(p=>p.side===s).length>5);
   const eligible=!substitutes&&m.duration>=120&&owner?.performance?.calibrationEligible;
   const own=owner&&rankEvidence(owner),known=players.filter(p=>p.name!==h.name).map(rankEvidence).filter(Boolean);
   const center=weightedMedian(known),coverage=known.length/Math.max(1,players.length-1);
   const score=eligible?owner.performance.score:null;
   const value=own?.value??(center!==null?clamp(center*(1+(score===null?0:clamp((score-60)/40,-1,1)*.35*Math.min(1,m.duration/300))),500,4900):null);
   return {mid:m.mid,t:m.t,score,value,weight:own?own.weight*.7:value===null?0:(.2+.4*coverage)*Math.min(1,m.duration/300),rankAnchored:value!==null,known:known.length};
  });
  const ranked=games.filter(g=>g.value!==null),scores=games.filter(g=>g.score!==null).map(g=>g.score);
  return {name:h.name,value:weightedMedian(ranked),weight:ranked.length?Math.min(.7,average(ranked.map(g=>g.weight))):0,
   score:average(scores),games:games.length,records:games,rankAnchored:!!ranked.length,cached:h.cached};
 });
}
function estimateMatches(matches,options,recent){
 const records=matches.flatMap((m,index)=>m.players.map((p,slot)=>({name:p.name==='匿名玩家'?`${m.mid}:${slot}`:p.name,index,t:m.t,...rankEvidence(p)})).filter(r=>r.value!==undefined));
 for(const h of recent.filter(h=>h.rankAnchored))for(const r of h.records.filter(r=>r.value!==null))records.push({name:h.name,index:0,t:r.t,value:r.value,weight:h.weight,previous:false,crossRole:false,history:true});
 const byPlayer=new Map();
 for(const r of records){const list=byPlayer.get(r.name)||[];list.push(r);byPlayer.set(r.name,list);}
 const pool=[...byPlayer].map(([name,records])=>{
  const weight=Math.max(...records.map(r=>r.weight));
  const eligible=records.filter(r=>r.weight===weight),preferred=[...new Map(eligible.map(r=>[r.value,r])).values()];
  return {name,value:weightedMedian(preferred),weight,records:eligible,previous:preferred.every(r=>r.previous),crossRole:preferred.every(r=>r.crossRole),history:preferred.every(r=>r.history)};
 });
 const center=weightedMedian(pool),signals=matches.map(m=>performanceSignal(m));
 const calibration=matches.map((m,i)=>({m,signal:signals[i],known:m.known.filter(p=>rankEvidence(p))})).filter(x=>x.known.length>=2&&x.signal&&x.m.duration>=300);
 const calibrationPlayers=new Set(calibration.flatMap(x=>x.known.map(p=>p.name)));
 const calibrated=calibration.length>=2&&calibrationPlayers.size>=3?weightedMedian(calibration.map(x=>({value:x.signal.score,weight:x.known.reduce((s,p)=>s+rankEvidence(p).weight,0)/x.m.players.length}))):null;
 const recentScores=recent.filter(h=>h.score!==null),recentScore=average(recentScores.map(h=>h.score));
 matches.forEach((m,index)=>{
  const exact=m.known.filter(p=>p.status!=='previous'&&!p.crossRole),rankCoverage=exact.length/Math.max(1,m.players.length);
  if(options.estimate===false||(exact.length>=4&&rankCoverage>=.6))return;
  const roster=new Set(m.players.map(p=>p.name));
  const localRecent=recent.filter(h=>roster.has(h.name)),localScores=localRecent.filter(h=>h.score!==null);
  const historyPerformance=localScores.length?average(localScores.map(h=>h.score)):recentScore;
  const evidence=pool.map(p=>{
   const proximity=Math.max(1e-6,...p.records.map(r=>m.t&&r.t&&Number.isFinite(m.t)&&Number.isFinite(r.t)?1/(1+Math.abs(m.t-r.t)/(24*3600000)):1/(1+Math.abs(index-r.index)/3)));
   return {...p,weight:p.weight*proximity*(p.history&&!roster.has(p.name)?.5:1),proximity,clipped:clamp(p.value,center-500,center+500)};
  });
  const totalWeight=evidence.reduce((s,p)=>s+p.weight,0),freshness=evidence.length?average(evidence.map(p=>p.proximity)):0;
  const quality=Math.min(1,totalWeight/4)*Math.min(1,pool.length/4);
  const signal=signals[index],available=m.combatPlayers.filter(p=>p.performance?.calibrationEligible&&Number.isFinite(p.performance.score));
  const fallbackPerformance=available.length?average(available.map(p=>p.performance.score)):null;
  const recentBase=pool.length?center+evidence.reduce((s,p)=>s+(p.clipped-center)*p.weight,0)/totalWeight:null;
  const shrink=m.observedMean!==null&&recentBase!==null?.6*(1-rankCoverage)*quality:0;
  let rankBase=m.observedMean!==null?m.observedMean*(1-shrink)+(recentBase??m.observedMean)*shrink:recentBase;
  const unanchored=rankBase===null;
  const currentPerformance=signal?.score??fallbackPerformance;
  // Current-room evidence leads; shared recent performance is supplemental.
  const historyWeight=currentPerformance===null?1:historyPerformance===null?0:Math.min(.25,localScores.length/6*.25);
  const dynamicPerformance=currentPerformance===null?historyPerformance:historyPerformance===null?currentPerformance:(1-historyWeight)*currentPerformance+historyWeight*historyPerformance;
  const dynamicReference=dynamicPerformance===null?null:performanceReference(dynamicPerformance);
  if(unanchored)rankBase=dynamicReference;
  const reference=historyPerformance===null?(calibrated??60):.75*(calibrated??60)+.25*historyPerformance;
  const reason=rankBase===null?'本场和近期均缺少可用段位及战斗数据':!signal?'定位数据不足、职责缺失或含替补':m.duration<120?'不足两分钟，不使用战斗辅助':null;
  // Confidence in a sparse anchor constrains the correction; absence of rank
  // anchors uses a low-trust dynamic rule scale instead of a fixed 2500.
  const reliability=unanchored?.35:Math.max(.35,quality);
  const durationFactor=Math.min(1,(m.duration||0)/300),consistency=signal?.consistencyFactor??0;
  const weight=reason?0:.35*reliability*signal.coverage*durationFactor*signal.balanceFactor*consistency;
  let offset=reason?0:.65*(signal.score-reference)+.35*(signal.score-60),context='近期表现与本场定位基准综合';
  if(!reason&&Math.max(...signal.teams.map(t=>t.score))<55){offset=Math.min(offset,signal.score-60);context='双方整体表现偏低，下调参考';}
  else if(!reason&&Math.min(...signal.teams.map(t=>t.score))>=72&&signal.gap<=10){offset=Math.max(offset,.35*(Math.min(...signal.teams.map(t=>t.score))-60));context='双方表现良好且接近，上调参考';}
  const performanceRatio=clamp(offset/40,-1,1)*weight;
  const imbalanceRatio=reason?0:.35*reliability*signal.coverage*durationFactor*consistency*clamp((signal.gap-12)/28,0,1);
  const combatQuality=reason?0:signal.coverage*durationFactor*signal.balanceFactor*consistency;
  // With no observed room ranks, use the actual room's performance scale to
  // move away from a reused global rank prior, still within the ±35% boundary.
  const priorRatio=m.observedMean===null&&!unanchored&&dynamicReference!==null&&rankBase>0?clamp(dynamicReference/rankBase-1,-.35,.35)*combatQuality:0;
  const combinedPerformance=m.observedMean===null&&!unanchored?.75*priorRatio+.25*performanceRatio:performanceRatio;
  let ratio=clamp(combinedPerformance-imbalanceRatio,-.35,.35);
  // A large stomp cannot inflate the estimate even if the winning side farms.
  if(!reason&&signal.gap>12){ratio=Math.min(ratio,-imbalanceRatio);context+='；双方差距过大，向下修正';}
  const mean=rankBase===null?null:clamp(rankBase*(1+ratio),500,4900),delta=mean===null?0:mean-rankBase;
  const deviation=pool.length?weightedMedian(pool.map(p=>({value:Math.abs(p.value-center),weight:p.weight}))):0;
  // A shared pool does not give every match the same precision. Prefer unique
  // local players, and discount their inferred/old recent-game references.
  const localByName=new Map();
  for(const p of m.players){const r=rankEvidence(p);if(r&&!localByName.has(p.name))localByName.set(p.name,{...r,name:p.name,direct:true});}
  for(const h of localRecent.filter(h=>h.rankAnchored&&!localByName.has(h.name))){
   const proximity=Math.max(1e-6,...h.records.filter(g=>g.value!==null).map(g=>m.t&&g.t?1/(1+Math.abs(m.t-g.t)/(24*3600000)):1));
   localByName.set(h.name,{name:h.name,value:h.value,weight:h.weight*proximity,direct:false});
  }
  const local=[...localByName.values()],effectiveLocal=local.reduce((s,p)=>s+p.weight,0);
  const localQuality=Math.min(1,effectiveLocal/Math.max(4,m.players.length*.6));
  const rangeEvidence=local.length?local:evidence.map(p=>({value:p.clipped,weight:p.weight}));
  const p10=weightedQuantile(rangeEvidence,.1),p90=weightedQuantile(rangeEvidence,.9);
  // A display reference band, not a confidence interval for real MMR. Sparse
  // ranks do not erase complete and stable combat evidence in this room.
  const precision=Math.max(localQuality,.75*combatQuality);
  const baseUncertainty=240+240*(1-precision)+120*(1-localQuality)+100*(1-(unanchored?combatQuality:quality))+100*(1-(signal?.coverage??0))+100*(1-(signal?.balanceFactor??0))+80*(1-(signal?.consistencyFactor??0));
  const tailScale=local.length?.2+.35*localQuality:.15;
  const lowerMargin=Math.min(2000,baseUncertainty+(p10===null||rankBase===null?0:Math.min(1200,Math.max(0,rankBase-p10))*tailScale));
  const upperMargin=Math.min(2000,baseUncertainty+(p90===null||rankBase===null?0:Math.min(1200,Math.max(0,p90-rankBase))*tailScale));
  m.mean=mean;m.estimateRange=mean===null?null:{min:Math.floor(Math.max(500,mean-lowerMargin)),max:Math.ceil(Math.min(4900,mean+upperMargin))};
  m.estimateSource=unanchored?'本场与近期表现动态规则参考（无段位锚点）':m.observedMean!==null?'稀疏段位与近期表现融合':'近期段位及战斗表现参考';
  m.estimateDetails={version:'2.6',rankBase,rankCenter:center,observedMean:m.observedMean,rankCoverage,shrink,rankSamples:pool.length,effectiveRankSamples:totalWeight,
   dynamicReference,dynamicPerformance,currentPerformance,historyWeight,combatQuality,
   confidence:!unanchored&&local.length>=2&&pool.length>=4&&quality>=.5&&deviation<=500?'中':'低',unanchored,
   rangeMethod:'room-combat-adaptive-v2',rangeDetails:{precision,combatQuality,localSamples:local.length,directSamples:local.filter(p=>p.direct).length,recentSamples:local.filter(p=>!p.direct).length,effectiveLocalSamples:effectiveLocal,localQuality,p10,p90,baseUncertainty,lowerMargin,upperMargin},
   currentSamples:pool.filter(p=>!p.previous&&!p.history).length,previousSamples:pool.filter(p=>p.previous).length,crossRoleSamples:pool.filter(p=>p.crossRole).length,
   historySamples:pool.filter(p=>p.history).length,recentPlayers:localRecent.filter(h=>h.games).length,recentGames:[...new Set(localRecent.flatMap(h=>h.records.map(g=>g.mid)))].length,
   recentPerformance:historyPerformance,recentReferences:localRecent.map(h=>({name:h.name,games:h.games,rankAnchored:h.rankAnchored,reference:h.value,performance:h.score,cached:h.cached})),
   clippedSamples:pool.filter(p=>p.value<center-500||p.value>center+500).length,freshness,
   auxiliary:{weight,maxWeight:.35,delta,maxDelta:rankBase===null?0:rankBase*.35,relativeDelta:rankBase===null?0:delta/rankBase,performanceRatio,priorRatio,combinedPerformance,imbalanceRatio,
    performanceScore:signal?.score??null,referenceScore:reference,referenceSource:calibrated===null?'定位规则基准 60 与近期表现':'有段位对局表现与近期表现',
    teamScores:signal?.teams??[],teamGap:signal?.gap??null,dispersion:signal?.dispersion??null,balanceFactor:signal?.balanceFactor??0,consistencyFactor:consistency,performanceOffset:offset,context,
    players:signal?.players??0,coverage:signal?.coverage??0,calibrationMatches:calibration.length,calibrationPlayers:calibrationPlayers.size,reason}};
 });
}
// Personal prediction has its own leave-one-player-out context. It never uses
// the final match estimate, which already contains the subject's performance.
function personalPrediction(raw,matches,heroes,evaluatePerformance,frozen){
 const subject=raw.battletag,shown=new Set(matches.map(m=>m.mid)),order=['tank','dps','healer'];
 const excluded=[],records=[],latest=Math.max(0,...matches.map(m=>m.t));
 const direct=[];
 for(const m of raw.matches.filter(m=>shown.has(m.mid)))for(const p of m.players.filter(p=>p.name!==subject)){
  const evidence=rankEvidence(pick(p,'role',heroes));
  if(evidence)direct.push({name:p.name,t:m.t,...evidence,direct:true,anchors:[p.name]});
 }
 const independentRaw={...raw,recentHistory:(raw.recentHistory||[]).filter(h=>h.name!==subject).map(h=>({...h,
  matches:h.matches.filter(m=>!['T','E'].some(s=>m.players.filter(p=>p.side===s).length>5)).map(m=>({...m,players:m.players.filter(p=>p.name!==subject)}))}))};
 const recent=recentReferences(independentRaw,heroes,evaluatePerformance,'role');
 for(const h of recent.filter(h=>h.rankAnchored))for(const r of h.records.filter(r=>r.value!==null)){
  const original=independentRaw.recentHistory.find(g=>g.name===h.name)?.matches.find(g=>g.mid===r.mid);
  const parsed=(original?.players||[]).map(p=>pick(p,'role',heroes)),own=parsed.find(p=>p.name===h.name);
  const anchors=own&&rankEvidence(own)?[h.name]:parsed.filter(p=>p.name!==h.name&&rankEvidence(p)).map(p=>p.name);
  direct.push({name:h.name,t:r.t,value:r.value,weight:h.weight,direct:false,anchors});
 }
 const byName=new Map();
 for(const r of direct){const list=byName.get(r.name)||[];list.push(r);byName.set(r.name,list);}
 const pool=[...byName].map(([name,rs])=>{const weight=Math.max(...rs.map(r=>r.weight)),best=rs.filter(r=>r.weight===weight),unique=[...new Map(best.map(r=>[r.value,r])).values()];
  return {name,value:weightedMedian(unique),weight,direct:best.some(r=>r.direct),anchors:[...new Set(best.flatMap(r=>r.anchors))],records:best};});
 const robust=items=>{const center=weightedMedian(items),total=items.reduce((s,p)=>s+p.weight,0);return center===null||!total?null:center+items.reduce((s,p)=>s+(clamp(p.value,center-500,center+500)-center)*p.weight,0)/total;};
 function contextForPlayer(m){
  const localByName=new Map();
  const original=raw.matches.find(g=>g.mid===m.mid);
  for(const p of original.players.filter(p=>p.name!==subject)){const e=rankEvidence(pick(p,'role',heroes));if(e&&!localByName.has(p.name))localByName.set(p.name,{name:p.name,...e,direct:true,anchors:[p.name]});}
  const roster=new Set(original.players.filter(p=>p.name!==subject).map(p=>p.name));
  const aged=pool.map(p=>{const freshness=Math.max(1e-6,...p.records.map(r=>m.t&&r.t?1/(1+Math.abs(m.t-r.t)/(24*3600000)):1));return {...p,freshness,weight:p.weight*freshness*(!p.direct&&!roster.has(p.name)?.5:1)};});
  const local=[...localByName.values()],localWeight=local.reduce((s,p)=>s+p.weight,0),globalBase=robust(aged),localBase=robust(local);
  if(globalBase===null)return {base:null,quality:0,anchorNames:[],reason:'缺少非本人段位锚点'};
  const localFraction=local.length>=3?1:Math.min(1,localWeight/3),base=localBase===null?globalBase:localFraction*localBase+(1-localFraction)*globalBase;
  const evidence=localFraction===1?local:aged,total=evidence.reduce((s,p)=>s+p.weight,0),center=weightedMedian(evidence);
  const mad=weightedMedian(evidence.map(p=>({value:Math.abs(p.value-center),weight:p.weight})));
  const directRatio=total?evidence.filter(p=>p.direct).reduce((s,p)=>s+p.weight,0)/total:0;
  const freshness=total?evidence.reduce((s,p)=>s+(p.freshness??1)*p.weight,0)/total:0;
  const localCoverage=Math.min(1,localWeight/3);
  const anchorNames=[...new Set(evidence.flatMap(p=>p.anchors))];
  const quality=Math.min(1,anchorNames.length/4)*(.5+.5*directRatio)*freshness/(1+mad/700)*(.35+.65*localCoverage);
  return {base,quality,localSamples:local.length,localWeight,localFraction,anchorNames,referenceNames:evidence.map(p=>p.name),directSamples:evidence.filter(p=>p.direct).length,directRatio,freshness,mad,localCoverage};
 }
 function independentBalance(m){
  const eligible=m.combatPlayers.filter(p=>p.name!==subject&&p.performance?.calibrationEligible&&p.performance.coverage>=.8&&Number.isFinite(p.performance.score));
  const teams=['T','E'].map(side=>eligible.filter(p=>p.side===side));
  const common=order.filter(r=>teams.every(t=>t.some(p=>p.role===r)));
  if(teams.some(t=>t.length<3)||!common.length)return {factor:.35,gap:null,reason:'非本人双方表现数据不足，降低修正可信度'};
  const scores=teams.map(team=>average(common.map(r=>weightedMedian(team.filter(p=>p.role===r).map(p=>({value:p.performance.score,weight:1}))))));
  const gap=Math.abs(scores[0]-scores[1]);return {factor:clamp(1-gap/30,.15,1),gap,scores,roles:common};
 }
 for(const m of matches){
  if(frozen){
   const original=frozen.records.find(r=>r.mid===m.mid);
   if(original){const recency=Math.pow(2,-Math.max(0,latest-original.t)/(7*86400000));records.push({...original,recency,weight:original.value===null?0:original.coverage*original.durationFactor*original.context.quality*recency});}
   else excluded.push(frozen.excluded.find(r=>r.mid===m.mid)||{mid:m.mid,reason:'缺少原始个人预测依据'});
   continue;
  }
  const self=m.combatPlayers.filter(p=>p.name===subject);
  let reason=self.length!==1?'未找到唯一的本人记录':m.hasSubstitutes?'含替补或重复记录':!m.hasGameData?'缺少战斗数据':m.duration<120?'不足两分钟':!order.includes(self[0].role)?'职责未知':self[0].performance?.calibrationEligible!==true||!Number.isFinite(self[0].performance.score)||!Number.isFinite(self[0].performance.coverage)||self[0].performance.coverage<.8?'本人定位数据不足或冲突':null;
  if(reason){excluded.push({mid:m.mid,reason});continue;}
  const p=self[0],context=contextForPlayer(m),balance=independentBalance(m),durationFactor=Math.min(1,m.duration/300),recency=Math.pow(2,-Math.max(0,latest-m.t)/(7*86400000));
  const quality=p.performance.coverage*durationFactor*context.quality*balance.factor;
  const ratio=.35*quality*clamp((p.performance.score-60)/40,-1,1);
  const value=context.base===null?null:clamp(context.base*(1+ratio),500,4900);
  records.push({mid:m.mid,t:m.t,role:p.role,hero:p.hero,duration:m.duration,performance:p.performance.score,coverage:p.performance.coverage,
   context,balance,durationFactor,recency,quality,ratio,value,weight:value===null?0:p.performance.coverage*durationFactor*context.quality*recency});
 }
 const byRole=order.map(r=>{
  const available=records.filter(p=>p.role===r),games=available.filter(p=>p.value!==null&&p.weight>0),sum=games.reduce((s,g)=>s+g.weight,0),effective=sum?sum*sum/games.reduce((s,g)=>s+g.weight*g.weight,0):0;
  const median=weightedMedian(games),candidate=robust(games),anchors=[...new Set(games.flatMap(g=>g.context.anchorNames))];
  const quality=sum?games.reduce((s,g)=>s+g.context.quality*g.weight,0)/sum:0;
  const directCoverage=sum?games.reduce((s,g)=>s+g.context.directRatio*g.weight,0)/sum:0;
  const mad=median===null?null:weightedMedian(games.map(g=>({value:Math.abs(g.value-median),weight:g.weight})));
  const reasons=[];if(games.length<3)reasons.push('至少需要 3 场本人有效对局');if(effective<2)reasons.push('有效样本量不足 2');if(games.length<2)reasons.push('至少需要 2 场独立环境依据');if(anchors.length<3)reasons.push('至少需要 3 名非本人段位锚点');
  const mean=reasons.length?null:candidate;
  const confidence=mean===null?'不足':games.length>=6&&effective>=4&&quality>=.6&&directCoverage>=.6&&mad<=300?'中':'低';
  const shortFactor=sum?games.reduce((s,g)=>s+g.durationFactor*g.weight,0)/sum:0;
  const floor=confidence==='中'?200:400;
  const margin=Math.max(floor,200+300*(1-quality)+300/Math.sqrt(Math.max(1,effective))+150*(1-shortFactor)+Math.min(400,mad??0));
  const p20=weightedQuantile(games,.2),p80=weightedQuantile(games,.8);
  const lower=mean===null?null:Math.min(1500,margin+Math.max(0,mean-p20)),upper=mean===null?null:Math.min(1500,margin+Math.max(0,p80-mean));
  const actual=raw.matches.filter(m=>shown.has(m.mid)).sort((a,b)=>b.t-a.t).flatMap(m=>m.players.filter(p=>p.name===subject).map(p=>pick({...p,role:r},'role',heroes))).find(p=>p.score!==null&&!p.crossRole);
  return {role:r,availableGames:available.length,games:games.length,duration:available.reduce((s,g)=>s+g.duration,0),effectiveSamples:effective,
   mean,candidateMean:candidate,rank:mean===null?null:rank(mean),confidence,range:mean===null?null:{min:Math.floor(Math.max(500,mean-lower)),max:Math.ceil(Math.min(4900,mean+upper))},
   rangeDetails:{quality,directCoverage,mad,margin,p20,p80,lowerMargin:lower,upperMargin:upper},anchorNames:anchors,performanceMean:average(available.map(g=>g.performance)),
   actualRank:actual?{score:actual.score,rank:rank(actual.score),status:actual.status,season:actual.season||''}:null,reasons,
   volatile:mean!==null&&Math.abs(candidate-median)>150,records:available};
 });
 const selected=[...byRole].filter(r=>r.availableGames).sort((a,b)=>b.duration-a.duration||b.availableGames-a.availableGames||order.indexOf(a.role)-order.indexOf(b.role))[0]||null;
 return {version:'1.0',subject,selectedRole:selected?.role??null,selected,byRole,excluded,maxCorrection:.35,
  basis:'本人定位表现 + 非本人段位环境；分职责规则预测，非真实竞技定级或 MMR'};
}

// Evidence completeness index, not a calibrated probability of rank accuracy.
// Only queried ranks count as independent anchors; inferred history cannot
// manufacture extra anchors. Deterministic freshness is measured at query time.
function confidenceEvidence(raw,matches,options,heroes){
 const reference=Math.max(Date.parse(raw.queriedAt)||0,...matches.map(m=>m.t||0));
 const ageQuality=stamp=>{const time=Date.parse(stamp);return Number.isFinite(time)&&reference?Math.pow(2,-Math.max(0,reference-time)/(7*86400000)):.6;};
 const pool=new Map();
 for(const m of matches)for(const p of m.players){const r=rankEvidence(p);if(!r)continue;const w=r.weight*ageQuality(p.res.rankQueriedAt||raw.queriedAt);pool.set(p.name,Math.max(pool.get(p.name)||0,w));}
 for(const h of raw.recentHistory||[])for(const m of h.matches)for(const row of m.players){
  const p=pick(row,options.strategy,heroes),r=rankEvidence(p);if(!r)continue;
  const w=.5*r.weight*ageQuality(p.res.rankQueriedAt||h.queriedAt||raw.queriedAt);pool.set(p.name,Math.max(pool.get(p.name)||0,w));
 }
 const global=Math.min(1,[...pool.values()].reduce((s,w)=>s+w,0)/12);
 for(const m of matches){
  const local=new Map(),exact=new Set();
  for(const p of m.players){const r=rankEvidence(p);if(!r)continue;const age=ageQuality(p.res.rankQueriedAt||raw.queriedAt);local.set(p.name,Math.max(local.get(p.name)||0,r.weight*age));if(!r.crossRole&&!r.previous)exact.add(p.name);}
  const signal=performanceSignal(m),localSupport=Math.min(1,[...local.values()].reduce((s,w)=>s+w,0)/6);
  const directCoverage=Math.min(1,exact.size/Math.max(1,m.players.length));
  const dataCoverage=(signal?.coverage??0)*Math.min(1,(m.duration||0)/300)*ageQuality(m.dataQueriedAt||raw.queriedAt);
  const stability=signal?signal.balanceFactor*signal.consistencyFactor:0;
  const anchored=pool.size>0,score=m.mean===null?0:100*(.45*localSupport+.20*global+.15*directCoverage+.10*dataCoverage+.10*stability);
  m.confidenceEvidence={version:'1.0',percent:Math.round(clamp(score,0,anchored?95:30)),localSupport,globalSupport:global,directCoverage,dataCoverage,stability,independentAnchors:pool.size,localAnchors:local.size,anchored,referenceTime:reference,cap:anchored?95:30};
 }
 const percent=matches.length?Math.round(average(matches.map(m=>m.confidenceEvidence.percent))):0;
 return {version:'1.0',percent,aggregation:'equal-match-mean',matches:matches.length,independentAnchors:pool.size,basis:'证据完整与稳定性评分，非预测命中率'};
}
function build(raw,options,heroes,evaluatePerformance){
 const range=xs=>xs.length?{min:Math.min(...xs),max:Math.max(...xs)}:null;
 const average=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 const seen=new Set();
 const matches=[...raw.matches].sort((a,b)=>b.t-a.t).filter(m=>{if(seen.has(m.mid))return false;seen.add(m.mid);return true;}).slice(0,options.limit||50).map(m=>{
  const combatPlayers=m.players.map(p=>pick(p,options.strategy,heroes));
  if(evaluatePerformance)combatPlayers.forEach(p=>p.performance=evaluatePerformance(p,m));
  const players=combatPlayers.filter(p=>options.side==='all'||!options.side||p.side===options.side);
  const known=players.filter(p=>p.score!==null),scores=known.map(p=>p.score),mean=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;
  const allRoleScores=players.flatMap(p=>{
   const latest={};for(const r of [...(p.res.rows||[]),...(p.res.previousRows||[])]){const value=rowStrength(r);if(value!==null&&latest[r.r]===undefined)latest[r.r]=value;}return p.res.error?[]:Object.values(latest);
  });
  return {...m,combatPlayers,hasSubstitutes:['T','E'].some(side=>m.players.filter(p=>p.side===side).length>5),players,known,scores,mean,observedMean:mean,roleRange:range(scores),allRoleScores,allRoleRange:range(allRoleScores),estimateSource:null};
 }).sort((a,b)=>a.t-b.t);
 // Overstats never imputes missing ranks. This optional extension estimates a
 // MATCH trend, while preserving every player's missing rank and provenance.
 estimateMatches(matches,options,recentReferences(raw,heroes,evaluatePerformance,options.strategy));
 const confidence=confidenceEvidence(raw,matches,options,heroes);
 return summarize(raw,matches,options,heroes,evaluatePerformance,confidence);
}
// Aggregate already evaluated historical matches without re-estimating their evidence.
function summarize(raw,matches,options,heroes,evaluatePerformance,confidence,frozenPrediction){
 const average=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 confidence??={version:'1.0',percent:matches.length?Math.round(average(matches.map(m=>m.confidenceEvidence?.percent||0))):0,aggregation:'equal-match-mean',matches:matches.length,independentAnchors:Math.max(0,...matches.map(m=>m.confidenceEvidence?.independentAnchors||0)),basis:'证据完整与稳定性评分，非预测命中率'};
 const players=matches.flatMap(m=>m.players),scores=players.filter(p=>p.score!==null).map(p=>p.score);
 const means=matches.map(m=>m.mean).filter(v=>v!==null),observed=matches.map(m=>m.observedMean).filter(v=>v!==null);
 const summary={crossRole:players.filter(p=>p.score!==null&&p.crossRole).length,total:players.length,known:scores.length,mean:average(means),observedMean:average(observed),min:means.length?Math.min(...means):null,max:means.length?Math.max(...means):null,playerMean:average(scores),estimated:matches.filter(m=>m.estimateSource).length,unanchored:matches.filter(m=>m.estimateDetails?.unanchored).length,auxiliary:matches.filter(m=>m.estimateDetails?.auxiliary.weight>0).length,previous:players.filter(p=>p.status==='previous').length,errors:players.filter(p=>p.status==='query_error').length};
 summary.confidencePercent=confidence.percent;
 return {...raw,matches,summary,confidence,options,personalPrediction:personalPrediction(raw,matches,heroes,evaluatePerformance,frozenPrediction),algorithmVersion:'2.6',aggregation:'equal-match-mean'};
}
const api={bands,bases,roles,states,role,esc,compact,rowStrength,rank,normalize,pick,build,summarize};root.QS=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
