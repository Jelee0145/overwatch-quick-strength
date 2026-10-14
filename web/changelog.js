'use strict';
(()=>{
 const version='2026-10-14-history-1',key='changelog|'+version;
 const dialog=document.getElementById('changelogDialog'),button=document.getElementById('changelogAcknowledge'),notice=document.getElementById('changelogNotice');
 const open=()=>{notice.textContent='';if(!dialog.open)dialog.showModal();};
 document.getElementById('changelogOpen').onclick=open;
 dialog.addEventListener('cancel',event=>event.preventDefault());
 button.onclick=async()=>{
  if(button.disabled)return;button.disabled=true;
  try{await Cloud.storage(key,true);dialog.close();}
  catch{notice.textContent='阅读状态保存失败，请点击“我知道了”重试。';}
  finally{button.disabled=false;}
 };
 (async()=>{try{await Cloud.boot();if(await Cloud.storage(key)!==true)open();}catch{/* Login and cache failures are handled by the application. */}})();
})();
