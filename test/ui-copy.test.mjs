import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {rewriteCopy} from '../scripts/ui-copy.mjs';
test('cloud pages use fox branding and plain labels while routes, controls and values remain intact',async()=>{
 for(const page of ['index.html','tools/strength.html','tools/draw.html','login.html','admin.html']){
  const html=await readFile(new URL('../public/'+page,import.meta.url),'utf8');assert.match(html,/<title>[^<]*狸狸天眼查/);assert.ok(!html.includes('守望工具箱'));assert.match(html,/rel="icon"/);
 }
 const draw=await readFile(new URL('../public/tools/draw.html',import.meta.url),'utf8');for(const mode of ['wheel','card','slot'])assert.ok(draw.includes('data-mode="'+mode+'"'));assert.ok(draw.includes('>翻牌'));assert.ok(draw.includes('>转盘'));assert.ok(draw.includes('>抽个英雄'));
 const strength=await readFile(new URL('../public/tools/strength.html',import.meta.url),'utf8');for(const id of ['query','limit','statisticsRange','svg','json','png','aiReviewGenerate'])assert.ok(strength.includes('id="'+id+'"'));assert.ok(strength.includes('>保存图表'));assert.ok(strength.includes('>保存数据'));assert.ok(strength.includes('>保存图片'));
 assert.equal(rewriteCopy("const mode='wheel';const r='重装';const action='approved';"),"const mode='wheel';const r='重装';const action='approved';");
});
