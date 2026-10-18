'use strict';
(()=>{
 const $=id=>document.getElementById(id),model=window.EventsModel;
 const dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const timeFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const dateFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'});
 let snapshot=null,view='scheduled',busy=false;
 const filters=()=>({view,from:$('eventsFrom').value,to:$('eventsTo').value,tournament:$('eventsTournament').value,region:$('eventsRegion').value,team:$('eventsTeam').value});
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
  const f=filters(),invalid=f.from&&f.to&&f.from>f.to,matches=invalid?[]:model.select(snapshot.matches,f),list=$('eventsList');
  list.replaceChildren();$('eventsCount').textContent=`${matches.length} 场比赛`;
  $('eventsUpdated').textContent='更新于 '+dateTime.format(new Date(snapshot.updatedAt));
  if(invalid){list.append(element('p','events-empty','开始日期不能晚于结束日期。'));return;}
  if(!matches.length){const hasFilters=f.from||f.to||f.tournament||f.region||f.team.trim();list.append(element('p','events-empty',hasFilters?'没有符合筛选条件的比赛，试试调整筛选。':view==='completed'?'数据源暂未提供近期 OWCS 赛果。':'数据源暂未提供近期 OWCS 赛程。'));return;}
  let currentDay='',group;
  for(const match of matches){
   const date=model.day(match.startsAt)||'tbd';
   if(date!==currentDay){currentDay=date;group=element('section','events-day');const heading=element('h2','events-day-heading',date==='tbd'?'时间待定':dateFormat.format(new Date(match.startsAt)));if(date!=='tbd')heading.append(element('span','',date));group.append(heading);list.append(group);}
   const row=element('article','event-match'),meta=element('div','event-meta');
   meta.append(element('span','event-region',match.region),element('span','event-tournament',match.tournament));if(match.bestOf)meta.append(element('span','event-format','BO'+match.bestOf));
   const body=element('div','event-match-body'),time=element('div','event-time'),stamp=element('time','',match.startsAt?timeFormat.format(new Date(match.startsAt)):'待定');if(match.startsAt)stamp.dateTime=match.startsAt;
   const completed=match.status==='completed';time.append(stamp,element('span','event-status',completed?'已结束':!match.startsAt?'时间待定':Date.parse(match.startsAt)<Date.now()?'待更新':'未开始'));
   const versus=element('div','event-versus');
   const scores=match.scores.every(s=>s!==null)?match.scores.join(' : '):completed?'—':'VS';
   versus.append(teamLabel(match.teams[0],true),element('strong','event-score'+(completed?' is-completed':''),scores),teamLabel(match.teams[1],false));
   const url=new URL(match.sourceUrl);if(url.protocol==='https:'&&url.hostname==='liquipedia.net'&&!url.port&&!url.username&&!url.password&&url.pathname.startsWith('/overwatch/')){const link=element('a','event-source-link','赛事详情 ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';body.append(time,versus,link);}else body.append(time,versus);
   row.append(meta,body);group.append(row);
  }
 }
 async function refresh(){
  if(busy)return;busy=true;$('eventsRefresh').disabled=true;$('eventsRefresh').textContent='正在刷新…';$('eventsList').setAttribute('aria-busy','true');
  try{
   const next=await Cloud.api('/api/events');snapshot=next;
   fillOptions('eventsTournament',next.matches.map(m=>m.tournament),'全部赛事');fillOptions('eventsRegion',next.matches.map(m=>m.region),'全部赛区');
   notice(next.stale?'暂时无法更新，正在显示上次获取的数据，赛程或比分可能已变化。':'');render();
  }catch(error){notice((snapshot?'刷新失败，保留当前内容。':'')+error.message);if(!snapshot){$('eventsCount').textContent='获取失败';$('eventsList').replaceChildren(element('p','events-empty','暂时无法获取比赛，请点击“刷新赛程”重试。'));}}
  finally{busy=false;$('eventsRefresh').disabled=false;$('eventsRefresh').textContent='刷新赛程 ↻';$('eventsList').setAttribute('aria-busy','false');}
 }
 $('eventsFilters').onsubmit=e=>e.preventDefault();$('eventsFilters').addEventListener('input',render);$('eventsFilters').addEventListener('change',render);
 $('eventsClear').onclick=()=>{$('eventsFilters').reset();render();};$('eventsRefresh').onclick=refresh;
 document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));render();});
 Cloud.boot().then(()=>{refresh();setInterval(()=>{if(!document.hidden)refresh();},5*60*1000);}).catch(()=>{});
})();
