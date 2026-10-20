(function(root){
'use strict';
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const number=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))||Number(v)<0?null:Number(v);
const median=xs=>{const a=[...xs].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length?(a.length%2?a[i]:(a[i-1]+a[i])/2):null;};
const contribution=b=>{const gs=(b.groups||[]).filter(g=>g.key!=='survival'&&!g.missing),w=gs.reduce((s,g)=>s+g.weight,0);return w?gs.reduce((s,g)=>s+g.score*g.weight,0)/w:null;};
function evaluate(base,player,match,rows,configs,policy){
 const seconds=number(match.duration),h=number(player.stats?.healingTaken),d=number(player.stats?.damageTaken);
 const index=(match.players||[]).findIndex(p=>p===player||(p.name===player.name&&p.hero===player.hero&&p.side===player.side));
 const config=configs[index],slug=config?.record?.slug,self=policy.selfSustain[slug]||{},sensitivity=self.sensitivity??(config?.role==='healer'?.75:1);
 const info={version:policy.version,applied:false,delta:0,maxDelta:policy.maxDelta,sensitivity,
  healingTakenPer10:h===null||!seconds?null:h*600/seconds,damageTakenPer10:d===null||!seconds?null:d*600/seconds,
  expectedHealing:null,expectedDamage:null,referenceRange:null,healRatio:null,damageRatio:null,adjustedHealRatio:null,
  contribution:contribution(base),peerContribution:null,confidence:0,label:'资源数据不足',reason:null,source:policy.source,
  sourceVerified:false,sourceCaveat:'受治疗来源未拆分，不能认定全部来自队友；承伤不等于抵挡'};
 const skip=reason=>({...info,reason});
 if(base.score===null||!config?.configured||index<0)return skip('缺少可用定位评分或本人阵容记录');
 if(base.coverage<.8||!base.calibrationEligible)return skip('基础表现覆盖或数据一致性不足，不作资源修正');
 if(h===null||d===null)return skip('受治疗量或承伤未返回；不加减分');
 if(seconds<policy.minDuration)return skip('不足两分钟；只展示资源数据，不调整评分');
 const roster=match.players||[];
 if(root.QS?.hasSubstitutes?root.QS.hasSubstitutes(roster,match.gameMode):['T','E'].some(side=>roster.filter(p=>p.side===side).length>5))return skip('含替补；个人参战时长不明，不作资源修正');
 const need=(i,healing)=>{const c=configs[i];if(!c?.configured)return null;return (policy.needs[c.id]??1)*(healing?(policy.selfSustain[c.record?.slug]?.healingNeed??1):1);};
 const allies=roster.map((p,i)=>({p,i})).filter(x=>x.p.side===player.side&&x.i!==index);
 const valid=allies.filter(x=>number(x.p.stats?.healingTaken)!==null&&number(x.p.stats?.damageTaken)!==null&&need(x.i,true)!==null&&rows[x.i]?.coverage>=.8);
 if(valid.length<3||valid.length/allies.length<.75)return skip('至少需要三名同队完整资源参考，且覆盖 ≥75%');
 const hScale=median(valid.map(x=>number(x.p.stats.healingTaken)*600/seconds/need(x.i,true)));
 const dScale=median(valid.map(x=>number(x.p.stats.damageTaken)*600/seconds/need(x.i,false)));
 const expectedH=hScale*need(index,true),expectedD=dScale*need(index,false);
 if(expectedH<300||expectedD<500)return skip('同队治疗或承伤活动太少，不计算比值');
 const ownContribution=info.contribution;
 const peers=roster.map((p,i)=>({p,i})).filter(x=>x.i!==index&&configs[x.i]?.role===config.role&&rows[x.i]?.coverage>=.8&&contribution(rows[x.i])!==null);
 const peerContribution=median(peers.map(x=>contribution(rows[x.i])));
 const teams=['T','E'].map(side=>{const rs=roster.map((p,i)=>({p,i})).filter(x=>x.p.side===side&&rows[x.i]?.coverage>=.8&&rows[x.i]?.score!==null);return rs.length>=3?median(rs.map(x=>rows[x.i].score)):null;});
 const gap=teams.every(v=>v!==null)?Math.abs(teams[0]-teams[1]):null;
 const balance=gap===null?.5:clamp(1-gap/40,.2,1);
 const confidence=valid.length/allies.length*Math.min(1,seconds/300)*balance*(peers.length>=2?1:.6);
 const healRatio=info.healingTakenPer10/expectedH,damageRatio=info.damageTakenPer10/expectedD;
 // Greater actual damage creates legitimate healing demand. Neither tank
 // damage-taking nor healing received is directly rewarded or punished.
 const necessity=clamp(damageRatio,1,2.5),adjusted=healRatio/necessity;
 const survival=(base.groups||[]).find(g=>g.key==='survival')?.score??0;
 const death=(base.metrics||[]).find(m=>m.key==='death')?.score??0;
 const primary=Object.entries(config.override.primary||config.template.primary).every(([key,min])=>base.metrics.find(m=>m.key===key)?.score>=min);
 const comparable=peerContribution!==null&&ownContribution>=peerContribution-5;
 const earn=ownContribution===null?0:clamp((ownContribution-55)/30,0,1);
 const waste=ownContribution===null?0:clamp((60-ownContribution)/25,0,1);
 const low=clamp((policy.lowRatio-healRatio)/policy.lowRatio,0,1);
 const high=clamp((adjusted-policy.highRatio)/policy.highRatio,0,1);
 let delta=0,label='资源与贡献平衡';
 if(low>0&&primary&&survival>=65&&death>=55&&comparable){delta=policy.maxDelta*low*earn*sensitivity*confidence;label='低受治疗 · 贡献达标';}
 else if(high>0&&waste>0){delta=-policy.maxDelta*high*waste*sensitivity*confidence;label='高受治疗 · 贡献偏低';}
 else if(healRatio>policy.highRatio&&damageRatio>1.5){label='承伤需求高 · 不因治疗多扣分';}
 else if(low>0){label='受治疗偏少 · 未满足加分条件';}
 delta=Math.round(clamp(delta,-policy.maxDelta,policy.maxDelta)*100)/100;
 return {...info,applied:Math.abs(delta)>0,delta,expectedHealing:expectedH,expectedDamage:expectedD,
  referenceRange:{min:expectedH*policy.lowRatio,max:expectedH*policy.highRatio},healRatio,damageRatio,adjustedHealRatio:adjusted,
  peerContribution,confidence,balanceFactor:balance,teamGap:gap,label,
  reason:delta?'定位、贡献、生存及同队资源参考综合修正':'符合当前数据口径，但无充分加减分依据'};
}
root.QS_RESOURCES={evaluate,contribution};if(typeof module!=='undefined')module.exports=root.QS_RESOURCES;
})(typeof window!=='undefined'?window:globalThis);
