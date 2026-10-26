// Loopback preview with synthetic accounts, signed fixture history and mock upstream only.
import path from 'node:path';
import {createRuntime} from '../../server/runtime.mjs';
import {createHttpServer} from '../../server/http.mjs';
import {staticAssets} from '../../server/assets.mjs';
import {analysisFixture} from '../../test/services-fixture.mjs';
import {service} from '../../test/query-fixture.mjs';
import {signSnapshot} from '../../src/security.mjs';
const port=8791,origin='http://127.0.0.1:'+port;
const config={PASSWORD_PEPPER:'preview-only-pepper',CACHE_SIGNING_KEY:'preview-only-signing',API_KEY_ENCRYPTION_KEY:'preview-only-key',DASHEN_SERVER:'1',DASHEN_DTS:'2026',DASHEN_ROLE_ID:'fixture-role',DASHEN_TOKEN:'fixture-token',PUBLIC_ORIGIN:origin};
const mock=service({newGames:5});
const runtime=createRuntime(config,{filename:':memory:',assets:staticAssets(path.resolve(import.meta.dirname,'../../public')),intervalMs:0,eventsFetch:async()=>new Response('',{status:503}),upstreamFetch:async(url,init)=>{const value=new URL(url),body=init?.body?JSON.parse(init.body):undefined;return Response.json({code:0,data:await mock.call(config,value.pathname.replace('/v1/a19ld5tool',''),Object.fromEntries(value.searchParams),body)});}});
const invoke=async(path,body={},extra={})=>{const response=await runtime.env.AUTH.get().fetch('https://internal/',{method:'POST',body:JSON.stringify({path,body,ip:'preview',...extra})});if(!response.ok)throw Error('Preview setup failed');return response.json();};
const account=await invoke('/register',{email:'preview@example.test',password:'preview-password-only'});
const store=runtime.database.store('auth'),record=await store.get('user:'+account.user.id);record.status='approved';await store.put('user:'+record.id,record);
const raw=analysisFixture(),tasks=runtime.env.TASKS.get(runtime.env.TASKS.idFromName(record.id));
await tasks.fetch('https://internal/',{method:'POST',body:JSON.stringify({path:'/history',user:record.id,version:record.version,body:{action:'push',envelopes:[await signSnapshot(record.id,raw,runtime.env)]}})});
const server=createHttpServer(runtime,{origin,allowLoopback:true});server.listen(port,'127.0.0.1',()=>console.log('Synthetic unified preview ready on loopback; fixture login: preview@example.test'));
async function stop(){await new Promise(resolve=>server.close(resolve));await runtime.close();}
process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));process.on('SIGINT',()=>stop().then(()=>process.exit(0)));
