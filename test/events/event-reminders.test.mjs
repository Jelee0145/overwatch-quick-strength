import test from 'node:test';
import assert from 'node:assert/strict';
import {EventReminders,matchIdentity} from '../../server/event-reminders.mjs';
import {SqliteDatabase} from '../../server/storage.mjs';
import {generateKeyPairSync} from 'node:crypto';
const base=Date.parse('2026-10-20T12:00:00Z');
function match(time=base+60000){return {id:'legacy-'+time,series:'owcs',sourceUrl:'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Asia/Stage_3/Japan',teams:[{name:'Team A'},{name:'Team B'}],startsAt:new Date(time).toISOString(),status:'scheduled',region:'日本'};}
function subscription(id){const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=publicKey.export({format:'jwk'});return {endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{auth:Buffer.alloc(16,1).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url')}};}
function setup(){const db=new SqliteDatabase(':memory:');let now=base,current=match(),fail=false;const sent=[];const env={EVENTS:{get:()=>({fetch:async()=>fail?new Response('',{status:503}):Response.json({matches:[current]})})}};const service=new EventReminders(db.store('reminders'),env,{now:()=>now,publicKey:'test',send:async(s,p)=>{sent.push({s,p});return {};}});return {db,service,sent,setTime:t=>now=t,setMatch:m=>current=m,fail:()=>fail=true};}
test('identity survives changed time, rejects unknown teams and ambiguous repeat pairings',async()=>{
 const c=setup();try{assert.equal(matchIdentity(match()),matchIdentity(match(base+900000)));assert.equal(matchIdentity({...match(),teams:[{name:'TBD'},{name:'A'}]}),null);const values=await c.service.decorate([match(),match(base+900000)]);assert.ok(values.every(m=>!m.reservable));}finally{await c.db.close();}
});
test('account reservation fans out to all devices and tracks postponement before sending',async()=>{
 const c=setup();try{
 const a=subscription('a'),b=subscription('b');await c.service.handle('u','subscribe',{subscription:a});await c.service.handle('u','subscribe',{subscription:b});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});
 const postponed=match(base+180000);c.setMatch(postponed);c.setTime(base+60000);await c.service.alarm();assert.equal(c.sent.length,0);let value=await c.service.handle('u','list');assert.equal(value.reservations[0].match.startsAt,postponed.startsAt);assert.equal(value.reservations[0].changed,true);
 c.setTime(base+180000);await c.service.alarm();assert.equal(c.sent.length,2);assert.ok(c.sent.every(s=>s.p.title==='即将开赛'));assert.equal((await c.service.handle('u','list')).notices.length,1);
 await c.service.alarm();assert.equal(c.sent.length,2);
 }finally{await c.db.close();}
});
test('cancellation, source absence and stale schedules never produce a reminder',async()=>{
 for(const scenario of ['cancel','missing','stale']){const c=setup();try{await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match()]);const value=await c.service.handle('u','reserve',{matchId:match().id});if(scenario==='cancel')await c.service.handle('u','cancel',{id:value.reservations[0].id});if(scenario==='missing')c.setMatch({...match(),teams:[{name:'Different'},{name:'Opponent'}]});if(scenario==='stale')c.fail();c.setTime(base+60000);await c.service.alarm();assert.equal(c.sent.length,0);}finally{await c.db.close();}}
});
test('a postponement discovered after notification rearms the new time without replaying the old notice',async()=>{
 const c=setup();try{await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});c.setTime(base+60000);await c.service.alarm();assert.equal(c.sent.length,1);
 c.setMatch(match(base+600000));c.setTime(base+180000);await c.service.alarm();assert.equal((await c.service.handle('u','list')).notices.length,0);c.setTime(base+600000);await c.service.alarm();assert.equal(c.sent.length,2);assert.notEqual(c.sent[0].p.id,c.sent[1].p.id);
 }finally{await c.db.close();}
});
test('list polling cannot postpone scheduled work and failed final verification suppresses stale notification',async()=>{
 const c=setup();try{await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match(base+3600000)]);c.setMatch(match(base+3600000));await c.service.handle('u','reserve',{matchId:match(base+3600000).id});const first=await c.db.store('reminders').getAlarm();c.setTime(base+15000);await c.service.handle('u','list');assert.equal(await c.db.store('reminders').getAlarm(),first);
 c.setTime(base+3600000-60000);await c.service.alarm();c.fail();c.setTime(base+3600000);await c.service.alarm();assert.equal(c.sent.length,0);
 }finally{await c.db.close();}
});
test('stable identity can reserve after list time changes and malformed subscriptions return a client error',async()=>{
 const c=setup();try{await assert.rejects(c.service.handle('u','subscribe',{subscription:{}}),e=>e.status===400);await c.service.handle('u','subscribe',{subscription:subscription('a')});const [m]=await c.service.decorate([match()]);c.setTime(base+1000);await c.service.alarm();await c.service.decorate([match(base+300000)]);assert.equal((await c.service.handle('u','reserve',{matchId:m.reminderId})).reservations.length,1);}finally{await c.db.close();}
});
test('account reservations can precede a device and report delivery readiness independently',async()=>{
 const c=setup();try{
  await c.service.decorate([match()]);const reserved=await c.service.handle('u','reserve',{matchId:match().id});assert.equal(reserved.reservations.length,1);assert.equal(reserved.deliveryReady,false);assert.equal(reserved.deviceCount,0);
  const subscribed=await c.service.handle('u','subscribe',{subscription:subscription('later')});assert.equal(subscribed.deliveryReady,true);assert.equal(subscribed.deviceCount,1);assert.equal(subscribed.reservations[0].id,reserved.reservations[0].id);
 }finally{await c.db.close();}
});
test('subscriptions move between accounts and reservations recover from persisted state',async()=>{
 const c=setup();try{const s=subscription('shared');await c.service.handle('u','subscribe',{subscription:s});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});await c.service.handle('other','subscribe',{subscription:s});assert.equal(Object.keys((await c.service.state()).users.u.subscriptions).length,0);const restarted=new EventReminders(c.db.store('reminders'),{},{});assert.equal((await restarted.handle('u','list')).reservations.length,1);}finally{await c.db.close();}
});

test('generated notices are not successful pushes; sanitized failure retries and succeeds once',async()=>{
 const c=setup();try{
  await c.service.handle('u','subscribe',{subscription:subscription('secret-device')});await c.service.decorate([match()]);
  assert.equal((await c.service.handle('u','reserve',{matchId:match().id})).reservations[0].deliveryStatus,'pending');
  let attempts=0;c.service.send=async()=>{attempts++;if(attempts===1)throw Object.assign(Error('secret endpoint and authorization'),{statusCode:503});return {ok:true};};
  c.setTime(base+60000);await c.service.alarm();
  let value=await c.service.handle('u','list'),r=value.reservations[0];
  assert.equal(value.notices.length,1);assert.equal(r.state,'notified');assert.equal(r.deliveryStatus,'failed');assert.equal(r.deliveryCount,0);
  assert.deepEqual(r.deliveryFailure,{code:'http',at:base+60000,statusCode:503});
  assert.ok(!JSON.stringify(value).includes('secret'));const noticeId=value.notices[0].id;
  assert.equal(await c.db.store('reminders').getAlarm(),base+90000);
  c.setTime(base+90000);await c.service.alarm();value=await c.service.handle('u','list');r=value.reservations[0];
  assert.equal(r.deliveryStatus,'sent');assert.equal(r.deliveryCount,1);assert.equal(r.deliveryFailure,null);
  assert.equal(value.notices[0].id,noticeId);await c.service.alarm();assert.equal(attempts,2);
 }finally{await c.db.close();}
});

test('delivery metadata distinguishes timeout, unavailable and expired subscriptions without leaking errors',async()=>{
 for(const scenario of ['unavailable','timeout','expired']){const c=setup();try{
  if(scenario!=='unavailable')await c.service.handle('u','subscribe',{subscription:subscription('private')});
  c.service.send=async()=>{if(scenario==='expired')return {expired:true};throw Object.assign(Error('private token'),{name:'TimeoutError'});};
  await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});c.setTime(base+60000);await c.service.alarm();
  const value=await c.service.handle('u','list'),r=value.reservations[0];assert.equal(r.deliveryStatus,scenario==='unavailable'?'unavailable':'failed');
  assert.equal(r.deliveryFailure?.code,scenario==='unavailable'?undefined:scenario);assert.ok(!JSON.stringify(value).includes('private'));
 }finally{await c.db.close();}}
});

test('notices survive page absence for 24 hours and remain bounded to 100 entries',async()=>{
 const c=setup();try{
  const store=c.db.store('reminders'),state={catalog:{},users:{u:{subscriptions:{},reservations:{},notices:Array.from({length:105},(_,i)=>({id:String(i),createdAt:base-1000+i}))}},checked:{}};
  state.users.u.notices.unshift({id:'expired',createdAt:base-86400000});await store.put('state',state);
  let value=await c.service.handle('u','list');assert.equal(value.notices.length,100);assert.equal(value.notices[0].id,'5');
  c.setTime(base+3600000);value=await c.service.handle('u','list');assert.equal(value.notices.length,100);
  c.setTime(base+86400000);assert.equal((await c.service.handle('u','list')).notices.length,0);
 }finally{await c.db.close();}
});

test('startup recovery re-arms missing alarms without sends or expired-start replay',async()=>{
 for(const elapsed of [0,600000]){const c=setup();try{
  await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});
  const store=c.db.store('reminders');await store.deleteAlarm();c.setTime(base+elapsed);
  const restarted=new EventReminders(store,c.service.env,{now:()=>base+elapsed,send:async()=>{c.sent.push('push');return {};}});
  await restarted.recover();assert.equal(await store.getAlarm(),base+elapsed);assert.equal(c.sent.length,0);
  if(elapsed){await restarted.alarm();const view=await restarted.handle('u','list');assert.equal(c.sent.length,0);assert.equal(view.notices.length,0);assert.equal(view.reservations[0].state,'completed');}
 }finally{await c.db.close();}}
});

test('postponement clears old delivery failures and does not re-send before fresh new start',async()=>{
 const c=setup();try{
  await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});
  c.service.send=async()=>{throw Error('network failure');};c.setTime(base+60000);await c.service.alarm();
  c.setMatch(match(base+600000));c.setTime(base+180000);await c.service.alarm();let view=await c.service.handle('u','list');
  assert.equal(view.notices.length,0);assert.equal(view.reservations[0].deliveryStatus,'pending');assert.equal(view.reservations[0].deliveryFailure,null);
  c.service.send=async()=>{c.sent.push('push');return {};};c.setTime(base+600000);c.fail();await c.service.alarm();assert.equal(c.sent.length,0);
 }finally{await c.db.close();}
});

test('failed sends stop retrying after five minutes without losing the retained in-page notice',async()=>{
 const c=setup();try{
  let attempts=0;c.service.send=async()=>{attempts++;throw Error('offline');};
  await c.service.handle('u','subscribe',{subscription:subscription('a')});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});
  c.setTime(base+60000);await c.service.alarm();assert.equal(attempts,1);
  c.setTime(base+361000);await c.service.alarm();assert.equal(attempts,1);
  const view=await c.service.handle('u','list');assert.equal(view.notices.length,1);assert.equal(view.reservations[0].deliveryStatus,'failed');assert.equal(view.reservations[0].state,'completed');
 }finally{await c.db.close();}
});

test('push failure warnings contain only structured sanitized metadata',async()=>{
 const c=setup(),warn=console.warn,warnings=[];console.warn=value=>warnings.push(value);
 try{
  c.service.send=async()=>{throw Object.assign(Error('https://fcm.googleapis.com/secret-endpoint Bearer secret-token'),{statusCode:503});};
  await c.service.handle('u','subscribe',{subscription:subscription('private')});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});
  c.setTime(base+60000);await c.service.alarm();
  assert.deepEqual(warnings.map(value=>JSON.parse(value)),[{event:'event_reminder_push_failed',code:'http',at:base+60000,statusCode:503}]);
 }finally{console.warn=warn;await c.db.close();}
});
