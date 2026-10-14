import {mkdir,readFile,writeFile,copyFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {transform} from 'esbuild';
const base=path.resolve(import.meta.dirname,'..'), local=path.join(base,'source');
const shared=['core.js','benchmarks.js','rating-rules.js','resource-rating.js','performance.js'];
let revision='local';try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:base,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
await writeFile(path.join(base,'src/release.mjs'),'export const release='+JSON.stringify({revision,builtAt:new Date().toISOString(),version:'cloud-1.1.0'})+';');
// Remove known legacy outputs, keeping the directory itself usable by Windows dev watchers.
const outputDirectory=path.resolve(base,'public');if(path.dirname(outputDirectory)!==base)throw Error('Unexpected build output directory');
for(const name of ['art.js','data.js','chart.js','style.css','app.js','cloud.css','cloud-client.js','cloud-review.js','login.js','admin.js',...shared]){const target=path.resolve(outputDirectory,name);if(path.dirname(target)!==outputDirectory)throw Error('Unexpected legacy output');await rm(target,{force:true});}
const legacyAssets=path.resolve(outputDirectory,'assets');if(path.dirname(legacyAssets)!==outputDirectory)throw Error('Unexpected legacy assets');await rm(legacyAssets,{recursive:true,force:true});
await mkdir(path.join(base,'public/static'),{recursive:true});await mkdir(path.join(base,'src/shared'),{recursive:true});
// Remove only the unused CommonJS export adapter; scoring bodies stay identical.
for(const file of shared){const code=await readFile(path.join(local,file),'utf8');await writeFile(path.join(base,'src/shared',file),code.replace(/if\s*\(typeof module\s*!==?\s*['"]undefined['"]\)\s*module\.exports\s*=[^;]+;/g,''));}
const heroes=JSON.parse(await readFile(path.join(local,'data/heroes.json'),'utf8'));
const maps=JSON.parse(await readFile(path.join(local,'data/maps.json'),'utf8'));
await writeFile(path.join(base,'src/shared/data.mjs'),'export const heroes='+JSON.stringify(Object.fromEntries(heroes.map(h=>[String(h.heroGuid),{...h,role:h.roleType}])))+';\nexport const maps='+JSON.stringify(Object.fromEntries(maps.map(m=>[String(m.guid),m])))+';');
const ai=await readFile(path.join(local,'ai_review.py'),'utf8'), prompt=ai.match(/PROMPT = '''([\s\S]*?)'''/)[1];
const knowledge=await readFile(path.join(local,'AI锐评-游戏常识.md'),'utf8');
await writeFile(path.join(base,'src/prompt.mjs'),'export const prompt='+JSON.stringify(prompt+'\n\n'+knowledge)+';export const version="1.6-cloud.1";');
const media=JSON.parse(await readFile(path.join(local,'media/manifest.json'),'utf8'));
for(const dir of ['maps','icons'])await cp(path.join(local,'media',dir),path.join(base,'public/media',dir),{recursive:true});
let html=await readFile(path.join(local,'index.html'),'utf8');
const logo=html.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0];
if(!logo)throw Error('Missing website logo');
const favicon=logo.replace('class="mark"','xmlns="http://www.w3.org/2000/svg"').replace('width="42" height="42"','width="48" height="48"').replace(' aria-hidden="true"','');
const faviconURL='/static/logo.'+createHash('sha256').update(favicon).digest('hex').slice(0,16)+'.svg';
await writeFile(path.join(base,'public',faviconURL.slice(1)),favicon);
const brandPage=page=>page.replace(/<link\b[^>]*rel="(?:shortcut )?icon"[^>]*>/g,'').replace('</head>',`<link rel="icon" type="image/svg+xml" sizes="any" href="${faviconURL}"></head>`);
html=brandPage(html).replace('<title>快速强度图 · Quick Strength</title>','<title>快速强度图</title>');
html=html.replace(/<details id="credentials">[\s\S]*?<\/details>/,'');
html=html.replace(/<dialog id="aiKeyDialog"[\s\S]*?<\/dialog>/,'');
html=html.replace(/<button[^>]*id="aiReviewSettings"[^>]*>[\s\S]*?<\/button>/,'');
html=html.replace(/<\/header>/,'<div class="cloud-user"><span id="cloudIdentity"></span><button id="cloudLogout">退出</button></div></header>');
html=html.replace('<button id="cloudLogout">','<button id="changelogOpen" type="button">更新日志</button><button id="cloudLogout">');
html=html.replace('</body>',await readFile(path.join(base,'web/changelog.html'),'utf8')+'</body>');
html=html.replace('<button type="submit" id="query"', '<label class="check"><input id="supplementOtherMatches" type="checkbox">补充其他对局</label><p class="hint">不勾选为快查询：使用已有参考；勾选后按缺口补充近期对局。</p><button type="submit" id="query"');
html=html.replace('<div id="status"', '<p id="queryStats" class="hint"></p><p id="mapCacheStats" class="hint"></p><details id="cacheRecordsPanel" class="method" hidden><summary>缓存记录</summary><div id="cacheRecordsBody"></div></details><div id="status"');
// Keep chart defaults and element IDs available to the runtime without exposing advanced controls.
for(const id of ['title','side','strategy','estimate','art']){
  const label=new RegExp('<label\\b[^>]*>(?:(?!</label>)[\\s\\S])*?id="'+id+'"(?:(?!</label>)[\\s\\S])*?</label>');
  if(!label.test(html))throw Error('Missing chart setting: '+id);
  html=html.replace(label,match=>match.replace('<label','<label hidden'));
}
html=html.replace('<div class="field-pair"><label>展示场数','<div class="field-pair chart-range"><label>展示场数');
html=html.replace('<p class="hint">查询时自动合并已有对局', '<label>统计范围<select id="statisticsRange"><option value="all">全部历史</option><option value="5">5 场</option><option value="10">10 场</option><option value="20">20 场</option></select></label><button id="historyOpen" type="button" class="full history-open">历史记录</button><p id="statisticsNote" class="hint"></p><p class="hint">查询时自动合并已有对局');
const queryCount=html.match(/<div class="field-pair chart-range">[\s\S]*?<\/div>/)?.[0],queryStatus=html.match(/<div id="status"[^>]*>[\s\S]*?<\/div>/)?.[0];
if(!queryCount||!queryStatus)throw Error('Query controls adapter changed');
html=html.replace(queryCount,'').replace(queryStatus,'');
html=html.replace('<p class="hint">不勾选为快查询',queryCount.replace('展示场数','查询场数')+'<p class="hint">仅补查所选最近范围内缺少的数据，已有对局复用并合并历史。</p><p class="hint">不勾选为快查询');
html=html.replace('</form>','</form>'+queryStatus);
html=html.replace('</body>', '<dialog id="historyDialog" class="history-dialog"><div class="history-heading"><h2>历史记录</h2><button id="historyClose" type="button">关闭</button></div><label>搜索战网账号<input id="historySearch" placeholder="昵称或完整战网标签" maxlength="80"></label><p id="historyNotice" class="hint"></p><div id="historyList"></div></dialog></body>');
html=html.replace('<div class="explain">','<div class="timeline-navigation"><button id="timelineOlder" type="button" aria-label="向前查看一场">← 旧对局</button><span id="timelinePosition" role="status"></span><button id="timelineNewer" type="button" aria-label="向后查看一场">新对局 →</button></div><div id="timelineScroll" class="timeline-scroll" tabindex="0" aria-label="历史对局横向滚动条"><div id="timelineTrack"></div></div><div class="explain">');
html=html.replace(/<body>/,'<body class="cloud-pending">');
html=html.replace('<button type="button" id="cancel" class="full" hidden>停止查询</button>','<button type="button" id="cancel" class="full" hidden>停止查询</button><button type="button" id="resumeQuery" class="full" hidden>继续查询</button>');
html=html.replace(/<script src="ai-review.js[^\"]*"><\/script>/,'<script src="cloud-client.js"></script><script src="cloud-review.js"></script>');
html=html.replace(/app.js\?v=[^\"]*/,'app.js?v=cloud-1');
html=html.replace(/<\/head>/,'<link rel="stylesheet" href="cloud.css"></head>');
let app=await readFile(path.join(local,'app.js'),'utf8');
const cutStart=app.indexOf('function credentialPayload()'),cutEnd=app.indexOf('async function loadGameData');
app=app.slice(0,cutStart)+app.slice(cutEnd);
app=app.replace(/\$\('onlinePanel'\)\.onsubmit=[\s\S]*?(?=\$\('cancel'\)\.onclick)/,`$('onlinePanel').onsubmit=async e=>{e.preventDefault();if(activeJob)return;try{busy(true);status('正在建立查询…');const r=await Cloud.startQuery($('battleTag').value.trim(),Number($('limit').value),$('supplementOtherMatches').checked);activeJob=r.id;poll();}catch(e){busy(false);status(e.message,true);}};\n`);
{const start=app.indexOf('async function request('),end=app.indexOf('function busy(',start);if(start<0||end<0)throw Error('Local request adapter changed');app=app.slice(0,start)+'async function request(path,body){return Cloud.api(path,body);}\n'+app.slice(end);}
app=app.replace("raw=QS.normalize(job.result);activeJob=null", "await Cloud.save(job.envelope,job.cacheRecords,job.queryIndex);raw=QS.normalize(job.result||job.envelope.content.data);await openHistory(raw.battletag);activeJob=null");
app=app.replace("status(job.message||'查询中…');","status(job.message||'查询中…');if(job.cacheRequest){await CloudCache.fulfill(job);pollTimer=setTimeout(poll,50);return;}");
app=app.replace("request('/api/job/'+activeJob)","request('/api/job/'+activeJob+'?compact=1')");
app=app.replace("}else pollTimer=setTimeout(poll,1000);", "}else if(job.state==='paused'){$('resumeQuery').hidden=false;}else pollTimer=setTimeout(poll,1000);");
app=app.replace("function busy(value){", "$('resumeQuery').onclick=async()=>{try{await request('/api/job/'+activeJob+'/resume',{});$('resumeQuery').hidden=true;poll();}catch(e){status(e.message,true);}};\nfunction busy(value){$('resumeQuery').hidden=true;");
app=app.replace(/\$\('credentials'\)\.open=false;[\s\S]*$/,'(async()=>{try{await Cloud.boot();const latest=await Cloud.latest();if(latest.historyTag){await openHistory(latest.historyTag);}else if(latest.result){raw=QS.normalize(latest.result);$("battleTag").value=raw.battletag;generate();}if(latest.activeJob){activeJob=latest.activeJob;busy(true);poll();}}catch(e){status(e.message,true);}})();');
app=app.replace(/const payload=\{\.\.\.credentialPayload\(\),battletag:tag,matchId:match.mid\}/,'const payload={battletag:tag,matchId:match.mid,envelope:await CloudHistory.envelope(tag,match.mid)||await Cloud.snapshot(tag)}');
app=app.replace('if(m&&(!m.hasGameData||!m.resourceDataChecked))loadGameData(m);',"if(m&&(!m.hasGameData||!m.resourceDataChecked)){$('gameDataStatus').textContent='历史记录缺少部分游戏数据；不会自动补查';}");
app=app.replace("payload.token='';",'');
app=app.replace("status('已请求停止，正在结束当前请求…');", "status('已请求停止，正在结束当前请求…');poll();");
const exportStart=app.indexOf('function svgBlob()'),exportEnd=app.indexOf("$('json').onclick",exportStart);
if(exportStart<0||exportEnd<0)throw Error('Export adapter changed');
app=app.slice(0,exportStart)+await readFile(path.join(base,'web/cloud-export.js'),'utf8')+'\n'+app.slice(exportEnd);
const generateStart=app.indexOf('function generate(){'),personalStart=app.indexOf('function showPersonal(){',generateStart);
if(generateStart<0||personalStart<0)throw Error('Chart generation adapter changed');
app=app.slice(0,generateStart)+await readFile(path.join(base,'web/cloud-timeline.js'),'utf8')+'\n'+app.slice(personalStart);
const zoomStart=app.indexOf('function applyChartZoom(){'),playersStart=app.indexOf('function showPlayers(',zoomStart);
app=app.slice(0,zoomStart)+"function applyChartZoom(){$('chart').style.minWidth='';$('chartZoom').textContent='回到最新';$('chartZoom').removeAttribute('aria-pressed');$('zoomHint').textContent='按住图表左右拖动 · 点击场次看依据';}\n$('chartZoom').onclick=()=>{timeline.start=Math.max(0,timeline.all.length-TIMELINE_WINDOW);generate();};\n"+app.slice(playersStart);
app=app.replace('function showPlayers(index){','function showPlayers(index){timeline.detailMatch=model.matches[index];');
const jsonStart=app.indexOf("$('json').onclick="),jsonEnd=app.indexOf("['limit','side','strategy','estimate','art']",jsonStart);
app=app.slice(0,jsonStart)+"$('json').onclick=()=>{const data={...raw,historyExport:{retained:raw.matches.length,statisticsRange:$('statisticsRange').value,visibleMatchIds:model.matches.map(m=>m.mid)},visualization:{summary:model.summary,personalPrediction:model.personalPrediction,points:timeline.all.map(m=>({mid:m.mid,mean:m.mean,observedMean:m.observedMean,confidenceEvidence:m.confidenceEvidence,estimateDetails:m.estimateDetails,estimateRange:m.estimateRange,performances:m.players.map(p=>({name:p.name,...p.performance}))}))}};download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),fileName('json'));status('已导出当前账号全部保留历史 JSON（不含凭据和签名包）');};\n"+app.slice(jsonEnd);
const mapStart=app.indexOf('const mapAttempts=new Set()'),mapEnd=app.indexOf('\ngenerate();',mapStart);
if(mapStart<0||mapEnd<0)throw Error('Map adapter changed');
app=app.slice(0,mapStart)+"function queueMapArt(){QS_ASSETS.render($('chart').querySelector('svg'),$('art').checked);}\n"+app.slice(mapEnd);
app=app.replace('empty||mapLoading','empty').replace('mapAttempts.clear();generate();','generate();');
app+="\n$('limit').onchange=null;\n";
let chart=await readFile(path.join(local,'chart.js'),'utf8');
chart=chart.replace('if(showArt&&art[m.mapGuid])','if(showArt)').replace('href="${esc(art[m.mapGuid])}"','data-map-art="${esc(m.mapGuid)}"');
chart=chart.replace('n=matches.length;', 'n=matches.length,statsMatches=model.statsMatches||matches,statsCount=statsMatches.length;');
chart=chart.replace('const observedMatches=matches.filter', 'const observedMatches=statsMatches.filter');
chart=chart.replace('`${rank(s.mean)} · ${n} 场 / ${s.estimated} 场融合`','`${rank(s.mean)} · ${statsCount} 场 / ${s.estimated} 场融合`');
chart=chart.replace("text(confidenceX,156,'对局证据评分'", "text(confidenceX,156,model.statisticsLabel?.split(' · ').slice(0,2).join(' · ')||'对局证据评分'");
chart=chart.replace('matches.flatMap(m=>m.scores)', 'statsMatches.flatMap(m=>m.scores)');
// The axis and clipping window stay fixed; only the trajectory moves within it.
const axisLine=chart.split('\n').find(line=>line.includes('for(let v=lo;v<=hi;v+=500)'));
if(!axisLine)throw Error('Chart axis adapter changed');
const plotLayer="z.push('<g class=\"timeline-viewport\" clip-path=\"url(#timeline-window)\"><g class=\"timeline-trajectory\">');";
chart=chart.replace(axisLine,"z.push('</g></g>');\n"+axisLine+'\n'+plotLayer);
chart=chart.replace('// Map columns set', plotLayer+'\n // Map columns set');
chart=chart.replace('</clipPath></defs>', '</clipPath><clipPath id="timeline-window"><rect x="${left}" y="${top}" width="${right-left}" height="554"/></clipPath></defs>');
chart=chart.replace('panel(34,837,W-68,102);',"z.push('</g></g>');panel(34,837,W-68,102);");
chart=chart.replace('n*120+220','(model.windowSize||n)*120+220').replace('cw=(right-left)/Math.max(1,n)','cw=(right-left)/Math.max(1,model.windowSize||n)');
chart=chart.replace('center=i=>left+(i+.5)*cw','center=i=>left+(i+.5+(model.columnOffset||0))*cw').replaceAll('left+i*cw+3','left+(i+(model.columnOffset||0))*cw+3');
chart=chart.replace('`${n} 场`','`${model.windowSize||n} 场`');
chart=chart.replace('if(hi<=lo)hi=Math.min(5000,lo+500);','if(hi<=lo)hi=Math.min(5000,lo+500);if(model.plotScale){lo=model.plotScale.min;hi=model.plotScale.max;}');
chart=chart.replace('data-chart-version="${QS_CHART_VERSION}"','data-chart-version="${QS_CHART_VERSION}" data-plot-min="${lo}" data-plot-max="${hi}"');
chart=chart.replace("String(i+1).padStart", "String((model.windowOffset||0)+i+1).padStart");
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
async function staticFile(source,extension,name){const out=(await transform(source,{loader:extension==='css'?'css':'js',minify:true,target:'es2022',...(extension==='css'?{}:{format:'iife'})})).code;const url='/static/'+name+'.'+hash(out)+'.'+extension;await writeFile(path.join(base,'public',url.slice(1)),out);return url;}
const css=await staticFile(await readFile(path.join(local,'style.css'),'utf8')+'\n'+await readFile(path.join(base,'web/cloud.css'),'utf8'),'css','app');
const files=async names=>Promise.all(names.map(name=>readFile(path.join(local,name),'utf8')));
const browserData=await readFile(path.join(local,'data.js'),'utf8');
const runtime=await files(shared);
const smallArt='window.QS_MEDIA='+JSON.stringify(media)+';window.QS_ART={};window.QS_AVATAR=QS_MEDIA.avatar;window.QS_RANK_ART=QS_MEDIA.ranks;';
const main=await staticFile([browserData,...runtime,smallArt,chart,await readFile(path.join(base,'web/media-loader.js'),'utf8'),await readFile(path.join(base,'web/history-model.js'),'utf8'),await readFile(path.join(base,'web/cloud-history.js'),'utf8'),await readFile(path.join(base,'web/cloud-cache.js'),'utf8'),await readFile(path.join(base,'web/cloud-client.js'),'utf8'),await readFile(path.join(base,'web/cloud-review.js'),'utf8'),app,await readFile(path.join(base,'web/changelog.js'),'utf8')].join('\n'),'js','app');
html=html.replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace('</head>',`<link rel="stylesheet" href="${css}"><script defer src="${main}"></script></head>`);
await writeFile(path.join(base,'public/index.html'),html);
for(const page of ['login','admin']){let content=brandPage(await readFile(path.join(base,'web',page+'.html'),'utf8'));const js=await staticFile(await readFile(path.join(base,'web',page+'.js'),'utf8'),'js',page);content=content.replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace('</head>',`<link rel="stylesheet" href="${css}"><script defer src="${js}"></script></head>`);await writeFile(path.join(base,'public',page+'.html'),content);}
await writeFile(path.join(base,'public/_headers'),`/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/media/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
console.log('Cloud build complete: hashed scripts, lazy CDN media; original local tool preserved.');
