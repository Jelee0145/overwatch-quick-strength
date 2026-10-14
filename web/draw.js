'use strict';
(()=>{
 const $=id=>document.getElementById(id),heroes=HERO_DRAW_DATA.heroes,modes={wheel:'轮盘',card:'抽卡',slot:'老虎机'},reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let mode='wheel',role='all',busy=false,ready=false,records=[],lastHero=null;
 const pool=()=>HeroDrawEngine.pool(heroes,role),pick=()=>HeroDrawEngine.pick(pool());
 const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
 function portrait(hero){const img=document.createElement('img');img.src=hero.portrait;img.alt=hero.name;img.draggable=false;img.decoding='async';return img;}
 function cell(hero,className){const item=document.createElement('div');item.className=className;item.dataset.hero=hero.id;item.append(portrait(hero));return item;}
 function setCard(hero){$('cardPortrait').src=hero.portrait;$('cardPortrait').alt=hero.name;$('cardName').textContent=hero.name;$('cardRole').textContent=hero.role;}
 function centerWheel(index){const item=$('wheelTrack').children[index];return -index*item.getBoundingClientRect().width-item.getBoundingClientRect().width/2;}
 function idle(){
  const candidates=pool(),hero=lastHero&&candidates.some(h=>h.id===lastHero.id)?lastHero:candidates[0];
  $('poolCount').textContent=`当前英雄池 · ${candidates.length} 位英雄`;$('stagePool').textContent=role==='all'?'全英雄池':role+'英雄池';
  $('wheelTrack').replaceChildren(...Array.from({length:9},(_,i)=>cell(i===4?hero:candidates[(i+2)%candidates.length],'wheel-cell')));
  $('wheelTrack').style.transform=`translateX(${centerWheel(4)}px)`;
  $('heroCard').classList.toggle('revealed',!!lastHero);setCard(hero);$('slotTrack').replaceChildren(cell(hero,'slot-cell'));$('slotTrack').style.transform='translateY(0)';
 }
 function lock(value){busy=value;$('drawStage').classList.toggle('drawing',value);for(const button of document.querySelectorAll('[data-mode],[data-role],#drawButton,#clearDrawHistory'))button.disabled=value||!ready;$('drawButton').firstElementChild.textContent=value?'正在抽取…':'再抽一次';}
 async function animate(node,from,to,duration){
  const animation=node.animate([{transform:from},{transform:to}],{duration:reduced.matches?140:duration,easing:'cubic-bezier(.10,.78,.16,1)',fill:'forwards'});
  await animation.finished;node.style.transform=to;animation.cancel();
 }
 async function runWheel(hero){
  const track=$('wheelTrack'),sequence=Array.from({length:36},(_,i)=>cell(i===32?hero:pick(),'wheel-cell'));
  track.replaceChildren(...sequence);await animate(track,`translateX(${centerWheel(3)}px)`,`translateX(${centerWheel(32)}px)`,2600);sequence[32].classList.add('picked');
 }
 async function runCard(hero){
  $('heroCard').classList.remove('revealed');$('heroCard').classList.add('card-dealing');await wait(reduced.matches?100:500);setCard(hero);$('heroCard').classList.remove('card-dealing');$('heroCard').classList.add('revealed');await wait(reduced.matches?120:650);
 }
 async function runSlot(hero){
  const track=$('slotTrack'),sequence=Array.from({length:28},(_,i)=>cell(i===25?hero:pick(),'slot-cell'));
  track.replaceChildren(...sequence);const height=sequence[0].getBoundingClientRect().height;await animate(track,'translateY(0)',`translateY(${-25*height}px)`,2300);sequence[25].classList.add('picked');
 }
 function history(){
  $('historyCount').textContent=records.length;$('historyEmpty').hidden=records.length>0;$('clearDrawHistory').disabled=busy||!records.length;
  $('drawHistoryList').replaceChildren(...records.map(record=>{
   const hero=heroes.find(h=>h.id===record.hero),item=document.createElement('li'),content=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
   name.textContent=hero.name;detail.textContent=`${hero.role} · ${modes[record.mode]||'抽取'} · ${new Date(record.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`;
   content.append(name,detail);item.append(portrait(hero),content);return item;
  }));
 }
 async function draw(){
  if(busy||!ready)return;lock(true);$('drawStage').classList.remove('has-result');$('resultHint').textContent='英雄正在登场…';$('resultName').textContent='';$('resultRole').textContent='';
  let hero;
  try{
   await Cloud.verify();hero=pick();const preload=new Image();preload.src=hero.portrait;await preload.decode().catch(()=>{});
   await ({wheel:runWheel,card:runCard,slot:runSlot})[mode](hero);
   lastHero=hero;$('drawStage').classList.add('has-result');$('resultHint').textContent='命运选中了';$('resultName').textContent=hero.name;$('resultRole').textContent=hero.role;
   records=[{hero:hero.id,mode,at:new Date().toISOString()},...records].slice(0,50);
   try{await Cloud.storage('hero-draw-history',records);}catch{$('resultHint').textContent='已抽中，记录保存失败';}history();
  }catch(error){$('resultHint').textContent=error.message;if(hero)idle();}finally{lock(false);history();}
 }
 function switchMode(next){if(busy||!ready)return;mode=next;$('drawStage').dataset.mode=mode;for(const button of document.querySelectorAll('[data-mode]'))button.setAttribute('aria-pressed',String(button.dataset.mode===mode));for(const name of Object.keys(modes))$(name+'View').hidden=name!==mode;idle();Cloud.storage('hero-draw-mode',mode).catch(()=>{});}
 for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>switchMode(button.dataset.mode);
 for(const button of document.querySelectorAll('[data-role]'))button.onclick=()=>{if(busy||!ready)return;role=button.dataset.role;lastHero=null;for(const item of document.querySelectorAll('[data-role]'))item.setAttribute('aria-pressed',String(item.dataset.role===role));$('resultHint').textContent='英雄池已切换，准备出发。';$('resultName').textContent='';$('resultRole').textContent='';$('drawStage').classList.remove('has-result');idle();};
 $('drawButton').onclick=draw;$('historyOpen').onclick=()=>{history();$('drawHistory').showModal();};$('historyClose').onclick=()=>$('drawHistory').close();
 $('clearDrawHistory').onclick=async()=>{if(busy||!ready||!records.length)return;if(!confirm('清空当前账号在此浏览器的抽取记录？'))return;try{await Cloud.storage('hero-draw-history',[]);records=[];history();}catch(error){$('resultHint').textContent=error.message;}};
 const resize=new ResizeObserver(()=>{if(!busy&&ready)idle();});resize.observe($('drawStage'));
 Cloud.boot().then(async()=>{
  const saved=await Cloud.storage('hero-draw-history');records=Array.isArray(saved)?saved.filter(r=>r&&heroes.some(h=>h.id===r.hero)&&modes[r.mode]&&!Number.isNaN(Date.parse(r.at))).slice(0,50):[];
  const savedMode=await Cloud.storage('hero-draw-mode');ready=true;switchMode(modes[savedMode]?savedMode:'wheel');lock(false);$('drawButton').firstElementChild.textContent='开始抽取';history();
 }).catch(error=>{$('resultHint').textContent=error.message;});
})();
