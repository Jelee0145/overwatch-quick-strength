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
 // The slim view carries one detailed window plus a light index of the whole archive;
 // splice them back together so window maths, totals and the histogram stay exact.
 if(Array.isArray(view.series)&&Array.isArray(view.matches)){
  const detail=new Map(view.matches.map(match=>[match.mid,match]));
  view.matches=view.series.map(match=>detail.get(match.mid)||match);
 }
 if(view.model&&!Array.isArray(view.model.matches)){
  const statistics=view.statistics||{start:0,end:view.matches.length};
  view.model.matches=Array.isArray(view.series)?view.series.slice(statistics.start,statistics.end):view.matches;
 }
 // The side-filtered roster is dropped when it is the combat roster itself.
 if(Array.isArray(view.matches))for(const match of view.matches)if(match&&!Array.isArray(match.players)&&Array.isArray(match.combatPlayers))match.players=match.combatPlayers;
 timeline.analysis=view;raw=view.raw;timeline.all=view.matches;timeline.axis=view.axis;timeline.start=view.window.start;
 timeline.statistics=view.model;
 timeline.statistics.statisticsLabel=view.statisticsLabel;$('statisticsNote').textContent=view.statisticsLabel;
}
function matchReference(mid){return {sourceJob:timeline.archive?.sourceJob,...(timeline.analysis?.matchRefs?.find(ref=>ref.mid===mid)||{battletag:raw.battletag,mid,revision:timeline.analysis?.revision})};}
window.OWQS_MATCH_REFERENCE=matchReference;
function timelineWindow(){return QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,timeline.start);}
function renderServerTimeline(){
 if(!timeline.statistics){$('chart').innerHTML='<div class="empty-state"><strong>暂无对局</strong></div>';return;}
 paintTimeline();showPersonal();configureScroll();const w=timelineWindow();
 status(timeline.analysis?.offline?'离线模式':timeline.all.length?'':'暂无对局');
}
function chartView(){const w=timelineWindow();return {...timeline.statistics,matches:timeline.all.slice(w.start,w.end),statsMatches:timeline.statistics.matches,windowOffset:w.start,plotScale:timeline.axis};}
function paintTimeline(){
 const view=chartView(),w=timelineWindow(),images=timelineImages();model=view;timeline.pool=null;
 $('chart').innerHTML=view.matches.length?renderChart(view,QS_ART,$('art').checked,$('title').value||'快速强度图'):'<div class="empty-state"><strong>暂无对局</strong></div>';
 $('chart').querySelectorAll('[data-match]').forEach(el=>{
  const show=()=>{if(Date.now()<timeline.suppressUntil)return;const index=Number(el.dataset.match);timeline.selected=model.matches[index]?.mid;$('matchSelect').value=String(index);showPlayers(index);};
  el.onclick=show;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}};
 });
 restoreTimelineImages($('chart').querySelector('svg'),images);queueMapArt();
 const selected=Math.max(0,view.matches.findIndex(m=>m.mid===timeline.selected));
 timeline.selected=view.matches[selected]?.mid||null;
 $('matchSelect').innerHTML=view.matches.map((m,i)=>`<option value="${i}">第 ${(view.windowOffset||0)+i+1} 场 · ${QS.esc(QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图')}</option>`).join('');
 $('matchSelect').value=String(selected);if(timeline.detailMatch!==view.matches[selected]){showPlayers(selected);timeline.detailMatch=view.matches[selected];}else $('chart').querySelectorAll('.match-hit').forEach(n=>n.setAttribute('aria-pressed',String(Number(n.dataset.match)===selected)));
 timeline.lastEnd=w.end;$('timelinePosition').textContent=view.matches.length?`${w.start+1}—${w.end} / ${timeline.all.length} 场`:'暂无对局';
 $('timelineOlder').disabled=!w.start;$('timelineNewer').disabled=w.end>=timeline.all.length;
 ['png','svg','json'].forEach(id=>$(id).disabled=!view.matches.length||!!timeline.exporting);
 $('chartZoom').disabled=!view.matches.length;applyChartZoom();
 queueMicrotask(()=>window.dispatchEvent(new CustomEvent('owqs:analysis-updated',{detail:{model,raw,index:selected}})));
}
function timelineImages(){const images=new Map();$('chart').querySelectorAll('image[data-map-art]').forEach(n=>{const href=n.getAttribute('href');if(href?.startsWith('data:image/'))images.set(QS_MEDIA.maps[n.dataset.mapArt]?.preview||n.dataset.mapArt,href);});return images;}
function restoreTimelineImages(svg,images){svg?.querySelectorAll('image[data-map-art]').forEach(n=>{const href=images.get(QS_MEDIA.maps[n.dataset.mapArt]?.preview||n.dataset.mapArt);if(href)n.setAttribute('href',href);});}
function configureScroll(){const scroll=$('timelineScroll');if(scroll){scroll.hidden=true;scroll.scrollLeft=0;}timeline.unit=null;}
function cancelTimelineMotion(){timeline.motionGeneration=(timeline.motionGeneration||0)+1;clearTimeout(timeline.scrollTimer);for(const key of ['frame','snapFrame','afterSnapFrame']){if(timeline[key])cancelAnimationFrame(timeline[key]);timeline[key]=null;}timeline.pendingOffset=null;timeline.snap=null;$('chart').classList.remove('timeline-moving');}
async function generate(){
 cancelTimelineMotion();const tag=timeline.archive?.tag||raw.battletag;
 if(!tag){renderServerTimeline();return;}
 // Whole-history statistics cannot change with the visible window, so moving the window
 // only needs a local re-slice; re-downloading the archive for it cost a full analysis.
 if(!QS_HISTORY_MODEL.windowNeedsAnalysis(timeline.analysis,tag,$('statisticsRange').value,timeline.all,timeline.start)){renderServerTimeline();return;}
 const serial=timeline.analysisSerial=(timeline.analysisSerial||0)+1,archiveSerial=timeline.serial;
 try{
  const view=await OWQS_SERVER_ANALYSIS.load(tag,{...options(),sourceJob:timeline.archive?.sourceJob,start:timeline.start,statisticsRange:$('statisticsRange').value});
  if(serial!==timeline.analysisSerial||archiveSerial!==timeline.serial)return;
  applyServerAnalysis(view);renderServerTimeline();warmWindow(-1);warmWindow(1);
 }catch(error){if(serial!==timeline.analysisSerial||archiveSerial!==timeline.serial)return;timeline.start=timeline.analysis?.window.start||0;if(timeline.statistics)renderServerTimeline();status('历史分析未能更新：'+error.message,true);}
}
// One window per step. Free scrolling moved a single column and re-requested the whole
// analysis every time, so window steps fetch ten matches of detail instead.
function commitTimeline(start){cancelTimelineMotion();timeline.start=QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,start).start;void generate();}
function stepWindow(delta){commitTimeline(timeline.start+delta*TIMELINE_WINDOW);}
function warmWindow(delta){
 const tag=timeline.archive?.tag;if(!tag)return;
 const next=QS_HISTORY_MODEL.windowRange(timeline.all.length,TIMELINE_WINDOW,timeline.start+delta*TIMELINE_WINDOW).start;
 if(next===timeline.start)return;
 void OWQS_SERVER_ANALYSIS.load(tag,{...options(),sourceJob:timeline.archive?.sourceJob,start:next,statisticsRange:$('statisticsRange').value}).catch(()=>{});
}
$('statisticsRange').onchange=()=>commitTimeline(timeline.start);
$('timelineOlder').onclick=()=>stepWindow(-1);$('timelineNewer').onclick=()=>stepWindow(1);
$('timelineScroll').onkeydown=e=>{const step={ArrowLeft:-1,ArrowRight:1}[e.key];if(step){e.preventDefault();stepWindow(step);return;}if(e.key!=='Home'&&e.key!=='End')return;e.preventDefault();commitTimeline(e.key==='Home'?0:Math.max(0,timeline.all.length-TIMELINE_WINDOW));};
$('timelineScroll').onscroll=()=>{$('timelineScroll').scrollLeft=0;};
window.addEventListener('resize',()=>{clearTimeout(timeline.resizeTimer);timeline.resizeTimer=setTimeout(()=>renderServerTimeline(),100);});

$('matchSelect').addEventListener('change',()=>{timeline.selected=model.matches[Number($('matchSelect').value)]?.mid;});
async function renderHistoryList(){
 const body=$('historyList');body.replaceChildren();try{const accounts=await CloudHistory.list(),search=QS_HISTORY_MODEL.tag($('historySearch').value).toLowerCase(),rows=accounts.filter(a=>a.tag.toLowerCase().includes(search));
  if(!rows.length){body.textContent=accounts.length?'没有匹配的账号':'暂无已保存的战绩历史';return;}
  for(const a of rows){const section=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`${a.tag} · ${a.matches.length} 场 · 更新于 ${new Date(a.updatedAt).toLocaleString('zh-CN')}`;section.append(summary);
   const open=document.createElement('button');open.type='button';open.textContent='打开历史图表';open.onclick=()=>activate(a.tag);section.append(open);
   for(const m of [...a.matches].reverse()){const button=document.createElement('button');button.type='button';button.className='history-match';button.textContent=`${new Date(m.t).toLocaleString('zh-CN')} · ${QS_DATA.maps[m.mapGuid]?.name||m.mapName||'未知地图'} · ${m.ret===1?'胜':m.ret===-1?'负':'未知'}`;button.onclick=()=>activate(a.tag,m.mid);section.append(button);}body.append(section);
  }
 }catch(e){body.textContent=e.message;}
}
async function activate(tag,mid){if(activeJob){$('historyNotice').textContent='当前查询尚未完成，请完成或停止后再切换账号';return;}try{await openHistory(tag,mid);await Cloud.storage('latest',tag);$('historyDialog').close();}catch(e){$('historyNotice').textContent=e.message;}}
$('historyOpen').onclick=async()=>{try{await Cloud.boot();const note=$('historyNotice');note.replaceChildren();const syncStatus=document.createElement('span');syncStatus.id='historySyncStatus';syncStatus.textContent=CloudHistory.status();syncStatus.style.display='block';const retry=document.createElement('button');retry.type='button';retry.textContent='同步历史';retry.onclick=async()=>{retry.disabled=true;try{await CloudHistory.sync();await renderHistoryList();}finally{retry.disabled=false;}};note.append(syncStatus,retry);$('historyDialog').showModal();await renderHistoryList();retry.click();}catch(e){status(e.message,true);}};
$('historyClose').onclick=()=>$('historyDialog').close();$('historySearch').oninput=()=>{clearTimeout(timeline.searchTimer);timeline.searchTimer=setTimeout(renderHistoryList,120);};
