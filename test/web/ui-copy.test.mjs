import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rewriteCopy, cleanDecorativeEnglish } from '../../scripts/build/ui-copy.mjs';

test('copy rewrite changes labels without touching IDs, API fields or game values', () => {
  assert.equal(rewriteCopy('查询最新对局 ↗'), '查询战绩');
  assert.equal(rewriteCopy('更新日志'), '更新说明');
  assert.equal(
    rewriteCopy("const mode='wheel';const r='重装';const action='approved';"),
    "const mode='wheel';const r='重装';const action='approved';"
  );
  assert.equal(
    rewriteCopy('id="query" data-value="快速强度图"'),
    'id="query" data-value="对局分析"'
  );
});

test('decorative English cleanup keeps controls and adds accessible titles', () => {
  const html = cleanDecorativeEnglish(
    '<header><small>OVERWATCH TOOLBOX</small></header><p class="eyebrow">DATA</p><button id="svg">SVG</button>'
  );
  assert.ok(!html.includes('OVERWATCH TOOLBOX'));
  assert.ok(!html.includes('eyebrow'));
  assert.match(html, /<button id="svg" title="可编辑，放大也清晰">SVG<\/button>/);
});

test('cloud pages use fox branding and plain labels while routes, controls and values remain intact', async () => {
  for (const page of [
    'index.html',
    'tools/strength.html',
    'tools/draw.html',
    'tools/events.html',
    'login.html',
    'admin.html'
  ]) {
    const html = await readFile(new URL('../../public/' + page, import.meta.url), 'utf8');
    assert.match(html, /<title>[^<]*狸狸天眼查/);
    assert.ok(!html.includes('守望工具箱'));
    assert.match(html, /rel="icon"/);
  }
  const draw = await readFile(new URL('../../public/tools/draw.html', import.meta.url), 'utf8');
  for (const mode of ['wheel', 'card', 'slot'])
    assert.ok(draw.includes('data-mode="' + mode + '"'));
  assert.ok(draw.includes('>翻牌'));
  assert.ok(draw.includes('>转盘'));
  assert.ok(draw.includes('>抽个英雄'));
  const strength = await readFile(
    new URL('../../public/tools/strength.html', import.meta.url),
    'utf8'
  );
  for (const id of [
    'query',
    'limit',
    'pool',
    'statisticsRange',
    'svg',
    'json',
    'png',
    'aiReviewGenerate'
  ])
    assert.ok(strength.includes('id="' + id + '"'));
  assert.ok(strength.includes('>保存图表'));
  assert.ok(strength.includes('>保存数据'));
  assert.ok(strength.includes('>保存图片'));
});

test('tool-page logos and back links return to the root homepage', async () => {
  for (const page of ['strength', 'draw', 'events']) {
    const html = await readFile(
      new URL('../../public/tools/' + page + '.html', import.meta.url),
      'utf8'
    );
    const logo = html.match(/<a\b[^>]*class="(?:brand|toolkit-brand)"[^>]*>/)?.[0];
    const back = html.match(/<a\b[^>]*class="(?:analysis-back-link|back-link)"[^>]*>/)?.[0];
    assert.match(logo, /href="\/"/);
    assert.match(back, /href="\/"/);
    assert.ok(!html.includes('href="../index.html"'));
  }
});
