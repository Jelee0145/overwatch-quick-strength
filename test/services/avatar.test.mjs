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

test('chart prefers the player portrait over the bundled default', () => {
  const raw = analysisFixture(),
    model = analysisService.summarize(raw, analysisService.analyzeBatch(raw).matches.slice(-10)),
    chart = createChartService({ core: globalThis.QS, maps, avatar: 'data:image/webp;base64,AA' });
  assert.match(chart.render(model), /href="data:image\/webp;base64,AA"/);
  const own = chart.render({ ...model, avatar: '/api/v1/media/avatar?src=x' });
  assert.match(own, /href="\/api\/v1\/media\/avatar\?src=x" data-player-avatar="1"/);
  assert.doesNotMatch(own, /base64,AA/);
});
