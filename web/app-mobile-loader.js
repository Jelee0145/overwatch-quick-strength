'use strict';
// The phone layout is only fetched when its media query already matches, so desktop never downloads it.
(()=>{
 const media=matchMedia('(max-width:760px), (max-height:500px) and (pointer:coarse)');
 let started=false;
 function start(){
  if(started||!media.matches)return;
  started=true;
  const script=document.createElement('script');
  script.src='__APP_MOBILE_URL__';script.async=true;script.dataset.appMobile='';
  document.head.append(script);
 }
 start();media.addEventListener?.('change',start);
})();
