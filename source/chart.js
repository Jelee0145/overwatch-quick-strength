'use strict';
const QS_CHART_VERSION='3.4.1';
// The renderer owns no DOM, network or mutable global dependencies.
function createChartService({core:QS,maps={},avatar='',rankArt={}}){
 const QS_DATA={maps},QS_AVATAR=avatar,QS_RANK_ART=rankArt;
function renderChart(model,art,showArt,title){
 const {esc,rank,bands}=QS,s=model.summary,matches=model.matches,n=matches.length,statsMatches=model.statsMatches||matches,statsCount=statsMatches.length;
 const W=Math.max(1440,n*120+220),H=1100,left=136,right=W-72,top=256,bottom=698,cw=(right-left)/Math.max(1,n);
 const ink='#eff3f7',muted='#93a2b3',observed='#82e4df',estimated='#ffb466',grid='#34404c';
 const colors=['#c89071','#aeb8c4','#e2bb63','#92c9b3','#47cba4','#72a7dc','#a1cc78','#aa9bc9','#ba9bd4'];
 const values=matches.flatMap(m=>[...m.scores,...m.allRoleScores,...(m.estimateRange?[m.estimateRange.min,m.estimateRange.max]:[]),...(m.mean!==null?[m.mean]:[])]).filter(Number.isFinite);
 let lo=values.length?Math.max(500,Math.floor((Math.min(...values)-100)/500)*500):500,hi=values.length?Math.min(5000,Math.ceil((Math.max(...values)+150)/500)*500):3000;
 if(hi<=lo)hi=Math.min(5000,lo+500);
 if(model.plotScale&&Number.isFinite(model.plotScale.min)&&Number.isFinite(model.plotScale.max)&&model.plotScale.max>model.plotScale.min){lo=model.plotScale.min;hi=model.plotScale.max;}
 const y=v=>bottom-(v-lo)/(hi-lo)*(bottom-top),center=i=>left+(i+.5)*cw;
 const z=[],text=(x,y,t,size=16,color=muted,extra='')=>z.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(t)}</text>`);
 const line=(x1,y1,x2,y2,stroke,w=1,extra='')=>z.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}" ${extra}/>`);
 const rect=(x,y,w,h,fill,extra='')=>z.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`);
 const panel=(x,y,w,h)=>rect(x,y,w,h,'#151d27','rx="10" stroke="#303b47"');
 const value=v=>Number.isFinite(v)?v.toFixed(1):'—',pointValue=v=>Number.isFinite(v)?Math.round(v):'—';
 const observedMatches=statsMatches.filter(m=>m.observedMean!==null).length,metricStart=425,metricWidth=(W-metricStart-46)/3;
 z.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(title)}：顶部为强度预估、个人段位预测和预估可信度；轨迹青色为实测，橙色为估算" data-chart-version="${QS_CHART_VERSION}" style="font-family:Microsoft YaHei,PingFang SC,sans-serif;font-variant-numeric:tabular-nums"><defs>
 <linearGradient id="chart-back" x2="1" y2="1"><stop stop-color="#27303a"/><stop offset="1" stop-color="#111822"/></linearGradient>
 <linearGradient id="map-shade" x2="0" y2="1"><stop stop-color="#121b26" stop-opacity=".26"/><stop offset=".55" stop-color="#121b26" stop-opacity=".50"/><stop offset="1" stop-color="#121b26" stop-opacity=".93"/></linearGradient>
 <radialGradient id="orange-halo"><stop stop-color="#f58220" stop-opacity=".13"/><stop offset="1" stop-color="#f58220" stop-opacity="0"/></radialGradient>
 <pattern id="estimate-hatch" width="9" height="9" patternUnits="userSpaceOnUse"><path d="M-1 1l10 10M8 -1l2 2" stroke="${estimated}" stroke-width="1" opacity=".10"/></pattern>
 <clipPath id="chart-avatar"><circle cx="93" cy="91" r="32"/></clipPath><clipPath id="chart-name"><rect x="143" y="55" width="245" height="76"/></clipPath></defs>`);
 rect(0,0,W,H,'url(#chart-back)');z.push('<ellipse cx="405" cy="72" rx="340" ry="140" fill="url(#orange-halo)"/>');
 // Cut corners and registration marks give the chart a restrained OW HUD character.
 z.push(`<path d="M24 38V24h32M${W-56} 24h32v14M24 ${H-38}v14h32M${W-56} ${H-24}h32v-14" fill="none" stroke="#68727d" stroke-width="1" opacity=".55"/>`);
 panel(34,34,W-68,150);rect(34,58,3,38,'#f58220');
 z.push('<circle cx="93" cy="91" r="35" fill="#2f3b46" stroke="#f6b06f" stroke-width="1.5"/>');
 if(typeof QS_AVATAR!=='undefined'&&QS_AVATAR)z.push(`<image href="${esc(QS_AVATAR)}" x="61" y="59" width="64" height="64" clip-path="url(#chart-avatar)"/>`);else text(93,102,'Q',30,ink,'text-anchor="middle"');
 const [name,tag]=model.battletag.split('#');
 z.push(`<g clip-path="url(#chart-name)"><title>${esc(model.battletag)}</title>`);text(145,88,name||'快速对局',28,ink,'font-weight="700"');text(145,113,tag?'#'+tag:'快速对局记录',15,muted);z.push('</g>');
 const caption=title||'快速强度图';text(61,156,caption.length>18?caption.slice(0,18)+'…':caption,15,'#c8d0d9');text(387,156,`${n} 场`,15,muted,'text-anchor="end"');
 const rolesLabel=r=>QS.roles[r]||'未知职责';
 const personal=model.personalPrediction?.selected;
 const metrics=[
  {x:metricStart,label:'强度预估',number:s.mean,color:s.unanchored?muted:s.estimated?estimated:observed,detail:s.unanchored?'动态规则参考 · 缺少段位依据':`${rank(s.mean)} · ${statsCount} 场 / ${s.estimated} 场融合`},
  {x:metricStart+metricWidth,label:'个人段位预测',number:personal?.mean??null,color:observed,detail:personal?.mean!==null&&personal?.mean!==undefined?`${rolesLabel(personal.role)} · ${personal.rank}`:`${personal?rolesLabel(personal.role)+' · ':''}样本不足${personal?' · '+personal.games+'/3 场':''}`}

 ];
 metrics.forEach((m,i)=>{line(m.x-20,60,m.x-20,158,grid);text(m.x,71,m.label,15,muted);text(m.x,114,i===1&&m.number===null?'样本不足':value(m.number),i===1&&m.number===null?28:38,m.color,'font-weight="700"');text(m.x,143,m.detail,14,'#c0c9d3');if(i===1&&personal?.range)text(m.x,164,`参考 ${personal.range.min}–${personal.range.max} · ${personal.games} 场 / 有效 ${personal.effectiveSamples.toFixed(1)}`,12,muted);
  if((i===0&&!s.unanchored&&Number.isFinite(s.mean)||i===1&&Number.isFinite(personal?.mean))&&typeof QS_RANK_ART!=='undefined'){
   const icon=QS_RANK_ART[Math.min(8,Math.max(0,Math.floor((m.number-500)/500)))];
   if(icon)z.push(`<image href="${esc(icon)}" x="${m.x+metricWidth-88}" y="84" width="50" height="50" preserveAspectRatio="xMidYMid meet"><title>${esc(rank(m.number))} 官方段位图标</title></image>`);
  }
 });
 const confidenceX=metricStart+metricWidth*2,confidence=s.confidencePercent??0;
 z.push('<g><title>对局强度预估的证据完整与稳定性评分，非预测命中率；独立段位、职责覆盖、时效及战斗数据共同计算。</title>');
 line(confidenceX-20,60,confidenceX-20,158,grid);text(confidenceX,71,'预估可信度',15,muted);text(confidenceX,114,`${confidence}%`,38,ink,'font-weight="600"');
 rect(confidenceX,128,metricWidth-45,5,'#343e49','rx="2"');rect(confidenceX,128,(metricWidth-45)*confidence/100,5,observed,'rx="2"');text(confidenceX,156,'对局证据评分',14,muted);z.push('</g>');
 panel(34,200,W-68,619);text(61,232,'对局强度轨迹',21,ink,'font-weight="600"');text(right,231,'青色＝实测  /  橙色＝估算  /  范围不代表置信区间',14,muted,'text-anchor="end"');
 // Map columns set the atmosphere; an overlay keeps every data mark legible.
 matches.forEach((m,i)=>{
  const x=left+i*cw+3,width=cw-6,c=center(i),win=m.ret===1?'#71c7a9':m.ret===-1?'#d77a79':'#8b95a2';
  rect(x,top,width,bottom-top,'#1a2531','rx="3"');
  if(showArt&&art[m.mapGuid]){z.push(`<image href="${esc(art[m.mapGuid])}" x="${x}" y="${top}" width="${width}" height="${bottom-top}" preserveAspectRatio="xMidYMid slice" opacity=".56"/>`);rect(x,top,width,bottom-top,'url(#map-shade)');}
  rect(x,top,width,3,win);text(x+9,279,String(i+1).padStart(2,'0'),12,muted);text(c,279,m.ret===1?'胜':m.ret===-1?'负':'平 / 未知',13,win,'text-anchor="middle"');
 });
 for(let v=lo;v<=hi;v+=500){line(left,y(v),right,y(v),grid,1,'opacity=".65"');text(left-18,y(v)+6,v===5000?'5000':rank(v),17,'#acb7c4','text-anchor="end"');}
 matches.forEach((m,i)=>{
  const c=center(i),x=left+i*cw+3,width=cw-6;
  if(m.allRoleRange){const r=m.allRoleRange;line(c+22,y(r.min),c+22,y(r.max),'#afbdcc',2,'opacity=".7"');line(c+18,y(r.min),c+26,y(r.min),'#afbdcc',1);line(c+18,y(r.max),c+26,y(r.max),'#afbdcc',1);}
  if(m.roleRange){const r=m.roleRange,yy=y(r.max),height=y(r.min)-yy;
   if(height<1)line(c-14,yy,c+14,yy,observed,3);else rect(c-14,yy,28,height,'#82e4df12',`rx="2" stroke="${observed}" stroke-width="2.5"`);
  }
  if(m.observedMean!==null&&m.estimateSource){z.push(`<circle class="raw-observed-point" cx="${c}" cy="${y(m.observedMean)}" r="4" fill="#15212b" stroke="${observed}" stroke-width="1.5"/>`);}
  if(m.estimateRange){const r=m.estimateRange,yy=y(r.max);rect(c-14,yy,28,y(r.min)-yy,'url(#estimate-hatch)',`rx="2" stroke="${estimated}" stroke-width="2.5"`);}
  const groups=new Map();m.known.forEach(p=>groups.set(p.score,(groups.get(p.score)||0)+1));groups.forEach((count,score)=>line(c-14,y(score),c+14,y(score),observed,2+Math.min(3,count)));
  const map=QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图';text(c,731,map.length>7?map.slice(0,6)+'…':map,Math.min(16,cw/7.7),ink,'text-anchor="middle"');
  let date='时间未知';if(m.t&&Number.isFinite(m.t)){try{date=new Date(m.t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}catch{}}
  text(c,754,date,13,muted,'text-anchor="middle"');
  const label=m.estimateSource?(m.estimateDetails?.unanchored?'动态规则参考':'融合估算'):m.mean===null?'暂无段位':`实测 ${m.known.length}/${m.players.length}`;
  const aux=m.estimateDetails?.auxiliary;
  const tip=`${map} · ${m.mean===null?'暂无强度':value(m.mean)} · ${m.estimateSource||'可查段位均值'} · 可查 ${m.known.length}/${m.players.length}${m.estimateRange?` · 参考范围 ${m.estimateRange.min}–${m.estimateRange.max}`:''}${aux?` · 段位基准 ${value(m.estimateDetails.rankBase)} · 修正比例 ${(aux.relativeDelta*100).toFixed(1)}%，修正 ${aux.delta>=0?'+':''}${value(aux.delta)} 点`:''}。点击查看本场详情`;
  z.push(`<rect class="match-hit" data-match="${i}" aria-pressed="false" x="${x}" y="${top}" width="${width}" height="554" rx="3" fill="transparent" tabindex="0" role="button" aria-label="查看第 ${i+1} 场玩家明细：${esc(map)}，${esc(label)}，强度 ${value(m.mean)}"><title>${esc(tip)}</title></rect>`);
 });
 // Shared geometry, provenance colors; straight segments never invent a curve.
 for(let i=1;i<n;i++){
  const a=matches[i-1],b=matches[i];if(a.mean===null||b.mean===null)continue;
  const isEstimate=!!(a.estimateSource||b.estimateSource),color=isEstimate?estimated:observed,attrs='pointer-events="none"';
  line(center(i-1),y(a.mean),center(i),y(b.mean),color,9,'opacity=".05" pointer-events="none"');line(center(i-1),y(a.mean),center(i),y(b.mean),color,2.7,attrs);
 }
 matches.forEach((m,i)=>{
  const c=center(i);if(m.mean===null){text(c,470,'无可查样本',14,muted,'text-anchor="middle" pointer-events="none"');return;}
  const py=y(m.mean),isEstimate=!!m.estimateSource;
  z.push(`<circle class="${isEstimate?'estimated-point':'observed-point'}" data-value="${m.mean}" cx="${c}" cy="${py}" r="6" fill="${isEstimate?estimated:observed}" stroke="#15212b" stroke-width="2" pointer-events="none"/>`);
  text(c,Math.max(top+43,py-16),pointValue(m.mean),19,isEstimate?estimated:observed,'text-anchor="middle" font-weight="650" stroke="#14202b" stroke-width="4" paint-order="stroke" pointer-events="none"');
 });
 panel(34,837,W-68,102);text(61,865,'实测段位分布',17,ink);text(W-61,865,`${s.known} 个可查玩家位 · 玩家位均值 ${value(s.playerMean)} · 不含估算`,14,muted,'text-anchor="end"');
 const bins=Array(45).fill(0);statsMatches.flatMap(m=>m.scores).forEach(v=>bins[Math.min(44,Math.max(0,Math.floor((v-500)/100)))]++);
 const peak=Math.max(1,...bins),bw=(W-126)/45;
 bins.forEach((count,i)=>{const x=63+i*bw+2;rect(x,910-(count?count/peak*31:1),bw-4,count?count/peak*31:1,colors[Math.floor(i/5)],'rx="1"');});bands.forEach((b,i)=>text(63+(i*5+2.5)*bw,929,b,14,colors[i],'text-anchor="middle"'));
 panel(34,957,W-68,110);
 const legendStart=65,step=(W-130)/5;
 [0,1,2,3,4].forEach(i=>{
  const x=legendStart+i*step;
  if(i===0){line(x,986,x+30,986,observed,2.5);z.push(`<circle cx="${x+15}" cy="986" r="4.5" fill="${observed}"/>`);}
  if(i===1){line(x,986,x+30,986,estimated,2.5);z.push(`<circle cx="${x+15}" cy="986" r="4.5" fill="${estimated}"/>`);}
  if(i===2)rect(x+5,978,20,16,'none',`rx="1" stroke="${observed}" stroke-width="2"`);
  if(i===3){line(x+15,977,x+15,995,'#afbdcc',2);line(x+10,977,x+20,977,'#afbdcc');line(x+10,995,x+20,995,'#afbdcc');}
  if(i===4)rect(x+5,978,20,16,'url(#estimate-hatch)',`rx="1" stroke="${estimated}" stroke-width="2"`);
  text(x+40,992,['实测均值','融合估值','本局职责范围','全部职责范围','估算参考范围'][i],15,'#d3dbe4');
 });
 text(65,1023,'实测是可查竞技段位的样本均值；融合估算补充稀疏场次，未知玩家不分配段位。',14,muted);
 text(65,1049,`${model.source.slice(0,30)} · 非真实快速 MMR · 按时间从早到晚`,12,'#8593a4');text(W-65,1049,`展示 v${QS_CHART_VERSION}  /  估算 v${model.algorithmVersion}  /  战斗修正 ±35% · 个人预测 v1.0`,12,'#8593a4','text-anchor="end"');
 z.push('</svg>');return z.join('');
}
 return Object.freeze({render(model,{art={},showArt=true,title='快速强度图'}={}){return renderChart(model,art,showArt,title);}});
}
globalThis.OWQS_CREATE_CHART_SERVICE=createChartService;
// Preserve the browser's existing four-argument entry point.
function renderChart(model,art,showArt,title){
 return createChartService({core:QS,maps:QS_DATA.maps,avatar:typeof QS_AVATAR==='undefined'?'':QS_AVATAR,rankArt:typeof QS_RANK_ART==='undefined'?{}:QS_RANK_ART}).render(model,{art,showArt,title});
}
