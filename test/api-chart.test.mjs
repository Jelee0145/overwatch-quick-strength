import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {renderApiChart} from '../src/api-chart.mjs';
import {analysisFixture} from './services-fixture.mjs';
import {staticAssets} from '../server/assets.mjs';
import media from '../source/media/manifest.json' with {type:'json'};
test('API charts embed only versioned public assets, retain latest-ten scoring and escape player text',async()=>{
 const raw=analysisFixture(),id=Object.keys(media.maps).find(k=>media.maps[k].export);
 raw.battletag='<script>alert(1)</script>#123';for(const m of raw.matches)m.mapGuid=id;
 const assets=staticAssets(path.resolve('public')),paths=[];
 const chart=await renderApiChart(raw,{}, {fetch:request=>{paths.push(new URL(request.url).pathname);assert.equal(request.headers.get('Authorization'),null);return assets.fetch(request);}});
 assert.ok(chart.svg.includes('data:image/webp;base64,'));assert.equal(chart.missingAssets,0);assert.ok(!chart.svg.includes('<script>'));assert.ok(!/href="https?:/.test(chart.svg));
 assert.equal(chart.displayed,Math.min(10,raw.matches.length));assert.equal(chart.width,1440);assert.ok(paths.every(url=>/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/.test(url)));
 assert.equal(await renderApiChart({...raw,matches:[]},{},assets),null);
});
