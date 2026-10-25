import {mkdir,readFile,writeFile,copyFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {buildBackend,sharedSources} from './build-backend.mjs';
import {createHash} from 'node:crypto';
import {transform,build} from 'esbuild';
import {gitNotes} from './release-notes.mjs';
import {buildToolkit} from './build-toolkit.mjs';
import {buildAssetPreload} from './build-asset-preload.mjs';
import {buildApiCapture} from './build-api-capture.mjs';
import {rewriteCopy,cleanDecorativeEnglish,cleanAnalysisUi,cleanAnalysisRuntime} from './ui-copy.mjs';
const base=path.resolve(import.meta.dirname,'..'), local=path.join(base,'source');
const shared=sharedSources;
const capture=process.argv.includes('--bot-capture');
if(!process.argv.includes('--web-only'))await buildBackend({base});
// Remove known legacy outputs, keeping the directory itself usable by Windows dev watchers.
const outputDirectory=path.resolve(base,'public');if(path.dirname(outputDirectory)!==base)throw Error('Unexpected build output directory');
for(const name of ['art.js','data.js','chart.js','style.css','app.js','cloud.css','cloud-client.js','cloud-review.js','login.js','admin.js',...shared]){const target=path.resolve(outputDirectory,name);if(path.dirname(target)!==outputDirectory)throw Error('Unexpected legacy output');await rm(target,{force:true});}
const legacyAssets=path.resolve(outputDirectory,'assets');if(path.dirname(legacyAssets)!==outputDirectory)throw Error('Unexpected legacy assets');await rm(legacyAssets,{recursive:true,force:true});
await mkdir(path.join(base,'public/static'),{recursive:true});
const noteConfig=JSON.parse(await readFile(path.join(base,'web/release-notes.json'),'utf8'));
const releaseNotes=gitNotes(noteConfig.baseline,noteConfig.entries);
await writeFile(path.join(base,'public/release-notes.json'),JSON.stringify(releaseNotes));
const media=JSON.parse(await readFile(path.join(local,'media/manifest.json'),'utf8'));
for(const dir of ['maps','icons'])await cp(path.join(local,'media',dir),path.join(base,'public/media',dir),{recursive:true});
let html=await readFile(path.join(local,'index.html'),'utf8');
const oldLogo=html.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0];
if(!oldLogo)throw Error('Missing original brand logo');
const logo=(await readFile(path.join(base,'web/fox.svg'),'utf8')).trim();
html=html.replace(oldLogo,logo);
if(!logo)throw Error('Missing website logo');
const favicon=logo.replace(' class="mark"','').replace('width="42" height="42"','width="48" height="48"').replace(' aria-hidden="true"','');
const faviconURL='/static/logo.'+createHash('sha256').update(favicon).digest('hex').slice(0,16)+'.svg';
await writeFile(path.join(base,'public',faviconURL.slice(1)),favicon);
const brandPage=page=>page.replace(/<title>([^<]+)<\/title>/,(_,title)=>'<title>'+(/^(守望工具箱|快速强度图)/.test(title)?(/英雄抽取/.test(title)?'随机英雄 · ':'快速强度图'===title||title.includes('Quick Strength')?'对局分析 · ':'')+'狸狸天眼查':title.replace(/快速强度图|守望工具箱/g,'狸狸天眼查'))+'</title>').replace(/<link\b[^>]*rel="(?:shortcut )?icon"[^>]*>/g,'').replace('</head>',`<link rel="icon" type="image/svg+xml" sizes="any" href="${faviconURL}"></head>`);
const httpClient=await readFile(path.join(base,'web/http-client.js'),'utf8');
const installHead='<link rel="manifest" href="/manifest.json"><script defer src="/install.js"></script>';
await writeFile(path.join(base,'public/app-icon.svg'),await readFile(path.join(base,'web/app-icon.svg')));
// Minified so the install prompt stays inside the page startup budget.
await writeFile(path.join(base,'public/install.js'),(await transform(await readFile(path.join(base,'web/install.js'),'utf8'),{loader:'js',minify:true,target:'es2022'})).code);
await writeFile(path.join(base,'public/event-reminders-sw.js'),await readFile(path.join(base,'web/event-reminders-sw.js')));
await writeFile(path.join(base,'public/manifest.json'),JSON.stringify({id:'/',name:'狸狸天眼查',short_name:'天眼查',description:'守望先锋对局分析、英雄抽取与赛事中心',lang:'zh-CN',start_url:'/',scope:'/',display:'standalone',background_color:'#ffffff',theme_color:'#f58220',icons:[{src:'/app-icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]}));
const withInstall=page=>page.replace('</head>',installHead+'</head>');
html=html.replace('<span>快速强度图</span>','<span>狸狸天眼查</span>').replace('快速强度图首页','狸狸天眼查首页');
html=html.replace('<a class="brand" href="./index.html"','<a class="brand" href="/"');
 html=withInstall(brandPage(html)).replace('<title>快速强度图 · Quick Strength</title>','<title>快速强度图</title>');
html=html.replace('width=device-width,initial-scale=1','width=device-width,initial-scale=1,viewport-fit=cover');
html=html.replace(/<details id="credentials">[\s\S]*?<\/details>/,'');
html=html.replace(/<dialog id="aiKeyDialog"[\s\S]*?<\/dialog>/,'');
html=html.replace(/<button[^>]*id="aiReviewSettings"[^>]*>[\s\S]*?<\/button>/,'');
html=html.replace(/<\/header>/,'<div class="cloud-user"><span id="cloudIdentity"></span><button id="apiKeyOpen" type="button">API</button><button id="cloudLogout">退出</button></div></header>');
html=html.replace('<button id="cloudLogout">','<button id="changelogOpen" type="button">更新日志</button><button id="cloudLogout">');
html=html.replace('<main>','<main><a href="/" class="analysis-back-link">← 返回首页</a>');
html=html.replace('</body>',await readFile(path.join(base,'web/changelog.html'),'utf8')+await readFile(path.join(base,'web/api-key.html'),'utf8')+'</body>');
html=html.replace('</body>','<dialog id="mobileChartDialog" class="mobile-chart-dialog"><div class="mobile-chart-heading"><h2>对局图表</h2><button id="mobileChartClose" type="button">关闭</button></div><div id="mobileChartBody" class="mobile-chart-body"></div><p class="hint">滑动查看完整图表，点击场次返回查看明细。</p></dialog></body>');
html=html.replace('<div class="canvas-wrap">','<div id="mobileSummary" class="mobile-summary" aria-label="对局统计摘要"></div><div class="canvas-wrap">').replace('<button id="chartZoom"','<button id="mobileChartOpen" type="button" class="mobile-chart-open">放大查看</button><button id="chartZoom"');
html=html.replace('<small>CONFIGURATION</small>','<small>CONFIGURATION</small><button id="mobileSettingsToggle" type="button" aria-expanded="true">收起设置</button>');
html=html.replace('<button type="submit" id="query"', '<label>对局模式<select id="pool"><option value="">全部快速模式</option><option value="55">快速 5v5</option><option value="66">快速 6v6</option></select></label><label class="check"><input id="supplementOtherMatches" type="checkbox">补充其他对局</label><p class="hint">不勾选为快查询：使用已有参考；勾选后按缺口补充近期对局。</p><p class="hint">5v5 与 6v6 分开采集和统计；选择某一模式时只分析该人数的对局。</p><button type="submit" id="query"');
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
// The only loadGameData call site is replaced below; keep the credentials marker for the boot rewrite at the end.
const deadStart=app.indexOf('async function loadGameData'),deadEnd=app.indexOf("$('credentials').open=false;",deadStart);
if(deadStart<0||deadEnd<0)throw Error('Dead game-data adapter changed');
app=app.slice(0,deadStart)+app.slice(deadEnd);
app=app.replace(/\$\('onlinePanel'\)\.onsubmit=[\s\S]*?(?=\$\('cancel'\)\.onclick)/,`$('onlinePanel').onsubmit=async e=>{e.preventDefault();if(activeJob)return;try{busy(true);status('正在建立查询…');const r=await Cloud.startQuery($('battleTag').value.trim(),Number($('limit').value),$('supplementOtherMatches').checked,$('pool').value);activeJob=r.id;poll();}catch(e){busy(false);status(e.message,true);}};\n`);
{const start=app.indexOf('async function request('),end=app.indexOf('function busy(',start);if(start<0||end<0)throw Error('Local request adapter changed');app=app.slice(0,start)+'async function request(path,body){return Cloud.api(path,body);}\n'+app.slice(end);}
const pollStart=app.indexOf('async function poll(){'),pollEnd=app.indexOf("$('onlinePanel').onsubmit",pollStart);
if(pollStart<0||pollEnd<0)throw Error('Query polling adapter changed');
app=app.slice(0,pollStart)+await readFile(path.join(base,'web/cloud-query.js'),'utf8')+'\n'+app.slice(pollEnd);
app=app.replace("function busy(value){", "$('resumeQuery').onclick=async()=>{try{await request('/api/job/'+activeJob+'/resume',{});$('resumeQuery').hidden=true;poll();}catch(e){status(e.message,true);}};\nfunction busy(value){$('resumeQuery').hidden=true;");
app=app.replace(/\$\('credentials'\)\.open=false;[\s\S]*$/,'(async()=>{try{await Cloud.boot();const latest=await Cloud.latest();if(latest.historyTag){await openHistory(latest.historyTag);}else if(latest.result){raw=QS.normalize(latest.result);$("battleTag").value=raw.battletag;generate();}if(latest.activeJob){activeJob=latest.activeJob;busy(true);poll();}}catch(e){status(e.message,true);}})();');
app=app.replace('if(m&&(!m.hasGameData||!m.resourceDataChecked))loadGameData(m);',"if(m&&(!m.hasGameData||!m.resourceDataChecked)){$('gameDataStatus').textContent='历史记录缺少部分游戏数据；不会自动补查';}");
app=app.replace("status('已请求停止，正在结束当前请求…');", "status('已请求停止，正在结束当前请求…');poll();");
const exportStart=app.indexOf('function svgBlob()'),exportEnd=app.indexOf("$('json').onclick",exportStart);
if(exportStart<0||exportEnd<0)throw Error('Export adapter changed');
app=app.slice(0,exportStart)+await readFile(path.join(base,'web/cloud-export.js'),'utf8')+'\n'+app.slice(exportEnd);
const generateStart=app.indexOf('function generate(){'),personalStart=app.indexOf('function showPersonal(){',generateStart);
if(generateStart<0||personalStart<0)throw Error('Chart generation adapter changed');
app=app.slice(0,generateStart)+await readFile(path.join(base,'web/cloud-timeline.js'),'utf8')+'\n'+app.slice(personalStart);
const zoomStart=app.indexOf('function applyChartZoom(){'),playersStart=app.indexOf('function showPlayers(',zoomStart);
app=app.slice(0,zoomStart)+"function applyChartZoom(){$('chart').style.minWidth='';$('chartZoom').textContent='回到最新';$('chartZoom').removeAttribute('aria-pressed');$('zoomHint').textContent='按住图表左右拖动 · 点击场次看依据';}\n$('chartZoom').onclick=()=>{timeline.start=Math.max(0,timeline.all.length-TIMELINE_WINDOW);generate();};\n"+app.slice(playersStart);
app=app.replace('function showPlayers(index){','function showPlayers(index){timeline.detailMatch=model.matches[index];window.OWQS_LAST_ANALYSIS={model,raw,index};queueMicrotask(()=>window.dispatchEvent(new CustomEvent("owqs:analysis-updated",{detail:{model,raw,index}})));');
// Exact-match adapters fail closed if the upstream UI template changes.
app=cleanAnalysisRuntime(app);
app=app.replace('function showPerformance(p){','function showPerformance(p,embedded=false){').replace("$('performancePanel').scrollIntoView({block:'nearest'});","if(!embedded)$('performancePanel').scrollIntoView({block:'nearest'});");
const jsonStart=app.indexOf("$('json').onclick="),jsonEnd=app.indexOf("['limit','side','strategy','estimate','art']",jsonStart);
app=app.slice(0,jsonStart)+"$('json').onclick=()=>{const data={...raw,historyExport:{retained:raw.matches.length,statisticsRange:$('statisticsRange').value,visibleMatchIds:model.matches.map(m=>m.mid)},visualization:{summary:model.summary,personalPrediction:model.personalPrediction,points:timeline.all.map(m=>({mid:m.mid,mean:m.mean,observedMean:m.observedMean,confidenceEvidence:m.confidenceEvidence,estimateDetails:m.estimateDetails,estimateRange:m.estimateRange,performances:m.players.map(p=>({name:p.name,...p.performance}))}))}};download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),fileName('json'));status('已导出当前账号全部保留历史 JSON（不含凭据和签名包）');};\n"+app.slice(jsonEnd);
const mapStart=app.indexOf('const mapAttempts=new Set()'),mapEnd=app.indexOf('\ngenerate();',mapStart);
if(mapStart<0||mapEnd<0)throw Error('Map adapter changed');
app=app.slice(0,mapStart)+"function queueMapArt(){QS_ASSETS.render($('chart').querySelector('svg'),$('art').checked);}\n"+app.slice(mapEnd);
app=app.replace('empty||mapLoading','empty').replace('mapAttempts.clear();generate();','generate();');
app+="\n$('limit').onchange=null;\n";
// The phone layout loads on demand; expose only the state and renderers it shares with this bundle.
app+="window.OWQS_APP={get model(){return model},get activeJob(){return activeJob},timeline,showPlayers,showPerformance,settleTimeline};\n";
app=app.replaceAll('QS.normalize(', 'OWQS_SERVICES.data.normalize(');
let chart=await readFile(path.join(local,'chart.js'),'utf8');
chart=chart.replace('if(showArt&&art[m.mapGuid])','if(showArt)').replace('href="${esc(art[m.mapGuid])}"','data-map-art="${esc(m.mapGuid)}"');
// Shared source renderer already supports statsMatches and plotScale for server/browser parity.
chart=chart.replace("text(confidenceX,156,'对局证据评分'", "text(confidenceX,156,model.statisticsLabel?.split(' · ').slice(0,2).join(' · ')||'对局证据评分'");
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
chart=chart.replace('data-chart-version="${QS_CHART_VERSION}"','data-chart-version="${QS_CHART_VERSION}" data-plot-min="${lo}" data-plot-max="${hi}"');
chart=chart.replace("String(i+1).padStart", "String((model.windowOffset||0)+i+1).padStart");
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
async function staticFile(source,extension,name){const out=(await transform(source,{loader:extension==='css'?'css':'js',minify:true,target:'es2022',...(extension==='css'?{}:{format:'iife'})})).code;const url='/static/'+name+'.'+hash(out)+'.'+extension;await writeFile(path.join(base,'public',url.slice(1)),out);return url;}
// Keep reminders off the startup budget: the engine hashes separately and loads after the page is idle.
const reminderEngine=await staticFile(await readFile(path.join(base,'web/event-reminders.js'),'utf8'),'js','event-reminders');
const reminderLoader=await staticFile((await readFile(path.join(base,'web/event-reminders-loader.js'),'utf8')).replace('__EVENT_REMINDERS_URL__',reminderEngine),'js','event-reminders-loader');
// Secondary panels load right after the main chunk; only the tiny loader counts toward the startup budget.
const extras=await staticFile(rewriteCopy([await readFile(path.join(base,'web/api-key.js'),'utf8'),await readFile(path.join(base,'web/cloud-review.js'),'utf8'),await readFile(path.join(base,'web/changelog.js'),'utf8')].join('\n')),'js','app-extras');
const extrasLoader=await staticFile((await readFile(path.join(base,'web/app-extras-loader.js'),'utf8')).replace('__APP_EXTRAS_URL__',extras),'js','app-extras-loader');
// Phone chrome and analysis layout are desktop-irrelevant; the loader only fetches them when the media query matches.
const mobile=await staticFile(rewriteCopy([await readFile(path.join(base,'web/mobile-shell.js'),'utf8'),await readFile(path.join(base,'web/mobile.js'),'utf8')].join('\n')),'js','app-mobile');
const mobileLoader=await staticFile((await readFile(path.join(base,'web/app-mobile-loader.js'),'utf8')).replace('__APP_MOBILE_URL__',mobile),'js','app-mobile-loader');
const css=await staticFile(await readFile(path.join(local,'style.css'),'utf8')+'\n'+await readFile(path.join(base,'web/cloud.css'),'utf8')+'\n'+await readFile(path.join(base,'web/mobile-shell.css'),'utf8')+'\n'+await readFile(path.join(base,'web/mobile.css'),'utf8')+'\n'+await readFile(path.join(base,'web/event-reminders.css'),'utf8'),'css','app');
const files=async names=>Promise.all(names.map(name=>readFile(path.join(local,name),'utf8')));
const browserData=await readFile(path.join(local,'data.js'),'utf8');
const runtime=await files(shared);
const services=await build({entryPoints:[path.join(base,'web/services.js')],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false});
runtime.push(services.outputFiles[0].text);
const smallArt='window.QS_MEDIA='+JSON.stringify(media)+';window.QS_ART={};window.QS_AVATAR=QS_MEDIA.avatar;window.QS_RANK_ART=QS_MEDIA.ranks;';
const main=await staticFile(rewriteCopy([httpClient,browserData,...runtime,smallArt,chart,await readFile(path.join(base,'web/media-loader.js'),'utf8'),await readFile(path.join(base,'web/history-model.js'),'utf8'),await readFile(path.join(base,'web/cloud-history.js'),'utf8'),await readFile(path.join(base,'web/cloud-cache.js'),'utf8'),await readFile(path.join(base,'web/cloud-client.js'),'utf8'),await readFile(path.join(base,'web/server-analysis.js'),'utf8'),app].join('\n')),'js','app');
html=html.replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace('</head>',`<link rel="preload" as="script" href="${mobile}" media="(max-width:760px), (max-height:500px) and (pointer:coarse)"><link rel="stylesheet" href="${css}"><script defer src="${main}"></script><script defer src="${mobileLoader}"></script><script defer src="${extrasLoader}"></script><script defer src="${reminderLoader}"></script><script defer src="/install.js"></script></head>`);
await mkdir(path.join(base,'public/tools'),{recursive:true});
html=cleanAnalysisUi(html);
await writeFile(path.join(base,'public/tools/strength.html'),rewriteCopy(cleanDecorativeEnglish(html)));
if(capture)await buildApiCapture({base,html:rewriteCopy(cleanDecorativeEnglish(html)),app:rewriteCopy(app),css});
await buildToolkit({base,brandPage:page=>withInstall(brandPage(page)),logo,staticFile,releaseNotes,rewriteCopy,cleanDecorativeEnglish});
for(const page of ['login','admin']){let content=withInstall(brandPage(await readFile(path.join(base,'web',page+'.html'),'utf8')));const js=await staticFile(rewriteCopy(httpClient+'\n'+await readFile(path.join(base,'web',page+'.js'),'utf8')),'js',page);content=content.replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace('</head>',`<link rel="stylesheet" href="${css}"><script defer src="${js}"></script><script defer src="/install.js"></script></head>`);await writeFile(path.join(base,'public',page+'.html'),rewriteCopy(cleanDecorativeEnglish(content)));}
await writeFile(path.join(base,'public/_headers'),`/release-notes.json\n  Cache-Control: no-store\n/event-reminders-sw.js\n  Cache-Control: no-store\n/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/media/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
await buildAssetPreload({base,media,staticFile});
console.log('Cloud build complete: hashed scripts, lazy CDN media, idle browser prewarming; original local tool preserved.');
