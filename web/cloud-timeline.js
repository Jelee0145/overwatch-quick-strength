const TIMELINE_WINDOW=10;
const timeline={archive:null,all:[],start:0,selected:null,serial:0,drag:null,suppressUntil:0,scrollTimer:null,frame:null,statistics:null};
async function openHistory(tag,mid,sourceJob){
 const serial=++timeline.serial;cancelTimelineMotion();const analysisSerial=timeline.analysisSerial=(timeline.analysisSerial||0)+1;
 const view=await OWQS_SERVER_ANALYSIS.load(tag,{...options(),sourceJob,statisticsRange:$('statisticsRange').value});if(serial!==timeline.serial||analysisSerial!==timeline.analysisSerial)return;
 timeline.archive={tag,sourceJob};timeline.detailMatch=null;timeline.selected=mid||view.matches.at(-1)?.mid||null;
 $('battleTag').value=tag;applyServerAnalysis(view);
 const index=mid?timeline.all.findIndex(m=>m.mid===mid):-1;timeline.start=index>=0?Math.max(0,index+1-TIMELINE_WINDOW):view.window.start;
 if(timeline.start!==view.window.start)await generate();else renderServerTimeline();
}
function applyServerAnalysis(view){
 timeline.analysis=view;raw=view.raw;timeline.all=view.matches;timeline.axis=view.axis;timeline.start=view.window.start;
 timeline.statistics=view.model;
 timeline.statistics.statisticsLabel=view.statisticsLabel;$('statisticsNote').textContent=view.statisticsLabel;
}
function matchReference(mid){return {sourceJob:timeline.archive?.sourceJob,...(timeline.analysis?.matchRefs?.find(ref=>ref.mid===mid)||{battletag:raw.battletag,mid,revision:timeline.analysis?.revision})};}
window.OWQS_MATCH_REFERENCE=matchReference;
function timelineWindow(){return QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,timeline.start);}
function renderServerTimeline(){
 if(!timeline.statistics){$('chart').innerHTML='<div class="empty-state"><strong>查看最近快速对局</strong><span>输入战网昵称，查询并生成你的强度图</span></div>';return;}
 paintTimeline();showPersonal();configureScroll();const w=timelineWindow();
 status((timeline.analysis?.offline?'离线缓存 · ':'')+(timeline.all.length?`已保留 ${timeline.all.length} 场历史 · 当前显示 ${w.end-w.start} 场`:'请输入战网昵称开始查询'));
}
function chartView(){const w=timelineWindow();return {...timeline.statistics,matches:timeline.all.slice(w.start,w.end),statsMatches:timeline.statistics.matches,windowOffset:w.start,plotScale:timeline.axis};}
function paintTimeline(){
 const view=chartView(),w=timelineWindow(),images=timelineImages();model=view;timeline.pool=null;
 $('chart').innerHTML=view.matches.length?renderChart(view,QS_ART,$('art').checked,$('title').value||'快速强度图'):'<div class="empty-state"><strong>查看最近快速对局</strong><span>输入战网昵称，查询并生成你的强度图</span></div>';
 $('chart').querySelectorAll('[data-match]').forEach(el=>{
  const show=()=>{if(Date.now()<timeline.suppressUntil)return;const index=Number(el.dataset.match);timeline.selected=model.matches[index]?.mid;$('matchSelect').value=String(index);showPlayers(index);};
  el.onclick=show;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}};
 });
 restoreTimelineImages($('chart').querySelector('svg'),images);queueMapArt();
 const selected=Math.max(0,view.matches.findIndex(m=>m.mid===timeline.selected));
 timeline.selected=view.matches[selected]?.mid||null;
 $('matchSelect').innerHTML=view.matches.map((m,i)=>`<option value="${i}">第 ${(view.windowOffset||0)+i+1} 场 · ${QS.esc(QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图')}</option>`).join('');
 $('matchSelect').value=String(selected);if(timeline.detailMatch!==view.matches[selected]){showPlayers(selected);timeline.detailMatch=view.matches[selected];}else $('chart').querySelectorAll('.match-hit').forEach(n=>n.setAttribute('aria-pressed',String(Number(n.dataset.match)===selected)));
 timeline.lastEnd=w.end;$('timelinePosition').textContent=view.matches.length?`${w.start+1}—${w.end} / ${timeline.all.length} 场 · 按住图表左右拖动`:'尚无历史对局';
 $('timelineOlder').disabled=!w.start;$('timelineNewer').disabled=w.end>=timeline.all.length;
 ['png','svg','json'].forEach(id=>$(id).disabled=!view.matches.length||!!timeline.exporting);
 $('chartZoom').disabled=!view.matches.length;applyChartZoom();
 queueMicrotask(()=>window.dispatchEvent(new CustomEvent('owqs:analysis-updated',{detail:{model,raw,index:selected}})));
}
function timelineImages(){const images=new Map();$('chart').querySelectorAll('image[data-map-art]').forEach(n=>{const href=n.getAttribute('href');if(href?.startsWith('data:image/'))images.set(QS_MEDIA.maps[n.dataset.mapArt]?.preview||n.dataset.mapArt,href);});return images;}
function restoreTimelineImages(svg,images){svg?.querySelectorAll('image[data-map-art]').forEach(n=>{const href=images.get(QS_MEDIA.maps[n.dataset.mapArt]?.preview||n.dataset.mapArt);if(href)n.setAttribute('href',href);});}
function timelineUnit(){if(timeline.unit)return timeline.unit;const svg=$('chart').querySelector('svg'),width=Number(svg?.getAttribute('width'))||1440;return $('chart').clientWidth*(width-208)/width/Math.max(1,timelineWindow().end-timelineWindow().start);}
function configureScroll(){const scroll=$('timelineScroll'),max=Math.max(0,timeline.all.length-TIMELINE_WINDOW),svg=$('chart').querySelector('svg'),width=Number(svg?.getAttribute('width'))||1440;
 timeline.unit=$('chart').clientWidth*(width-208)/width/Math.max(1,timelineWindow().end-timelineWindow().start);scroll.hidden=!max;$('timelineTrack').style.width=(scroll.clientWidth+max*timeline.unit)+'px';timeline.visualOffset=timeline.start;scroll.scrollLeft=timeline.start*timeline.unit;
}
function cancelTimelineMotion(){timeline.motionGeneration=(timeline.motionGeneration||0)+1;clearTimeout(timeline.scrollTimer);for(const key of ['frame','snapFrame','afterSnapFrame']){if(timeline[key])cancelAnimationFrame(timeline[key]);timeline[key]=null;}timeline.pendingOffset=null;timeline.snap=null;$('chart').classList.remove('timeline-moving');}
async function generate(){
 cancelTimelineMotion();const tag=timeline.archive?.tag||raw.battletag;
 if(!tag){renderServerTimeline();return;}
 const serial=timeline.analysisSerial=(timeline.analysisSerial||0)+1,archiveSerial=timeline.serial;
 try{
  const view=await OWQS_SERVER_ANALYSIS.load(tag,{...options(),sourceJob:timeline.archive?.sourceJob,start:timeline.start,statisticsRange:$('statisticsRange').value});
  if(serial!==timeline.analysisSerial||archiveSerial!==timeline.serial)return;
  applyServerAnalysis(view);renderServerTimeline();
 }catch(error){if(serial!==timeline.analysisSerial||archiveSerial!==timeline.serial)return;timeline.start=timeline.analysis?.window.start||0;if(timeline.statistics)renderServerTimeline();status('历史分析未能更新：'+error.message,true);}
}
function replaceTimelinePool(offset){
 const range=QS_HISTORY_MODEL.bufferedRange(timeline.all.length,TIMELINE_WINDOW,offset),svg=$('chart').querySelector('svg');if(!svg)return;
 const images=timelineImages(),container=document.createElement('div'),view={...chartView(),matches:timeline.all.slice(range.start,range.end),windowSize:range.size,windowOffset:range.start,columnOffset:range.start-range.anchor};
 container.innerHTML=renderChart(view,QS_ART,$('art').checked,$('title').value||'快速强度图');const source=container.querySelectorAll('.timeline-trajectory'),destination=svg.querySelectorAll('.timeline-trajectory');
 destination.forEach((layer,i)=>layer.replaceChildren(...source[i].childNodes));restoreTimelineImages(svg,images);queueMapArt();timeline.pool={...range,layers:[...destination],columnWidth:(Number(svg.getAttribute('width'))-208)/Math.max(1,range.size)};
}
function previewTimeline(offset,mirror=false){
 offset=Math.max(0,Math.min(offset,Math.max(0,timeline.all.length-TIMELINE_WINDOW)));timeline.visualOffset=offset;
 if(!timeline.pool||offset<timeline.pool.anchor-2||offset>timeline.pool.anchor+2)replaceTimelinePool(offset);
 if(timeline.pool){const pixels=-(offset-timeline.pool.anchor)*timeline.pool.columnWidth;timeline.pool.layers.forEach(layer=>layer.style.transform=`translate3d(${pixels}px,0,0)`);}
 $('chart').classList.add('timeline-moving');if(mirror)$('timelineScroll').scrollLeft=offset*timelineUnit();
}
function scheduleTimelinePreview(offset){timeline.pendingOffset=offset;if(timeline.frame)return;timeline.frame=requestAnimationFrame(()=>{timeline.frame=null;previewTimeline(timeline.pendingOffset,true);});}
function commitTimeline(start){cancelTimelineMotion();timeline.start=QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,start).start;void generate();}
function settleTimeline(){const offset=timeline.pendingOffset??timeline.visualOffset??timeline.start;timeline.pendingOffset=null;commitTimeline(offset);}
function snapTimeline(target){
 const from=timeline.pendingOffset??timeline.visualOffset??timeline.start;timeline.pendingOffset=null;cancelTimelineMotion();target=QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,target??from).start;
 const duration=QS_HISTORY_MODEL.snapDuration(target-from,matchMedia('(prefers-reduced-motion: reduce)').matches);if(!duration||Math.abs(target-from)>6){commitTimeline(target);return;}
 const generation=timeline.motionGeneration;timeline.snap={target,from};let began;
 const tick=time=>{if(generation!==timeline.motionGeneration)return;began??=time;const progress=Math.min(1,(time-began)/duration);previewTimeline(from+(target-from)*QS_HISTORY_MODEL.snapEase(progress),true);
  if(progress<1)timeline.snapFrame=requestAnimationFrame(tick);else {timeline.snapFrame=null;timeline.afterSnapFrame=requestAnimationFrame(()=>{timeline.afterSnapFrame=null;if(generation===timeline.motionGeneration)commitTimeline(target);});}
 };timeline.snapFrame=requestAnimationFrame(tick);
}
$('statisticsRange').onchange=()=>{settleTimeline();};
$('timelineOlder').onclick=()=>snapTimeline((timeline.snap?.target??timeline.start)-1);$('timelineNewer').onclick=()=>snapTimeline((timeline.snap?.target??timeline.start)+1);
$('timelineScroll').onscroll=()=>{if(timeline.drag?.moved||timeline.snap)return;const offset=$('timelineScroll').scrollLeft/Math.max(1,timelineUnit());if(Math.abs(offset-(timeline.visualOffset??timeline.start))*timelineUnit()<1.1)return;
 scheduleTimelinePreview(offset);clearTimeout(timeline.scrollTimer);timeline.scrollTimer=setTimeout(()=>snapTimeline(),110);
};
$('chart').onpointerdown=e=>{if(e.button!==0||!timeline.all.length)return;const offset=timeline.pendingOffset??timeline.visualOffset??timeline.start;cancelTimelineMotion();timeline.pendingOffset=null;timeline.drag={pointer:e.pointerId,x:e.clientX,offset,unit:timelineUnit(),moved:false};};
$('chart').onpointermove=e=>{const d=timeline.drag;if(!d||d.pointer!==e.pointerId)return;if(Math.abs(e.clientX-d.x)>6&&!d.moved){d.moved=true;$('chart').setPointerCapture(e.pointerId);$('chart').classList.add('dragging');}
 if(d.moved){e.preventDefault();scheduleTimelinePreview(d.offset+(d.x-e.clientX)/Math.max(1,d.unit));timeline.suppressUntil=Date.now()+350;}
};
function endTimelineDrag(e){const d=timeline.drag;if(!d||d.pointer!==e.pointerId)return;timeline.drag=null;$('chart').classList.remove('dragging');if($('chart').hasPointerCapture(e.pointerId))$('chart').releasePointerCapture(e.pointerId);if(d.moved){timeline.suppressUntil=Date.now()+350;snapTimeline();}}
$('chart').onpointerup=endTimelineDrag;$('chart').onpointercancel=endTimelineDrag;
$('chart').addEventListener('click',e=>{if(!timeline.pool||Date.now()<timeline.suppressUntil)return;const hit=e.target.closest('[data-match]');if(!hit)return;const m=timeline.all[timeline.pool.start+Number(hit.dataset.match)];if(m){timeline.selected=m.mid;settleTimeline();}});
$('timelineScroll').onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const max=Math.max(0,timeline.all.length-TIMELINE_WINDOW);commitTimeline(e.key==='Home'?0:e.key==='End'?max:Math.round(timeline.visualOffset??timeline.start)+(e.key==='ArrowLeft'?-1:1));}};
window.addEventListener('resize',()=>{clearTimeout(timeline.resizeTimer);timeline.resizeTimer=setTimeout(()=>{settleTimeline();configureScroll();},100);});

$('matchSelect').addEventListener('change',()=>{timeline.selected=model.matches[Number($('matchSelect').value)]?.mid;});
async function renderHistoryList(){
 const body=$('historyList');body.replaceChildren();try{const accounts=await CloudHistory.list(),search=QS_HISTORY_MODEL.tag($('historySearch').value).toLowerCase(),rows=accounts.filter(a=>a.tag.toLowerCase().includes(search));
  if(!rows.length){body.textContent=accounts.length?'没有匹配的账号':'暂无已保存的战绩历史';return;}
  for(const a of rows){const section=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`${a.tag} · ${a.matches.length} 场 · 更新于 ${new Date(a.updatedAt).toLocaleString('zh-CN')}`;section.append(summary);
   const open=document.createElement('button');open.type='button';open.textContent='打开历史图表';open.onclick=()=>activate(a.tag);section.append(open);
   for(const m of [...a.matches].reverse()){const button=document.createElement('button');button.type='button';button.className='history-match';button.textContent=`${new Date(m.t).toLocaleString('zh-CN')} · ${QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图'} · ${m.ret===1?'胜':m.ret===-1?'负':'未知'} · ${m.mid}`;button.onclick=()=>activate(a.tag,m.mid);section.append(button);}body.append(section);
  }
 }catch(e){body.textContent=e.message;}
}
async function activate(tag,mid){if(activeJob){$('historyNotice').textContent='当前查询尚未完成，请完成或停止后再切换账号';return;}try{await openHistory(tag,mid);await Cloud.storage('latest',tag);$('historyDialog').close();}catch(e){$('historyNotice').textContent=e.message;}}
$('historyOpen').onclick=async()=>{try{await Cloud.boot();const note=$('historyNotice');note.replaceChildren();const description=document.createElement('span');description.textContent='同账号自动同步战绩历史，每个战网账号最多500场。抽签记录、锐评及设置仍保存在本机。';const syncStatus=document.createElement('span');syncStatus.id='historySyncStatus';syncStatus.textContent=CloudHistory.status();syncStatus.style.display='block';const retry=document.createElement('button');retry.type='button';retry.textContent='同步历史';retry.onclick=async()=>{retry.disabled=true;try{await CloudHistory.sync();await renderHistoryList();}finally{retry.disabled=false;}};note.append(description,syncStatus,retry);$('historyDialog').showModal();await renderHistoryList();retry.click();}catch(e){status(e.message,true);}};
$('historyClose').onclick=()=>$('historyDialog').close();$('historySearch').oninput=()=>{clearTimeout(timeline.searchTimer);timeline.searchTimer=setTimeout(renderHistoryList,120);};
