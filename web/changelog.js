'use strict';
(()=>{
 let notes=typeof QS_RELEASE_NOTES==='undefined'?null:QS_RELEASE_NOTES,checking=false;
 const dialog=document.getElementById('changelogDialog'),button=document.getElementById('changelogAcknowledge'),notice=document.getElementById('changelogNotice'),entries=document.getElementById('changelogEntries');
 const key=()=> 'changelog|'+notes.version;
 const paint=()=>{
  notice.textContent='';entries.replaceChildren();document.getElementById('changelogVersion').textContent=(notes.entries[0]?.date||'')+' · 最新更新';
  const history=document.createElement('details'),historyHeading=document.createElement('summary');historyHeading.textContent='历史更新';history.append(historyHeading);
  for(const [index,entry] of notes.entries.entries()){
   const section=document.createElement(index===0?'section':'details'),heading=document.createElement(index===0?'h3':'summary');heading.textContent=entry.date+' · '+entry.title;
   const list=document.createElement('ul');for(const item of entry.items){const line=document.createElement('li');line.textContent=item;list.append(line);}section.append(heading,list);(index===0?entries:history).append(section);
  }
  if(notes.entries.length>1)entries.append(history);
  if(!dialog.open)dialog.showModal();
 };
 // Toolkit pages inline the notes; the analysis bundle fetches them on demand so they stay off the startup budget.
 const open=()=>{if(notes){paint();return;}loadNotes(false).then(value=>{if(value)paint();});};
 async function loadNotes(remote){
  if(notes&&!remote)return notes;
  try{const response=await fetch('/release-notes.json',{cache:'no-store',credentials:'same-origin'});if(response.ok){const value=await response.json();if(typeof value.version==='string'&&Array.isArray(value.entries)&&value.entries.length)notes=value;}}catch{}
  return notes;
 }
 document.getElementById('changelogOpen').onclick=open;
 dialog.addEventListener('cancel',event=>event.preventDefault());
 button.onclick=async()=>{if(button.disabled)return;button.disabled=true;const versionKey=key();try{await Cloud.storage(versionKey,true);dialog.close();}catch{notice.textContent='阅读状态保存失败，请点击“我知道了”重试。';}finally{button.disabled=false;}};
 async function check(remote=false){
  if(checking||button.disabled||(remote&&dialog.open))return;checking=true;
  try{await Cloud.boot();notes=await loadNotes(remote);if(!notes)return;
   if(await Cloud.storage(key())!==true)open();
  }catch{/* Retry on the next visit or focus; never mark unread updates as read. */}finally{checking=false;}
 }
 check();setInterval(()=>{if(!document.hidden)check(true);},300000);
 window.addEventListener('focus',()=>check(true));document.addEventListener('visibilitychange',()=>{if(!document.hidden)check(true);});
})();
