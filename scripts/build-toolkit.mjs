import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export async function buildToolkit({base,brandPage,logo,staticFile,releaseNotes,rewriteCopy,cleanDecorativeEnglish}){
 const manifest=JSON.parse(await readFile(path.join(base,'web/draw/heroes.json'),'utf8')),heroes=[];
 await mkdir(path.join(base,'public/media/heroes'),{recursive:true});
 for(const hero of manifest.heroes){
  const directory=path.resolve(base,'web/draw/portraits'),file=path.resolve(directory,hero.file);
  if(path.dirname(file)!==directory||!/^[a-z0-9-]+$/.test(hero.id)||!hero.transparent)throw Error('Invalid transparent hero portrait: '+hero.id);
  const bytes=await readFile(file),digest=createHash('sha256').update(bytes).digest('hex');
  if(digest!==hero.sha256||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Hero portrait verification failed: '+hero.id);
  const portrait='/media/heroes/'+hero.id+'.'+digest.slice(0,16)+'.png';
  await writeFile(path.join(base,'public',portrait.slice(1)),bytes);
  heroes.push({id:hero.id,name:hero.name,role:hero.role,portrait});
 }
 const css=await staticFile(await readFile(path.join(base,'web/cloud.css'),'utf8')+'\n'+await readFile(path.join(base,'web/toolkit.css'),'utf8')+'\n'+await readFile(path.join(base,'web/mobile-shell.css'),'utf8')+'\n'+await readFile(path.join(base,'web/event-reminders.css'),'utf8'),'css','toolkit');
 const common=['window.QS_RELEASE_NOTES='+JSON.stringify(releaseNotes)+';',await readFile(path.join(base,'web/cloud-cache.js'),'utf8'),await readFile(path.join(base,'web/toolkit-session.js'),'utf8'),await readFile(path.join(base,'web/api-key.js'),'utf8'),await readFile(path.join(base,'web/changelog.js'),'utf8')].join('\n');
 // Reminders stay out of the page bundles; the events page needs the engine before its own script.
 const reminderEngine=await staticFile(await readFile(path.join(base,'web/event-reminders.js'),'utf8'),'js','event-reminders');
 const reminderLoader=await staticFile((await readFile(path.join(base,'web/event-reminders-loader.js'),'utf8')).replace('__EVENT_REMINDERS_URL__',reminderEngine),'js','event-reminders-loader');
 const owMark='<svg class="ow-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true"><path d="M22 18A43 43 0 0 1 78 18" stroke="#f58220" stroke-width="10"/><path d="M15 25A43 43 0 1 0 85 25" stroke="currentColor" stroke-width="10"/><path d="M22 78L42 59V34L50 26L58 34V59L78 78L67 85L50 69L33 85Z" fill="currentColor"/></svg>';
 const fan=['genji','tracer','dva'].map(id=>'<img loading="lazy" src="'+heroes.find(h=>h.id===id).portrait+'" alt="">').join('');
 for(const page of ['toolkit','draw','events']){
  let html=brandPage(await readFile(path.join(base,'web',page+'.html'),'utf8')).replaceAll('{{SITE_MARK}}',logo).replaceAll('{{OW_MARK}}',owMark).replace('{{HERO_FAN}}',fan).replace('{{HERO_COUNT}}',String(heroes.length)).replace('{{CHANGELOG}}',await readFile(path.join(base,'web/changelog.html'),'utf8')+await readFile(path.join(base,'web/api-key.html'),'utf8'));
  html=html.replace('width=device-width,initial-scale=1','width=device-width,initial-scale=1,viewport-fit=cover');
  const code=page==='draw'?[common,'window.HERO_DRAW_DATA='+JSON.stringify({updatedAt:manifest.updatedAt,heroes})+';',await readFile(path.join(base,'web/draw-engine.js'),'utf8'),await readFile(path.join(base,'web/draw.js'),'utf8')].join('\n'):page==='events'?null:common;
  const eventsCSS=page!=='draw'?'<link rel="stylesheet" href="'+await staticFile(await readFile(path.join(base,'web/events.css'),'utf8'),'css','events')+'">':'';
  let scripts;
  if(page==='events'){
   // Deferred scripts run in order: session first (defines Cloud), then the reminder engine, then the page.
   const before=await staticFile(rewriteCopy(common),'js','events-session');
   const after=await staticFile(rewriteCopy([await readFile(path.join(base,'web/events-model.js'),'utf8'),await readFile(path.join(base,'web/events.js'),'utf8'),await readFile(path.join(base,'web/mobile-shell.js'),'utf8')].join('\n')),'js','events-page');
   scripts=`<script defer src="${before}"></script><script defer src="${reminderEngine}"></script><script defer src="${after}"></script>`;
  }else{
   const script=await staticFile(rewriteCopy(code+'\n'+await readFile(path.join(base,'web/mobile-shell.js'),'utf8')),'js',page);
   scripts=`<script defer src="${script}"></script><script defer src="${reminderLoader}"></script>`;
  }
  html=html.replace('</head>',`<link rel="stylesheet" href="${css}">${eventsCSS}${scripts}</head>`);
  await writeFile(path.join(base,page==='toolkit'?'public/index.html':'public/tools/'+page+'.html'),rewriteCopy(cleanDecorativeEnglish(html)));
 }
}
