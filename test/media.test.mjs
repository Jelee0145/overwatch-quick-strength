import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir,stat} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
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
 const html=await read('public/index.html');assert.ok(!html.includes('art.js'));const script=html.match(/<script defer src="([^"]+)"/)[1],css=html.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
 const code=await read('public'+script);assert.ok(!code.includes('/api/map-art'));assert.ok(!code.includes('data:image/'));assert.ok(!code.includes('credentialPayload'));
 const bytes=(await stat(path.join(base,'public',script))).size+(await stat(path.join(base,'public',css))).size+Buffer.byteLength(html);assert.ok(bytes<300000,`${bytes} exceeds the startup budget`);
 assert.deepEqual((await readdir(path.join(base,'public'))).filter(f=>f.endsWith('.js')),[]);
});
