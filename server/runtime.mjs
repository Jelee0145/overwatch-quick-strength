import {AuthDirectory} from '../src/actors/auth.mjs';
import {UserTasks} from '../src/actors/tasks.mjs';
import {EventCenter} from '../src/events/center.mjs';
import {SqliteDatabase} from './storage.mjs';
import {pacedFetch} from './limiter.mjs';
import {EventReminders} from './event-reminders.mjs';
import {createPushSender} from './web-push.mjs';

export function createRuntime(config,{filename,assets,upstreamFetch=fetch,eventsFetch=fetch,pushSender,intervalMs=500}={}){
 const database=new SqliteDatabase(filename),instances=new Map(),running=new Map();
 const env={...config,ASSETS:assets,EVENTS_FETCH:eventsFetch,UPSTREAM_FETCH:pacedFetch(upstreamFetch,{intervalMs})};
 const send=pushSender||(config.WEB_PUSH_PUBLIC_KEY&&config.WEB_PUSH_PRIVATE_KEY&&config.WEB_PUSH_SUBJECT?createPushSender({publicKey:config.WEB_PUSH_PUBLIC_KEY,privateKey:config.WEB_PUSH_PRIVATE_KEY,subject:config.WEB_PUSH_SUBJECT}):null);
 env.REMINDERS=new EventReminders(database.store('reminders'),env,{send,publicKey:config.WEB_PUSH_PUBLIC_KEY||''});
 const instance=ns=>{
  if(ns==='reminders')return env.REMINDERS;
  if(!instances.has(ns)){const Class=ns==='auth'?AuthDirectory:ns==='events'?EventCenter:UserTasks;instances.set(ns,new Class({storage:database.store(ns)},env));}
  return instances.get(ns);
 };
 env.AUTH={idFromName:()=> 'auth',get:()=>({fetch:(input,init)=>instance('auth').fetch(new Request(input,init))})};
 env.TASKS={idFromName:id=>'tasks:'+id,get:ns=>({fetch:(input,init)=>instance(ns).fetch(new Request(input,init))})};
 env.EVENTS={idFromName:()=> 'events',get:()=>({fetch:(input,init)=>instance('events').fetch(new Request(input,init))})};
 const ready=env.REMINDERS.recover();
 let closed=false;
 async function tick(){
  await ready;
  if(closed)return;
  for(const {ns} of await database.due()){
   if(running.has(ns)||running.size>=4)continue;
   const work=(async()=>{
    const storage=database.store(ns),lease=Date.now()+60000;
    // Leave a durable lease before dispatch, so a killed process resumes on restart.
    await storage.setAlarm(lease);
    const leaseRevision=storage.alarmRevision();
    // A handler may deliberately reschedule to exactly the lease timestamp.
    // Timestamp equality does not mean the alarm was left untouched.
    try{await instance(ns).alarm();await storage.clearUnchangedAlarm(lease,leaseRevision);}catch{await storage.setAlarm(Date.now()+5000);console.error('Background task failed; scheduled retry');}
   })();running.set(ns,work);work.finally(()=>running.delete(ns));
  }
 }
 const timer=setInterval(()=>tick().catch(()=>console.error('Task scheduler unavailable')),250);timer.unref();
 return {env,database,instance,tick,ready,async startEvents(){
  await ready;
  if(running.has('events'))return running.get('events');
  const work=instance('events').alarm();running.set('events',work);
  try{await work;}finally{running.delete('events');}
 },async close(){closed=true;clearInterval(timer);try{await ready;await Promise.all(running.values());}finally{await database.close();}}};
}
