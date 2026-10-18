import {parseEvents} from './events-parser.mjs';
import {json} from './security.mjs';

export const EVENTS_API='https://liquipedia.net/overwatch/api.php?action=parse&page=Liquipedia%3AMatches&prop=text&format=json';
const TTL=5*60*1000,MAX_AGE=24*60*60*1000,MAX_BYTES=2*1024*1024;
export class EventCenter{
 constructor(ctx,env){this.storage=ctx.storage;this.env=env;this.pending=null;}
 now(){return Date.now();}
 async fetch(request){
  if(request.method!=='GET')return json({error:'请求方法错误'},405);
  try{
   const value=await this.read(request.headers.get('X-OWQS-Public-Origin'));return json(value,200,{'Cache-Control':'private, no-store'});
  }catch{return json({error:'赛事数据暂不可用，请稍后重试'},503,{'Retry-After':'300','Cache-Control':'no-store'});}
 }
 async read(contact){
  // Assign before the first storage await so parallel requests share one refresh.
  if(!this.pending)this.pending=this.load(contact).finally(()=>{this.pending=null;});
  return this.pending;
 }
 async load(contact){
  const now=this.now(),saved=await this.storage.get('snapshot'),next=await this.storage.get('nextAttempt')||0;
  if(saved&&now-saved.updatedAt<TTL)return this.view(saved,false);
  if(now>=next){
   // Persist the cooldown first; a restart must not bypass upstream rate limits.
   await this.storage.put('nextAttempt',now+TTL);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
   try{
    const identity=this.env.EVENTS_CONTACT||this.env.PUBLIC_ORIGIN||contact;
    if(!identity||/[\r\n]/.test(identity))throw Error('Missing event API contact');
    const response=await (this.env.EVENTS_FETCH||fetch)(EVENTS_API,{headers:{'User-Agent':'OWQS-EventCenter/1.0 ('+identity+')','Accept':'application/json','Accept-Encoding':'gzip'},signal:controller.signal,redirect:'manual'});
    if(!response.ok){
     const retry=response.headers.get('Retry-After');
     const until=/^\d+$/.test(retry||'')?this.now()+Number(retry)*1000:Date.parse(retry||'');
     if(Number.isFinite(until)&&until>now+TTL)await this.storage.put('nextAttempt',until);
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
   }catch{
    // Back off for five full minutes after failure, including time spent waiting.
    await this.storage.put('nextAttempt',Math.max(await this.storage.get('nextAttempt')||0,this.now()+TTL));
    // Keep the last valid snapshot on network, parse and upstream failures.
   }
   finally{clearTimeout(timer);}
  }
  if(saved&&this.now()-saved.updatedAt<=MAX_AGE)return this.view(saved,true);
  throw Error('No usable event data');
 }
 view(snapshot,stale){return {matches:snapshot.matches,updatedAt:new Date(snapshot.updatedAt).toISOString(),stale,source:{name:'Liquipedia',url:'https://liquipedia.net/overwatch/Liquipedia:Matches',license:'CC BY-SA 3.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/3.0/'},coverage:'仅包含数据源当前提供的 OWCS 近期比赛，不代表完整赛季。'};}
}
