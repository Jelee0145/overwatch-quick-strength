import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventCenter,EVENTS_API} from '../src/events.mjs';
import {parseEvents,liquipediaLink,liquipediaLogo} from '../src/events-parser.mjs';
import worker from '../src/worker.mjs';
import {createRuntime} from '../server/runtime.mjs';
import {card,page,response} from './events-fixture.mjs';

class Storage{
 constructor(){this.map=new Map();}
 async get(k){return structuredClone(this.map.get(k));}
 async put(k,v){this.map.set(k,structuredClone(v));}
}
function setup(fetcher=async()=>response(page())){const storage=new Storage(),env={EVENTS_CONTACT:'https://site.test',EVENTS_FETCH:fetcher},center=new EventCenter({storage},env);let now=1792310400000;center.now=()=>now;return {center,storage,env,advance:ms=>{now+=ms;}};}
const request=()=>new Request('https://events.internal/');

test('events parser covers OWCS regions, scores including zero, entities and unknown time/opponent; ignores other events',()=>{
 const regions=[['China','中国'],['Asia/Stage_3/Korea','韩国'],['Asia/Stage_3/Japan','日本'],['Asia/Stage_3/Pacific','太平洋'],['North_America','北美'],['EMEA','EMEA'],['World_Finals','国际赛']];
 const html=regions.map(([r])=>card({path:'Overwatch_Champions_Series/2026/'+r})).join('')+card({path:'Other_Cup/2026'})+card({path:'Overwatch_Champions_Series/2026/Asia',timestamp:null,teams:['A &amp; B','TBD']});
 const matches=parseEvents(page(html));assert.equal(matches.length,9);for(const [i,[,r]] of regions.entries())assert.equal(matches[i].region,r);
 assert.equal(matches[7].teams[0].name,'A & B');assert.equal(matches[7].teams[1].name,'TBD');assert.equal(matches[7].startsAt,null);
 assert.deepEqual(matches.at(-1).scores,[3,0]);assert.equal(matches.at(-1).status,'completed');assert.equal(matches[0].bestOf,5);
 assert.equal(parseEvents(page('', '')).length,0);assert.throws(()=>parseEvents('<p>maintenance</p>'));
 assert.throws(()=>parseEvents(page('<div class="new-match">Changed</div>')));
 assert.throws(()=>parseEvents(page(card().replace('match-info-tournament-name','renamed'))));
 assert.equal(parseEvents(page(card()+card(),'')).length,1);
 const duplicate=parseEvents(page(card(),card({scores:[0,3]})));assert.equal(duplicate.length,1);assert.equal(duplicate[0].status,'completed');assert.deepEqual(duplicate[0].scores,[0,3]);
 for(const u of ['javascript:alert(1)','https://evil.test/overwatch/a','https://liquipedia.net.evil.test/overwatch/a','https://evil@liquipedia.net/overwatch/a','https://liquipedia.net:444/overwatch/a'])assert.equal(liquipediaLink(u),null);
 assert.equal(liquipediaLink('/overwatch/Test'),'https://liquipedia.net/overwatch/Test');
});

test('events team badges use the light variant and reject off-site or non-image sources',()=>{
 const withIcons=card().replace('<span class="name">','<span class="team-template-image-icon team-template-darkmode"><img src="/commons/images/dark.png"></span><span class="team-template-image-icon team-template-lightmode"><img src="/commons/images/light.svg.png"></span><span class="name">');
 const match=parseEvents(page(withIcons,''))[0];assert.equal(match.teams[0].logo,'https://liquipedia.net/commons/images/light.svg.png');assert.equal(match.teams[1].logo,null);
 for(const url of ['javascript:alert(1)','data:image/svg+xml,anything','https://evil.test/commons/images/logo.png','https://liquipedia.net/overwatch/logo.png','https://liquipedia.net/commons/images/page.html'])assert.equal(liquipediaLogo(url),null);
});

test('events model filters without requests, sorts results, and uses Beijing midnight in every host timezone',async()=>{
 const context={window:{},Intl};vm.runInNewContext(await readFile(new URL('../web/events-model.js',import.meta.url),'utf8'),context);const model=context.window.EventsModel;
 assert.equal(model.day('2026-10-17T16:00:00Z'),'2026-10-18');assert.equal(model.day(null),'');
 const matches=parseEvents(page(card({timestamp:'1792252800'})+card({timestamp:'1792339200'})+card({timestamp:null}),card({timestamp:'1792166400',finished:true,scores:[3,0]})));
 assert.equal(model.select(matches).at(-1).startsAt,null);assert.equal(model.select(matches,{team:'FALCONS'}).length,3);
 assert.equal(model.select(matches,{team:'cRa',region:'韩国'}).length,3);
 assert.equal(model.select(matches,{from:'2026-10-18',to:'2026-10-18'}).length,1);
 assert.equal(model.select(matches,{view:'completed'}).length,1);
 assert.equal(model.select(matches,{tournament:'none'}).length,0);assert.equal(model.select(matches,{region:'中国'}).length,0);
 const results=parseEvents(page('',card({timestamp:'1792166400',scores:[3,0]})+card({timestamp:'1792252800',scores:[0,3]})));
 assert.equal(model.select(results,{view:'completed'})[0].startsAt,'2026-10-17T16:00:00.000Z');
});

test('shared events cache single-flights requests, uses API/contact/gzip and persists freshness through restart',async()=>{
 let calls=0;const ctx=setup(async(url,init)=>{calls++;assert.equal(url,EVENTS_API);assert.equal(init.redirect,'manual');assert.match(init.headers['User-Agent'],/https:\/\/site.test/);assert.equal(init.headers['Accept-Encoding'],'gzip');await new Promise(r=>setTimeout(r,10));return response(page());});
 const values=await Promise.all(Array.from({length:8},()=>ctx.center.fetch(request())));assert.equal(calls,1);const first=await values[0].json();assert.equal(first.stale,false);assert.equal(first.matches.length,2);
 assert.match(values[0].headers.get('Cache-Control'),/private/);
 const restarted=new EventCenter({storage:ctx.storage},ctx.env);restarted.now=ctx.center.now;assert.equal((await restarted.fetch(request())).status,200);assert.equal(calls,1);
 ctx.advance(300001);await restarted.fetch(request());assert.equal(calls,2);
});

test('events failures preserve snapshots, back off, respect Retry-After, and reject data older than 24 hours',async()=>{
 let calls=0,fail=false;const ctx=setup(async()=>{calls++;return fail?new Response('',{status:429,headers:{'Retry-After':'900'}}):response(page());});
 await ctx.center.read();const saved=await ctx.storage.get('snapshot');fail=true;ctx.advance(300001);
 assert.equal((await ctx.center.read()).stale,true);assert.deepEqual(await ctx.storage.get('snapshot'),saved);assert.equal(calls,2);
 ctx.advance(300001);assert.equal((await ctx.center.read()).stale,true);assert.equal(calls,2);
 ctx.advance(600000);await ctx.center.read();assert.equal(calls,3);
 ctx.advance(86400001);assert.equal((await ctx.center.fetch(request())).status,503);
 const cold=setup(async()=>new Response('bad',{status:503}));assert.equal((await cold.center.fetch(request())).status,503);
 const edge=setup();await edge.center.read();edge.advance(86400000-1000);edge.env.EVENTS_FETCH=async()=>{edge.advance(10000);throw Error('timeout');};assert.equal((await edge.center.fetch(request())).status,503);
});

test('events cooldown starts after failure and honors HTTP-date Retry-After and redirects',async()=>{
 let fail=false,calls=0;const ctx=setup(async()=>{calls++;if(!fail)return response(page());ctx.advance(10000);return new Response('',{status:503});});
 await ctx.center.read();ctx.advance(300001);fail=true;await ctx.center.read();const finished=ctx.center.now();assert.ok(await ctx.storage.get('nextAttempt')>=finished+300000);
 ctx.advance(299999);await ctx.center.read();assert.equal(calls,2);
 ctx.advance(2);const until=ctx.center.now()+1200000;ctx.env.EVENTS_FETCH=async()=>new Response('',{status:429,headers:{'Retry-After':new Date(until).toUTCString()}});await ctx.center.read();assert.ok(await ctx.storage.get('nextAttempt')>=until-1000);
 ctx.advance(1200001);ctx.env.EVENTS_FETCH=async()=>new Response('',{status:302,headers:{Location:'https://evil.test/'}});assert.equal((await ctx.center.read()).stale,true);
});

test('events rejects changed upstream structure, HTML errors, oversized bodies and parse errors without replacing cache',async()=>{
 const ctx=setup();await ctx.center.read();const saved=await ctx.storage.get('snapshot');
 const failures=[()=>response('<p>changed</p>'),()=>new Response('challenge',{headers:{'Content-Type':'text/html'}}),()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'Content-Type':'application/json'}}),()=>new Response('bad',{headers:{'Content-Type':'application/json'}}),()=>response(page(card().replace('href="/overwatch/','href="https://evil.test/'))),()=>{throw Error('network');}];
 for(const fail of failures){ctx.advance(300001);ctx.env.EVENTS_FETCH=fail;assert.equal((await ctx.center.read()).stale,true);assert.deepEqual(await ctx.storage.get('snapshot'),saved);}
});

test('events timeout aborts upstream after ten seconds and keeps persisted backoff after restart',async()=>{
 const ctx=setup((url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
 const original=globalThis.setTimeout;let delay;globalThis.setTimeout=(fn,ms)=>{delay=ms;return original(fn,1);};
 try{assert.equal((await ctx.center.fetch(request())).status,503);assert.equal(delay,10000);}finally{globalThis.setTimeout=original;}
 const restarted=new EventCenter({storage:ctx.storage},{...ctx.env,EVENTS_FETCH:()=>{throw Error('must not fetch');}});restarted.now=ctx.center.now;assert.equal((await restarted.fetch(request())).status,503);
});

test('events endpoint and page require approved login, reject writes and never access task quotas',async()=>{
 let approved=false,calls=0,contact;
 const env={AUTH:{idFromName:()=>'',get:()=>({fetch:async()=>approved?Response.json({user:{id:'user'}}):Response.json({error:'请先登录'},{status:401})})},EVENTS:{idFromName:name=>{assert.equal(name,'global');return name;},get:()=>({fetch:async(url,init)=>{calls++;contact=init.headers['X-OWQS-Public-Origin'];return Response.json({matches:[]});}})},TASKS:{get:()=>{throw Error('must not create tasks');}},ASSETS:{fetch:async request=>new Response(new URL(request.url).pathname)}};
 assert.equal((await worker.fetch(new Request('https://site.test/api/events'),env)).status,401);assert.equal(calls,0);
 assert.equal((await worker.fetch(new Request('https://site.test/tools/events'),env)).status,302);
 approved=true;assert.equal((await worker.fetch(new Request('https://site.test/api/events'),env)).status,200);assert.equal(contact,'https://site.test');
 assert.equal(await(await worker.fetch(new Request('https://site.test/tools/events/'),env)).text(),'/tools/events.html');
 assert.equal((await worker.fetch(new Request('https://site.test/api/events',{method:'POST',headers:{Origin:'https://site.test','Content-Type':'application/json'},body:'{}'}),env)).status,405);assert.equal(calls,1);
});

test('standalone EVENTS binding persists the snapshot and does not share the match upstream limiter',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'owqs-events-'));let calls=0;
 const options={filename:path.join(dir,'state.sqlite3'),eventsFetch:async()=>{calls++;return response(page());},upstreamFetch:()=>{throw Error('not match data');}};
 const config={PUBLIC_ORIGIN:'https://site.test'};let runtime=createRuntime(config,options);
 try{
  const get=()=>runtime.env.EVENTS.get(runtime.env.EVENTS.idFromName('global')).fetch('https://events.internal/');
  assert.equal((await get()).status,200);await runtime.close();runtime=createRuntime(config,options);assert.equal((await get()).status,200);assert.equal(calls,1);
 }finally{await runtime.close();await rm(dir,{recursive:true,force:true});}
});
