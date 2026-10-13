import {mkdir,readFile,writeFile,copyFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {transform} from 'esbuild';
const base=path.resolve(import.meta.dirname,'..'), local=path.join(base,'source');
const shared=['core.js','benchmarks.js','rating-rules.js','resource-rating.js','performance.js'];
let revision='local';try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:base,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
await writeFile(path.join(base,'src/release.mjs'),'export const release='+JSON.stringify({revision,builtAt:new Date().toISOString(),version:'cloud-1.0.1'})+';');
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
html=html.replace(/<details id="credentials">[\s\S]*?<\/details>/,'');
html=html.replace(/<dialog id="aiKeyDialog"[\s\S]*?<\/dialog>/,'');
html=html.replace(/<button[^>]*id="aiReviewSettings"[^>]*>[\s\S]*?<\/button>/,'');
html=html.replace(/<\/header>/,'<div class="cloud-user"><span id="cloudIdentity"></span><button id="cloudLogout">退出</button></div></header>');
html=html.replace('<button type="submit" id="query"', '<label class="check"><input id="supplementOtherMatches" type="checkbox">补充其他对局</label><p class="hint">不勾选为快查询：使用已有参考；勾选后按缺口补充近期对局。</p><button type="submit" id="query"');
html=html.replace('<div id="status"', '<p id="queryStats" class="hint"></p><p id="mapCacheStats" class="hint"></p><details id="cacheRecordsPanel" class="method"><summary>缓存记录</summary><div id="cacheRecordsBody"></div></details><div id="status"');
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
app=app.replace("raw=QS.normalize(job.result);activeJob=null", "await Cloud.save(job.envelope,job.cacheRecords,job.queryIndex);raw=QS.normalize(job.result||job.envelope.content.data);activeJob=null");
app=app.replace("status(job.message||'查询中…');","status(job.message||'查询中…');if(job.cacheRequest){await CloudCache.fulfill(job);pollTimer=setTimeout(poll,50);return;}");
app=app.replace("request('/api/job/'+activeJob)","request('/api/job/'+activeJob+'?compact=1')");
app=app.replace("}else pollTimer=setTimeout(poll,1000);", "}else if(job.state==='paused'){$('resumeQuery').hidden=false;}else pollTimer=setTimeout(poll,1000);");
app=app.replace("function busy(value){", "$('resumeQuery').onclick=async()=>{try{await request('/api/job/'+activeJob+'/resume',{});$('resumeQuery').hidden=true;poll();}catch(e){status(e.message,true);}};\nfunction busy(value){$('resumeQuery').hidden=true;");
app=app.replace(/\$\('credentials'\)\.open=false;[\s\S]*$/,'(async()=>{try{await Cloud.boot();const latest=await Cloud.latest();if(latest.result){raw=QS.normalize(latest.result);$("battleTag").value=raw.battletag;generate();}if(latest.activeJob){activeJob=latest.activeJob;busy(true);poll();}}catch(e){status(e.message,true);}})();');
app=app.replace(/const payload=\{\.\.\.credentialPayload\(\),battletag:tag,matchId:match.mid\}/,'const payload={battletag:tag,matchId:match.mid,envelope:await Cloud.snapshot(tag)}');
app=app.replace("payload.token='';",'');
app=app.replace("status('已请求停止，正在结束当前请求…');", "status('已请求停止，正在结束当前请求…');poll();");
const exportStart=app.indexOf('function svgBlob()'),exportEnd=app.indexOf("$('json').onclick",exportStart);
if(exportStart<0||exportEnd<0)throw Error('Export adapter changed');
app=app.slice(0,exportStart)+await readFile(path.join(base,'web/cloud-export.js'),'utf8')+'\n'+app.slice(exportEnd);
const mapStart=app.indexOf('const mapAttempts=new Set()'),mapEnd=app.indexOf('\ngenerate();',mapStart);
if(mapStart<0||mapEnd<0)throw Error('Map adapter changed');
app=app.slice(0,mapStart)+"function queueMapArt(){QS_ASSETS.render($('chart').querySelector('svg'),$('art').checked);}\n"+app.slice(mapEnd);
app=app.replace('empty||mapLoading','empty').replace('mapAttempts.clear();generate();','generate();');
let chart=await readFile(path.join(local,'chart.js'),'utf8');
chart=chart.replace('if(showArt&&art[m.mapGuid])','if(showArt)').replace('href="${esc(art[m.mapGuid])}"','data-map-art="${esc(m.mapGuid)}"');
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
async function staticFile(source,extension,name){const out=(await transform(source,{loader:extension==='css'?'css':'js',minify:true,target:'es2022',...(extension==='css'?{}:{format:'iife'})})).code;const url='/static/'+name+'.'+hash(out)+'.'+extension;await writeFile(path.join(base,'public',url.slice(1)),out);return url;}
const css=await staticFile(await readFile(path.join(local,'style.css'),'utf8')+'\n'+await readFile(path.join(base,'web/cloud.css'),'utf8'),'css','app');
const files=async names=>Promise.all(names.map(name=>readFile(path.join(local,name),'utf8')));
const browserData=await readFile(path.join(local,'data.js'),'utf8');
const runtime=await files(shared);
const smallArt='window.QS_MEDIA='+JSON.stringify(media)+';window.QS_ART={};window.QS_AVATAR=QS_MEDIA.avatar;window.QS_RANK_ART=QS_MEDIA.ranks;';
const main=await staticFile([browserData,...runtime,smallArt,chart,await readFile(path.join(base,'web/media-loader.js'),'utf8'),await readFile(path.join(base,'web/cloud-cache.js'),'utf8'),await readFile(path.join(base,'web/cloud-client.js'),'utf8'),await readFile(path.join(base,'web/cloud-review.js'),'utf8'),app].join('\n'),'js','app');
html=html.replace(/<script\b[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace('</head>',`<link rel="stylesheet" href="${css}"><script defer src="${main}"></script></head>`);
await writeFile(path.join(base,'public/index.html'),html);
for(const page of ['login','admin']){let content=await readFile(path.join(base,'web',page+'.html'),'utf8');const js=await staticFile(await readFile(path.join(base,'web',page+'.js'),'utf8'),'js',page);content=content.replace(/<link[^>]*rel="stylesheet"[^>]*>/g,'').replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g,'').replace('</head>',`<link rel="stylesheet" href="${css}"><script defer src="${js}"></script></head>`);await writeFile(path.join(base,'public',page+'.html'),content);}
await writeFile(path.join(base,'public/_headers'),`/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/media/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`);
console.log('Cloud build complete: hashed scripts, lazy CDN media; original local tool preserved.');
