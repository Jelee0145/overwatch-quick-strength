import {mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const base=path.resolve(import.meta.dirname,'..'),stage=path.join(base,'dist/server-stage');
if(path.dirname(stage)!==path.join(base,'dist'))throw Error('Invalid stage directory');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
// Explicit allowlist: credentials, caches, local source and repository metadata never enter the archive.
for(const name of ['server','src','public'])await cp(path.join(base,name),path.join(stage,name),{recursive:true});
for(const name of ['access-policy.json'])await cp(path.join(base,name),path.join(stage,name));
await writeFile(path.join(stage,'package.json'),JSON.stringify({name:'owqs-standalone',private:true,type:'module',engines:{node:'>=24'},scripts:{start:'node server/main.mjs'}}));
// Exercise imports from the isolated allowlisted package, not the source checkout.
execFileSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(pathToFileURL(path.join(stage,'src/worker.mjs')).href)+')'],{cwd:stage,stdio:'pipe'});
const archive=path.join(base,'dist/owqs-server.tar.gz');
// Relative paths keep Windows drive letters from being parsed as remote hosts.
execFileSync('tar',['-czf','owqs-server.tar.gz','-C','server-stage','.'],{cwd:path.join(base,'dist'),stdio:'pipe'});
const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(archive+'.sha256',sha256+'  owqs-server.tar.gz\n');
console.log('Standalone package ready: dist/owqs-server.tar.gz ('+bytes.length+' bytes)');
