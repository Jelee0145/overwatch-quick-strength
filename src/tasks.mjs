import {Fault,json,token,digest,canonical,mac,equal,signSnapshot,verifySnapshot,putBlob,getBlob,deleteBlob} from './security.mjs';
import {createQuery,queryStep} from './query.mjs';import {prepareReview,callReview} from './review.mjs';
export async function authCall(env,path,body={},rest={}){const r=await env.AUTH.get(env.AUTH.idFromName('directory')).fetch('https://internal/',{method:'POST',body:JSON.stringify({path,body,...rest})});const data=await r.json();if(!r.ok)throw new Fault(data.error,r.status);return data;}
const active=j=>['running','paused'].includes(j?.state);
export class UserTasks{
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.storage=ctx.storage;this.chain=Promise.resolve();}
 async fetch(request){const i=await request.json();const work=this.chain.then(()=>this.handle(i));this.chain=work.catch(()=>{});try{return json(await work);}catch(e){return json({error:e instanceof Fault?e.message:'任务服务暂不可用'},e.status||500);}}
 async schedule(){await this.storage.setAlarm(Date.now()+1000);}
 async job(id){const j=await this.storage.get('job:'+id);if(!j||j.until<Date.now())throw new Fault('任务不存在或已过期',404);return j;}
 async handle(i){const {user,version,path,body:b={}}=i;await authCall(this.env,'/check-user',{user,version});
  if(path==='/query'||path==='/ai-review'){
   const kind=path==='/query'?'query':'ai',prior=b.envelope?await verifySnapshot(b.envelope,user,this.env,b.battletag):null;
   let analysis;if(kind==='ai'){if(!prior)throw new Fault('本地缺少可信对局，请先查询');analysis=await prepareReview(prior,b.matchId);if(!b.force&&b.cachedReview?.content?.user===user&&b.cachedReview.content.fingerprint===analysis.fingerprint&&equal(b.cachedReview.signature,await mac(b.cachedReview.content,this.env.CACHE_SIGNING_KEY)))return {cached:true,review:{...b.cachedReview.content.review,cached:true},reviewEnvelope:b.cachedReview};}
   const fingerprint=await digest(canonical(kind==='query'?{tag:b.battletag,limit:b.limit}: {fingerprint:analysis.fingerprint,requestId:b.requestId}));
   const previous=await this.storage.get('active:'+kind);if(previous){const old=await this.storage.get('job:'+previous);if(old&&active(old)){if(old.fingerprint===fingerprint)return {id:old.id,state:old.state};throw new Fault('当前'+(kind==='query'?'查询':'AI')+'任务尚未完成',409);}}
   if(kind==='ai'&&(typeof b.requestId!=='string'||b.requestId.length>100))throw new Fault('缺少请求标识');
   // A completed idempotency key is reused until the short-term result expires.
   const dedupeKey=kind==='query'? await digest(canonical({fingerprint,requestId:b.requestId||token()})):fingerprint;
   const done=await this.storage.get('dedupe:'+kind+':'+dedupeKey);if(done){const old=await this.storage.get('job:'+done);if(old&&old.until>Date.now())return {id:old.id,state:old.state};}
   const data=kind==='query'?createQuery(b.battletag,b.limit,prior||{matches:[]}):analysis;
   const id=token(),job={id,user,version,kind,fingerprint,dedupeKey,state:'running',message:kind==='query'?'查询已建立':'正在准备 AI锐评…',createdAt:Date.now(),until:Date.now()+3600000};
   if(kind==='ai')job.reviewKey=String(b.reviewKey||'').slice(0,150);
   await authCall(this.env,'/quota',{user,kind,job:id});
   await putBlob(this.storage,'data:'+id,data);await this.storage.put('job:'+id,job);await this.storage.put('active:'+kind,id);await this.storage.put('dedupe:'+kind+':'+dedupeKey,id);await this.schedule();return {id,state:'running'};
  }
  if(path==='/active'){const tasks=[];for(const kind of ['query','ai']){const id=await this.storage.get('active:'+kind),j=id&&await this.storage.get('job:'+id);if(j&&active(j)&&j.until>Date.now())tasks.push({id:j.id,kind:j.kind,state:j.state,message:j.message});}return {tasks};}
  const job=await this.job(b.id);if(job.user!==user)throw new Fault('任务不存在',404);
  if(path==='/status'){const r={id:job.id,kind:job.kind,state:job.state,message:job.message,reviewKey:job.reviewKey||null};if(job.state==='done'){if(job.kind==='query'){r.envelope=await getBlob(this.storage,'result:'+job.id);r.result=r.envelope.content.data;}else{r.reviewEnvelope=await getBlob(this.storage,'result:'+job.id);r.review=r.reviewEnvelope.content.review;}}return r;}
  if(path==='/cancel'){if(job.kind==='ai')throw new Fault('已发出的 AI 请求不能取消计费');job.cancel=true;if(job.state==='paused'){job.state='cancelled';job.message='查询已停止';job.until=Date.now()+3600000;await this.storage.delete('active:query');}await this.storage.put('job:'+job.id,job);await this.schedule();return {ok:true};}
  if(path==='/resume'){if(job.kind!=='query'||job.state!=='paused')throw new Fault('当前任务不能继续');if(job.resumeAfter>Date.now())throw new Fault('请稍后继续当前任务',429);job.state='running';job.message='正在继续查询…';await this.storage.put('job:'+job.id,job);await this.schedule();return {ok:true};}
  throw new Fault('接口不存在',404);
 }
 async alarm(){
  // One upstream request per alarm; all execution checkpoints are durable.
  const jobs=[...await this.storage.list({prefix:'job:'})].map(([,j])=>j);const now=Date.now();
  for(const j of jobs)if(j.until<now){await this.storage.delete('job:'+j.id);await deleteBlob(this.storage,'data:'+j.id);await deleteBlob(this.storage,'result:'+j.id);if(await this.storage.get('active:'+j.kind)===j.id)await this.storage.delete('active:'+j.kind);await this.storage.delete('dedupe:'+j.kind+':'+(j.dedupeKey||j.fingerprint));}
  const last=await this.storage.get('lastKind');const job=jobs.filter(j=>j.state==='running'&&j.until>now).sort((a,b)=>(a.kind===last)-(b.kind===last))[0];
  if(job){
   try{
    await authCall(this.env,'/check-user',{user:job.user,version:job.version});if(job.cancel){job.state='cancelled';job.message='查询已停止';}else{
     const data=await getBlob(this.storage,'data:'+job.id);if(!data)throw new Fault('任务数据已过期',410);
     if(job.kind==='query'){
      job.message=await queryStep(data,this.env);if(data.phase==='done'){await putBlob(this.storage,'result:'+job.id,await signSnapshot(job.user,data.result,this.env));job.state='done';}else await putBlob(this.storage,'data:'+job.id,data);
     }else{
      // Alarms may be delivered again after interruption: never resend a dispatched AI request.
      if(job.dispatched)throw new Fault('上次 AI 请求中断，未自动重发；请手动重新锐评',504);
      job.dispatched=true;await this.storage.put('job:'+job.id,job);
      const review=await callReview(this.env,data.payload,data.fingerprint);const content={user:job.user,fingerprint:data.fingerprint,review};await putBlob(this.storage,'result:'+job.id,{content,signature:await mac(content,this.env.CACHE_SIGNING_KEY)});job.state='done';job.message='锐评已生成';
     }
    }
   }catch(e){job.state=e.status===429&&job.kind==='query'?'paused':'failed';job.message=e instanceof Fault?e.message:'任务服务暂不可用';job.resumeAfter=Date.now()+30000;if(job.kind==='ai')await authCall(this.env,'/quota',{user:job.user,kind:'ai',job:job.id,refund:true}).catch(()=>{});}
   const latest=await this.storage.get('job:'+job.id);if(latest?.cancel&&job.kind==='query'){job.state='cancelled';job.message='查询已停止';}
   if(!active(job)){job.until=Date.now()+3600000;await this.storage.delete('active:'+job.kind);await deleteBlob(this.storage,'data:'+job.id);}
   await this.storage.put('job:'+job.id,job);await this.storage.put('lastKind',job.kind);
  }
  const rest=[...await this.storage.list({prefix:'job:'})].map(([,j])=>j);if(rest.length)await this.storage.setAlarm(rest.some(j=>j.state==='running')?Date.now()+1000:Math.min(...rest.map(j=>j.until))+1);
 }
}
