import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawn,execFileSync} from 'node:child_process';import path from 'node:path';import {passwordHash,token} from '../src/security.mjs';
const base=path.resolve(import.meta.dirname,'..'),privateDir=path.join(base,'.private');await mkdir(privateDir,{recursive:true});
let input='';for await(const chunk of process.stdin)input+=chunk;let password=input;input='';
const status=async(state,message)=>writeFile(path.join(privateDir,'provision-status.json'),JSON.stringify({state,message,at:new Date().toISOString()}));
try{
 const pepper=token(),adminHash=await passwordHash(password,pepper);password='';
 const python='C:/Users/35992/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
 const local=path.resolve(base,'../quick-strength');
 // DPAPI secrets are read into memory only; subprocess stdout is captured, never printed.
 const script="import sys,json;sys.path.insert(0,sys.argv[1]);from credentials import CredentialStore;from ai_review import KeyStore;from pathlib import Path;p=Path(sys.argv[1])/'.private';c=CredentialStore(p).load();print(json.dumps({'DASHEN_ROLE_ID':c['roleId'],'DASHEN_TOKEN':c['token'],'DEEPSEEK_KEY':KeyStore(p).load()}))";
 const secrets=JSON.parse(execFileSync(python,['-c',script,local],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
 if(!secrets.DASHEN_TOKEN||!secrets.DEEPSEEK_KEY)throw Error('existing secrets missing');
 Object.assign(secrets,{PASSWORD_PEPPER:pepper,CACHE_SIGNING_KEY:token(),ADMIN_PASSWORD_HASH:JSON.stringify(adminHash)});
 // The deployment backup contains hashes and API secrets, never the administrator password.
 const backup=execFileSync(python,['-c',"import sys;sys.path.insert(0,sys.argv[1]);from credentials import crypt;sys.stdout.buffer.write(crypt(sys.stdin.buffer.read()))",local],{input:JSON.stringify(secrets),windowsHide:true,stdio:['pipe','pipe','pipe']});await writeFile(path.join(privateDir,'cloud-secrets.dpapi'),backup);
 const child=spawn(process.execPath,[path.join(base,'node_modules/wrangler/bin/wrangler.js'),'secret','bulk','--name','quick-strength-friends'],{cwd:base,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG_PATH:path.join(base,'.wrangler/logs'),XDG_CONFIG_HOME:path.join(privateDir,'config')}});
 // Do not forward Wrangler output: even an upstream error must never echo a secret payload.
 child.stdout.resume();child.stderr.resume();child.stdin.end(JSON.stringify(secrets));for(const key of Object.keys(secrets))secrets[key]='';
 const code=await new Promise(resolve=>child.on('exit',resolve));if(code!==0)throw Error('secret upload failed');await status('done','Workers Secrets 已配置');
}catch{password='';await status('failed','密钥配置未完成，请检查登录和现有本机凭证后重试');process.exitCode=1;}
