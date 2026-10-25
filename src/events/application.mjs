import {Fault} from '../security.mjs';
import {filterEvents} from './filter.mjs';
import {broadcastsFor} from './broadcasts.mjs';

export async function listEvents(env,user,search,{refresh=false,paginate=true}={}){
 const params=new URLSearchParams(search);filterEvents({matches:[]},params,{paginate});
 const response=await env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal/'+(refresh?'refresh':'')+'?'+params,{method:refresh?'POST':'GET',headers:{'X-OWQS-Event-User':user}});
 if(response.status!==200)return {response};
 const value=filterEvents(await response.json(),params,{paginate});
 value.matches=env.REMINDERS?await env.REMINDERS.decorate(value.matches):value.matches.map(match=>({...match,broadcasts:broadcastsFor(match),reservable:false}));
 return {value};
}
export async function handleReminder(env,user,action,input={}){
 if(!env.REMINDERS){if(action==='list')return {enabled:false,publicKey:'',reservations:[],notices:[]};throw new Fault('比赛通知尚未启用',503);}
 return env.REMINDERS.handle(user,action,input);
}
