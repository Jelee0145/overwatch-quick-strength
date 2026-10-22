// Explicit online polling adapter, inserted in place of the local poll function by the web build.
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
