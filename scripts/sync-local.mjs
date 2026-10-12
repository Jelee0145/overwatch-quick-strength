import {mkdir,copyFile,cp} from 'node:fs/promises';import path from 'node:path';
const base=path.resolve(import.meta.dirname,'..'),local=path.resolve(base,'../quick-strength'),source=path.join(base,'source');await mkdir(source,{recursive:true});
for(const file of ['core.js','benchmarks.js','rating-rules.js','resource-rating.js','performance.js','data.js','art.js','chart.js','style.css','index.html','app.js','ai_review.py','AI锐评-游戏常识.md'])await copyFile(path.join(local,file),path.join(source,file));
await mkdir(path.join(source,'data'),{recursive:true});for(const file of ['heroes.json','maps.json'])await copyFile(path.join(local,'data',file),path.join(source,'data',file));await cp(path.join(local,'assets'),path.join(source,'assets'),{recursive:true});
console.log('Self-contained source copied; no .private, credentials or player snapshots.');
