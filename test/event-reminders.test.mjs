import test from 'node:test';
import assert from 'node:assert/strict';
import {EventReminders,matchIdentity} from '../server/event-reminders.mjs';
import {SqliteDatabase} from '../server/storage.mjs';
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
test('subscriptions move between accounts and reservations recover from persisted state',async()=>{
 const c=setup();try{const s=subscription('shared');await c.service.handle('u','subscribe',{subscription:s});await c.service.decorate([match()]);await c.service.handle('u','reserve',{matchId:match().id});await c.service.handle('other','subscribe',{subscription:s});assert.equal(Object.keys((await c.service.state()).users.u.subscriptions).length,0);const restarted=new EventReminders(c.db.store('reminders'),{},{});assert.equal((await restarted.handle('u','list')).reservations.length,1);}finally{await c.db.close();}
});
