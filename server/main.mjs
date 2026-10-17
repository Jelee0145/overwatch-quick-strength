import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRuntime} from './runtime.mjs';
import {staticAssets} from './assets.mjs';
import {createHttpServer} from './http.mjs';

process.umask(0o077);
const base=path.resolve(import.meta.dirname,'..'),data=process.env.OWQS_DATA||'/var/lib/owqs';
const config=JSON.parse(await readFile(process.env.OWQS_CONFIG||'/etc/owqs/config.json','utf8'));
for(const key of ['PASSWORD_PEPPER','CACHE_SIGNING_KEY','API_KEY_ENCRYPTION_KEY','ADMIN_PASSWORD_HASH','PUBLIC_ORIGIN'])if(!config[key])throw Error('Missing server configuration: '+key);
const runtime=createRuntime(config,{filename:path.join(data,'state.sqlite3'),assets:staticAssets(path.join(base,'public'))});
const server=createHttpServer(runtime,{origin:config.PUBLIC_ORIGIN});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||8788),'127.0.0.1',()=>console.log('OWQS listening on loopback'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await new Promise(resolve=>server.close(resolve));await runtime.close();}
process.on('SIGTERM',()=>stop().then(()=>process.exit(0)));process.on('SIGINT',()=>stop().then(()=>process.exit(0)));
