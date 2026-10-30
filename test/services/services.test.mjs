import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
  createMatchService,
  createDataService,
  ServiceError
} from '../../backend/src/services/index.mjs';
import { analysisService, dataService } from '../../backend/src/services/runtime.mjs';
import { analyzeResult } from '../../backend/src/api/analysis.mjs';
import { prepareReview, MODEL } from '../../backend/src/adapters/review.mjs';
import { prompt, version } from '../../backend/src/prompt.mjs';
import { digest, canonical } from '../../backend/src/security.mjs';
import { service } from '../query-fixture.mjs';
import { analysisFixture, archiveFixture } from '../services-fixture.mjs';

const baseline = JSON.parse(
  await readFile(new URL('../services-baseline.json', import.meta.url), 'utf8')
);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

test('shared analysis preserves pre-refactor Bot output and AI payload/fingerprint without changing raw input', async () => {
  const raw = freeze(analysisFixture()),
    before = hash(raw);
  for (const item of baseline.cases)
    assert.equal(hash(analyzeResult(raw, item.options)), item.hash, JSON.stringify(item.options));
  assert.equal(hash(analyzeResult({ matches: [] })), baseline.empty);
  const review = await prepareReview(raw, 'fixture-4');
  assert.equal(hash(review.payload), baseline.reviewPayload);
  assert.equal(
    review.fingerprint,
    await digest(
      canonical({
        account: raw.battletag,
        mid: 'fixture-4',
        payload: review.payload,
        model: MODEL,
        prompt,
        version,
        reasoningEffort: 'low'
      })
    )
  );
  assert.equal(hash(raw), before);
  const result = analysisService.analyzeBatch(raw);
  result.matches[0].players[0].stats.kill = 0;
  assert.equal(hash(raw), before);
  assert.throws(
    () => analysisService.analyzeBatch({ ...raw, matches: Array(51).fill(raw.matches[0]) }),
    /最多 50 场/
  );
});

test('review baseline accepts both LF and CRLF checkouts while fingerprints bind the exact runtime prompt', async () => {
  const raw = analysisFixture(),
    lf = prompt.replaceAll('\r\n', '\n'),
    fingerprints = [];
  for (const runtimePrompt of [lf, lf.replaceAll('\n', '\r\n')]) {
    const compiled = await build({
      entryPoints: [
        new URL('../../backend/src/adapters/review.mjs', import.meta.url).pathname.replace(
          /^\/([A-Z]:)/,
          '$1'
        )
      ],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
      plugins: [
        {
          name: 'checkout-line-endings',
          setup(b) {
            b.onLoad({ filter: /[\\/]src[\\/]prompt\.mjs$/ }, () => ({
              contents: `export const prompt=${JSON.stringify(runtimePrompt)};export const version=${JSON.stringify(version)};`,
              loader: 'js'
            }));
          }
        }
      ]
    });
    const runtime = await import(
      'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
    );
    const review = await runtime.prepareReview(raw, 'fixture-4');
    assert.equal(hash(review.payload), baseline.reviewPayload);
    assert.equal(
      review.fingerprint,
      await digest(
        canonical({
          account: raw.battletag,
          mid: 'fixture-4',
          payload: review.payload,
          model: MODEL,
          prompt: runtimePrompt,
          version,
          reasoningEffort: 'low'
        })
      )
    );
    fingerprints.push(review.fingerprint);
  }
  assert.notEqual(fingerprints[0], fingerprints[1]);
});

test('quick-play pools split 5v5 and 6v6; substitutes follow the mode roster size', () => {
  const raw = analysisFixture();
  // Ten players per match means LeisurePreset (5v5), never a substitute.
  const five = analysisService.analyzeBatch({
    ...raw,
    matches: raw.matches.map((m) => ({ ...m, gameMode: 'LeisurePreset' }))
  });
  assert.equal(five.matches[0].gameModeLabel, '快速 5v5');
  assert.equal(five.matches[0].hasSubstitutes, false);
  // A sixth player is normal in Leisure6v6 but a substitute in LeisurePreset.
  const six = (m) => ({
    ...m,
    mid: m.mid + '-66',
    gameMode: 'Leisure6v6',
    players: [...m.players, { ...m.players[0], name: 'Sub#100', side: 'T' }]
  });
  const sixes = analysisService.analyzeBatch({ ...raw, matches: raw.matches.map(six) });
  assert.equal(sixes.matches[0].gameModeLabel, '快速 6v6');
  assert.equal(sixes.matches[0].hasSubstitutes, false);
  const mixed = [
    ...raw.matches.map((m) => ({ ...m, gameMode: 'LeisurePreset' })),
    ...raw.matches.map(six)
  ];
  assert.equal(
    analysisService.analyzeBatch({ ...raw, matches: mixed }, { pool: '55' }).matches.length,
    12
  );
  assert.equal(
    analysisService.analyzeBatch({ ...raw, matches: mixed }, { pool: '66' }).matches.length,
    12
  );
  assert.equal(analysisService.analyzeBatch({ ...raw, matches: mixed }, {}).matches.length, 24);
  // Legacy records without a mode cannot be proven to belong to the chosen pool.
  const legacy = { ...raw, matches: raw.matches.map((m) => ({ ...m, gameMode: '' })) };
  assert.equal(analysisService.analyzeBatch(legacy, { pool: '55' }).matches.length, 0);
  assert.equal(analysisService.analyzeBatch(legacy, { pool: '66' }).matches.length, 0);
  assert.equal(analysisService.analyzeBatch(legacy, {}).matches.length, 12);
  const seven = analysisService.analyzeBatch({
    ...raw,
    matches: raw.matches.map((m) => ({
      ...six(m),
      players: [...six(m).players, { ...m.players[0], name: 'Extra#100', side: 'T' }]
    }))
  });
  assert.equal(seven.matches[0].hasSubstitutes, true);
  assert.match(seven.personalPrediction.excluded[0].reason, /快速 6v6 场上人数超出赛制上限/);
});

test('history analysis preserves original per-batch evidence and frozen personal predictions', () => {
  const archive = freeze(archiveFixture()),
    history = analysisService.analyzeHistory(archive);
  assert.equal(hash(history), baseline.history);
  const summary = analysisService.summarize(
    history.raw,
    history.matches,
    {},
    { records: history.personalRecords, excluded: history.personalExcluded }
  );
  assert.equal(hash(canonical(summary)), baseline.historySummary);
  const before = hash(history),
    altered = structuredClone(history.raw);
  altered.matches.forEach((m) => m.players.forEach((p) => (p.res.rows = [])));
  const frozen = freeze({ records: history.personalRecords, excluded: history.personalExcluded });
  const preserved = analysisService.summarize(altered, freeze(history.matches), {}, frozen);
  for (const role of preserved.personalPrediction.byRole)
    for (const record of role.records)
      assert.deepEqual(record.context, frozen.records.find((r) => r.mid === record.mid).context);
  assert.equal(hash(history), before);
});

test('500-match history remains batch-based and never enters the 50-match normalizer as a whole', () => {
  const raw = analysisFixture(),
    batches = {},
    matches = [];
  for (let i = 0; i < 50; i++) {
    const data = {
      ...raw,
      matches: raw.matches.slice(0, 10).map((m, j) => ({ ...m, mid: `${i}-${j}`, t: i * 10 + j }))
    };
    batches['b' + i] = { content: { data } };
    matches.push(...data.matches.map((m) => ({ mid: m.mid, batchId: 'b' + i })));
  }
  const history = analysisService.analyzeHistory({ tag: raw.battletag, batches, matches });
  assert.equal(history.matches.length, 500);
  assert.equal(
    analysisService.summarize(
      history.raw,
      history.matches,
      {},
      { records: history.personalRecords, excluded: history.personalExcluded }
    ).matches.length,
    500
  );
});

test('data transforms handle unknown ranks, missing metrics, perspective and stable history winners without mutation', () => {
  const data = createDataService();
  assert.deepEqual(data.rankRows({}), []);
  assert.throws(
    () => data.rankRows({ unexpected: [] }),
    (e) => e instanceof ServiceError && e.status === 502
  );
  const player = data.player(
    {
      name: ' Example#100 ',
      heroGuid: 'hero',
      customerToken: 'must-stay-private',
      kill: -1,
      death: '4',
      soloKills: 2,
      cure: true
    },
    'T'
  );
  assert.equal(player.name, 'Example#100');
  assert.equal(player.stats.kill, null);
  assert.equal(player.stats.death, 4);
  assert.equal(player.stats.soloKill, 2);
  assert.equal(player.stats.cure, null);
  assert.ok(!JSON.stringify(player).includes('must-stay-private'));
  const game = analysisFixture().matches[0],
    record = freeze({ owner: 'Fixture#100', game }),
    before = hash(record);
  const opponent = game.players.find((p) => p.side === 'E').name,
    projected = data.projectBattle(record, opponent, { mid: game.mid, ret: -1 });
  assert.equal(projected.teamScore, game.opponentScore);
  assert.equal(projected.opponentScore, game.teamScore);
  assert.equal(projected.ret, -1);
  assert.equal(projected.players.find((p) => p.name === opponent).side, 'T');
  assert.equal(hash(record), before);
  assert.equal(data.projectBattle(record, 'Missing#100', {}), null);
  const raw = analysisFixture(),
    a = { content: { data: raw } },
    b = { content: { data: { ...raw, matches: raw.matches.map((m) => ({ ...m, ret: 0 })) } } };
  assert.deepEqual(data.indexHistory({ a, z: b }), data.indexHistory({ z: b, a }));
  assert.ok(data.indexHistory({ a, z: b }).every((m) => m.batchId === 'z'));
  const merged = data.mergeMatches([raw.matches[0]], [{ ...raw.matches[0], ret: 0 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].ret, 0);
  assert.equal(raw.matches[0].ret, -1);
});

test('acquisition is injectable, checkpoints survive JSON transport and original prior/cache inputs stay unchanged', async () => {
  const clock = Date.parse('2026-10-17T00:00:00Z'),
    mock = service();
  let tick = clock;
  const matches = createMatchService({
    provider: mock.call,
    pick: analysisService.pick,
    playerIdentity: async () => undefined,
    digest,
    canonical,
    createId: () => 'synthetic-id',
    now: () => tick,
    sleep: async (ms) => {
      tick += ms;
    }
  });
  const prior = freeze({ matches: [] }),
    state = matches.createQuery('Main#100', 5, prior, [], { supplementOtherMatches: false });
  await matches.queryStep(state, {});
  await matches.queryStep(state, {});
  const saved = json(matches.queryCheckpoint(state)),
    restored = matches.restoreQuery(saved, prior);
  for (let n = 0; restored.phase !== 'done' && n < 100; n++)
    await matches.runQuery(restored, {}, { budgetMs: 8000, minIntervalMs: 0 });
  assert.equal(restored.phase, 'done');
  assert.equal(restored.result.matches.length, 5);
  assert.equal(restored.now, new Date(clock).toISOString());
  assert.deepEqual(prior, { matches: [] });
  assert.ok(!JSON.stringify(restored.result).includes('-private'));
  assert.ok(!JSON.stringify(saved).includes('function'));
  const snapshot = freeze(restored.result),
    snapshotHash = hash(snapshot),
    warm = matches.createQuery('Main#100', 5, snapshot);
  for (let n = 0; warm.phase !== 'done' && n < 100; n++)
    await matches.runQuery(warm, {}, { minIntervalMs: 0 });
  assert.equal(hash(snapshot), snapshotHash);
});

test('browser service bundle preserves display normalization without importing scoring or chart services', async () => {
  const compiled = await build({
    entryPoints: [
      new URL('../../frontend/web/services.js', import.meta.url).pathname.replace(
        /^\/([A-Z]:)/,
        '$1'
      )
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    metafile: true
  });
  const context = vm.createContext({ structuredClone });
  context.window = context;
  vm.runInContext(
    await readFile(new URL('../../source/core.js', import.meta.url), 'utf8'),
    context
  );
  vm.runInContext(compiled.outputFiles[0].text, context);
  const browser = context.OWQS_SERVICES,
    raw = analysisFixture();
  assert.equal(browser.analysis, undefined);
  assert.deepEqual(json(browser.data.normalize(raw)), json(dataService.normalize(raw)));
  assert.ok(
    !Object.keys(compiled.metafile.inputs).some((name) =>
      /[\\/]services[\\/](analysis|chart)\.mjs$/.test(name)
    )
  );
  for (const name of ['app/timeline.js', 'server-analysis.js']) {
    const source = await readFile(new URL('../../frontend/web/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.analyzeBatch\s*\(|\.analyzeHistory\s*\(|\.summarize\s*\(/);
  }
});
