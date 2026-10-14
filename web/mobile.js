'use strict';
(()=>{
 const chart=document.getElementById('chart'),summary=document.getElementById('mobileSummary'),dialog=document.getElementById('mobileChartDialog'),body=document.getElementById('mobileChartBody');
 const aside=document.querySelector('.workspace>aside'),toggle=document.getElementById('mobileSettingsToggle');let initialized=false;
 const setCollapsed=value=>{aside.classList.toggle('mobile-collapsed',value);toggle.textContent=value?'展开设置':'收起设置';toggle.setAttribute('aria-expanded',String(!value));};
 toggle.onclick=()=>setCollapsed(!aside.classList.contains('mobile-collapsed'));
 const read=()=>{
  if(!matchMedia('(max-width:760px)').matches)return;
  const svg=chart.querySelector('svg');summary.replaceChildren();if(!svg)return;
  if(!initialized){setCollapsed(true);initialized=true;}
  const texts=[...svg.querySelectorAll('text')];
  for(const title of ['强度预估','个人段位预测','预估可信度']){
   const index=texts.findIndex(n=>n.textContent===title);if(index<0)continue;
   const card=document.createElement('div'),label=document.createElement('span'),value=document.createElement('strong'),note=document.createElement('small');
   label.textContent=title;value.textContent=texts[index+1]?.textContent||'—';note.textContent=texts[index+2]?.textContent||'';card.append(label,value,note);summary.append(card);
  }
 };
 new MutationObserver(records=>{if(records.some(r=>r.target===chart))read();}).observe(chart,{childList:true});
 matchMedia('(max-width:760px)').addEventListener('change',read);read();
 document.getElementById('mobileChartOpen').onclick=()=>{
  if(!chart.querySelector('svg'))return;settleTimeline();
  const svg=chart.querySelector('svg'),clone=svg.cloneNode(true);
  clone.querySelectorAll('[id]').forEach(n=>n.id='mobile-'+n.id);
  clone.querySelectorAll('*').forEach(n=>{for(const attribute of [...n.attributes])if(attribute.value.includes('url(#'))n.setAttribute(attribute.name,attribute.value.replace(/url\(#([^)]+)\)/g,'url(#mobile-$1)'));});
  body.replaceChildren(clone);
  body.querySelectorAll('[data-match]').forEach(hit=>{hit.onclick=()=>{const index=hit.dataset.match;dialog.close();chart.querySelector(`[data-match="${index}"]`)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));};});
  dialog.showModal();body.scrollLeft=0;
 };
 document.getElementById('mobileChartClose').onclick=()=>dialog.close();
})();
