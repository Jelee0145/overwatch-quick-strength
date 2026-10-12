import {spawn} from 'node:child_process';import path from 'node:path';
const base=path.resolve(import.meta.dirname,'..');
for(let attempt=1;attempt<=3;attempt++){
 let output='';const child=spawn(process.execPath,[path.join(base,'scripts/wrangler.mjs'),'deploy'],{cwd:base,stdio:['inherit','pipe','pipe'],env:process.env});
 child.stdout.on('data',b=>{output+=b;process.stdout.write(b);});child.stderr.on('data',b=>{output+=b;process.stderr.write(b);});
 const code=await new Promise(resolve=>child.on('exit',resolve));if(code===0)process.exit(0);
 if(attempt===3||!/\b(429|502|503|504)\b|Gateway Timeout|ECONNRESET|ETIMEDOUT/.test(output)){process.exit(code||1);}
 console.log(`Cloudflare 临时错误，${attempt}/3 次发布失败，5 秒后重试同一版本。`);await new Promise(resolve=>setTimeout(resolve,5000));
}
