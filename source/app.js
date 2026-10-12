'use strict';
const $=id=>document.getElementById(id);let raw=QS.normalize({battletag:'',matches:[]}),model,activeJob=null,pollTimer=null,chartExpanded=false;
const gameRequests=new Set();
const status=(message,error=false)=>{$('status').textContent=message;$('status').classList.toggle('error',error);};
const options=()=>({limit:Number($('limit').value),side:$('side').value,strategy:$('strategy').value,estimate:$('estimate').checked});
function generate(){
 const selected=model?.matches[Number($('matchSelect').value)]?.mid;
 model=QS.build(raw,options(),QS_DATA.heroes,(p,m)=>QS_PERFORMANCE.evaluate(p,m,QS_DATA.heroes,QS_BENCHMARKS));
 showPersonal();
 const empty=!model.matches.length;
 $('chart').innerHTML=empty?'<div class="empty-state"><strong>查看最近快速对局</strong><span>输入战网昵称，查询并生成你的强度图</span></div>':renderChart(model,QS_ART,$('art').checked,$('title').value||'快速强度图');
 ['png','svg','json'].forEach(id=>$(id).disabled=empty||mapLoading);
 $('chartZoom').disabled=empty;applyChartZoom();
 $('matchSelect').innerHTML=model.matches.map((m,i)=>`<option value="${i}">第 ${i+1} 场 · ${QS.esc(QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图')}</option>`).join('');
 const index=Math.max(0,model.matches.findIndex(m=>m.mid===selected));$('matchSelect').value=String(index);showPlayers(index);$('chart').querySelectorAll('[data-match]').forEach(el=>{const show=()=>{$('matchSelect').value=el.dataset.match;showPlayers(Number(el.dataset.match));};el.addEventListener('click',show);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});});
 queueMapArt();
 const s=model.summary;status(empty?'请输入战网昵称开始查询':`已生成 ${model.matches.length} 场 · ${s.estimated} 场融合估算 · ${s.known}/${s.total} 个玩家位有有效段位${s.errors?' · '+s.errors+' 个查询失败':''}${raw.historyStatus?' · 近期参考 '+raw.historyStatus.playersWithGames+' 人 / '+raw.historyStatus.games+' 场':''}${raw.syncStatus?' · 本次读取 '+raw.syncStatus.fetchedMatches+' 场 / 复用 '+raw.syncStatus.reusedMatches+' 场':''}`);
}
function showPersonal(){
 const report=model.personalPrediction,selected=report.selected;
 const number=n=>Number.isFinite(n)?n.toFixed(1):'—';
 $('personalBody').innerHTML=`<p>对局强度预估 ${number(model.summary.mean)}，预估可信度 ${model.summary.confidencePercent}%（对局证据评分，非命中率）；可查玩家位 ${model.summary.known}/${model.summary.total}；原始可查段位按场次均值 ${number(model.summary.observedMean)}。个人预测仅使用 ${QS.esc(raw.battletag)} 的有效对局，默认展示有效游玩时长最多的职责：${selected?QS.esc(QS.roles[selected.role]):'暂无有效职责'}。环境基准排除本人段位和表现，不受“玩家范围”筛选影响。</p><div class="table-wrap"><table><thead><tr><th>职责</th><th>个人预测</th><th>参考范围</th><th>本人有效场次</th><th>有效样本量</th><th>本人表现均分</th><th>已查本人段位</th><th>限制 / 原因</th></tr></thead><tbody>${report.byRole.map(r=>`<tr><td>${QS.esc(QS.roles[r.role])}${r.role===report.selectedRole?' · 默认':''}</td><td>${r.mean===null?'样本不足':QS.esc(r.rank)+' · '+number(r.mean)}</td><td>${r.range?r.range.min+'—'+r.range.max:'—'}</td><td>${r.games}/${r.availableGames}</td><td>${number(r.effectiveSamples)}</td><td>${number(r.performanceMean)}</td><td>${r.actualRank?QS.esc(r.actualRank.rank)+(r.actualRank.status==='previous'?'（回退）':''):'—'}</td><td>${QS.esc(r.reasons.length?r.reasons.join('；'):r.volatile?'近期预测波动较大':'规则参考，非真实定级')}</td></tr>`).join('')}</tbody></table></div><p>单场预测 = 独立环境基准 × [1 + 35% × 可信系数 × clamp((本人表现−60)/40, −1, 1)]；按职责、近期衰减权重稳健汇总。至少 3 场本人有效对局、有效样本量 ≥2、至少 3 名非本人独立段位锚点才显示预测段位。短局效率不扣表现分，但降低预测可信度。未返回的个人英雄使用时长未核验。</p><details><summary>逐场本人计算与排除记录</summary><div class="table-wrap"><table><thead><tr><th>职责 / 场次</th><th>本人表现</th><th>环境基准</th><th>修正</th><th>本局预测</th><th>环境质量</th><th>非本人锚点</th></tr></thead><tbody>${report.byRole.flatMap(r=>r.records.map(g=>`<tr><td>${QS.esc(QS.roles[r.role])} · ${QS.esc(g.mid.slice(0,8))}</td><td>${number(g.performance)}</td><td>${number(g.context.base)}</td><td>${(g.ratio*100).toFixed(1)}%</td><td>${number(g.value)}</td><td>${(g.context.quality*100).toFixed(0)}%</td><td>${g.context.anchorNames.length}</td></tr>`)).join('')}</tbody></table></div><p>${report.excluded.length?report.excluded.map(e=>QS.esc(e.mid.slice(0,8)+'：'+e.reason)).join('；'):'没有排除本人记录'}。</p></details><p class="hint">预测版本 ${report.version}，未经过真实竞技段位标注校准；范围是规则参考范围，不能解读为统计置信区间。原始个人段位和直方图保持实际查询口径。</p>`;
}
function applyChartZoom(){
 $('chart').style.minWidth=chartExpanded?`${Math.max(1120,(model?.matches.length||0)*100)}px`:(model?.matches.length||0)>10?`${model.matches.length*65}px`:'';
 $('chartZoom').textContent=chartExpanded?'适应宽度':'放大阅读';$('chartZoom').setAttribute('aria-pressed',String(chartExpanded));
 $('zoomHint').textContent=chartExpanded?'左右滑动查看 · 点击场次看依据':'点击场次查看依据';
}
$('chartZoom').onclick=()=>{chartExpanded=!chartExpanded;applyChartZoom();};
function showPlayers(index){
 const m=model.matches[index];
 if(window.QS_REVIEW)window.QS_REVIEW.render(m,raw);
 $('chart').querySelectorAll('.match-hit').forEach(el=>el.setAttribute('aria-pressed',String(Number(el.dataset.match)===index)));
 $('performancePanel').hidden=true;
 const time=m?.duration!==null&&m?.duration!==undefined?` · 时长 ${Math.floor(m.duration/60)}:${String(Math.floor(m.duration%60)).padStart(2,'0')}`:'';
 const score=m&&m.teamScore!==null&&m.opponentScore!==null?` · 比分 ${m.teamScore}:${m.opponentScore}`:'';
 $('matchMeta').textContent=m?`本场强度 ${m.mean===null?'—':m.mean.toFixed(1)} · ${m.estimateSource?'估算：'+m.estimateSource:m.mean===null?'缺少可查段位':'实测可查段位均值（'+m.known.length+'/'+m.players.length+'，不代表完整对局）'}${m.estimateRange?' · 参考范围 '+m.estimateRange.min+'—'+m.estimateRange.max:''}${time}${score}`:'';
 const estimate=m?.estimateDetails,aux=estimate?.auxiliary;
 $('estimateDetail').hidden=!estimate;
 const fixed=v=>Number.isFinite(v)?v.toFixed(1):'—';
 $('estimateDetail').innerHTML=estimate?`<div class="estimate-equation"><div><span>${estimate.unanchored?'动态规则参考':'段位融合参考'}</span><strong>${fixed(estimate.rankBase)}</strong><small>${estimate.rankSamples} 名独立参考 · 近期补充 ${estimate.historySamples} 名</small></div><span class="equation-sign" aria-hidden="true">+</span><div><span>战斗修正</span><strong>${aux.delta>=0?'+':''}${fixed(aux.delta)}</strong><small>实际 ${(aux.relativeDelta*100).toFixed(1)}% · 上限 ±35%</small></div><span class="equation-sign" aria-hidden="true">≈</span><div><span>本场融合估值</span><strong class="estimate-final">${fixed(m.mean)}</strong><small>证据评分 ${m.confidenceEvidence.percent}% · 非实测段位</small></div></div><p>${QS.esc(m.estimateSource)}；原始可查均值 ${fixed(m.observedMean)}（${m.known.length}/${m.players.length}）；本场 ${estimate.recentPlayers} 名玩家已补近期 ${estimate.recentGames} 场参考。${estimate.unanchored?'无段位锚点：分值使用表现映射规则，不能解读为真实段位。':''}${aux.reason?QS.esc(aux.reason)+'。':''}个人缺失段位保持 —，参考范围不是置信区间。</p><p>范围 ${m.estimateRange?m.estimateRange.min+'—'+m.estimateRange.max:'—'} · 本场独立参考 ${estimate.rangeDetails.localSamples} 名（直接 ${estimate.rangeDetails.directSamples} / 近期 ${estimate.rangeDetails.recentSamples}）· 有效样本 ${estimate.rangeDetails.effectiveLocalSamples.toFixed(2)} · 本场段位证据 ${(estimate.rangeDetails.localQuality*100).toFixed(0)}% · 战斗证据 ${((estimate.combatQuality||0)*100).toFixed(0)}%；证据多且一致则收窄，缺少依据或双方悬殊则放宽。</p><p class="combat-balance">${aux.teamScores?.length?`我方表现 ${fixed(aux.teamScores[0].score)} / 对方表现 ${fixed(aux.teamScores[1].score)} · 差距 ${fixed(aux.teamGap)} · 均衡 ${aux.balanceFactor.toFixed(2)} · 一致性 ${aux.consistencyFactor.toFixed(2)} · 悬殊下调 ${(aux.imbalanceRatio*100).toFixed(1)}% · ${QS.esc(aux.context)}`:QS.esc(aux.reason||'缺少双方表现数据')}</p>`:'';

 const snapshot=p=>{const stamp=p.res.rankQueriedAt;if(!stamp||stamp===raw.queriedAt)return '';const date=new Date(stamp);return Number.isFinite(date.getTime())?' · 快照 '+date.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'}):'';};
 const value=v=>v===null||v===undefined?'—':v.toLocaleString('zh-CN',{maximumFractionDigits:0});
 $('players').innerHTML=m?m.players.map((p,index)=>{const hero=QS_DATA.heroes[p.hero],icon=window.QS_HERO_ICONS?.[p.hero];return `<tr><td class="${p.name===raw.battletag?'player-self':''}">${QS.esc(p.name)}</td><td><span class="team-label ${p.side==='E'?'enemy':''}">${p.side==='E'?'对方':'我方'}</span></td><td><div class="hero-cell">${icon?`<img src="${QS.esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<span>${QS.esc(hero?.name||'未知英雄')}<small>${QS.esc(QS.roles[p.role]||'未知职责')} · ${QS.esc(p.performance?.profileName||'通用定位')}</small></span></div></td><td>${value(p.stats.kill)} / ${value(p.stats.assist)} / ${value(p.stats.death)}</td><td>${value(p.stats.finalHit)}</td><td>${value(p.stats.soloKill)}</td><td>${value(p.stats.heroDamage)}</td><td>${value(p.stats.cure)}</td><td>${value(p.stats.resistDamage)}</td><td>${value(p.stats.healingTaken)}</td><td>${value(p.stats.damageTaken)}</td><td class="${p.score===null?'muted':'rank-pill'}">${p.score===null?'—':QS.rank(p.score)}</td><td>${p.score??'—'}</td><td class="muted">${QS.esc(QS.states[p.status])}${QS.esc(snapshot(p))}${p.status==='invalid_score'?' ('+QS.esc(p.rawScore)+')':''}${p.status==='previous'?' '+QS.esc(p.season):''}${(model.options.strategy==='highest'||p.crossRole)&&p.rankRole?(p.crossRole?' / 跨职责参考：':' / ')+QS.esc(QS.roles[p.rankRole]||p.rankRole):''}</td>${performanceCell(p,index)}</tr>`;}).join(''):'<tr><td colspan="15">查询后显示本局玩家、英雄与游戏数据</td></tr>';
 document.querySelectorAll('.hero-cell img').forEach(img=>img.addEventListener('error',()=>img.hidden=true,{once:true}));
 $('players').querySelectorAll('[data-performance]').forEach(button=>button.onclick=()=>showPerformance(m.players[Number(button.dataset.performance)]));
 $('gameDataStatus').textContent=m?.hasGameData?(m.resourceDataChecked?'英雄为接口返回值；受治疗未拆分来源，承伤与抵挡不同；— 表示未返回。':'正在补齐本场受治疗与承伤数据…'):m?'正在读取本场游戏数据…':'游戏数据来自对局详情';
 $('gameDataStatus').classList.remove('error');$('retryGameData').hidden=true;
 if(m&&(!m.hasGameData||!m.resourceDataChecked))loadGameData(m);
}
function performanceCell(p,index){
 const r=p.performance;
 if(!r.grade)return `<td class="performance-cell"><span class="muted" title="${QS.esc(r.reason)}">待评</span><small>${QS.esc(r.reason)}</small></td>`;
 return `<td class="performance-cell"><button type="button" class="grade grade-${r.grade}" data-performance="${index}" aria-label="查看 ${QS.esc(p.name)} 的 ${r.grade} 级表现评分明细" title="${QS.esc(r.hero)} · ${r.score} 分 · ${QS.esc(r.reference)}；点击查看指标">${r.grade}<span>${r.score.toFixed(1)}</span></button><small>整局估评</small></td>`;
}
function showPerformance(p){
 const r=p.performance,format=n=>n===null||n===undefined?'—':n.toLocaleString('zh-CN',{maximumFractionDigits:2});
 $('performancePanel').innerHTML=`<div class="performance-head"><h3>${QS.esc(p.name)} · ${QS.esc(r.hero)} <span class="grade grade-${r.grade}">${r.grade} · ${r.score.toFixed(1)}</span></h3><button id="closePerformance" type="button">收起</button></div><p>${QS.esc(r.profileName)} · 默认标签 ${QS.esc(r.playstyle)} · ${QS.esc(r.reference)} · 数据覆盖 ${Math.round(r.coverage*100)}% · B 为接近基准，阵亡指标反向计分。K/D 使用每 10 分钟击杀 ÷（每 10 分钟阵亡 + 1）。</p><div class="rating-groups">${r.groups.map(g=>`<span>${QS.esc(g.label)} <strong>${g.score.toFixed(1)}</strong> · ${(g.weight*100).toFixed(0)}%${g.missing?'（中性参考）':''}</span>`).join('')}</div><div class="rating-metrics"><table><thead><tr><th>指标</th><th>本局 / 10 分钟</th><th>参考 / 10 分钟</th><th>单项分</th><th>权重</th><th>参考来源</th></tr></thead><tbody>${r.metrics.map(item=>`<tr><td>${item.label}</td><td>${format(item.value)}${item.key==='kd'?'（比值）':''}</td><td>${format(item.baseline)}${item.key==='kd'?'（比值）':''}</td><td>${item.score.toFixed(1)}</td><td>${(item.weight*100).toFixed(1)}%</td><td>${QS.esc(item.baselineSource)}</td></tr>`).join('')}</tbody></table></div><p class="rating-warning">${r.warnings.map(QS.esc).join('；')}。</p><p class="hint">基准：<a href="${QS.esc(r.source)}" target="_blank" rel="noreferrer">Counterwatch · 定位中位数参考</a>${r.matches?' · 页面对局数 '+format(r.matches):''}${r.sourceUpdated?' · 页面更新 '+QS.esc(r.sourceUpdated):''} · 本地快照 ${QS.esc(r.benchmarkVersion)}。基础指标取 5v5 全段位社区快照；收尾指标另用规则比例参考，非国服快速专属样本；评分版本 ${r.version}，不是段位或 MMR。</p>`;
  if(r.resource){const x=r.resource,formatResource=v=>Number.isFinite(v)?v.toFixed(1):'—';$('performancePanel').innerHTML+=`<div class="resource-rating"><h4>资源效率辅助 · 上限 ±${x.maxDelta} 分</h4><p>基础表现 ${formatResource(r.baseScore)} + 资源修正 ${x.delta>=0?'+':''}${formatResource(x.delta)} = 最终表现 ${formatResource(r.score)}；${QS.esc(x.label)}。</p><p>受治疗 / 10 分钟 ${formatResource(x.healingTakenPer10)} · 承伤 / 10 分钟 ${formatResource(x.damageTakenPer10)} · 定位参考带 ${x.referenceRange?formatResource(x.referenceRange.min)+'—'+formatResource(x.referenceRange.max):'—'} · 英雄敏感度 ${formatResource(x.sensitivity)} · 证据系数 ${formatResource(x.confidence)}。</p><p>${QS.esc(x.reason||'')}；${QS.esc(x.sourceCaveat)}。${QS.esc(x.source)}。</p></div>`;}
$('performancePanel').hidden=false;$('performancePanel').scrollIntoView({block:'nearest'});$('closePerformance').onclick=()=>{$('performancePanel').hidden=true;};
}
function download(blob,name){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function fileName(ext){return (raw.battletag||'quick-strength').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'-快速强度图.'+ext;}
function svgBlob(){const svg=$('chart').querySelector('svg').cloneNode(true);svg.querySelectorAll('.match-hit').forEach(el=>el.remove());return new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'});}
$('png').onclick=async()=>{
 const source=$('chart').querySelector('svg'),width=Number(source.getAttribute('width'))*2,height=Number(source.getAttribute('height'))*2;
 $('png').disabled=true;status(`正在导出 ${width} × ${height} 高清 PNG…`);
 let url;
 try{const image=new Image();url=URL.createObjectURL(svgBlob());await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('SVG 图片解码失败'));image.src=url;});const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败');download(blob,fileName('png'));status('已导出高清 PNG');}catch(e){status('导出失败：'+e.message,true);}finally{if(url)URL.revokeObjectURL(url);$('png').disabled=false;}
};
$('svg').onclick=()=>{download(svgBlob(),fileName('svg'));status('已导出可缩放 SVG');};
$('json').onclick=()=>{const exportData={...raw,visualization:{title:$('title').value,chartVersion:QS_CHART_VERSION,options:model.options,summary:model.summary,confidence:model.confidence,algorithmVersion:model.algorithmVersion,aggregation:model.aggregation,personalPrediction:model.personalPrediction,points:model.matches.map(m=>({mid:m.mid,mean:m.mean,observedMean:m.observedMean,confidenceEvidence:m.confidenceEvidence,estimateSource:m.estimateSource,estimateDetails:m.estimateDetails||null,estimateRange:m.estimateRange||null,roleRange:m.roleRange,allRoleRange:m.allRoleRange,performances:m.players.map(p=>({name:p.name,side:p.side,heroGuid:p.hero,...p.performance}))})),performanceVersion:QS_PERFORMANCE.version,benchmarkVersion:QS_BENCHMARKS.version}};download(new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'}),fileName('json'));status('已导出原始数据与估算来源 JSON（不含查询凭据）');};
['limit','side','strategy','estimate','art'].forEach(id=>$(id).onchange=()=>{mapAttempts.clear();generate();});
let redrawTimer=null;$('title').oninput=()=>{clearTimeout(redrawTimer);redrawTimer=setTimeout(generate,150);};$('matchSelect').onchange=()=>showPlayers(Number($('matchSelect').value));
async function request(path,body){
 if(location.protocol==='file:')throw Error('在线查询需要本地服务，请双击“启动工具.cmd”');
 const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});let data;try{data=await response.json();}catch{throw Error('本地服务未启动或返回格式异常');}if(!response.ok)throw Error(data.error||'请求失败');return data;
}
function busy(value){$('query').disabled=value;$('cancel').hidden=!value;}
async function poll(){
 if(!activeJob)return;try{const job=await request('/api/job/'+activeJob);status(job.message||'查询中…');if(job.state==='done'){raw=QS.normalize(job.result);activeJob=null;busy(false);generate();status('查询完成 · '+job.message+(raw.historyStatus?` · 近期 ${raw.historyStatus.playersWithGames} 人 / ${raw.historyStatus.games} 场 · 缓存 ${raw.historyStatus.cacheHits} · ${raw.historyStatus.requests} 次额外请求`:''));}else if(job.state==='failed'||job.state==='cancelled'){activeJob=null;busy(false);status(job.message,job.state==='failed');}else pollTimer=setTimeout(poll,1000);}catch(e){activeJob=null;busy(false);status(e.message,true);}
}
$('onlinePanel').onsubmit=async e=>{
 e.preventDefault();if(activeJob)return;
 const payload={recentHistory:true,battletag:$('battleTag').value.trim(),roleId:$('roleId').value.trim(),token:$('token').value.trim(),dts:$('dts').value.trim(),server:$('serverId').value.trim(),limit:Math.min(Number($('limit').value),20)};
 try{if(!payload.battletag.includes('#'))throw Error('请输入完整战网昵称（昵称#编号）');if(!$('useSaved').checked&&(!payload.roleId||!payload.token))throw Error('请展开“大神查询凭据”填写 Role ID 和 Token');payload.useSaved=$('useSaved').checked;if(!payload.useSaved&&$('remember').checked)await request('/api/credentials/save',payload);busy(true);status('正在建立查询…');const result=await request('/api/query',payload);activeJob=result.id;$('token').value='';$('credentialJson').value='';await credentialState();poll();}catch(e){busy(false);status(e.message,true);}finally{payload.token='';}
};
$('cancel').onclick=async()=>{if(activeJob){try{await request('/api/job/'+activeJob+'/cancel',{});status('已请求停止，正在结束当前请求…');}catch(e){status(e.message,true);}}};
const mapAttempts=new Set();let mapLoading=false;
function queueMapArt(){
 if(!$('art').checked||mapLoading||location.protocol==='file:')return;
 const needed=[...new Set(model.matches.map(m=>m.mapGuid))].filter(g=>g&&!QS_ART[g]&&!mapAttempts.has(g));
 if(!needed.length)return;
 needed.forEach(g=>mapAttempts.add(g));mapLoading=true;$('png').disabled=true;$('svg').disabled=true;
 request('/api/map-art',{maps:needed}).then(result=>{Object.assign(QS_ART,result.images);}).catch(()=>{}).finally(()=>{mapLoading=false;generate();});
}

generate();

function credentialPayload(){return {battletag:$('battleTag').value.trim(),roleId:$('roleId').value.trim(),token:$('token').value.trim(),dts:$('dts').value.trim(),server:$('serverId').value.trim(),useSaved:$('useSaved').checked};}
async function credentialState(){try{const saved=await request('/api/credentials');$('credentialStatus').textContent=(saved.saved?'本机已加密保存 · ':'本机尚未保存 · ')+saved.message;$('useSaved').checked=saved.saved;$('token').placeholder=saved.saved?'已加密保存，无需重复填写':'大神查询 Token';$('tokenSavedHint').textContent=saved.saved?'已保存 Token 不回填到网页。直接使用本机已保存凭证即可；此输入框仅用于替换新 Token。':'尚未保存 Token，请填写后加密保存。';if(saved.saved){$('roleId').value=saved.roleId;$('dts').value=saved.dts;$('serverId').value=saved.server;}}catch(e){$('credentialStatus').textContent=e.message;}}
$('credentialJson').oninput=()=>{try{const d=JSON.parse($('credentialJson').value);if(d.result)Object.assign(d,d.result);if(d.roleId&&d.token){$('roleId').value=d.roleId;$('token').value=d.token;$('dts').value=d.dts||d.day||'2026';$('serverId').value=d.server||'1';$('useSaved').checked=false;}}catch{}};
$('token').oninput=()=>{$('useSaved').checked=false;};
$('saveCredentials').onclick=async()=>{try{await request('/api/credentials/save',{...credentialPayload(),useSaved:false});$('token').value='';$('credentialJson').value='';await credentialState();status('凭证已用 Windows 当前账户加密保存');}catch(e){status(e.message,true);}};
$('checkCredentials').onclick=async()=>{try{$('checkCredentials').disabled=true;status('正在检测凭证…');const d=await request('/api/credentials/check',credentialPayload());status(d.message);await credentialState();}catch(e){status(e.message,true);await credentialState();}finally{$('checkCredentials').disabled=false;}};
$('clearCredentials').onclick=async()=>{try{await request('/api/credentials/clear',{});$('token').value='';$('credentialJson').value='';await credentialState();status('已清除本机保存的凭证');}catch(e){status(e.message,true);}};
$('loginPage').onclick=()=>window.open('https://ds.163.com/','_blank','noopener');
$('copyTokenScript').onclick=async()=>{try{const role=$('roleId').value.trim();if(!/^\d+$/.test(role))throw Error('请先填写 Role ID，再复制取凭证脚本');const source=await (await fetch('/browser-token.js')).text();await navigator.clipboard.writeText(source.replace('YOUR_ROLE_ID',role));status('已复制脚本，请在已登录的大神页面 F12 Console 运行');}catch(e){status('复制失败：'+e.message,true);}};
async function loadGameData(match){
 const tag=raw.battletag,key=tag+'|'+match.mid;if(gameRequests.has(key))return;
 const payload={...credentialPayload(),battletag:tag,matchId:match.mid};gameRequests.add(key);
 try{
  const data=await request('/api/match-data',payload);
  if(raw.battletag!==tag)return;
  const target=raw.matches.find(m=>m.mid===match.mid);if(!target)return;
  const remaining=[...data.players];
  target.players.forEach(p=>{const i=remaining.findIndex(d=>d.name===p.name&&d.side===p.side&&d.hero===p.hero);if(i>=0)p.stats=remaining.splice(i,1)[0].stats;});
  Object.assign(target,{duration:data.duration,teamScore:data.teamScore,opponentScore:data.opponentScore,hasGameData:true,resourceDataChecked:!!data.resourceDataChecked,dataQueriedAt:data.dataQueriedAt||target.dataQueriedAt});
  generate();
 }catch(e){
  if(raw.battletag===tag&&model.matches[Number($('matchSelect').value)]?.mid===match.mid){$('gameDataStatus').textContent='本场游戏数据未能读取：'+e.message;$('gameDataStatus').classList.add('error');$('retryGameData').hidden=false;}
 }finally{gameRequests.delete(key);payload.token='';}
}
$('retryGameData').onclick=()=>{const m=model.matches[Number($('matchSelect').value)];if(m){$('retryGameData').hidden=true;$('gameDataStatus').textContent='正在读取本场游戏数据…';loadGameData(m);}};
$('credentials').open=false;
(async()=>{await credentialState();try{const latest=await request('/api/latest');if(latest.result){raw=QS.normalize(latest.result);$('battleTag').value=raw.battletag;generate();}if(latest.activeJob){activeJob=latest.activeJob;busy(true);poll();}}catch(e){status('读取最近查询失败：'+e.message,true);}})();
