import {parseEvents} from './events-parser.mjs';
import {json} from './security.mjs';

export const EVENTS_API='https://liquipedia.net/overwatch/api.php?action=parse&page=Liquipedia%3AMatches&prop=text&format=json';
const DAY=24*60*60*1000,MAX_AGE=2*DAY,MAX_BYTES=2*1024*1024;
export const eventDay=now=>new Date(now+8*60*60*1000).toISOString().slice(0,10);
export const nextEventSync=now=>(Math.floor((now+8*60*60*1000)/DAY)+1)*DAY-8*60*60*1000;
export class EventCenter{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.pending=null;}
 now(){return Date.now();}
 async fetch(request){
  if(new URL(request.url).pathname==='/sync'&&request.method==='POST'){await this.alarm();return json({ok:true});}
  if(request.method!=='GET')return json({error:'请求方法错误'},405);
  try{
   const value=await this.read();return json(value,200,{'Cache-Control':'private, no-store'});
  }catch{return json({error:'赛程暂未就绪，请稍后再来'},503,{'Cache-Control':'no-store'});}
 }
 async read(){
  // Visitor requests only read persisted data. They never start or await a sync.
  const saved=await this.storage.get('snapshot');
  if(!saved||this.now()-saved.updatedAt>MAX_AGE)throw Error('No usable event data');
  return this.view(saved,eventDay(saved.updatedAt)!==eventDay(this.now()));
 }
 async refresh(){
  if(!this.pending)this.pending=this.load().finally(()=>{this.pending=null;});
  return this.pending;
 }
 async alarm(){
  try{await this.refresh();}catch{/* A daily sync failure preserves the last good snapshot. */}
  const next=await this.storage.get('nextAttempt')||nextEventSync(this.now());
  await this.storage.setAlarm(Math.max(this.now()+1000,next));
 }
 async load(){
  const now=this.now(),saved=await this.storage.get('snapshot'),next=await this.storage.get('nextAttempt')||0;
  const attempted=await this.storage.get('lastAttemptDay');
  if(attempted===eventDay(now)||saved&&eventDay(saved.updatedAt)===eventDay(now)){
   await this.storage.put('nextAttempt',Math.max(next,nextEventSync(now)));
   return this.read();
  }
  if(now>=next){
   // One attempt per Beijing calendar day, even after failure or process restart.
   await this.storage.put('lastAttemptDay',eventDay(now));
   await this.storage.put('nextAttempt',Math.max(nextEventSync(now),now+30000));
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
   try{
    const identity=this.env.EVENTS_CONTACT||this.env.PUBLIC_ORIGIN;
    if(!identity||/[\r\n]/.test(identity))throw Error('Missing event API contact');
    const response=await (this.env.EVENTS_FETCH||fetch)(EVENTS_API,{headers:{'User-Agent':'OWQS-EventCenter/1.0 ('+identity+')','Accept':'application/json','Accept-Encoding':'gzip'},signal:controller.signal,redirect:'manual'});
    if(!response.ok){
     const retry=response.headers.get('Retry-After');
     const until=/^\d+$/.test(retry||'')?this.now()+Number(retry)*1000:Date.parse(retry||'');
     if(Number.isFinite(until)&&until>(await this.storage.get('nextAttempt')))await this.storage.put('nextAttempt',until);
     throw Error('Upstream unavailable');
    }
    if(Number(response.headers.get('Content-Length'))>MAX_BYTES)throw Error('Response too large');
    if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('Unexpected response');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Error('Response too large');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
    const data=JSON.parse(new TextDecoder().decode(bytes)),matches=parseEvents(data.parse?.text?.['*']);
    const snapshot={matches,updatedAt:this.now()};await this.storage.put('snapshot',snapshot);
    return this.view(snapshot,false);
   }catch{/* Keep the last valid snapshot; the next attempt is the next daily sync. */}
   finally{clearTimeout(timer);}
  }
  return this.read();
 }
 view(snapshot,stale){return {matches:snapshot.matches,updatedAt:new Date(snapshot.updatedAt).toISOString(),stale,source:{name:'Liquipedia',url:'https://liquipedia.net/overwatch/Liquipedia:Matches',license:'CC BY-SA 3.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/'},coverage:'仅包含数据源当前提供的 OWCS 近期比赛，不代表完整赛季。'};}
}
