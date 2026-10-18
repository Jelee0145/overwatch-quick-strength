import {AuthDirectory} from '../src/auth.mjs';
import {UserTasks} from '../src/tasks.mjs';
import {EventCenter} from '../src/events.mjs';
import {SqliteDatabase} from './storage.mjs';
import {pacedFetch} from './limiter.mjs';

export function createRuntime(config,{filename,assets,upstreamFetch=fetch,eventsFetch=fetch,intervalMs=500}={}){
 const database=new SqliteDatabase(filename),instances=new Map(),running=new Map();
 const env={...config,ASSETS:assets,EVENTS_FETCH:eventsFetch,UPSTREAM_FETCH:pacedFetch(upstreamFetch,{intervalMs})};
 const instance=ns=>{
  if(!instances.has(ns)){const Class=ns==='auth'?AuthDirectory:ns==='events'?EventCenter:UserTasks;instances.set(ns,new Class({storage:database.store(ns)},env));}
  return instances.get(ns);
 };
 env.AUTH={idFromName:()=> 'auth',get:()=>({fetch:(input,init)=>instance('auth').fetch(new Request(input,init))})};
 env.TASKS={idFromName:id=>'tasks:'+id,get:ns=>({fetch:(input,init)=>instance(ns).fetch(new Request(input,init))})};
 env.EVENTS={idFromName:()=> 'events',get:()=>({fetch:(input,init)=>instance('events').fetch(new Request(input,init))})};
 let closed=false;
 async function tick(){
  if(closed)return;
  for(const {ns} of await database.due()){
   if(running.has(ns)||running.size>=4)continue;
   const work=(async()=>{
    const storage=database.store(ns),lease=Date.now()+60000;
    // Leave a durable lease before dispatch, so a killed process resumes on restart.
    await storage.setAlarm(lease);
    try{await instance(ns).alarm();if(await storage.getAlarm()===lease)await storage.deleteAlarm();}catch{await storage.setAlarm(Date.now()+5000);console.error('Background task failed; scheduled retry');}
   })();running.set(ns,work);work.finally(()=>running.delete(ns));
  }
 }
 const timer=setInterval(()=>tick().catch(()=>console.error('Task scheduler unavailable')),250);timer.unref();
 return {env,database,instance,tick,async close(){closed=true;clearInterval(timer);await Promise.all(running.values());await database.close();}};
}
