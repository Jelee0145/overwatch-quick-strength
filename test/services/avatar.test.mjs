import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisService, dataService } from '../../backend/src/services/runtime.mjs';
import { avatarUrl } from '../../backend/src/services/data.mjs';
import { createChartService } from '../../backend/src/services/chart.mjs';
import { maps } from '../../backend/src/shared/data.mjs';
import { analysisFixture, archiveFixture } from '../services-fixture.mjs';

const portrait = 'https://ld5picproxy.ds.163.com/overwatch/' + 'a'.repeat(32) + '.png';

test('player portraits only come from the provider image CDN', () => {
  assert.equal(avatarUrl(portrait), portrait);
  assert.equal(globalThis.QS.avatarUrl(portrait), portrait);
  for (const bad of [
    'http://ld5picproxy.ds.163.com/overwatch/a.png',
    'https://ld5picproxy.ds.163.com.evil.test/a.png',
    'https://ld5picproxy.ds.163.com/../a.png',
    'javascript:alert(1)',
    42
  ]) {
    assert.equal(avatarUrl(bad), '');
    assert.equal(globalThis.QS.avatarUrl(bad), '');
  }
  assert.equal(dataService.normalize({ ...analysisFixture(), avatar: portrait }).avatar, portrait);
  assert.equal('avatar' in dataService.normalize({ ...analysisFixture(), avatar: 'x' }), false);
});

test('history keeps the newest known portrait even when the latest batch has none', () => {
  const archive = archiveFixture();
  archive.batches.a.content.data.avatar = portrait;
  assert.equal(analysisService.analyzeHistory(archive).raw.avatar, portrait);
});

test('Bot chart SVG embeds the portrait and never links out', async () => {
  const { renderApiChart } = await import('../../backend/src/api/chart.mjs'),
    original = globalThis.fetch,
    assets = { fetch: async () => new Response('', { status: 404 }) };
  globalThis.fetch = async (url) =>
    url === portrait
      ? new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' }
        })
      : new Response('', { status: 404 });
  try {
    const { svg } = await renderApiChart({ ...analysisFixture(), avatar: portrait }, {}, assets);
    assert.match(svg, /<image href="data:image\/png;base64,iVBORw=="/);
    assert.doesNotMatch(svg, /href="https?:/);
    globalThis.fetch = async () => {
      throw Error('offline');
    };
    const fallback = await renderApiChart({ ...analysisFixture(), avatar: portrait }, {}, assets);
    assert.doesNotMatch(fallback.svg, /href="https?:/);
  } finally {
    globalThis.fetch = original;
  }
});

test('chart prefers the player portrait over the bundled default', () => {
  const raw = analysisFixture(),
    model = analysisService.summarize(raw, analysisService.analyzeBatch(raw).matches.slice(-10)),
    chart = createChartService({ core: globalThis.QS, maps, avatar: 'data:image/webp;base64,AA' });
  assert.match(chart.render(model), /href="data:image\/webp;base64,AA"/);
  const own = chart.render({ ...model, avatar: '/api/v1/media/avatar?src=x' });
  assert.match(own, /href="\/api\/v1\/media\/avatar\?src=x" data-player-avatar="1"/);
  assert.doesNotMatch(own, /base64,AA/);
});
