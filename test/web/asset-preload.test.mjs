import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../../web/asset-preload.js',import.meta.url),'utf8');
const asset='/media/maps/01234567890123456789.webp',version='0123456789abcdef';
function harness({saveData=false,checkpoint=null,assets=[{url:asset,bytes:100}],stall=false}={}){
 let now=0,id=0,busy=false;const timers=new Map(),events={},calls=[],storage=new Map(checkpoint?[['owqs:asset-progress:v1',JSON.stringify(checkpoint)]]:[]);
 const c={Date:{now:()=>now},URL,AbortController,location:{origin:'https://test.example'},navigator:{onLine:true,connection:{saveData}},document:{readyState:'complete',hidden:false,querySelector:()=>busy?{}:null,addEventListener:(n,f)=>events[n]=f},performance:{getEntriesByType:()=>[]},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout:(f,ms)=>{timers.set(++id,{f,at:now+ms});return id;},clearTimeout:i=>timers.delete(i),addEventListener:(n,f)=>events[n]=f};c.window=c;
 c.fetch=async(url,options)=>{calls.push({url,options});if(stall&&url===asset)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{name:'AbortError'}))));return {ok:true,text:async()=>JSON.stringify({version,assets}),arrayBuffer:async()=>new ArrayBuffer(0)};};
 vm.runInNewContext(source,c);
 async function tick(ms){now+=ms;const ready=[...timers].filter(([,t])=>t.at<=now);for(const [i,t]of ready){timers.delete(i);t.f();}for(let i=0;i<12;i++)await Promise.resolve();}
 return {c,calls,events,storage,tick,setBusy:v=>busy=v};
}
test('prewarming waits for idle, uses one low-priority credential-free request, and checkpoints completion',async()=>{
 const h=harness();await h.tick(2999);assert.equal(h.calls.length,0);await h.tick(1);assert.equal(h.calls.length,1);await h.tick(750);assert.equal(h.calls.length,2);
 assert.equal(h.calls[1].url,asset);assert.equal(h.calls[1].options.priority,'low');assert.equal(h.calls[1].options.credentials,'omit');assert.equal(h.calls[1].options.cache,'force-cache');assert.equal(JSON.parse(h.storage.get('owqs:asset-progress:v1')).cursor,1);
});
test('save-data and active queries suppress all background traffic',async()=>{
 const h=harness({saveData:true});await h.tick(10000);assert.equal(h.calls.length,0);h.c.navigator.connection.saveData=false;h.setBusy(true);await h.tick(10000);assert.equal(h.calls.length,0);h.setBusy(false);await h.tick(3000);assert.equal(h.calls.length,1);
});
test('interaction aborts a transfer, preserves its cursor and resumes after inactivity',async()=>{
 const h=harness({stall:true});await h.tick(3000);await h.tick(750);h.events.pointerdown();await h.tick(100);assert.equal(h.calls[1].options.signal.aborted,true);assert.equal(h.storage.size,0);await h.tick(3000);assert.equal(h.calls.length,3);assert.equal(h.calls[2].url,asset);
});
test('versioned progress resumes current builds and resets stale versions; private URLs are rejected',async()=>{
 const resumed=harness({checkpoint:{version,cursor:1,time:0}});await resumed.tick(3000);await resumed.tick(750);assert.equal(resumed.calls.length,1);
 const changed=harness({checkpoint:{version:'ffffffffffffffff',cursor:1,time:0}});await changed.tick(3000);await changed.tick(750);assert.equal(changed.calls[1].url,asset);
 const bad=harness({assets:[{url:'/api/me',bytes:10}]});await bad.tick(3000);await bad.tick(750);assert.ok(bad.calls.every(c=>c.url==='__ASSET_PLAN_URL__'));
});
test('built plans contain current public assets, exclude HD export-only images and fit the idle budget',async()=>{
 const html=await readFile(new URL('../../public/login.html',import.meta.url),'utf8'),script=html.match(/src="(\/static\/asset-preload\.[^"]+)"/)[1];
 const helper=await readFile(new URL('../../public'+script,import.meta.url),'utf8'),url=helper.match(/\/static\/asset-plan\.[a-f0-9]{16}\.json/)[0],plan=JSON.parse(await readFile(new URL('../../public'+url,import.meta.url),'utf8'));
 const media=JSON.parse(await readFile(new URL('../../source/media/manifest.json',import.meta.url),'utf8')),previews=new Set(Object.values(media.maps).map(m=>m.preview));
 for(const a of plan.assets){assert.ok(!a.url.includes('/api/'));assert.equal(a.bytes,(await stat(new URL('../../public'+a.url,import.meta.url))).size);if(a.url.startsWith('/media/maps/'))assert.ok(previews.has(a.url));}
 assert.ok(plan.assets.reduce((n,a)=>n+a.bytes,0)<8*1024*1024);assert.ok(plan.assets.some(a=>a.url.startsWith('/media/heroes/')));
});
test('background transfer stops at the session budget and resumes at the next untransferred asset',async()=>{
 const assets=Array.from({length:10},(_,i)=>({url:'/media/maps/'+String(i).padStart(20,'0')+'.webp',bytes:1024*1024}));
 const h=harness({assets});await h.tick(3000);for(let i=0;i<11;i++)await h.tick(750);
 assert.equal(h.calls.length,9);assert.equal(h.c.OWQS_ASSET_PRELOAD.bytes,8*1024*1024);assert.equal(JSON.parse(h.storage.get('owqs:asset-progress:v1')).cursor,8);
});
test('an invalid preload manifest stops after three spaced attempts',async()=>{
 const h=harness({assets:[{url:'/api/private',bytes:10}]});await h.tick(3000);await h.tick(30000);await h.tick(30000);await h.tick(30000);assert.equal(h.calls.length,3);
});
