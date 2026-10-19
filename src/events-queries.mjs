import {Fault} from './security.mjs';
import {eventApi,EVENT_LIMIT,splitEventRange} from './events-source.mjs';

const HOUR=3600000,MAX_QUERIES=8,MAX_PARTS=160;
// One persistent index and bounded, chunked results. None of this shares user tasks/quotas.
export class EventQueries{
 constructor(center){this.center=center;this.storage=center.storage;this.pending=null;this.tail=Promise.resolve();}
 exclusive(fn){const work=this.tail.then(fn);this.tail=work.catch(()=>{});return work;}
 async index(){return await this.storage.get('eventQueries')||[];}
 async hasPending(){return (await this.index()).some(q=>q.job&&q.job.todo.length&&q.job.failures<3);}
 async ensure(query,{force=false}={}){return this.exclusive(async()=>{
  const now=this.center.now(),key=query.series+':'+(query.from?query.from+':'+query.to:'recent'),index=await this.index();let entry=index.find(q=>q.key===key);
  if(!entry){
   if(index.length>=MAX_QUERIES){
    const candidates=index.filter(q=>!q.job||q.job.failures>=3).sort((a,b)=>a.usedAt-b.usedAt);if(!candidates.length)throw new Fault('赛事补查正在排队，请稍后再试',429);
    const old=candidates[0];for(const part of [...old.cache?.parts||[],...old.job?.parts||[]])await this.storage.delete(part);index.splice(index.indexOf(old),1);
   }
   entry={key,query,usedAt:now};index.push(entry);
  }
  entry.usedAt=now;
  const historical=query.to&&query.to<new Date(now+8*HOUR).toISOString().slice(0,10),ttl=historical?24*HOUR:HOUR;
  if(!entry.job&&(!entry.cache||now-entry.cache.updatedAt>=ttl||force&&now-entry.cache.updatedAt>=30000))entry.job={id:crypto.randomUUID(),todo:[query],parts:[],truncated:false,failures:0};
  if(entry.job?.failures>=3&&now>=(await this.storage.get('refreshAfter')||0))entry.job.failures=0;
  await this.storage.put('eventQueries',index);return key;
 });}
 async work(){
  if(!this.pending)this.pending=this.workOne().finally(()=>{this.pending=null;});return this.pending;
 }
 async workOne(){
  const index=await this.index(),entry=index.find(q=>q.job?.todo.length&&q.job.failures<3);if(!entry)return;
  const job=entry.job,range=job.todo[0],limit=range.from?EVENT_LIMIT:50;let batch;
  try{batch=await this.center.source(eventApi(range,limit),range);}
  catch(error){
   if(!error.retryAfter)await this.exclusive(async()=>{const rows=await this.index(),row=rows.find(q=>q.key===entry.key&&q.job?.id===job.id);if(row){row.job.failures++;await this.storage.put('eventQueries',rows);}});
   return;
  }
  const saturated=batch.counts.scheduled>=limit||batch.counts.completed>=limit,split=range.from&&saturated?splitEventRange(range):null;
  const parts=[];
  if(!split){
   for(let offset=0;offset<Math.min(batch.matches.length,(MAX_PARTS-job.parts.length)*25);offset+=25){
    const key='eventQuery:'+job.id+':'+(job.parts.length+parts.length),chunk=batch.matches.slice(offset,offset+25);
    if(new TextEncoder().encode(JSON.stringify(chunk)).length>100000)throw Error('Event cache chunk too large');
    await this.storage.put(key,chunk);parts.push(key);
   }
  }
  await this.exclusive(async()=>{
   const rows=await this.index(),row=rows.find(q=>q.key===entry.key&&q.job?.id===job.id);if(!row)return;
   row.job.todo.shift();row.job.failures=0;
   if(split)row.job.todo.unshift(...split);else {row.job.parts.push(...parts);if(range.from&&saturated)row.job.truncated=true;}
   if(row.job.parts.length>=MAX_PARTS){row.job.todo=[];row.job.truncated=true;}
   if(!row.job.todo.length){
    const old=row.cache?.parts||[];row.cache={parts:row.job.parts,updatedAt:this.center.now(),truncated:row.job.truncated};delete row.job;
    // Publish only complete metadata; failed refreshes cannot replace the successful cache.
    await this.storage.put('eventQueries',rows);for(const key of old)await this.storage.delete(key);
   }else {rows.splice(rows.indexOf(row),1);rows.push(row);await this.storage.put('eventQueries',rows);}
  });
 }
 async read(key){
  const entry=(await this.index()).find(q=>q.key===key);if(!entry)throw new Fault('赛事查询已过期，请重试',404);
  if(!entry.cache||this.center.now()-entry.cache.updatedAt>7*24*HOUR){
   if(entry.job?.failures>=3)throw new Fault('赛事补查暂时失败，请稍后重试',503);
   return {state:'pending',series:entry.query.series,range:entry.query.from?{from:entry.query.from,to:entry.query.to}:null,retryAfter:Math.max(1,Math.ceil(((await this.storage.get('refreshAfter')||this.center.now()+1000)-this.center.now())/1000)),message:'服务器正在按日期与赛事补查，请稍候。'};
  }
  const matches=[],seen=new Set();for(const part of entry.cache.parts){const rows=await this.storage.get(part);if(!rows)throw new Fault('赛事缓存暂不可用，请重试',503);for(const match of rows)if(!seen.has(match.id)){seen.add(match.id);matches.push(match);}}
  const value=this.center.view({matches,updatedAt:entry.cache.updatedAt},!!entry.job);
  return {...value,series:entry.query.series,range:entry.query.from?{from:entry.query.from,to:entry.query.to}:null,truncated:entry.cache.truncated,updating:!!entry.job&&entry.job.failures<3,retryAfter:entry.job?Math.max(1,Math.ceil(((await this.storage.get('refreshAfter')||this.center.now()+1000)-this.center.now())/1000)):undefined,refreshError:entry.job?(entry.job.failures>=3?'补查暂时失败，已保留上次成功的数据。':'正在更新日期查询，先显示上次成功的数据。'):undefined,coverage:entry.cache.truncated?'部分日期达到数据源或缓存条数上限，结果可能不完整，请缩小日期范围。':entry.query.from?'已按北京时间日期范围向 Liquipedia 补查；仅包含上游已公布的数据。':'数据源当前提供的近期比赛，每类最多 50 场。'};
 }
}
