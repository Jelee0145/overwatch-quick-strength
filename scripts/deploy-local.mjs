#!/usr/bin/env node
// In-place release for the Tencent standalone host: the repository is the
// running application (systemd WorkingDirectory and the Nginx web root both
// point at this checkout). Rollback is a git checkout plus the same command.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const run=(command,args=[])=>execFileSync(command,args,{cwd:root,stdio:'inherit'});
const output=(command,args=[])=>execFileSync(command,args,{cwd:root,encoding:'utf8'}).trim();
function retrySync(fn,timeout){
 const end=Date.now()+timeout;
 for(;;){
  try{return fn();}catch(error){if(Date.now()>=end)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);}
 }
}

// Build output (dist/, public/) is untracked; only tracked edits block a release.
if(output('git',['status','--porcelain','--untracked-files=no']))throw Error('工作区有未提交改动，先提交再发布');
run('npm',['run','backend:build']);
run('npm',['run','web:build']);
run('systemctl',['restart','owqs']);

// Nginx answers 502 for the moment between restart and the port binding.
const health=retrySync(()=>output('curl',['--fail','--silent','--show-error','--max-time','5','--resolve','106.55.47.68:8443:127.0.0.1','https://106.55.47.68:8443/api/health']),20000);
const value=JSON.parse(health),revision=output('git',['rev-parse','HEAD']);
if(value.revision!==revision)throw Error('线上版本与当前提交不一致：'+value.revision);

const page=output('curl',['--fail','--silent','--show-error','--max-time','15','--resolve','106.55.47.68:8443:127.0.0.1','https://106.55.47.68:8443/login']);
if(page!==readFileSync(path.join(root,'public/login.html'),'utf8'))throw Error('线上登录页与构建产物不一致');

output('git',['tag','-f','deploy/'+new Date().toISOString().slice(0,10),revision]);
console.log('已发布 '+revision.slice(0,7)+'：服务与网页均来自当前仓库目录。');
