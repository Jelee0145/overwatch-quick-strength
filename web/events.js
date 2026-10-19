'use strict';
(()=>{
 const $=id=>document.getElementById(id),model=window.EventsModel;
 const dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const timeFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const dateFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'});
 let snapshot=null,view='scheduled',busy=false,requestId=0,retryTimer,queryTimer;
 const scope=()=>new URLSearchParams({series:$('eventsSeries').value,...($('eventsFrom').value&&$('eventsTo').value?{from:$('eventsFrom').value,to:$('eventsTo').value}:{})});
 const filters=()=>({view,series:$('eventsSeries').value,from:$('eventsFrom').value,to:$('eventsTo').value,tournament:$('eventsTournament').value,region:$('eventsRegion').value,team:$('eventsTeam').value});
 function element(tag,className,value){const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;}
 function teamLabel(team,left){
  const label=element('span','event-team'+(left?' event-team-left':'')),name=element('span','event-team-name',team.name),badge=element('span','event-logo-slot');badge.setAttribute('aria-hidden','true');
  try{const url=new URL(team.logo);if(url.protocol==='https:'&&url.hostname==='liquipedia.net'&&!url.port&&!url.username&&!url.password&&url.pathname.startsWith('/commons/images/')&&/\.(png|svg|webp|jpe?g|gif)$/i.test(url.pathname)){
   const image=element('img','event-logo');image.alt='';image.width=32;image.height=32;image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';image.onerror=()=>image.remove();image.src=url.href;badge.append(image);
  }}catch{/* A missing or invalid badge keeps a neutral placeholder beside the name. */}
  label.append(...(left?[name,badge]:[badge,name]));return label;
 }
 function notice(message){$('eventsNotice').textContent=message;$('eventsNotice').hidden=!message;}
 function fillOptions(id,values,label){const select=$(id),value=select.value;select.replaceChildren(new Option(label,''),...[...new Set(values)].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(v=>new Option(v,v)));if(values.includes(value))select.value=value;}
 function render(){
  if(!snapshot)return;
  $('eventsCoverage').textContent=snapshot.coverage||'';
  const f=filters(),invalid=f.from&&f.to&&f.from>f.to,matches=invalid?[]:model.select(snapshot.matches,f),list=$('eventsList');
  list.replaceChildren();$('eventsCount').textContent=`${matches.length} 场比赛`;
  $('eventsUpdated').textContent='更新于 '+dateTime.format(new Date(snapshot.updatedAt));
  if(invalid){list.append(element('p','events-empty','开始日期不能晚于结束日期。'));return;}
  if(!matches.length){const hasFilters=f.from||f.to||f.tournament||f.region||f.team.trim();list.append(element('p','events-empty',hasFilters?'没有符合筛选条件的比赛，试试调整筛选。':view==='completed'?'数据源暂未提供匹配的赛果。':'数据源暂未提供匹配的赛程。'));return;}
  let currentDay='',group;
  for(const match of matches){
   const date=model.day(match.startsAt)||'tbd';
   if(date!==currentDay){currentDay=date;group=element('section','events-day');const heading=element('h2','events-day-heading',date==='tbd'?'时间待定':dateFormat.format(new Date(match.startsAt)));if(date!=='tbd')heading.append(element('span','',date));group.append(heading);list.append(group);}
   const row=element('article','event-match'),meta=element('div','event-meta');
   meta.append(element('span','event-region',match.region),element('span','event-tournament',match.tournament));if(match.bestOf)meta.append(element('span','event-format','BO'+match.bestOf));
   const body=element('div','event-match-body'),time=element('div','event-time'),stamp=element('time','',match.startsAt?timeFormat.format(new Date(match.startsAt)):'待定');if(match.startsAt)stamp.dateTime=match.startsAt;
   const completed=match.status==='completed',status=element('span','event-status',completed?'已结束':!match.startsAt?'时间待定':Date.parse(match.startsAt)<Date.now()?'赛果待公布':'未开始');if(status.textContent==='赛果待公布'){status.classList.add('is-pending');status.replaceChildren('赛果',element('wbr'),'待公布');}time.append(stamp,status);
   const versus=element('div','event-versus');
   const scores=match.scores.every(s=>s!==null)?match.scores.join(' : '):completed?'—':'VS';
   versus.append(teamLabel(match.teams[0],true),element('strong','event-score'+(completed?' is-completed':''),scores),teamLabel(match.teams[1],false));
   const url=new URL(match.sourceUrl);if(url.protocol==='https:'&&url.hostname==='liquipedia.net'&&!url.port&&!url.username&&!url.password&&url.pathname.startsWith('/overwatch/')){const link=element('a','event-source-link','赛事详情 ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';body.append(time,versus,link);}else body.append(time,versus);
   row.append(meta,body);group.append(row);
  }
 }
 function setView(next){view=next;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));}
 async function refresh(sync=true){
  const id=++requestId;clearTimeout(retryTimer);busy=true;$('eventsList').setAttribute('aria-busy','true');$('eventsRefresh').disabled=true;$('eventsRefresh').textContent='更新中…';
  const params=scope();
  try{
   const next=await Cloud.api((sync?'/api/events/refresh':'/api/events')+'?'+params,sync?{}:undefined);if(id!==requestId)return;
   if(next.state==='pending'){
    notice(next.message||'服务器正在补查，请稍候。');$('eventsCount').textContent='正在补查…';
    if(!snapshot)$('eventsList').replaceChildren(element('p','events-empty','正在按日期与赛事获取数据…'));
    retryTimer=setTimeout(()=>refresh(false),Math.max(1,Math.min(300,Number(next.retryAfter)||5))*1000);return;
   }
   snapshot=next;fillOptions('eventsTournament',next.matches.map(m=>m.tournament),'全部阶段');fillOptions('eventsRegion',next.matches.map(m=>m.region),'全部赛区');
   notice(next.refreshError||(next.truncated?next.coverage:next.stale?'正在显示上次同步的数据，赛程或比分可能已变化。':''));render();
   if(next.updating)retryTimer=setTimeout(()=>refresh(false),Math.max(1,Math.min(300,Number(next.retryAfter)||5))*1000);
  }catch(error){if(id!==requestId)return;notice(error.message+(snapshot?'，已保留当前赛程。':''));if(!snapshot){$('eventsCount').textContent='暂无赛程';$('eventsList').replaceChildren(element('p','events-empty','服务器赛程暂未就绪，请点击“刷新赛程”重试。'));}}
  finally{if(id===requestId){busy=false;$('eventsList').setAttribute('aria-busy','false');$('eventsRefresh').disabled=false;$('eventsRefresh').textContent='刷新赛程';}}
 }
 function queryChanged(){
  ++requestId;clearTimeout(retryTimer);clearTimeout(queryTimer);
  const from=$('eventsFrom').value,to=$('eventsTo').value;
  if(from&&to&&from>to){busy=false;$('eventsRefresh').disabled=false;$('eventsRefresh').textContent='刷新赛程';$('eventsList').setAttribute('aria-busy','false');render();return;}
  if(from&&to&&to<model.day(new Date().toISOString()))setView('completed');
  queryTimer=setTimeout(()=>refresh(false),400);
 }
 $('eventsFilters').onsubmit=e=>{e.preventDefault();clearTimeout(queryTimer);refresh(false);};
 $('eventsFilters').addEventListener('input',render);$('eventsFilters').addEventListener('change',render);
 for(const id of ['eventsSeries','eventsFrom','eventsTo'])$(id).addEventListener('change',queryChanged);
 $('eventsSeries').addEventListener('change',()=>{$('eventsTournament').value='';});
 $('eventsClear').onclick=()=>{$('eventsFilters').reset();queryChanged();render();};
 document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{setView(button.dataset.view);render();});
 $('eventsRefresh').onclick=()=>refresh();
 Cloud.boot().then(async()=>{await refresh(false);if(!scope().get('from')&&scope().get('series')==='owcs')await refresh();}).catch(()=>{});
})();
