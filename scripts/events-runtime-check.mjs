import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';
import {page} from '../test/events-fixture.mjs';

const entry=`export {EventCenter} from './events.mjs';export default {async fetch(request,env){const url=new URL(request.url),path=url.pathname,sync=['/sync','/refresh'].includes(path);return env.EVENTS.get(env.EVENTS.idFromName('global')).fetch('https://events.internal'+(sync?path:'/')+url.search,{method:sync?'POST':'GET'});}};`;
const compiled=await build({stdin:{contents:entry,resolveDir:path.resolve(import.meta.dirname,'../src')},bundle:true,format:'esm',platform:'neutral',write:false});
let calls=0;
const mf=new Miniflare({workers:[{config:{name:'events-runtime-check',compatibilityDate:'2026-10-12',manifest:{mainModule:'worker.mjs',modules:{'worker.mjs':{type:'esm',contents:compiled.outputFiles[0].text}}},env:{EVENTS_CONTACT:{type:'text',value:'https://events.example.test'},EVENTS:{type:'durable-object',worker:'events-runtime-check',exportName:'EventCenter'}},exports:{EventCenter:{type:'durable-object',storage:'sqlite'}}},dev:{outboundService:{type:'fetcher',handler:request=>{calls++;assert.equal(new URL(request.url).hostname,'liquipedia.net');assert.match(request.headers.get('User-Agent'),/events\.example\.test/);return Response.json({parse:{text:{'*':page()}}});}}}}]});
try{
 assert.equal((await mf.dispatchFetch('https://runtime/events')).status,503);assert.equal(calls,0);
 assert.equal((await mf.dispatchFetch('https://runtime/sync')).status,200);
 const responses=await Promise.all(Array.from({length:3},()=>mf.dispatchFetch('https://runtime/events')));
 for(const response of responses){assert.equal(response.status,200);const value=await response.json();assert.equal(value.matches.length,2);assert.equal(value.matches[1].scores[1],0);assert.equal(value.stale,false);}
 await mf.dispatchFetch('https://runtime/sync');assert.equal(calls,1);
 const manual=await mf.dispatchFetch('https://runtime/refresh');assert.equal(manual.status,200);assert.equal((await manual.json()).matches.length,2);assert.equal(calls,1);
 const queued=await mf.dispatchFetch('https://runtime/events?from=2026-10-01&to=2026-10-18');assert.equal(queued.status,202);assert.equal((await queued.json()).state,'pending');assert.equal(calls,1);
 console.log('Native events runtime passed: hourly background sync, shared manual refresh, read-only GET, durable alarms and bundled parser.');
}finally{await mf.dispose();}
