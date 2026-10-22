import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Bot captures use the final website DOM, stylesheet and player renderer',async()=>{
 const bundle=JSON.parse(await readFile('plugins/astrbot_plugin_owqs_api/website.json','utf8'));
 const page=await readFile('public/tools/strength.html','utf8');
 const css=page.match(/<link rel="stylesheet" href="([^"]+)"/)[1];
 assert.equal(bundle.css,await readFile('public'+css,'utf8'));
 assert.ok(page.includes(bundle.data));assert.ok(page.includes(bundle.review));
 assert.equal((bundle.data.match(/<th[ >]/g)||[]).length,13);
 assert.ok(bundle.script.includes('function showPlayers('));
 assert.ok(bundle.script.includes('function performanceCell('));
 assert.ok(bundle.script.includes('对局记录缺少部分游戏数据；不会自动补查'));
 assert.ok(bundle.script.includes("$('aiReviewText').textContent=INPUT.review"));
 assert.ok(!bundle.script.includes('loadGameData(m)'));
});
