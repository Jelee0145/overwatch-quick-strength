import {parseEventBatch} from './events-parser.mjs';
import {json} from './security.mjs';

import {eventApi,eventQuery} from './events-source.mjs';
import {EventQueries} from './events-queries.mjs';
import {Fault} from './security.mjs';
export const EVENTS_API=eventApi();
const SOURCE_VERSION=2;
const HOUR=60*60*1000,MAX_AGE=48*HOUR,MAX_BYTES=2*1024*1024;
export const nextEventSync=now=>(Math.floor(now/HOUR)+1)*HOUR;
export class EventCenter{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.pending=null;this.sourceBusy=false;this.queries=new EventQueries(this);}
 now(){return Date.now();}
 async fetch(request){
  const url=new URL(request.url),path=url.pathname;
  let query;try{query=eventQuery(url.searchParams);}catch(error){return json({error:error.message},error.status||400);}
  if((query.from||query.series!=='owcs')&&['GET','POST'].includes(request.method)&&path!=='/sync'){
   try{const key=await this.queries.ensure(query,{force:request.method==='POST'&&path==='/refresh'});let value=await this.queries.read(key);if(value.state==='pending'||value.updating){await this.queries.work();value=await this.queries.read(key);}return json(value,value.state==='pending'?202:200,{'Cache-Control':'private, no-store',...(value.state==='pending'?{'Retry-After':String(value.retryAfter)}:{})});}
   catch(error){return json({error:error instanceof Fault?error.message:'赛事补查暂不可用，请稍后重试'},error.status||503,{'Cache-Control':'no-store'});}
   finally{await this.schedule();}
  }
  if(path==='/sync'&&request.method==='POST'){await this.alarm();return json({ok:true});}
  if(path==='/refresh'&&request.method==='POST'){
   try{const value=await this.refresh(true);return json(value,200,{'Cache-Control':'private, no-store'});}
   catch{return json({error:'赛程更新失败，请稍后重试'},503,{'Cache-Control':'no-store'});}
   finally{await this.schedule();}
  }
  if(request.method!=='GET')return json({error:'请求方法错误'},405);
  try{
   const value=await this.read();return json(value,200,{'Cache-Control':'private, no-store'});
  }catch{return json({error:'赛程暂未就绪，请稍后再来'},503,{'Cache-Control':'no-store'});}
 }
 async read(){
  // Visitor requests only read persisted data. They never start or await a sync.
  const saved=await this.storage.get('snapshot');
  if(!saved||this.now()-saved.updatedAt>MAX_AGE)throw Error('No usable event data');
  return this.view(saved,this.now()-saved.updatedAt>=HOUR);
 }
 async refresh(force=false){
  if(!this.pending)this.pending=this.load(force).finally(()=>{this.pending=null;this.sourceBusy=false;this.queries=new EventQueries(this);});
  return this.pending;
 }
 async alarm(){
  await this.queries.work();
  try{await this.refresh();}catch{/* A sync failure preserves the last good snapshot. */}
  await this.schedule();
 }
 async schedule(){
  // New key deliberately ignores the old daily nextAttempt on policy upgrade.
  const next=await this.storage.get('refreshAfter')||0;
  const saved=await this.storage.get('snapshot'),due=!saved||saved.sourceVersion!==SOURCE_VERSION||saved.updatedAt<Math.floor(this.now()/HOUR)*HOUR;
  await this.storage.setAlarm(Math.max(due||await this.queries.hasPending()?this.now()+1000:nextEventSync(this.now()),next));
 }
 async load(force){
  const now=this.now(),saved=await this.storage.get('snapshot'),next=await this.storage.get('refreshAfter')||0;
  if(now>=next&&(force||!saved||saved.sourceVersion!==SOURCE_VERSION||saved.updatedAt<Math.floor(now/HOUR)*HOUR)){
   try{
    const {matches}=await this.source(EVENTS_API);
    const snapshot={matches,updatedAt:this.now(),sourceVersion:SOURCE_VERSION};await this.storage.put('snapshot',snapshot);
    await this.storage.put('refreshFailed',false);return this.view(snapshot,false);
   }catch(error){if(!error.retryAfter)await this.storage.put('refreshFailed',true);}
  }
  const value=await this.read();
  if(await this.storage.get('refreshFailed'))return {...value,refreshError:'更新失败或上游暂时限流，正在显示上次成功的数据，请稍后重试。'};
  return value;
 }
 async source(api,options={series:'owcs'}){
  const cooldown=seconds=>Object.assign(Error('Event source cooldown'),{retryAfter:seconds});
  if(this.sourceBusy)throw cooldown(1);this.sourceBusy=true;
  let timer,started=false;
  try{
   const next=await this.storage.get('refreshAfter')||0;if(this.now()<next)throw cooldown(Math.ceil((next-this.now())/1000));
   await this.storage.put('refreshAfter',this.now()+30000);started=true;
   const controller=new AbortController();timer=setTimeout(()=>controller.abort(),10000);
   const identity=this.env.EVENTS_CONTACT||this.env.PUBLIC_ORIGIN;
   if(!identity||/[\r\n]/.test(identity))throw Error('Missing event API contact');
   const response=await (this.env.EVENTS_FETCH||fetch)(api,{headers:{'User-Agent':'OWQS-EventCenter/1.0 ('+identity+')','Accept':'application/json','Accept-Encoding':'gzip'},signal:controller.signal,redirect:'manual'});
   if(!response.ok){
    const retry=response.headers.get('Retry-After'),until=/^\d+$/.test(retry||'')?this.now()+Number(retry)*1000:Date.parse(retry||'');
    if(Number.isFinite(until)&&until>(await this.storage.get('refreshAfter')))await this.storage.put('refreshAfter',until);
    throw Error('Upstream unavailable');
   }
   if(Number(response.headers.get('Content-Length'))>MAX_BYTES)throw Error('Response too large');
   if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('Unexpected response');
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Error('Response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   const data=JSON.parse(new TextDecoder().decode(bytes));return parseEventBatch(data.parse?.text?.['*'],options);
  }catch(error){if(started)await this.storage.put('refreshAfter',Math.max(await this.storage.get('refreshAfter')||0,this.now()+5*60*1000));throw error;}
  finally{clearTimeout(timer);this.sourceBusy=false;}
 }

 view(snapshot,stale){return {matches:snapshot.matches,updatedAt:new Date(snapshot.updatedAt).toISOString(),stale,source:{name:'Liquipedia',url:'https://liquipedia.net/overwatch/Liquipedia:Matches',license:'CC BY-SA 3.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/'},coverage:'上游先筛 OWCS，再分别获取最多 50 场近期赛程与赛果；日期条件仅筛缓存，不代表所选日期的全部比赛或完整赛季。'};}
}
