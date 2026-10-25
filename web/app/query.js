// Online query/polling adapter. The local product keeps its own implementation.
async function request(path,body){return Cloud.api(path,body);}
function busy(value){$('resumeQuery').hidden=true;$('query').disabled=value;$('cancel').hidden=!value;}
async function poll(){
 if(!activeJob)return;const id=activeJob;clearTimeout(pollTimer);
 try{
  const job=await Cloud.api('/api/v1/jobs/'+encodeURIComponent(id));if(activeJob!==id)return;
  status(job.message||'查询中…');
  if(job.state==='done'){
   activeJob=null;busy(false);
   let storageWarning='';if(job.envelope){try{await Cloud.save(job.envelope,job.cacheRecords,job.queryIndex);}catch(error){storageWarning=' · 本机保存未完成：'+error.message;}}
   const tag=job.result?.battletag||job.envelope?.content?.data?.battletag;
   if(!tag)throw Error('查询结果缺少战网账号');
   OWQS_SERVER_ANALYSIS.invalidate(tag);let archiveWarning=job.archiveWarning||'';
   if(archiveWarning)await openHistory(tag,null,id);
   else try{await openHistory(tag);}catch(error){archiveWarning='历史读取未完成：'+error.message;await openHistory(tag,null,id);}
   status('查询完成 · '+(job.message||'历史已更新')+storageWarning+(archiveWarning?' · '+archiveWarning+'；当前显示本次查询结果':''));
  }else if(job.state==='failed'||job.state==='cancelled'){
   activeJob=null;busy(false);status(job.message||'查询已结束',job.state==='failed');
  }else if(job.state==='paused'){
   $('resumeQuery').hidden=false;
  }else if(job.cacheRequest){
   // Only an old task created before migration can request browser cache records.
   await CloudCache.fulfill(job);pollTimer=setTimeout(poll,50);
  }else pollTimer=setTimeout(poll,1000);
 }catch(error){if(activeJob&&activeJob!==id)return;activeJob=null;busy(false);status(error.message,true);}
}
function wireQuery(){
 $('resumeQuery').onclick=async()=>{try{await request('/api/job/'+activeJob+'/resume',{});$('resumeQuery').hidden=true;poll();}catch(e){status(e.message,true);}};
 $('onlinePanel').onsubmit=async e=>{e.preventDefault();if(activeJob)return;try{busy(true);status('正在建立查询…');const r=await Cloud.startQuery($('battleTag').value.trim(),Number($('limit').value),$('supplementOtherMatches').checked,$('pool').value);activeJob=r.id;poll();}catch(e){busy(false);status(e.message,true);}};
 $('cancel').onclick=async()=>{if(activeJob){try{await request('/api/job/'+activeJob+'/cancel',{});status('已请求停止，正在结束当前请求…');poll();}catch(e){status(e.message,true);}}};
}
