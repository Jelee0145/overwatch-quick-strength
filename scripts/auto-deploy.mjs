#!/usr/bin/env node
// Polls main and releases only when the checkout passes the same test suite CI runs.
// Invoked by owqs-autodeploy.timer; logs to /var/log/owqs-auto-deploy.log.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {verifyRevision} from './verify-release.mjs';

const root=path.resolve(import.meta.dirname,'..'),state='/var/lib/owqs/auto-deploy-failed',released='/var/lib/owqs/auto-deploy-released';
const ssh='ssh -i /root/.ssh/owqs_github -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
const env={...process.env,GIT_SSH_COMMAND:ssh};
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env}).trim();
const log=message=>console.log(new Date().toISOString()+' '+message);

const read=file=>{try{return readFileSync(file,'utf8').trim();}catch{return '';}};
const failed=read(state),deployed=read(released);

git('fetch','--quiet','git@github.com:Jelee0145/overwatch-quick-strength.git','main');
const target=git('rev-parse','FETCH_HEAD'),current=git('rev-parse','HEAD');
if(target===deployed){log(target.slice(0,7)+' 已发布，无需处理');process.exit(0);}
if(target===failed){log(target.slice(0,7)+' 测试未通过，等待新提交');process.exit(0);}
if(git('status','--porcelain','--untracked-files=no')){log('工作区有未提交改动，跳过自动发布');process.exit(1);}

log('在临时检出目录构建并运行完整测试 '+target.slice(0,7));
try{
 verifyRevision({root,revision:target,env});
}catch{
 mkdirSync(path.dirname(state),{recursive:true});
 writeFileSync(state,target+'\n');
 log('测试未通过，不发布；线上仍为上一版本');
 process.exit(1);
}

if(target!==current){
 log('验证通过，开始合并 '+target.slice(0,7));
 git('merge','--ff-only',target);
}else log(target.slice(0,7)+' 验证通过，开始发布');

log('测试通过，执行发布');
execFileSync(process.execPath,[path.join(root,'scripts/deploy-local.mjs')],{cwd:root,stdio:'inherit'});
writeFileSync(state,'');
mkdirSync(path.dirname(released),{recursive:true});
writeFileSync(released,target+'\n');
log('发布完成 '+target.slice(0,7));
