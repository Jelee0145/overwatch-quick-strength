import {mkdir,copyFile} from 'node:fs/promises';import path from 'node:path';
const base=path.resolve(import.meta.dirname,'..'),local=path.resolve(base,'local'),source=path.join(base,'source');await mkdir(source,{recursive:true});
for(const file of ['core.js','benchmarks.js','rating-rules.js','resource-rating.js','performance.js','data.js','chart.js','style.css','index.html','app.js','ai_review.py','AI锐评-游戏常识.md'])await copyFile(path.join(local,file),path.join(source,file));
await mkdir(path.join(source,'data'),{recursive:true});for(const file of ['heroes.json','maps.json'])await copyFile(path.join(local,'data',file),path.join(source,'data',file));
console.log('Source synced; optimized CDN media preserved. Refresh media manually if the map catalog changed.');
