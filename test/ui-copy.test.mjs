import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import {parseFragment} from 'parse5';import {rewriteCopy,cleanAnalysisUi,cleanAnalysisRuntime} from '../scripts/ui-copy.mjs';
const descendants=node=>[node,...(node.childNodes||[]).flatMap(descendants)];
const attr=(node,name)=>node.attrs?.find(a=>a.name===name)?.value;
const signature=html=>descendants(parseFragment(html)).filter(n=>attr(n,'id')||['button','input','select','textarea'].includes(n.tagName)).map(n=>[n.tagName,n.attrs?.filter(a=>!(a.name==='hidden'&&['queryStats','mapCacheStats','statisticsNote','zoomHint'].includes(attr(n,'id'))))]);

test('analysis cleanup retains every original DOM hook and control while removing static prose',async()=>{
 const original=await readFile(new URL('../source/index.html',import.meta.url),'utf8'),cleaned=cleanAnalysisUi(original);
 assert.deepEqual(signature(cleaned),signature(original),'IDs, controls, values, labels and status attributes must survive');
 assert.ok(!cleaned.includes('读图提示'));assert.ok(!cleaned.includes('定位表现评级说明'));
 assert.ok(!cleaned.includes('算法与数据说明'));assert.ok(!cleaned.includes('查询时自动合并已有对局'));
 for(const label of ['Counterwatch 公开指标与打法标签','OverBuddy 最后一击基准状态','暴雪匹配说明','Overstats 快速强度引擎'])assert.ok(cleaned.includes(label),label);
});

test('analysis cleanup preserves actionable errors and live status hooks',()=>{
 const html='<main><p class="hint">静态说明</p><p id="status" class="hint" role="status" aria-live="polite">查询失败</p><p class="hint" role="alert">重新登录</p><span id="gameDataStatus" role="status" aria-live="polite">游戏数据来自对局详情</span><button id="retryGameData" hidden>重试</button><details id="cacheRecordsPanel" class="method" hidden><summary>缓存</summary><div id="cacheRecordsBody"></div></details><footer></footer></main>';
 const cleaned=cleanAnalysisUi(html);
 assert.ok(!cleaned.includes('静态说明'));assert.ok(cleaned.includes('查询失败'));assert.ok(cleaned.includes('重新登录'));
 assert.deepEqual(signature(cleaned),signature(html));
 assert.match(cleaned,/<span id="gameDataStatus" role="status" aria-live="polite"><\/span>/);
 assert.ok(cleaned.includes('id="cacheRecordsBody"'));
});

test('analysis runtime adapters fail on missing or duplicate template matches',async()=>{
 const source=await readFile(new URL('../source/app.js',import.meta.url),'utf8');
 const transformed=cleanAnalysisRuntime(source);new vm.Script(transformed);
 const gameLine=source.split('\n').find(line=>line.includes("$('gameDataStatus').textContent=m?.hasGameData"));
 assert.ok(gameLine);assert.throws(()=>cleanAnalysisRuntime(source.replace(gameLine,'')),/gameDataStatus/);
 assert.throws(()=>cleanAnalysisRuntime(source+'\n'+gameLine),/gameDataStatus/);
 const marker=' const value=v=>v===null||v===undefined?';
 assert.throws(()=>cleanAnalysisRuntime(source.replace(marker,' const changed=v=>')),/estimate prose/);
 assert.throws(()=>cleanAnalysisRuntime(source+'\n'+marker),/estimate prose/);
});

test('runtime cleanup preserves evidence small labels and compact dynamic limitations',async()=>{
 const source=await readFile(new URL('../source/app.js',import.meta.url),'utf8'),gameLine=source.split('\n').find(line=>line.includes("$('gameDataStatus').textContent=m?.hasGameData"));
 const render=cleanAnalysisRuntime('function render(m,estimate,aux){'+gameLine+'\n const value=v=>v===null||v===undefined?"—":v;}');
 for(const [estimate,aux,expected]of [[{unanchored:false},{},''],[{unanchored:true},{},'无段位参考'],[{unanchored:false},{reason:'缺少双方表现数据'},'缺少双方表现数据']]){
  const paragraphs=Array.from({length:3},()=>({textContent:'旧说明',removed:false,remove(){this.removed=true;}})),evidence=[{textContent:'4 名独立参考'},{textContent:'证据评分 60% · 非实测段位'}],status={textContent:''};
  const block={querySelectorAll(selector){assert.equal(selector,'p','never delete evidence small labels');return paragraphs;}};
  const context={$:id=>id==='estimateDetail'?block:status};vm.runInNewContext(render,context);
  context.render({hasGameData:true,resourceDataChecked:true},estimate,aux);
  assert.equal(paragraphs[0].textContent,expected);assert.equal(paragraphs[0].removed,!expected);assert.ok(paragraphs.slice(1).every(p=>p.removed));
  assert.deepEqual(evidence.map(n=>n.textContent),['4 名独立参考','证据评分 60% · 非实测段位']);assert.equal(status.textContent,'');
  context.render({hasGameData:false},estimate,aux);assert.equal(status.textContent,'本场数据不完整');
 }
});
test('cloud pages use fox branding and plain labels while routes, controls and values remain intact',async()=>{
 for(const page of ['index.html','tools/strength.html','tools/draw.html','tools/events.html','login.html','admin.html']){
  const html=await readFile(new URL('../public/'+page,import.meta.url),'utf8');assert.match(html,/<title>[^<]*狸狸天眼查/);assert.ok(!html.includes('守望工具箱'));assert.match(html,/rel="icon"/);
 }
 const draw=await readFile(new URL('../public/tools/draw.html',import.meta.url),'utf8');for(const mode of ['wheel','card','slot'])assert.ok(draw.includes('data-mode="'+mode+'"'));assert.ok(draw.includes('>翻牌'));assert.ok(draw.includes('>转盘'));assert.ok(draw.includes('>抽个英雄'));
 const strength=await readFile(new URL('../public/tools/strength.html',import.meta.url),'utf8');for(const id of ['query','limit','pool','statisticsRange','svg','json','png','aiReviewGenerate'])assert.ok(strength.includes('id="'+id+'"'));assert.ok(strength.includes('>保存图表'));assert.ok(strength.includes('>保存数据'));assert.ok(strength.includes('>保存图片'));
 assert.equal(rewriteCopy("const mode='wheel';const r='重装';const action='approved';"),"const mode='wheel';const r='重装';const action='approved';");
});
test('tool-page logos and back links return to the root homepage',async()=>{
 for(const page of ['strength','draw','events']){
  const html=await readFile(new URL('../public/tools/'+page+'.html',import.meta.url),'utf8');
  const logo=html.match(/<a\b[^>]*class="(?:brand|toolkit-brand)"[^>]*>/)?.[0];
  const back=html.match(/<a\b[^>]*class="(?:analysis-back-link|back-link)"[^>]*>/)?.[0];
  assert.match(logo,/href="\/"/);assert.match(back,/href="\/"/);
  assert.ok(!html.includes('href="./index.html"'));
 }
});
