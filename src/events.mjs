import {parseEvents} from './events-parser.mjs';
import {json} from './security.mjs';

export const EVENTS_API='https://liquipedia.net/overwatch/api.php?action=parse&page=Liquipedia%3AMatches&prop=text&format=json';
const HOUR=60*60*1000,MAX_AGE=48*HOUR,MAX_BYTES=2*1024*1024;
export const nextEventSync=now=>(Math.floor(now/HOUR)+1)*HOUR;
export class EventCenter{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.pending=null;}
 now(){return Date.now();}
 async fetch(request){
  const path=new URL(request.url).pathname;
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
  if(!this.pending)this.pending=this.load(force).finally(()=>{this.pending=null;});
  return this.pending;
 }
 async alarm(){
  try{await this.refresh();}catch{/* A sync failure preserves the last good snapshot. */}
  await this.schedule();
 }
 async schedule(){
  // New key deliberately ignores the old daily nextAttempt on policy upgrade.
  const next=await this.storage.get('refreshAfter')||0;
  await this.storage.setAlarm(Math.max(nextEventSync(this.now()),next));
 }
 async load(force){
  const now=this.now(),saved=await this.storage.get('snapshot'),next=await this.storage.get('refreshAfter')||0;
  if(now>=next&&(force||!saved||saved.updatedAt<Math.floor(now/HOUR)*HOUR)){
   // Persist spacing before the request, including failures and process restarts.
   await this.storage.put('refreshAfter',now+30000);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
   try{
    const identity=this.env.EVENTS_CONTACT||this.env.PUBLIC_ORIGIN;
    if(!identity||/[\r\n]/.test(identity))throw Error('Missing event API contact');
    const response=await (this.env.EVENTS_FETCH||fetch)(EVENTS_API,{headers:{'User-Agent':'OWQS-EventCenter/1.0 ('+identity+')','Accept':'application/json','Accept-Encoding':'gzip'},signal:controller.signal,redirect:'manual'});
    if(!response.ok){
     const retry=response.headers.get('Retry-After');
     const until=/^\d+$/.test(retry||'')?this.now()+Number(retry)*1000:Date.parse(retry||'');
     if(Number.isFinite(until)&&until>(await this.storage.get('refreshAfter')))await this.storage.put('refreshAfter',until);
     throw Error('Upstream unavailable');
    }
    if(Number(response.headers.get('Content-Length'))>MAX_BYTES)throw Error('Response too large');
    if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('Unexpected response');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Error('Response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    const data=JSON.parse(new TextDecoder().decode(bytes)),matches=parseEvents(data.parse?.text?.['*']);
    const snapshot={matches,updatedAt:this.now()};await this.storage.put('snapshot',snapshot);
    await this.storage.put('refreshFailed',false);
    return this.view(snapshot,false);
   }catch{
    await this.storage.put('refreshFailed',true);
    await this.storage.put('refreshAfter',Math.max(await this.storage.get('refreshAfter')||0,this.now()+5*60*1000));
   }
   finally{clearTimeout(timer);}
  }
  const value=await this.read();
  if(await this.storage.get('refreshFailed'))return {...value,refreshError:'更新失败或上游暂时限流，正在显示上次成功的数据，请稍后重试。'};
  return value;
 }
 view(snapshot,stale){return {matches:snapshot.matches,updatedAt:new Date(snapshot.updatedAt).toISOString(),stale,source:{name:'Liquipedia',url:'https://liquipedia.net/overwatch/Liquipedia:Matches',license:'CC BY-SA 3.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/'},coverage:'仅包含数据源当前提供的 OWCS 近期比赛，不代表完整赛季。'};}
}
