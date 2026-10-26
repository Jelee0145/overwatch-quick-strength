import { createDataService } from '../../src/services/data.mjs';
import * as historyGeometry from '../../src/services/history-geometry.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { signSnapshot, verifySnapshot } from '../../src/security.mjs';
const source = await readFile(new URL('../../web/history-model.js', import.meta.url), 'utf8'),
  context = vm.createContext({ OWQS_SERVICES: { data: createDataService(), historyGeometry } });
vm.runInContext(source, context);
const H = context.QS_HISTORY_MODEL;
const scope = 'u|1|2026',
  tag = 'Main#100',
  game = (i) => ({
    mid: '900719925474099' + String(i).padStart(4, '0'),
    t: i * 1000,
    players: [],
    mapGuid: 'map',
    ret: 1
  }),
  envelope = (from, to, stamp = '2026-10-14T00:00:00Z') => ({
    content: {
      data: {
        battletag: tag,
        matches: Array.from({ length: to - from }, (_, j) => game(from + j)),
        queriedAt: stamp
      }
    },
    signature: 'test'
  });
test('history merges five new and five overlapping games without replacing old games; long string IDs remain distinct', () => {
  const first = H.merge(null, envelope(0, 10), 'a', scope),
    second = H.merge(first, envelope(5, 15, '2026-10-14T01:00:00Z'), 'b', scope);
  assert.equal(second.matches.length, 15);
  assert.equal(new Set(second.matches.map((m) => m.mid)).size, 15);
  assert.equal(second.matches[0].mid, game(0).mid);
  assert.equal(second.matches[5].batchId, 'b');
  assert.equal(second.matches[0].batchId, 'a');
  assert.equal(first.matches.length, 10);
  const older = H.merge(second, envelope(5, 15), 'c', scope);
  assert.equal(older.matches[5].batchId, 'b');
  assert.ok(!older.batches.c);
  assert.throws(() =>
    H.merge(second, { content: { data: { battletag: 'Other#100', matches: [] } } }, 'x', scope)
  );
  assert.throws(() => H.merge(second, envelope(0, 10), 'x', 'other|1|2026'));
});
test('history retains the newest 500 games and releases only unreferenced signed batches', () => {
  let a = null;
  for (let i = 0; i < 500; i += 20) a = H.merge(a, envelope(i, i + 20), String(i), scope);
  a = H.merge(a, envelope(500, 501, '2026-10-14T02:00:00Z'), 'last', scope);
  assert.equal(a.matches.length, 500);
  assert.equal(a.matches[0].mid, game(1).mid);
  assert.equal(a.matches.at(-1).mid, game(500).mid);
  assert.ok(a.batches['0']);
  a = H.merge(a, envelope(501, 521, '2026-10-14T03:00:00Z'), 'later', scope);
  assert.ok(!a.batches['0']);
  assert.equal(a.matches[0].mid, game(21).mid);
});
test('window clamps, single-match stepping and independent all/5/10/20 statistics boundaries', () => {
  for (const size of [5, 10, 20]) {
    const last = H.windowRange(500, size, 999);
    assert.equal(last.start, 500 - size);
    assert.equal(last.end, 500);
    assert.equal(H.windowRange(15, size, -99).start, 0);
  }
  assert.equal(H.statisticsRange(500, 15, 'all').end, 500);
  assert.equal(H.statisticsRange(500, 15, '5').start, 10);
  assert.equal(H.statisticsRange(500, 15, '20').start, 0);
  assert.equal(H.windowRange(15, 10, 4).end, 14);
});
test('motion buffer spans both edges, snap easing is monotonic and reduced-motion disables animation', () => {
  const range = H.bufferedRange(500, 10, 123.7);
  assert.equal(range.anchor, 123);
  assert.equal(range.start, 120);
  assert.equal(range.end, 136);
  assert.equal(range.size, 10);
  assert.equal(H.bufferedRange(30, 10, -8).start, 0);
  assert.equal(H.bufferedRange(30, 10, 999).end, 30);
  assert.equal(H.bufferedRange(5, 10, 2).size, 5);
  assert.equal(H.snapEase(0), 0);
  assert.equal(H.snapEase(1), 1);
  let previous = -1;
  for (let i = 0; i <= 50; i++) {
    const next = H.snapEase(i / 50);
    assert.ok(next >= previous && next <= 1);
    previous = next;
  }
  assert.equal(H.snapDuration(0.8, true), 0);
  assert.equal(H.snapDuration(0), 0);
  assert.ok(H.snapDuration(0.3) >= 110 && H.snapDuration(3) <= 180);
  const axis = H.axisRange([
    {
      scores: [1500, 3000],
      allRoleScores: [3400],
      mean: 2200,
      estimateRange: { min: 1800, max: 2700 }
    }
  ]);
  assert.equal(axis.min, 1000);
  assert.equal(axis.max, 4000);
});
test('old archive signatures remain usable for AI after newest snapshot changes; user/scope/tamper checks remain enforced', async () => {
  const env = { DASHEN_SERVER: '1', DASHEN_DTS: '2026', CACHE_SIGNING_KEY: 'history-test-secret' },
    a = await signSnapshot('u', envelope(0, 10).content.data, env),
    b = await signSnapshot('u', envelope(5, 15, '2026-10-14T01:00:00Z').content.data, env),
    archive = H.merge(H.merge(null, a, 'a', scope), b, 'b', scope),
    old = archive.batches[archive.matches[0].batchId];
  assert.equal((await verifySnapshot(old, 'u', env, tag)).matches[0].mid, game(0).mid);
  await assert.rejects(() => verifySnapshot(old, 'other', env, tag));
  await assert.rejects(() => verifySnapshot(old, 'u', { ...env, DASHEN_SERVER: '2' }, tag));
  const changed = structuredClone(old);
  changed.content.data.matches[0].ret = -1;
  await assert.rejects(() => verifySnapshot(changed, 'u', env, tag));
});
test('summary extraction preserves scores, confidence and personal prediction against original local algorithm for identical inputs', async () => {
  const files = [
      'core.js',
      'rating-rules.js',
      'resource-rating.js',
      'benchmarks.js',
      'performance.js'
    ],
    cloud = vm.createContext({}),
    local = vm.createContext({});
  for (const name of files) {
    vm.runInContext(
      await readFile(new URL('../../source/' + name, import.meta.url), 'utf8'),
      cloud
    );
    vm.runInContext(await readFile(new URL('../../local/' + name, import.meta.url), 'utf8'), local);
  }
  const heroes = JSON.parse(
      await readFile(new URL('../../source/data/heroes.json', import.meta.url), 'utf8')
    ),
    byId = Object.fromEntries(heroes.map((h) => [h.heroGuid, { ...h, role: h.roleType }])),
    hero = heroes[0].heroGuid;
  const raw = {
    battletag: tag,
    queriedAt: '2026-10-14T00:00:00Z',
    matches: Array.from({ length: 10 }, (_, i) => ({
      ...game(i),
      duration: 600,
      hasGameData: true,
      players: Array.from({ length: 10 }, (_, j) => ({
        name: j ? `P${j}#100` : tag,
        side: j < 5 ? 'T' : 'E',
        hero,
        stats: { kill: 20, assist: 5, death: 4, heroDamage: 10000, cure: 4000, resistDamage: 7000 },
        res: { rows: [{ r: byId[hero].role, s: 499 }], rankQueriedAt: '2026-10-14T00:00:00Z' }
      }))
    }))
  };
  const opts = { limit: 10, side: 'all', strategy: 'legacy', estimate: true },
    run = (c) =>
      c.QS.build(c.QS.normalize(raw), opts, byId, (p, m) =>
        c.QS_PERFORMANCE.evaluate(p, m, byId, c.QS_BENCHMARKS)
      ),
    a = run(cloud),
    b = run(local);
  for (const property of ['summary', 'personalPrediction', 'confidence', 'matches'])
    assert.equal(JSON.stringify(a[property]), JSON.stringify(b[property]), property);
  const aggregate = cloud.QS.summarize(cloud.QS.normalize(raw), a.matches, opts, byId, (p, m) =>
    cloud.QS_PERFORMANCE.evaluate(p, m, byId, cloud.QS_BENCHMARKS)
  );
  assert.equal(JSON.stringify(aggregate.summary), JSON.stringify(a.summary));
  assert.equal(JSON.stringify(aggregate.personalPrediction), JSON.stringify(a.personalPrediction));
  const frozen = {
      records: a.personalPrediction.byRole.flatMap((r) => r.records),
      excluded: a.personalPrediction.excluded
    },
    historical = cloud.QS.summarize(
      cloud.QS.normalize(raw),
      a.matches,
      opts,
      byId,
      undefined,
      undefined,
      frozen
    );
  assert.equal(JSON.stringify(historical.personalPrediction), JSON.stringify(a.personalPrediction));
  const altered = cloud.QS.normalize(raw);
  altered.matches.forEach((m) =>
    m.players.filter((p) => p.name !== tag).forEach((p) => (p.res.rows = []))
  );
  const preserved = cloud.QS.summarize(
    altered,
    a.matches,
    opts,
    byId,
    undefined,
    undefined,
    frozen
  );
  for (const r of preserved.personalPrediction.byRole)
    for (const record of r.records)
      assert.equal(
        JSON.stringify(record.context),
        JSON.stringify(frozen.records.find((p) => p.mid === record.mid).context)
      );
});
test('IndexedDB archive migration, restart, user/season isolation and quota failure retain prior history', async () => {
  const tables = { cache: new Map(), historyAccounts: new Map() };
  let failWrite = false;
  const db = {
    transaction(name) {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const r = {};
              queueMicrotask(() => {
                r.result = structuredClone(tables[name].get(key));
                r.onsuccess?.();
                tx.oncomplete?.();
              });
              return r;
            },
            getAll() {
              const r = {};
              queueMicrotask(() => {
                r.result = structuredClone([...tables[name].values()]);
                r.onsuccess?.();
              });
              return r;
            },
            openCursor(range) {
              const keys = [...tables[name].keys()].filter((key) => range.includes(key)),
                r = {};
              let i = 0;
              const next = () =>
                queueMicrotask(() => {
                  const key = keys[i++];
                  r.result =
                    key === undefined
                      ? null
                      : { key, value: structuredClone(tables[name].get(key)), continue: next };
                  r.onsuccess?.();
                });
              next();
              return r;
            },
            put(value, key) {
              const r = {};
              queueMicrotask(() => {
                if (failWrite) {
                  tx.onabort?.();
                  return;
                }
                tables[name].set(key, structuredClone(value));
                r.result = key;
                tx.oncomplete?.();
              });
              return r;
            }
          };
        }
      };
      return tx;
    }
  };
  const env = { DASHEN_SERVER: '1', DASHEN_DTS: '2026', CACHE_SIGNING_KEY: 'fixture-key' },
    old = await signSnapshot('u', envelope(0, 10).content.data, env);
  tables.cache.set('u|snapshot|1|2026|Main#100', old);
  const c = vm.createContext({
    window: {},
    IDBKeyRange: { bound: (lo, hi) => ({ includes: (key) => key >= lo && key <= hi }) },
    Cloud: {
      key: async (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    },
    QS_HISTORY_MODEL: H
  });
  vm.runInContext(
    await readFile(new URL('../../web/cloud-history.js', import.meta.url), 'utf8'),
    c
  );
  const archive = c.window.CloudHistory,
    session = { user: { id: 'u' }, scope: { server: '1', dts: '2026' } };
  await archive.initialize(db, session);
  assert.equal((await archive.load(tag)).matches.length, 10);
  assert.equal((await archive.list()).length, 1);
  const next = await signSnapshot('u', envelope(5, 15, '2026-10-14T01:00:00Z').content.data, env);
  failWrite = true;
  await assert.rejects(() => archive.save(next), /旧历史已保留/);
  assert.equal((await archive.load(tag)).matches.length, 10);
  failWrite = false;
  await archive.save(next);
  assert.equal((await archive.load(tag)).matches.length, 15);
  assert.equal((await archive.envelope(tag, game(0).mid)).signature, old.signature);
  await archive.initialize(db, session);
  assert.equal((await archive.load(tag)).matches.length, 15);
  await archive.initialize(db, { ...session, user: { id: 'other' } });
  assert.equal((await archive.list()).length, 0);
  assert.equal(await archive.load(tag), null);
  await assert.rejects(() => archive.save(next));
  await archive.initialize(db, { ...session, scope: { server: '1', dts: '2025' } });
  assert.equal((await archive.list()).length, 0);
  await assert.rejects(() => archive.save(next));
});
