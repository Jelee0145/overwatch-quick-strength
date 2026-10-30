import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { analysisFixture, archiveFixture } from '../services-fixture.mjs';
import { analysisService, dataService } from '../../backend/src/services/runtime.mjs';
import {
  analyzeArchive,
  selectArchiveMatch,
  selectArchiveEnvelope,
  normalizeHistoryAnalysisOptions,
  createHistoryAnalysisService
} from '../../backend/src/history/analysis.mjs';
import { renderAnalysisChart, renderApiChart } from '../../backend/src/api/chart.mjs';
import { selectApiMatch, projectApiMatch } from '../../backend/src/api/match.mjs';
import { digest } from '../../backend/src/security.mjs';
import { normalizeQueryOptions } from '../../backend/src/query/options.mjs';
import { webAnalysisView } from '../../backend/src/history/view.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const assets = {
  async fetch() {
    return new Response('', { status: 404 });
  }
};
function largeArchive() {
  const fixture = analysisFixture(),
    batches = {};
  for (let batch = 0; batch < 50; batch++) {
    const data = {
      ...fixture,
      queriedAt: new Date(Date.UTC(2026, 9, 1) + batch * 86400000).toISOString(),
      matches: fixture.matches.slice(0, 10).map((match, index) => ({
        ...match,
        mid: `batch-${batch}-${index}`,
        t: batch * 10 + index,
        gameMode: batch % 2 ? 'Leisure6v6' : 'LeisurePreset'
      }))
    };
    batches['b' + batch] = {
      content: { scope: { battletag: fixture.battletag, server: 'fixture', dts: 'season' }, data },
      signature: 'synthetic'
    };
  }
  return {
    tag: fixture.battletag,
    batches,
    matches: [{ mid: 'untrusted-index', batchId: 'nonexistent' }]
  };
}

test('archive DTO preserves 500 analyzed matches and freezes per-batch personal evidence', async () => {
  const archive = largeArchive();
  archive.batches.b0.content.data.accessToken = 'synthetic-sensitive-marker';
  archive.batches.b0.content.data.matches[0].players[0].privateIdentity =
    'synthetic-sensitive-marker';
  const before = clone(archive),
    view = await createHistoryAnalysisService().analyzeArchive(archive);
  assert.ok(!JSON.stringify(view).includes('synthetic-sensitive-marker'));
  assert.ok(!JSON.stringify(view).includes('"signature"'));
  assert.equal(view.matches.length, 500);
  assert.equal(view.raw.matches.length, 500);
  assert.equal(view.total, 500);
  assert.deepEqual(view.window, { start: 490, end: 500 });
  assert.deepEqual(view.statistics, { start: 0, end: 500 });
  assert.equal(view.model.matches.length, 500);
  assert.equal(view.chartView.matches.length, 10);
  assert.equal(view.revision, await digest(Object.keys(archive.batches).sort().join(',')));
  const indexed = { ...archive, matches: dataService.indexHistory(archive.batches) },
    history = analysisService.analyzeHistory(indexed);
  assert.deepEqual(view.matches, history.matches);
  assert.deepEqual(view.personalRecords, history.personalRecords);
  assert.deepEqual(view.personalExcluded, history.personalExcluded);
  const expected = analysisService.summarize(history.raw, history.matches, view.options, {
    records: history.personalRecords,
    excluded: history.personalExcluded
  });
  assert.deepEqual(view.model.personalPrediction, expected.personalPrediction);
  assert.deepEqual(view.model.summary, expected.summary);
  assert.deepEqual(archive, before);
  const filtered = await analyzeArchive(archive, {
    pool: '55',
    side: 'E',
    strategy: 'role',
    estimate: false,
    statisticsRange: 20,
    start: 0
  });
  assert.equal(filtered.total, 250);
  assert.equal(filtered.chartView.matches.length, 10);
  assert.equal(filtered.model.matches.length, 10);
  assert.ok(filtered.matches.every((m) => m.players.every((p) => p.side === 'E')));
});

test('window statistics and chart reuse selected summary and shared axis without flattening or re-evaluation', async () => {
  const archive = archiveFixture();
  archive.batches.a.content.data.matches[2].players[0].score = 900;
  const view = await analyzeArchive(archive, { start: 2, statisticsRange: '5' });
  assert.deepEqual(view.window, { start: 2, end: 12 });
  assert.deepEqual(view.statistics, { start: 7, end: 12 });
  assert.equal(view.chartView.summary, view.model.summary);
  assert.equal(view.chartView.personalPrediction, view.model.personalPrediction);
  assert.equal(view.chartView.statsMatches, view.model.matches);
  assert.equal(view.chartView.plotScale, view.axis);
  assert.deepEqual((await analyzeArchive(archive, { start: -5 })).window, { start: 0, end: 10 });
  assert.deepEqual((await analyzeArchive(archive, { start: 1000 })).window, { start: 10, end: 20 });
  const empty = await analyzeArchive({ tag: archive.tag, batches: {} });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.window, { start: 0, end: 0 });
  assert.equal(await renderAnalysisChart(empty, assets), null);
  const source = await readFile(new URL('../../source/chart.js', import.meta.url), 'utf8'),
    context = vm.createContext({});
  vm.runInContext(source, context);
  const factory = context.OWQS_CREATE_CHART_SERVICE,
    chart = factory({ core: globalThis.QS }),
    svg = chart.render(view.chartView);
  assert.ok(svg.includes(view.model.summary.mean.toFixed(1)));
  assert.equal((svg.match(/class="match-hit"/g) || []).length, 10);
  const anchored = chart.render({
    ...view.chartView,
    summary: { ...view.model.summary, unanchored: 0 }
  });
  assert.match(anchored, /5 场 \/ /);
  // The explicit whole-archive axis is used even when a statistics/window selection is smaller.
  const scaled = chart.render({ ...view.chartView, plotScale: { min: 500, max: 5000 } });
  assert.match(scaled, />5000<\/text>/);
  const art = { map: 'data:image/webp;base64,AAAA' };
  const embedded = chart.render({ ...view.chartView, lazyArt: false }, { art, showArt: true });
  assert.match(embedded, /href="data:image\/webp;base64,AAAA"/);
  assert.doesNotMatch(embedded, /data-map-art/);
  const lazy = chart.render({ ...view.chartView, lazyArt: true }, { art, showArt: true });
  assert.match(lazy, /data-map-art="map"/);
  assert.doesNotMatch(lazy, /href="data:image\/webp/);
  const old = chart.render(view.model),
    withDefault = chart.render({ ...view.model, statsMatches: view.model.matches });
  assert.equal(old, withDefault);
  const distribution = (svg) =>
    svg.slice(svg.indexOf('<rect x="34" y="837"'), svg.indexOf('<rect x="34" y="957"'));
  assert.equal(distribution(svg), distribution(old));
  const visibleOnly = chart.render({ ...view.chartView, statsMatches: view.chartView.matches });
  assert.notEqual(distribution(svg), distribution(visibleOnly));
  const rendered = await renderAnalysisChart(view, assets);
  assert.equal(rendered.displayed, 10);
  assert.equal(rendered.statisticsRange, '5');
  assert.equal(rendered.revision, view.revision);
});

test('stable match references select exact source-batch detail and original review envelope', async () => {
  const archive = archiveFixture(),
    view = await analyzeArchive(archive),
    ref = view.matchRefs.find((r) => r.mid === 'fixture-9');
  const selected = await selectArchiveMatch(archive, ref),
    expected = analysisService.analyzeHistory({
      ...archive,
      matches: dataService.indexHistory(archive.batches)
    });
  assert.deepEqual(
    selected.match,
    expected.matches.find((m) => m.mid === ref.mid)
  );
  assert.deepEqual(selected.detail.ref, ref);
  assert.deepEqual(
    selected.detail.webView.match.confidenceEvidence,
    selected.match.confidenceEvidence
  );
  const review = await selectArchiveEnvelope(archive, ref);
  assert.equal(review.batchId, 'z');
  assert.equal(review.envelope, archive.batches.z);
  const latest = selectApiMatch(analysisFixture(), 1);
  assert.deepEqual(
    latest.detail,
    projectApiMatch(latest.raw, latest.match, {}, { index: 1, count: 10 })
  );
  for (const changed of [
    { ...ref, tag: 'Other#1' },
    { ...ref, scope: 'other' },
    { ...ref, revision: '0'.repeat(64) }
  ])
    await assert.rejects(selectArchiveMatch(archive, changed));
  await assert.rejects(selectArchiveMatch(archive, 'missing'), (e) => e.status === 404);
  const changed = structuredClone(archive);
  changed.batches.new = changed.batches.a;
  await assert.rejects(selectArchiveMatch(changed, ref), (e) => e.status === 409);
});

test('analysis validates options, revisions and archive identity before evaluating', async () => {
  const archive = archiveFixture();
  // Query's public adapter coerces supplied enums; archive analysis keeps strict enum input.
  assert.equal(
    normalizeQueryOptions({ battletag: archive.tag, side: ['all'], strategy: ['role'] }).strategy,
    'role'
  );
  assert.throws(() => normalizeHistoryAnalysisOptions({ side: ['all'] }));
  assert.throws(() => normalizeQueryOptions({ battletag: archive.tag, side: null }));
  assert.equal(normalizeHistoryAnalysisOptions({ side: null }).side, 'all');
  for (const options of [
    { start: 1.5 },
    { start: '5' },
    { start: Infinity },
    { statisticsRange: '500' },
    { pool: '44' },
    { side: 'opponent' },
    { strategy: 'any' },
    { estimate: 'false' },
    { revision: 'bad' },
    null
  ])
    assert.throws(() => normalizeHistoryAnalysisOptions(options));
  for (const revision of ['bad', '0'.repeat(64)])
    await assert.rejects(analyzeArchive({ ...archive, revision }));
  await assert.rejects(
    analyzeArchive(archive, { revision: '0'.repeat(64) }),
    (e) => e.status === 409
  );
  const bad = structuredClone(archive);
  bad.batches.z.content.data.battletag = 'Other#1';
  await assert.rejects(analyzeArchive(bad));
  const mixed = largeArchive();
  mixed.batches.b1.content.scope.dts = 'other';
  await assert.rejects(analyzeArchive(mixed));
});

test('legacy Bot chart retains ten displayed matches and fixed ten-match summary', async () => {
  const rendered = await renderApiChart(analysisFixture(), { statisticsRange: 'all' }, assets);
  assert.equal(rendered.displayed, 10);
  assert.equal(rendered.statisticsRange, '10');
  assert.equal((rendered.svg.match(/class="match-hit"/g) || []).length, 10);
  assert.match(rendered.svg, /10 场 \/ /);
});

test('slim web analysis ships one window of detail plus a light archive index', async () => {
  const view = await createHistoryAnalysisService().analyzeArchive(largeArchive());
  const full = JSON.stringify(view),
    slimView = webAnalysisView(view),
    slim = JSON.stringify(slimView);
  assert.equal(view.chartView.matches.length, 10);
  assert.equal(view.model.matches.length, 500);
  assert.ok(!slim.includes('"chartView"'));
  assert.equal(slimView.series.length, 500);
  assert.ok(slimView.series.every((row) => row.light === true && row.players.length === 0));
  assert.deepEqual(
    slimView.series.map((row) => row.mid),
    view.matches.map((row) => row.mid)
  );
  assert.equal(slimView.matches.length, 10, 'only the visible window ships detail');
  assert.equal(slimView.matches[0].light, undefined);
  assert.equal(slimView.raw.matches.length, 10, 'the review lookup only needs the visible window');
  assert.equal(slimView.model.matches, undefined);
  assert.ok(
    Buffer.byteLength(slim) < Buffer.byteLength(full) * 0.12,
    `slim ${Buffer.byteLength(slim)} vs full ${Buffer.byteLength(full)}`
  );
  // A shorter range keeps the client able to slice exact statistics.
  const short = webAnalysisView(
    await createHistoryAnalysisService().analyzeArchive(largeArchive(), { statisticsRange: '5' })
  );
  assert.deepEqual(short.statistics, { start: 495, end: 500 });
  assert.equal(short.series.length, 500);
});
