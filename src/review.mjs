import './shared/core.js';import './shared/benchmarks.js';import './shared/rating-rules.js';import './shared/resource-rating.js';import './shared/performance.js';
import {heroes,maps} from './shared/data.mjs';import {prompt,version} from './prompt.mjs';
import {Fault,canonical,digest} from './security.mjs';
import {statKeys} from './query.mjs';
export const MODEL='deepseek-flash';
export async function prepareReview(snapshot,mid){
 const normalized=globalThis.QS.normalize(snapshot),model=globalThis.QS.build(normalized,{limit:50,side:'all',strategy:'legacy',estimate:true},heroes,(p,m)=>globalThis.QS_PERFORMANCE.evaluate(p,m,heroes,globalThis.QS_BENCHMARKS));
 const m=model.matches.find(m=>m.mid===mid),roster=m?.combatPlayers||m?.players;if(!m?.hasGameData||!m.duration||!roster?.length)throw new Fault('本场缺少有效时长或对局详情');const subject=roster.filter(p=>p.name===snapshot.battletag);if(subject.length!==1)throw new Fault('本场缺少唯一的查询账号');if(!Object.values(subject[0].stats).some(Number.isFinite))throw new Fault('本人战斗数据缺失');
 const labels=roster.map(p=>(p.side==='E'?'对方':'我方')+(heroes[p.hero]?.name||'未知英雄')),counts={},indices={};for(const name of labels)counts[name]=(counts[name]||0)+1;
 const players=roster.map((p,i)=>{indices[labels[i]]=(indices[labels[i]]||0)+1;const r=p.performance||{},resource=r.resource;
  return {alias:p.name===snapshot.battletag?'你':labels[i]+(counts[labels[i]]>1?indices[labels[i]]:''),side:p.side==='E'?'对方':'我方',hero:heroes[p.hero]?.name||'未知英雄',role:heroes[p.hero]?.roleType||'unknown',stats:p.stats,missing:statKeys.filter(k=>p.stats[k]===null),performance:{score:r.score??null,grade:r.grade??null,coverage:r.coverage??null,profile:r.profileName||'通用定位',reason:r.reason||'',groups:(r.groups||[]).map(g=>({label:g.label,score:g.score,weight:g.weight,missing:g.missing})),resource:resource?Object.fromEntries(['delta','confidence','sensitivity','healRatio','damageRatio','adjustedHealRatio','contribution','peerContribution','label','reason','sourceCaveat'].map(k=>[k,resource[k]??null])):null}};
 });
 const payload={map:maps[m.mapGuid]?.name||m.mapName||'未知地图',gameMode:maps[m.mapGuid]?.mode||'未知',resultPerspective:'查询账号',scoreSemantics:'接口目标/阶段进度，攻守视角未确认；胜负以result为准',result:({1:'胜','-1':'负',0:'平或未知'})[m.ret],duration:m.duration,durationUnit:'秒',durationText:Math.floor(m.duration/60)+'分'+Math.floor(m.duration%60)+'秒',statsBasis:'本局真实累计；数量为次数，伤害/治疗为数值，targetCompetingTime为秒',teamScore:m.teamScore,opponentScore:m.opponentScore,shortGame:m.duration<300,substitutes:['T','E'].some(side=>roster.filter(p=>p.side===side).length>5),heroCaveat:'英雄为接口返回值，非核验最长使用英雄',ratingVersion:'2.1',players};
 const fingerprint=await digest(canonical({account:snapshot.battletag,mid,payload,model:MODEL,prompt,version,reasoningEffort:'low'}));return {payload,fingerprint};
}
export async function callReview(env,payload,fingerprint,fetcher=fetch){
 if(!env.DEEPSEEK_KEY)throw new Fault('AI 密钥尚未配置，请联系管理员',503);let response;
 try{response=await fetcher('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.DEEPSEEK_KEY},body:JSON.stringify({model:MODEL,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(payload)}],thinking:{type:'enabled'},reasoning_effort:'low',stream:false,max_tokens:4096})});}catch{throw new Fault('AI 请求超时或网络不可用，请手动重试',504);}
 if(!response.ok)throw new Fault(({401:'AI 密钥无效，请联系管理员',402:'AI 余额不足，请联系管理员',429:'AI 接口限流，请稍后手动重试'})[response.status]||'AI 服务暂不可用，请手动重试',response.status===429?429:502);
 let value;try{value=await response.json();}catch{throw new Fault('AI 返回格式异常',502);}const text=value.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw new Fault('AI 未返回正文，请手动重试',502);
 return {text,model:MODEL,version,generatedAt:new Date().toISOString(),fingerprint,cached:false};
}
