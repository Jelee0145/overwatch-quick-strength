import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir,stat} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import vm from 'node:vm';
const base=path.resolve(import.meta.dirname,'..'),read=file=>readFile(path.join(base,file),'utf8');
test('CDN manifest covers every map ID; content-addressed media is real WebP',async()=>{
 const catalog=JSON.parse(await read('source/data/maps.json')),manifest=JSON.parse(await read('source/media/manifest.json')),coverage=JSON.parse(await read('source/media/coverage.json'));
 assert.equal(catalog.length,133);assert.deepEqual(Object.keys(manifest.maps).sort(),catalog.map(m=>m.guid).sort());
 assert.ok(coverage.maps.length>=131);assert.equal(coverage.maps.length+coverage.missing.length,133);
 const urls=[manifest.avatar,...Object.values(manifest.ranks),...Object.values(manifest.maps).flatMap(m=>[m.preview,m.export])].filter(Boolean);
 for(const url of new Set(urls)){assert.match(url,/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/);const buffer=await readFile(path.join(base,'public',url));assert.equal(buffer.subarray(0,4).toString(),'RIFF');assert.equal(buffer.subarray(8,12).toString(),'WEBP');assert.ok(url.includes(createHash('sha256').update(buffer).digest('hex').slice(0,20)));}
 const kings=catalog.filter(m=>m.name==='国王大道').map(m=>manifest.maps[m.guid].preview);assert.equal(new Set(kings).size,1);
});
test('optimized page has a small deferred bundle and no local map API',async()=>{
 const html=await read('public/tools/strength.html');assert.ok(!html.includes('art.js'));const script=html.match(/<script defer src="([^"]+)"/)[1],css=html.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
 const code=await read('public'+script);assert.ok(!code.includes('/api/map-art'));assert.ok(!/data:image\/[^;\s"']+;base64,[A-Za-z0-9+/=]{100,}/.test(code));assert.ok(!code.includes('credentialPayload'));
 const bytes=(await stat(path.join(base,'public',script))).size+(await stat(path.join(base,'public',css))).size+Buffer.byteLength(html);assert.ok(bytes<300000,`${bytes} exceeds the startup budget`);
 assert.deepEqual((await readdir(path.join(base,'public'))).filter(f=>f.endsWith('.js')),[]);
});
test('timeline preview clips only moving content, keeps axes outside moving layers and preserves ten-column geometry with one buffer',async()=>{
 const c=vm.createContext({});c.window=c;vm.runInContext(await read('source/core.js'),c);vm.runInContext(await read('source/data.js'),c);
 const build=await read('scripts/build.mjs'),start=build.indexOf("chart=chart.replace('if(showArt"),end=build.indexOf('const hash=',start);assert.ok(start>=0&&end>start);c.chart=await read('source/chart.js');vm.runInContext(build.slice(start,end),c);vm.runInContext(c.chart,c);
 const data=c.QS.normalize({battletag:'Geometry#100',queriedAt:'2026-10-14T00:00:00Z',source:'test',matches:Array.from({length:11},(_,i)=>({mid:'m'+i,t:i*600000,mapGuid:'map',players:[{name:'Geometry#100',side:'T',hero:'hero',score:2000+i*100,res:{rows:[]}}]}))}),model=c.QS.build(data,{limit:11,side:'all',strategy:'legacy',estimate:false},{hero:{name:'test',role:'dps'}});
 const preview=c.renderChart({...model,windowSize:10,plotScale:{min:1000,max:4000}}, {},false,'test');assert.match(preview,/<svg[^>]+width="1440"/);assert.match(preview,/data-plot-min="1000" data-plot-max="4000"/);assert.match(preview,/<clipPath id="timeline-window"><rect x="136" y="256" width="1232" height="554"\/>/);assert.equal((preview.match(/class="timeline-trajectory"/g)||[]).length,2);
 const stack=[];let axes=0;for(const token of preview.match(/<\/?g\b[^>]*>|<text\b[^>]*>[\s\S]*?<\/text>/g)||[]){if(token.startsWith('</g'))stack.pop();else if(token.startsWith('<g')){if(token.includes('timeline-trajectory'))assert.ok(stack.at(-1)?.includes('clip-path="url(#timeline-window)"'));stack.push(token);}else if(token.startsWith('<text x="118"')){axes++;assert.ok(!stack.some(g=>g.includes('timeline-trajectory')));}}
 assert.equal(stack.length,0);assert.ok(axes>=5);assert.equal((preview.match(/class="match-hit"/g)||[]).length,11);
 const settled=c.renderChart({...model,matches:model.matches.slice(0,10)}, {},false,'test');assert.equal((settled.match(/class="match-hit"/g)||[]).length,10);
});
