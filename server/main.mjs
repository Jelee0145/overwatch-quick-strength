import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {createRuntime} from './runtime.mjs';
import {staticAssets} from './assets.mjs';
import {createHttpServer} from './http.mjs';

process.umask(0o077);
const base=path.resolve(import.meta.dirname,'..'),data=process.env.OWQS_DATA||'/var/lib/owqs';
const config=JSON.parse(await readFile(process.env.OWQS_CONFIG||'/etc/owqs/config.json','utf8'));
for(const key of ['PASSWORD_PEPPER','CACHE_SIGNING_KEY','API_KEY_ENCRYPTION_KEY','ADMIN_PASSWORD_HASH','PUBLIC_ORIGIN'])if(!config[key])throw Error('Missing server configuration: '+key);
// Backend releases contain renderer media only. Combined checkout serving is an explicit developer opt-in.
const serveWeb=process.env.OWQS_SERVE_WEB==='1';
const rendererRoot=path.resolve(process.env.OWQS_RENDERER_ROOT||(existsSync(path.join(base,'backend-assets'))?path.join(base,'backend-assets'):path.join(base,'dist/backend-assets')));
const rendererAssets=staticAssets(rendererRoot,{rendererOnly:true});
const runtime=createRuntime({...config,BACKEND_ONLY:!serveWeb,RENDERER_ASSETS:rendererAssets},{filename:path.join(data,'state.sqlite3'),assets:serveWeb?staticAssets(path.resolve(process.env.OWQS_WEB_ROOT||path.join(base,'public'))):rendererAssets});
await runtime.startEvents();
const server=createHttpServer(runtime,{origin:config.PUBLIC_ORIGIN});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||8788),'127.0.0.1',()=>console.log('OWQS listening on loopback'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await new Promise(resolve=>server.close(resolve));await runtime.close();}
process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));process.on('SIGINT',()=>stop().then(()=>process.exit(0)));
