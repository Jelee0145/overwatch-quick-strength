import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Capture the real website components after the cloud adapters have run.
// No second table renderer or independently maintained stylesheet.
export async function buildApiCapture({base,html,app,css}){
 const section=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);if(a<0||b<0)throw Error('Website capture markup changed');return html.slice(a,b);};
 const review=section('<section id="aiReviewPanel"','<div class="detail-head">');
 const data=section('<div class="detail-head">','<section id="performancePanel"');
 const start=app.indexOf('function showPlayers('),end=app.indexOf('async function showPerformance(',start);
 if(start<0||end<0)throw Error('Website player renderer changed');
 const script=await readFile(path.join(base,'source/core.js'),'utf8')+'\n'+await readFile(path.join(base,'web/base/data.js'),'utf8')+`\nconst $=id=>document.getElementById(id);const timeline={};const raw=INPUT.raw;const model={matches:[INPUT.match],options:INPUT.options};function showPerformance(){}\n`+app.slice(start,end)+`
if(INPUT.kind==='data'){
 $('matchSelect').innerHTML='<option></option>';
 $('matchSelect').firstChild.textContent='第 '+INPUT.index+' 场 · '+INPUT.mapName;
 showPlayers(0);
}else{
 $('aiReviewPanel').hidden=false;
 $('aiReviewText').classList.remove('muted');
 $('aiReviewText').textContent=INPUT.review;
 $('aiReviewGenerate').hidden=true;$('aiReviewAgain').hidden=false;
 $('aiReviewStatus').textContent='已显示本地保存的锐评';
}
`;
 const bundle={version:1,css:await readFile(path.join(base,'public',css.slice(1)),'utf8'),data,review,script};
 await writeFile(path.join(base,'plugins/astrbot_plugin_owqs_api/website.json'),JSON.stringify(bundle));
}
