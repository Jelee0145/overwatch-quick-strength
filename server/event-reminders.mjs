import {createHash,randomUUID} from 'node:crypto';
import {Fault} from '../src/security.mjs';
import {broadcastsFor} from '../src/events-broadcasts.mjs';
import {validateSubscription} from './web-push.mjs';

const MINUTE=60000,DAY=86400000;
const retainNotices=(notices,now)=>notices.filter(n=>Number.isFinite(n.createdAt)&&now-n.createdAt<DAY).slice(-100);
function pushFailure(error,now){
 const status=Number(error?.statusCode),code=Number.isInteger(status)&&status>=400&&status<=599?'http':error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network';
 return {code,at:now,...(code==='http'?{statusCode:status}:{})};
}
function deliveryView(r,account,enabled,now){
 const deliveryCount=Object.values(r.deliveries||{}).filter(Boolean).length;
 const eligible=Object.values(account.subscriptions).some(d=>!r.notifiedAt||d.enabledAt<=r.notifiedAt);
 const expired=r.notifiedAt&&(r.finished||now-Date.parse(r.notifiedStartsAt)>5*MINUTE);
 return {deliveryStatus:deliveryCount?'sent':r.deliveryFailure||expired?'failed':!enabled||!eligible||r.finished&&!r.notifiedAt?'unavailable':'pending',deliveryCount,deliveryFailure:r.deliveryFailure||null};
}
const hash=value=>createHash('sha256').update(value).digest('hex');
// Time is mutable. Repeated pairings within a stage are deliberately ineligible.
export function matchIdentity(match){
 if(match.series!=='owcs'||match.teams?.length!==2||match.teams.some(t=>!t.name||/^(?:tbd|tba|待定|unknown)$/i.test(t.name)))return null;
 return hash(JSON.stringify([match.sourceUrl,...match.teams.map(t=>t.name.toLowerCase().trim()).sort()]));
}
export class EventReminders{
 constructor(storage,env,{send,publicKey='',now=()=>Date.now()}={}){this.storage=storage;this.env=env;this.send=send;this.publicKey=publicKey;this.now=now;this.chain=Promise.resolve();}
 exclusive(fn){const p=this.chain.then(fn);this.chain=p.catch(()=>{});return p;}
 async state(){return await this.storage.get('state')||{catalog:{},users:{},checked:{}};}
 recover(){return this.exclusive(async()=>{
  const state=await this.state(),now=this.now();
  for(const account of Object.values(state.users))account.notices=retainNotices(account.notices,now);
  await this.save(state);
  // Recover missing alarms without making network requests or replaying old notices.
  if(Object.values(state.users).some(u=>Object.values(u.reservations).some(r=>!r.finished)))await this.storage.setAlarm(now);
 });}
 async save(state){await this.storage.put('state',state);await this.schedule(state);}
 async schedule(state){
  const now=this.now(),active=Object.values(state.users).flatMap(u=>Object.values(u.reservations)).filter(r=>!r.finished);
  if(!active.length){await this.storage.deleteAlarm();return;}
  const times=active.map(r=>Date.parse(state.catalog[r.id]?.match.startsAt)).filter(t=>Number.isFinite(t)&&t>now);
  const existing=await this.storage.getAlarm(),hasRetry=active.some(r=>{const start=Date.parse(state.catalog[r.id]?.match.startsAt);return start<=now&&now-start<=5*MINUTE;});
  await this.storage.setAlarm(Math.min(now+(hasRetry?30000:2*MINUTE),...times,...(existing>now?[existing]:[])));
 }
 ingest(state,matches,checkedAt){
  const groups=new Map();for(const match of matches){const id=matchIdentity(match);if(id)groups.set(id,[...(groups.get(id)||[]),match]);}
  for(const [id,group] of groups){
   const old=state.catalog[id],unique=new Map(group.map(m=>[m.id,m]));
   if(old?.checkedAt>checkedAt){if(unique.size>1)old.ambiguous=true;continue;}
   if(unique.size!==1){state.catalog[id]={...(old||{match:group[0],checkedAt:0}),ambiguous:true};continue;}
   const match=group[0];if(old?.ambiguous&&checkedAt===0)continue;
   const same=old?.match.id===match.id&&old?.match.status===match.status;
   state.catalog[id]={match,checkedAt:checkedAt||(same?old?.checkedAt||0:0),ambiguous:false};
  }
 }
 decorate(matches){return this.exclusive(async()=>{
  const state=await this.state();this.ingest(state,matches,0);
  // A list read is not a fresh source observation; background tracking confirms schedules.
  await this.save(state);
  return matches.map(match=>{const id=matchIdentity(match),entry=state.catalog[id];return {...match,broadcasts:broadcastsFor(match),reminderId:id,reservable:!!id&&!entry?.ambiguous&&match.status!=='completed'&&(!match.startsAt||Date.parse(match.startsAt)>this.now())};});
 });}
 handle(user,action,body={}){return this.exclusive(async()=>{
  const state=await this.state(),account=state.users[user]||={subscriptions:{},reservations:{},notices:[]};
  if(action==='subscribe'){
   if(!this.send)throw new Fault('比赛通知尚未配置，请联系管理员',503);
   let subscription;try{subscription=validateSubscription(body.subscription);}catch{throw new Fault('通知设备格式错误',400);}const key=hash(subscription.endpoint);
   if(!account.subscriptions[key]&&Object.keys(account.subscriptions).length>=10)throw new Fault('最多启用 10 台通知设备');
   // A browser endpoint belongs to its current signed-in account only.
   for(const [id,other] of Object.entries(state.users))if(id!==user)delete other.subscriptions[key];
   account.subscriptions[key]={value:subscription,enabledAt:account.subscriptions[key]?.enabledAt||this.now()};
  }else if(action==='unsubscribe'){
   if(typeof body.endpoint!=='string')throw new Fault('通知设备格式错误');delete account.subscriptions[hash(body.endpoint)];
  }else if(action==='reserve'){
   const found=Object.entries(state.catalog).find(([key,v])=>key===body.matchId||v.match.id===body.matchId),[id,entry]=found||[];
   if(!entry||entry.ambiguous||entry.match.status==='completed'||(entry.match.startsAt&&Date.parse(entry.match.startsAt)<=this.now()))throw new Fault('这场比赛暂不支持预约，请刷新赛程');
   if(!account.reservations[id]&&Object.keys(account.reservations).length>=100)throw new Fault('最多保留 100 场预约，请先清理旧预约');
   account.reservations[id]||={id,originalStartsAt:entry.match.startsAt,createdAt:this.now(),deliveries:{}};
  }else if(action==='cancel'){
   delete account.reservations[body.id];account.notices=account.notices.filter(n=>n.matchId!==body.id);
  }else if(action!=='list')throw new Fault('接口不存在',404);
  account.notices=retainNotices(account.notices,this.now());
  await this.save(state);
  return {enabled:!!this.send,publicKey:this.publicKey,deviceCount:Object.keys(account.subscriptions).length,deliveryReady:!!this.send&&Object.keys(account.subscriptions).length>0,reservations:Object.values(account.reservations).map(r=>{const entry=state.catalog[r.id];return {id:r.id,...deliveryView(r,account,!!this.send,this.now()),match:entry?.match,changed:r.originalStartsAt!==entry?.match.startsAt,state:r.finished?'completed':r.notifiedAt?'notified':!entry?.checkedAt||entry.ambiguous?'unverified':'active'};}),notices:account.notices};
 });}
 alarm(){return this.exclusive(async()=>{
  const state=await this.state(),now=this.now(),ids=new Set(Object.values(state.users).flatMap(u=>Object.values(u.reservations).filter(r=>!r.finished).map(r=>r.id)));
  const sources=[...new Set([...ids].map(id=>state.catalog[id]?.match.sourceUrl).filter(Boolean))];
  // Share source requests across every account and device, obeying EventCenter's gate.
  const source=sources.filter(s=>now-(state.checked[s]||0)>=2*MINUTE||[...ids].some(id=>{const e=state.catalog[id],start=Date.parse(e?.match.startsAt);return e?.match.sourceUrl===s&&start<=now&&e.checkedAt<start;})).sort((a,b)=>(state.attempted?.[a]||0)-(state.attempted?.[b]||0))[0];
  if(source){
   state.attempted||={};state.attempted[source]=now;
   try{
    const response=await this.env.EVENTS.get().fetch('https://events.internal/track?source='+encodeURIComponent(source),{method:'POST'});
    if(response.ok){const data=await response.json();for(const id of ids)if(state.catalog[id]?.match.sourceUrl===source)state.catalog[id].checkedAt=0;this.ingest(state,data.matches,now);state.checked[source]=now;}
   }catch{/* Preserve reservations and retry after the shared source backoff. */}
  }
  for(const account of Object.values(state.users)){
   account.notices=retainNotices(account.notices,now);
   for(const r of Object.values(account.reservations)){
    const entry=state.catalog[r.id];if(!entry||r.finished)continue;
    if(entry.match.status==='completed'){r.finished=true;r.finishedAt=now;continue;}
    const start=Date.parse(entry.match.startsAt);
    if((Number.isFinite(start)&&now-start>DAY)||(!Number.isFinite(start)&&now-r.createdAt>14*DAY)){r.finished=true;r.finishedAt=now;continue;}
    if(r.notifiedAt&&r.notifiedStartsAt!==entry.match.startsAt&&start>now){r.notifiedAt=null;r.noticeId=null;r.deliveries={};delete r.deliveryFailure;account.notices=account.notices.filter(n=>n.matchId!==r.id);}
    if(entry.ambiguous||!entry.checkedAt||now-entry.checkedAt>3*MINUTE||!Number.isFinite(start)||start>now||entry.checkedAt<start)continue;
    // Never replay old reminders after a long outage.
    if(now-start>5*MINUTE){r.finished=true;r.finishedAt=now;continue;}
    if(!r.notifiedAt){r.notifiedAt=now;r.notifiedStartsAt=entry.match.startsAt;r.noticeId=randomUUID();account.notices.push({id:r.noticeId,matchId:r.id,url:broadcastsFor(entry.match)[0]?.url||'/tools/events',createdAt:now});account.notices=retainNotices(account.notices,now);}
    const payload={id:r.noticeId,title:'即将开赛',url:broadcastsFor(entry.match)[0]?.url||'/tools/events',tag:'owqs-match-'+r.id};
    // Persist the notice before outbound work; successful endpoints survive restarts.
    await this.storage.put('state',state);
    for(const [key,device] of Object.entries(account.subscriptions)){
     if(this.now()-start>5*MINUTE)break;
     if(r.deliveries[key]||device.enabledAt>r.notifiedAt||!this.send)continue;
     try{
      const result=await this.send(device.value,payload);
      if(result?.expired){delete account.subscriptions[key];r.deliveryFailure={code:'expired',at:this.now()};console.warn(JSON.stringify({event:'event_reminder_push_failed',...r.deliveryFailure}));}
      else{r.deliveries[key]=true;delete r.deliveryFailure;}
     }catch(error){r.deliveryFailure=pushFailure(error,this.now());console.warn(JSON.stringify({event:'event_reminder_push_failed',...r.deliveryFailure}));}
     // Persist only an allowlisted failure category, never provider text or device URLs.
     await this.storage.put('state',state);
    }
   }
  }
  for(const account of Object.values(state.users))for(const [id,r] of Object.entries(account.reservations))if(r.finishedAt&&now-r.finishedAt>7*DAY)delete account.reservations[id];
  // Bound catalog retention without dropping any account's reservations.
  const retained=new Set(Object.values(state.users).flatMap(u=>Object.keys(u.reservations)));
  for(const [id,v] of Object.entries(state.catalog))if(!retained.has(id)&&Date.parse(v.match.startsAt)<now-7*DAY)delete state.catalog[id];
  await this.save(state);
 });}
}
