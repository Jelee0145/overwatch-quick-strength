#!/usr/bin/env node
// Operator template: unpack a verified archive into a NEW release directory first.
// Validate: node split-release.mjs backend /opt/owqs/releases/RELEASE
// Activate explicitly with --activate --config /etc/owqs/config.json --data /var/lib/owqs.
// Backend activation backs up live SQLite, restarts the service and verifies canonical health.
// Failed acceptance restores the old pointer and restarts/verifies the previous service.
// Web uses /opt/owqs/web-releases/RELEASE and /opt/owqs/web-current.
import {readFile,readdir,lstat,realpath,open,symlink,rename,unlink,writeFile,mkdir,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const runFile=promisify(execFile);
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function validateRelease(directory,kind){
 if(!['backend','web'].includes(kind))throw Error('Expected backend or web');
 directory=path.resolve(directory);if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw Error('Release directory must be real');
 const manifest=JSON.parse(await readFile(path.join(directory,'artifact-manifest.json'),'utf8'));
 if(manifest.schemaVersion!==1||manifest.kind!==kind||!Array.isArray(manifest.files))throw Error('Invalid artifact manifest');
 const expected=new Map();
 for(const file of manifest.files){
  if(typeof file.path!=='string'||!file.path||file.path.includes('\\')||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||expected.has(file.path)||!/^([a-f0-9]{64})$/.test(file.sha256))throw Error('Invalid manifest path or digest');
  if(kind==='backend'&&!/^(server\/|src\/|backend-assets\/media\/(maps|icons)\/|access-policy\.json$|package\.json$)/.test(file.path))throw Error('Unexpected backend file');
  if(kind==='web'&&!file.path.startsWith('public/'))throw Error('Unexpected web file');
  expected.set(file.path,file);
 }
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
  const target=path.join(dir,entry.name),name=path.relative(directory,target).split(path.sep).join('/');
  if(entry.isSymbolicLink())throw Error('Release symlinks are forbidden');
  if(entry.isDirectory()){await walk(target);continue;}
  if(!entry.isFile())throw Error('Release contains a special file');
  if(name==='artifact-manifest.json')continue;
  const item=expected.get(name);if(!item)throw Error('Release contains an unlisted file');
  const bytes=await readFile(target);if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Artifact checksum mismatch: '+name);
  expected.delete(name);
 }}
 await walk(directory);if(expected.size)throw Error('Release is missing manifest files');
 const required=kind==='backend'?['server/main.mjs','src/worker.mjs','src/shared/events-html.mjs','src/shared/chart.mjs','src/prompt.mjs','access-policy.json']:['public/index.html','public/login.html','public/tools/strength.html','public/event-reminders-sw.js'];
 const listed=new Set(manifest.files.map(file=>file.path));for(const name of required)if(!listed.has(name))throw Error('Missing required release input: '+name);
 return manifest;
}
export async function backupDatabase(filename,destination){
 const {DatabaseSync,backup}=await import('node:sqlite');
 const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw Error('Expected a real SQLite database');
 await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
 const db=new DatabaseSync(filename,{readOnly:true});
 try{await backup(db,destination);await chmod(destination,0o600);}finally{db.close();}
 const copy=new DatabaseSync(destination,{readOnly:true});try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite backup integrity check failed');}finally{copy.close();}
}
async function replacePointer(pointer,target){
 const next=pointer+'.next-'+process.pid;await symlink(target,next,'dir');
 try{await rename(next,pointer);}catch(error){await unlink(next);throw error;}
}
async function revisionOf(directory){
 const {release}=await import(pathToFileURL(path.join(directory,'src/release.mjs')).href);if(!release?.revision)throw Error('Release revision missing');return release.revision;
}
export async function verifyHealth({origin,revision,fetcher=fetch,attempts=20,delayMs=500}){
 for(let attempt=0;attempt<attempts;attempt++){
  try{const response=await fetcher(new URL('/api/health',origin),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});if(response.ok){const value=await response.json();if(value.ok===true&&value.revision===revision)return;}}catch{}
  if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,delayMs));
 }
 throw Error('Canonical health revision verification failed');
}
export async function verifyWeb({origin,manifest,directory,fetcher=fetch}){
 const probes=['public/login.html','public/event-reminders-sw.js'];
 // A hashed asset verifies the selected static release without requiring a page session.
 const asset=manifest.files.find(file=>/^public\/static\/.*\.[a-f0-9]{16}\.(js|css)$/.test(file.path));if(asset)probes.push(asset.path);
 for(const name of probes){
  const response=await fetcher(new URL('/'+name.slice('public/'.length),origin),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
  const bytes=Buffer.from(await response.arrayBuffer()),expected=manifest.files.find(file=>file.path===name);
  if(!response.ok||!expected||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('Canonical web artifact verification failed: '+name);
  if(!name.includes('/static/')&&!/no-store/.test(response.headers.get('cache-control')||''))throw Error('Web HTML/service worker cache policy mismatch');
 }
}
export async function switchRelease({kind,directory,root='/opt/owqs',activate=false,configPath='/etc/owqs/config.json',data='/var/lib/owqs',service='owqs',origin,backup=backupDatabase,restart=async name=>{await runFile('systemctl',['restart',name],{timeout:90000});},health=verifyHealth,web=verifyWeb,replace=replacePointer}){
 root=path.resolve(root);directory=path.resolve(directory);const releases=path.join(root,kind==='backend'?'releases':'web-releases'),pointer=path.join(root,kind==='backend'?'current':'web-current');
 if(path.dirname(directory)!==releases||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path.basename(directory)))throw Error('Candidate must be one release under the expected release root');
 const manifest=await validateRelease(directory,kind);
 if(!activate)return {validated:true,kind,directory,pointer,activated:false};
 if(!/^[a-zA-Z0-9@_.-]+$/.test(service))throw Error('Invalid service name');
 const config=JSON.parse(await readFile(configPath,'utf8'));const canonical=new URL(config.PUBLIC_ORIGIN);
 if(canonical.protocol!=='https:'||canonical.username||canonical['pass'+'word']||canonical.pathname!=='/'||canonical.search||canonical.hash)throw Error('Expected canonical HTTPS PUBLIC_ORIGIN');
 if(origin&&new URL(origin).origin!==canonical.origin)throw Error('Acceptance origin must match configured PUBLIC_ORIGIN');
 origin=canonical.origin;data=path.resolve(data);
 if(data===root||data.startsWith(root+path.sep)||data===directory||data.startsWith(directory+path.sep))throw Error('Database must be outside release root');
 const lockPath=path.join(root,'.split-release.lock'),lock=await open(lockPath,'wx',0o600);
 try{
  let previous=null;try{const info=await lstat(pointer);if(!info.isSymbolicLink())throw Error('Current pointer must be a symlink');previous=await realpath(pointer);if(path.dirname(previous)!==releases)throw Error('Current pointer escapes release root');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!previous)throw Error('Activation requires an existing rollback pointer; bootstrap separately');
  if(previous===directory)throw Error('Candidate is already current');
  const previousManifest=await validateRelease(previous,kind);
  const revision=kind==='backend'?await revisionOf(directory):null,previousRevision=kind==='backend'?await revisionOf(previous):null;
  const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid;
  const databaseBackup=kind==='backend'?path.join(data,'backups','state-'+stamp+'.sqlite3'):null;
  // Online SQLite backup includes committed WAL changes and completes before pointer mutation.
  if(databaseBackup)await backup(path.join(data,'state.sqlite3'),databaseBackup);
  await symlink(previous,pointer+'.backup-'+stamp,'dir');
  const record=path.join(root,kind+'-switch-'+stamp+'.json'),audit={kind,previous,next:directory,databaseBackup,origin,at:new Date().toISOString(),status:'prepared'};
  await writeFile(record,JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});
  await replace(pointer,directory);
  try{
   if(kind==='backend'){await restart(service);await health({origin,revision});}
   else await web({origin,manifest,directory});
  }catch(error){
   audit.status='rollback-started';await writeFile(record,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
   try{
    await replace(pointer,previous);
    if(kind==='backend'){await restart(service);await health({origin,revision:previousRevision});}
    else await web({origin,manifest:previousManifest,directory:previous});
    audit.status='rolled-back';await writeFile(record,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
   }catch(rollbackError){throw new AggregateError([error,rollbackError],'Release failed and rollback acceptance failed; inspect '+record);}
   throw new Error('Release failed; previous release restored and verified. Record: '+record,{cause:error});
  }
  audit.status='accepted';await writeFile(record,JSON.stringify(audit,null,2)+'\n',{mode:0o600});
  return {validated:true,kind,directory,pointer,previous,record,databaseBackup,activated:true};
 }finally{await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [kind,directory,...flags]=process.argv.slice(2),options={kind,directory};
 for(let i=0;i<flags.length;i++){
  if(flags[i]==='--activate'){options.activate=true;continue;}
  const key={'--config':'configPath','--data':'data','--root':'root','--service':'service','--origin':'origin'}[flags[i]];
  if(!key||!flags[i+1]||flags[i+1].startsWith('--'))throw Error('Invalid release option');options[key]=flags[++i];
 }
 if(!directory||!path.isAbsolute(directory))throw Error('Usage: split-release.mjs backend|web ABSOLUTE_RELEASE [--activate --config FILE --data DIRECTORY --service owqs]');
 console.log(JSON.stringify(await switchRelease(options),null,2));
}
