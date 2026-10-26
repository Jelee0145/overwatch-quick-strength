import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudHistory, HISTORY_LIMITS } from '../../src/history/cloud-history.mjs';
import { signSnapshot, verifySnapshot, digest, getBlob, putBlob } from '../../src/security.mjs';
import { UserTasks } from '../../src/actors/tasks.mjs';
import worker from '../../src/worker.mjs';
import { service } from '../query-fixture.mjs';
import { restoreLegacyHistory } from '../../scripts/history-storage-rollback.mjs';
import { MemoryStorage } from '../helpers/storage.mjs';
class Storage extends MemoryStorage {
  constructor() {
    super();
    this.alarmTime = null;
  }
  async put(k, v) {
    assert.ok(new TextEncoder().encode(JSON.stringify(v)).length < 128 * 1024, 'DO value limit');
    return super.put(k, v);
  }
}
const env = () => ({
  CACHE_SIGNING_KEY: 'cloud-history-fixture-only',
  DASHEN_SERVER: '1',
  DASHEN_DTS: '2026'
});
const data = (ids = ['m1'], queriedAt = '2026-10-15T00:00:00Z', tag = 'Main#100', extra = {}) => ({
  battletag: tag,
  queriedAt,
  matches: ids.map((mid, i) => ({
    mid,
    t: Number(mid.replace(/\D/g, '')) || i,
    players: [],
    ret: 1
  })),
  ...extra
});
const signed = (e, ids, stamp, tag, extra) => signSnapshot('u', data(ids, stamp, tag, extra), e);
const push = (h, ...envelopes) => h.handle('u', { action: 'push', envelopes });
const list = (h) => h.handle('u', { action: 'list' });
const pull = (h, tag = 'Main#100', cursor) => h.handle('u', { action: 'pull', tag, cursor });

test('legacy archives migrate atomically, only selected batch blobs are read, and downgrade restores old readers', async () => {
  const e = env(),
    s = new Storage(),
    a = await signed(e, ['m1']),
    b = await signed(e, ['m2']),
    aid = await digest(JSON.stringify(a)),
    bid = await digest(JSON.stringify(b));
  const scope = await digest(JSON.stringify({ dts: e.DASHEN_DTS, server: e.DASHEN_SERVER })),
    root = 'history:v1:' + (await digest('u')),
    key = root + ':account:' + (await digest(JSON.stringify({ scope, tag: 'Main#100' })));
  await putBlob(s, key, { tag: 'Main#100', batches: { [aid]: a, [bid]: b } });
  await putBlob(s, root + ':catalog', {
    accounts: [{ key, scope, tag: 'Main#100', batchIds: [aid, bid].sort(), count: 2, bytes: 100 }]
  });
  const before = structuredClone(s.map),
    put = s.put.bind(s);
  let writes = 0;
  s.put = async (k, v) => {
    if (++writes === 3) throw Error('migration failure');
    return put(k, v);
  };
  await assert.rejects(() => pull(new CloudHistory(s, e)), /migration failure/);
  assert.deepEqual(s.map, before);
  s.put = put;
  const h = new CloudHistory(s, e),
    page = await pull(h);
  assert.equal(page.envelopes.length, 2);
  assert.equal((await getBlob(s, key)).version, 2);
  assert.equal((await getBlob(s, key)).batches, undefined);
  const same = structuredClone(s.map);
  assert.equal(await restoreLegacyHistory(s, [key]), 1);
  assert.deepEqual(s.map, same, 'dry-run leaves data unchanged');
  assert.equal(await restoreLegacyHistory(s, [key], { apply: true }), 1);
  assert.deepEqual((await getBlob(s, key)).batches, { [aid]: a, [bid]: b });
  assert.deepEqual(
    await pull(new CloudHistory(s, e)),
    page,
    'downgrade and re-upgrade preserve revision and signed bytes'
  );
  const reads = [],
    get = s.get.bind(s);
  s.get = async (k) => {
    reads.push(k);
    return get(k);
  };
  await push(h, await signed(e, ['m3']));
  assert.ok(
    !reads.some((k) => [aid, bid].some((id) => k.startsWith(key + ':batch:' + id))),
    'push reads metadata without parsing old signed blobs'
  );
});
test('history verifies old signatures; user, server, season and tampered input stay isolated', async () => {
  const e = env(),
    s = new Storage(),
    h = new CloudHistory(s, e),
    a = await signed(e);
  await push(h, a);
  assert.equal((await list(h)).accounts[0].count, 1);
  assert.equal((await h.handle('other', { action: 'list' })).accounts.length, 0);
  for (const changed of [
    { ...e, DASHEN_SERVER: '2' },
    { ...e, DASHEN_DTS: '2025' }
  ]) {
    const other = new CloudHistory(s, changed);
    assert.equal((await list(other)).accounts.length, 0);
    await assert.rejects(() => push(other, a));
  }
  await assert.rejects(() => h.handle('other', { action: 'push', envelopes: [a] }));
  const bad = structuredClone(a);
  bad.content.data.matches[0].ret = -1;
  await assert.rejects(() => push(h, bad));
  const valid = await signed(e, ['m2']),
    before = structuredClone(s.map);
  await assert.rejects(() => push(h, valid, bad));
  assert.deepEqual(s.map, before);
  const restored = await pull(new CloudHistory(s, e));
  assert.deepEqual(restored.envelopes, [a]);
  assert.equal((await verifySnapshot(restored.envelopes[0], 'u', e)).matches[0].mid, 'm1');
});
test('history merge is idempotent and order-independent, choosing query time then stable batch hash', async () => {
  const e = env(),
    a = await signed(e, ['m1', 'm2']),
    b = await signed(e, ['m2', 'm3'], '2026-10-15T01:00:00Z'),
    c = await signed(e, ['m2', 'm3'], '2026-10-15T01:00:00Z', undefined, { note: 'tie' }),
    s1 = new Storage(),
    s2 = new Storage(),
    h1 = new CloudHistory(s1, e),
    h2 = new CloudHistory(s2, e);
  await push(h1, a, b, c);
  await push(h1, c, b, a);
  await push(h2, c, b, a);
  assert.deepEqual(await list(h1), await list(h2));
  assert.deepEqual(await pull(h1), await pull(h2));
  assert.equal((await list(h1)).accounts[0].count, 3);
  const winner = (await digest(JSON.stringify(b))) > (await digest(JSON.stringify(c))) ? b : c;
  assert.ok((await pull(h1)).envelopes.some((x) => x.signature === winner.signature));
  const summary = (await list(h1)).accounts[0];
  assert.deepEqual(
    summary.batchIds,
    [await digest(JSON.stringify(a)), await digest(JSON.stringify(winner))].sort()
  );
});
test('history retains newest 500 distinct string match IDs and prunes unreferenced full batches', async () => {
  const e = env(),
    h = new CloudHistory(new Storage(), e);
  for (let n = 0; n < 550; n += 50)
    await push(
      h,
      await signed(
        e,
        Array.from({ length: 50 }, (_, i) => '900719925474099' + String(n + i).padStart(4, '0'))
      )
    );
  const account = (await list(h)).accounts[0];
  assert.equal(account.count, 500);
  assert.equal(account.batchIds.length, 10);
  const batches = (await pull(h)).envelopes;
  assert.equal(batches.flatMap((b) => b.content.data.matches).length, 500);
  assert.ok(!batches.some((b) => b.content.data.matches[0].mid.endsWith('0000')));
});
test('capacity applies globally across scopes and accounts and rejected updates are atomic', async () => {
  const e = env(),
    s = new Storage(),
    h = new CloudHistory(s, e, { accounts: 1 }),
    a = await signed(e);
  await push(h, a);
  const before = structuredClone(s.map);
  await assert.rejects(
    () => push(h, awaitableBad()),
    (e) => e.status === 400
  );
  function awaitableBad() {
    return { content: {}, signature: '' };
  }
  await assert.rejects(
    () => signed(e, ['m1'], undefined, 'Other#100').then((b) => push(h, b)),
    (e) => e.status === 413
  );
  assert.deepEqual(s.map, before);
  const next = { ...e, DASHEN_DTS: '2027' },
    other = new CloudHistory(s, next, { accounts: 1 });
  await assert.rejects(
    () => signed(next).then((b) => push(other, b)),
    (e) => e.status === 413
  );
  assert.deepEqual(s.map, before);
  const full = new CloudHistory(s, e, { bytes: 100 });
  await assert.rejects(
    () => push(full, a),
    (e) => e.status === 413
  );
  assert.deepEqual(s.map, before);
  const tiny = new CloudHistory(s, e, { envelopeBytes: 10 });
  await assert.rejects(
    () => push(tiny, a),
    (e) => e.status === 413
  );
});
test('storage failure during blob replacement rolls back existing archive and catalog', async () => {
  const e = env(),
    s = new Storage(),
    h = new CloudHistory(s, e),
    a = await signed(e);
  await push(h, a);
  const before = structuredClone(s.map),
    put = s.put.bind(s);
  let writes = 0;
  s.put = async (k, v) => {
    if (++writes === 2) throw Error('simulated disk failure');
    return put(k, v);
  };
  await assert.rejects(() => signed(e, ['m2']).then((b) => push(h, b)), /simulated disk failure/);
  s.put = put;
  assert.deepEqual(s.map, before);
  assert.deepEqual((await pull(h)).envelopes, [a]);
});
test('pagination stays below 2.8MB with full signed blobs exceeding a DO single value; malformed cursors fail', async () => {
  const e = env(),
    s = new Storage(),
    h = new CloudHistory(s, e);
  for (let n = 0; n < 3; n++)
    await push(
      h,
      await signed(e, ['m' + n], undefined, undefined, { padding: '中'.repeat(350000) })
    );
  let cursor = 0,
    seen = [];
  do {
    const page = await pull(h, undefined, cursor);
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < HISTORY_LIMITS.pageBytes);
    assert.ok(page.envelopes.length);
    seen.push(...page.envelopes);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map((x) => x.signature)).size, 3);
  assert.equal((await pull(h, undefined, 100)).nextCursor, null);
  for (const cursor of [-1, 0.5, '0', null]) await assert.rejects(() => pull(h, undefined, cursor));
});
test('parallel browser pushes and automatic archive use shared history serialization without losing matches', async () => {
  const e = env(),
    h = new CloudHistory(new Storage(), e),
    envelopes = await Promise.all(Array.from({ length: 8 }, (_, n) => signed(e, ['m' + n])));
  await Promise.all(envelopes.map((a) => push(h, a)));
  assert.equal((await list(h)).accounts[0].count, 8);
});
function taskEnv(e) {
  e.AUTH = {
    idFromName: (n) => n,
    get: () => ({ fetch: async () => Response.json({ ok: true, user: { id: 'u' }, version: 1 }) })
  };
  return e;
}
test('completed queries auto-archive; task expiry/restart leaves archive intact; archive failure remains a done query warning', async () => {
  for (const fail of [false, true]) {
    const e = taskEnv({ ...env(), DASHEN_ROLE_ID: 'fixture-role', DASHEN_TOKEN: 'fixture-token' }),
      s = new Storage(),
      t = new UserTasks({ storage: s }, e);
    if (fail) t.history = new CloudHistory(s, e, { bytes: 1 });
    const started = await t.handle({
        path: '/query',
        user: 'u',
        version: 1,
        body: { battletag: 'Main#100', limit: 10 }
      }),
      checkpoint = await getBlob(s, 'data:' + started.id);
    checkpoint.minIntervalMs = 0;
    await putBlob(s, 'data:' + started.id, checkpoint);
    const mock = service({ delay: 0 }),
      original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      return Response.json({
        code: 0,
        data: await mock.call(
          e,
          u.pathname.replace('/v1/a19ld5tool', ''),
          Object.fromEntries(u.searchParams),
          init.body ? JSON.parse(init.body) : undefined
        )
      });
    };
    try {
      await t.alarm();
    } finally {
      globalThis.fetch = original;
    }
    const status = await t.handle({
      path: '/status',
      user: 'u',
      version: 1,
      body: { id: started.id }
    });
    assert.equal(status.state, 'done');
    assert.equal(!!status.archiveWarning, fail);
    assert.ok(status.envelope);
    if (fail) await push(new CloudHistory(s, e), status.envelope);
    const done = await s.get('job:' + started.id);
    await s.put('job:' + started.id, { ...done, until: Date.now() - 1 });
    const restarted = new UserTasks({ storage: s }, e);
    await restarted.alarm();
    assert.equal(await getBlob(s, 'result:' + started.id), null);
    assert.equal((await restarted.history.handle('u', { action: 'list' })).accounts[0].count, 10);
    assert.equal(
      (await restarted.history.handle('u', { action: 'pull', tag: 'Main#100' })).envelopes[0]
        .signature,
      status.envelope.signature
    );
  }
});
test('history HTTP route uses authorized user and existing origin/CSRF authorization path', async () => {
  const e = taskEnv(env()),
    t = new UserTasks({ storage: new Storage() }, e);
  let received;
  e.TASKS = {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: async (url, init) => {
        received = { id, ...JSON.parse(init.body) };
        return t.fetch(new Request(url, init));
      }
    })
  };
  const request = (method = 'POST', origin = 'https://site.test') =>
    new Request('https://site.test/api/history', {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'list', user: 'attacker' }) } : {})
    });
  assert.equal((await worker.fetch(request(), e)).status, 200);
  assert.equal(received.user, 'u');
  assert.equal(received.id, 'u');
  assert.equal(received.path, '/history');
  assert.equal((await worker.fetch(request('POST', 'https://evil.test'), e)).status, 403);
  assert.equal((await worker.fetch(request('GET'), e)).status, 404);
  e.AUTH.get = () => ({ fetch: async () => Response.json({ error: 'denied' }, { status: 401 }) });
  assert.equal((await worker.fetch(request(), e)).status, 401);
});
