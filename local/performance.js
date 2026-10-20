(function(root){
'use strict';
const rules=root.QS_RATING_RULES||(typeof require==='function'?require('./rating-rules.js'):null);
const resources=root.QS_RESOURCES||(typeof require==='function'?require('./resource-rating.js'):null);
const version='2.1';
const labels={kill:'击杀',assist:'助攻',death:'阵亡 ↓',heroDamage:'英雄伤害',cure:'治疗',resistDamage:'抵挡',kd:'K/D（平滑）',finalHit:'最后一击',soloKill:'单独消灭'};
const groupLabels={survival:'生存与 K/D',finish:'击杀与收尾',damage:'伤害',mitigation:'抵挡',utility:'职责贡献'};
const number=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const median=xs=>{const a=[...xs].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length?(a.length%2?a[i]:(a[i-1]+a[i])/2):null;};
const metricScore=ratio=>clamp(60+35*Math.log2(Math.max(.001,ratio)),0,100);
const letter=score=>score>=85?'S':score>=72?'A':score>=55?'B':score>=40?'C':'D';
// Quick play arrives as LeisurePreset (5v5) or Leisure6v6 (6v6); only a team
// larger than the mode's roster is a substitute. Missing mode keeps the old 5.
const substitutes=match=>{
 const mode=String(match?.gameMode||''),found=/^leisure(\d+)v(\d+)$/i.exec(mode);
 const limit=found?Math.max(Number(found[1]),Number(found[2])):/^leisure/i.test(mode)?5:5;
 return ['T','E'].some(side=>(match?.players||[]).filter(p=>p.side===side).length>limit);
};
const cache=new WeakMap();
function categoryBaselines(benchmarks){
 if(cache.has(benchmarks))return cache.get(benchmarks);
 const result={};
 for(const [id,profile] of Object.entries(rules.profiles)){
  const rows=Object.values(benchmarks.heroes).filter(r=>r.role===profile.role&&rules.heroProfiles[r.slug]===id);
  result[id]={};
  for(const key of ['kill','death','assist','heroDamage','cure','resistDamage']){
   const xs=rows.filter(r=>{
    const o=rules.overrides[r.slug];
    return !(o?.baselineFromHero||[]).includes(key)&&(key!=='resistDamage'||!o?.groups||o.groups.mitigation>0)&&(!['assist','cure'].includes(key)||!o?.groups||o.groups.utility>0);
   }).map(r=>number(r.per10[key])).filter(v=>v!==null);
   result[id][key]=xs.length?median(xs):number(benchmarks.roles[profile.role]?.[key]);
  }
 }
 cache.set(benchmarks,result);return result;
}
function resolve(player,heroes,benchmarks){
 const record=Object.hasOwn(benchmarks.heroes,player.hero)?benchmarks.heroes[player.hero]:null;
 const hero=Object.hasOwn(heroes,player.hero)?heroes[player.hero]:null,role=hero?.role||player.role||record?.role;
 const slug=record?.slug,configured=slug&&Object.hasOwn(rules.heroProfiles,slug)?rules.heroProfiles[slug]:null;
 const id=configured||rules.defaults[role];if(!id||!Object.hasOwn(rules.profiles,id))return null;
 const template=rules.profiles[id],override=slug&&Object.hasOwn(rules.overrides,slug)?rules.overrides[slug]:{},groups={...(override.groups||template.groups)};
 const style=rules.styles[template.style];
 // Never transfer a budget into a missing group; tactical tuning is capped at 2%.
 for(const [key,shift] of Object.entries(style.shift))if(key!=='damage'){
  const receiver=key==='utility'&&!groups.utility&&groups.mitigation?'mitigation':key;
  if(groups[receiver]&&groups.damage){groups[receiver]+=shift;groups.damage-=shift;}
 }
 const baseline={...categoryBaselines(benchmarks)[id]};
 for(const key of override.baselineFromHero||[])if(number(record?.per10[key])!==null)baseline[key]=record.per10[key];
 for(const [key,factor] of Object.entries(override.baselineMultipliers||{}))if(baseline[key]!==null)baseline[key]*=factor;
 baseline.finalHit=baseline.kill*(override.finalRatio??template.finalRatio);
 baseline.soloKill=baseline.kill*(override.soloRatio??template.soloRatio);
 baseline.kd=baseline.kill/(baseline.death+1);
 return {record,hero,role,id,template,override,groups,baseline,style,configured:!!configured};
}
function evaluateBase(player,match,heroes,benchmarks){
 const config=resolve(player,heroes,benchmarks);
 const base={version,ruleVersion:rules.version,benchmarkVersion:benchmarks.version,hero:config?.hero?.name||config?.record?.name||'未知英雄',role:config?.role||player.role,
  source:'https://www.counterwatch.gg/stats/overwatch/heroes',reference:config?.configured?'定位模板基准':'通用职责参考',
  grade:null,score:null,metrics:[],groups:[],warnings:[],calibrationEligible:false};
 const fail=reason=>({...base,reason});
 const seconds=number(match.duration);if(!seconds)return fail('缺少有效对局时长');if(!config)return fail('缺少职责定位规则');
 const {id,template,override,groups,baseline,style}=config,values={},stats=player.stats||{},primary=override.primary||template.primary;
 Object.assign(base,{profile:id,profileName:template.name,playstyle:style.name,heroAdjustment:override.note||null,baseline:{...baseline},finishReference:rules.finishSource});
 for(const key of Object.keys(labels)){const value=number(stats[key]);values[key]=value===null?null:value*600/seconds;}
 values.kd=values.kill===null||values.death===null?null:values.kill/(values.death+1);
 if(values.death===null||Object.keys(primary).some(k=>values[k]===null))return fail('缺少阵亡或核心定位数据');
 let consistent=true;
 if(values.finalHit!==null&&values.kill!==null&&values.finalHit>values.kill+1e-8){values.finalHit=null;values.soloKill=null;consistent=false;base.warnings.push('最后一击超过击杀，异常收尾数据已排除');}
 if(values.soloKill!==null&&(values.soloKill>(values.finalHit??values.kill)+1e-8)){values.soloKill=null;consistent=false;base.warnings.push('单独消灭超过击杀/最后一击，异常数据已排除');}
 const inner={survival:override.survival||rules.survival,finish:template.finish,damage:{heroDamage:1},mitigation:{resistDamage:1},utility:override.utility||template.utility};
 let possible=0,available=0;
 for(const [group,budget] of Object.entries(groups)){
  const candidates=Object.entries(inner[group]||{}).filter(([key])=>baseline[key]>0&&(key!=='resistDamage'||baseline[key]>=100)&&(key!=='soloKill'||values.soloKill!==null));
  const total=candidates.reduce((s,[,w])=>s+w,0);if(!total)continue;
  possible+=budget;const valid=candidates.filter(([key])=>values[key]!==null),used=valid.reduce((s,[,w])=>s+w,0);
  if(!used){
   base.groups.push({key:group,label:groupLabels[group],score:60,weight:budget,missing:true});
   base.metrics.push({key:group+'Missing',label:groupLabels[group]+'（未返回）',group,value:null,baseline:null,ratio:null,score:60,weight:budget,baselineSource:'中性参考占位；非实测',referenceKind:'missing'});
   continue;
  }
  available+=budget*used/total;
  const items=valid.map(([key,w])=>{
   const ratio=key==='death'?(baseline[key]+1)/(values[key]+1):values[key]/baseline[key];
   return {key,label:labels[key],group,value:values[key],baseline:baseline[key],ratio,score:metricScore(ratio),weight:budget*w/used,
    baselineSource:['finalHit','soloKill'].includes(key)?'规则参考比例':'定位中位数'+((override.baselineFromHero||[]).includes(key)?' / 英雄特调':''),referenceKind:['finalHit','soloKill'].includes(key)?'rule':'community'};
  });
  const score=items.reduce((s,item)=>s+item.score*item.weight/budget,0);
  base.groups.push({key:group,label:groupLabels[group],score,weight:budget});base.metrics.push(...items);
 }
 const coverage=possible?available/possible:0;
 if(coverage<.6||!base.groups.some(g=>g.key!=='survival'&&!g.missing))return fail('可用评分指标不足 60% 或无核心贡献');
 const usedBudget=base.groups.reduce((s,g)=>s+g.weight,0);base.metrics.forEach(m=>m.weight/=usedBudget);base.groups.forEach(g=>g.weight/=usedBudget);
 const unadjusted=base.groups.reduce((s,g)=>s+g.score*g.weight,0);let score=Math.round(unadjusted*10)/10;
 const metric=key=>base.metrics.find(m=>m.key===key),survival=base.groups.find(g=>g.key==='survival');
 const contributions=base.groups.filter(g=>g.key!=='survival'),coreOK=Object.entries(primary).every(([key,min])=>metric(key)?.score>=min);
 const balanced=contributions.length===1?contributions[0].score>=85:contributions.filter(g=>g.score>=72).length>=2;
 if(score>=85&&(!balanced||!coreOK||metric('death')?.score<55||survival?.score<65||coverage<.8)){
  score=84.9;base.warnings.push('S 需贡献维度均衡、核心定位达标、生存 ≥65、阵亡项 ≥55、覆盖 ≥80%');
 }
 if(Object.keys(primary).every(key=>values[key]===0)){score=Math.min(score,39.9);base.warnings.push('无核心贡献，最高为 D；零阵亡不等于高表现');}
 if(seconds<300)base.warnings.push('短局：不足 5 分钟，波动较大；相同每 10 分钟效率不扣分');
 if(values.soloKill===null)base.warnings.push('单独消灭未返回，完全不计入；收尾预算在已知指标内分配');
 if(values.finalHit===null&&groups.finish)base.warnings.push('最后一击未返回，收尾预算暂用击杀，不当作 0');
 if(coverage<1)base.warnings.push('部分指标缺失；维度内重分配，整个维度缺失则用 60 分中性参考占位，不增加生存预算');
 if(!config.configured)base.warnings.push('未配置该英雄定位，暂用通用职责参考，不参与强度辅助');
 if(override.note)base.warnings.push(override.note);
 if(substitutes(match))base.warnings.push('含替补记录；整场时长可能低估个人效率');
 base.warnings.push('整局估评；打法标签为默认定位，换英雄与实际参战时长未核验');
 const sEligible=balanced&&coreOK&&metric('death')?.score>=55&&survival?.score>=65&&coverage>=.8;
 const scoreCeiling=Object.keys(primary).every(key=>values[key]===0)?39.9:sEligible?100:84.9;
 return {...base,grade:letter(score),score,unadjusted,scoreCeiling,coverage,duration:seconds,calibrationEligible:config.configured&&consistent&&coverage>=.8,reason:null};
}
const resourceCache=new WeakMap();
function evaluate(player,match,heroes,benchmarks){
 const base=evaluateBase(player,match,heroes,benchmarks);
 if(!resources||!rules.resources)return base;
 const roster=match.players||[],stamp=JSON.stringify([match.duration,roster.map(p=>[p.name,p.side,p.hero,p.stats])]);
 let cached=resourceCache.get(match);
 if(!cached||cached.stamp!==stamp||cached.heroes!==heroes||cached.benchmarks!==benchmarks){
  cached={stamp,heroes,benchmarks,rows:roster.map(p=>evaluateBase(p,match,heroes,benchmarks)),configs:roster.map(p=>resolve(p,heroes,benchmarks))};resourceCache.set(match,cached);
 }
 let resource=resources.evaluate(base,player,match,cached.rows,cached.configs,rules.resources);
 const score=base.score===null?null:Math.round(clamp(base.score+resource.delta,0,base.scoreCeiling??100)*10)/10;
 const proposedDelta=resource.delta,delta=score===null?0:Math.round((score-base.score)*10)/10;
 resource={...resource,proposedDelta,delta,applied:Math.abs(delta)>0,
  reason:proposedDelta>0&&delta<proposedDelta-.1?'资源效率符合加分条件，但受 S 级门槛或 100 分上限约束':resource.reason};
 return {...base,score,grade:score===null?null:letter(score),baseScore:base.score,resource,
  warnings:[...base.warnings,...(resource.applied?[`${resource.label}；资源修正 ${resource.delta>=0?'+':''}${resource.delta} 分（上限 ±${resource.maxDelta}）`]:[])]};
}
root.QS_PERFORMANCE={evaluate,version,labels,profiles:rules.profiles,categoryBaselines,resolve,letter};
if(typeof module!=='undefined')module.exports=root.QS_PERFORMANCE;
})(typeof window!=='undefined'?window:globalThis);
