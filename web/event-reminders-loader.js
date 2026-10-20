'use strict';
// Load match reminders after the page is interactive; the events page includes the engine directly.
(()=>{
 const url='__EVENT_REMINDERS_URL__';
 let started=false;
 function start(){
  if(started||window.EventReminders)return;
  started=true;
  const script=document.createElement('script');
  script.src=url;script.async=true;script.dataset.eventReminders='';
  document.head.append(script);
 }
 function idle(){
  if('requestIdleCallback' in window)window.requestIdleCallback(start,{timeout:1000});
  else setTimeout(start,50);
 }
 if(document.readyState==='complete')idle();
 else window.addEventListener('load',idle,{once:true});
})();
