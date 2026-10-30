import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../server/storage.mjs';
import { AuthDirectory } from '../../src/actors/auth.mjs';
import { UserTasks } from '../../src/actors/tasks.mjs';
import worker from '../../src/worker.mjs';
import { digest, putBlob } from '../../src/security.mjs';
import { historyInventory, inventoryId } from '../../src/operations/data-inventory.mjs';
import { compareInventories } from '../../scripts/compare-data-inventory.mjs';

const denyWrite = (storage) => {
  for (const name of [
    'put',
    'delete',
    'putBlob',
    'deleteBlob',
    'setAlarm',
    'deleteAlarm',
    'transaction'
  ])
    storage[name] = () => {
      throw Error('Write forbidden');
    };
  return storage;
};
async function fixture(n = 1) {
  const db = new SqliteDatabase(':memory:');
  const storage = db.store('auth');
  await storage.put('session:' + (await digest('admin')), {
    admin: true,
    until: Date.now() + 60000
  });
  await storage.put('session:' + (await digest('ordinary')), {
    admin: false,
    user: 'raw-user-00',
    version: 1,
    until: Date.now() + 60000
  });
  for (let i = 0; i < n; i++) {
    const id = 'raw-user-' + String(i).padStart(2, '0');
    await storage.put('user:' + id, {
      id,
      email: 'secret@example.test',
      password: 'private-password',
      apiKey: { digest: 'private-key' },
      status: i === 20 ? 'rejected' : 'approved',
      version: 1
    });
  }
  const env = {};
  const auth = new AuthDirectory({ storage: denyWrite(storage) }, env);
  const tasks = new Map();
  env.AUTH = {
    idFromName: (x) => x,
    get: () => ({ fetch: (_url, opts) => auth.fetch(new Request('https://internal/', opts)) })
  };
  env.TASKS = {
    idFromName: (x) => x,
    get: (id) => ({
      fetch: async (_url, opts) => {
        if (!tasks.has(id))
          tasks.set(id, new UserTasks({ storage: denyWrite(db.store('task:' + id)) }, env));
        return tasks.get(id).fetch(new Request('https://internal/', opts));
      }
    })
  };
  const call = (path = '/api/v1/admin/data-inventory', cookie = 'qs_admin=admin', method = 'GET') =>
    worker.fetch(new Request('https://test' + path, { method, headers: { Cookie: cookie } }), env);
  return { db, auth, tasks, env, call };
}
test('cold administrator inventory is read-only, bounded, redacted and GET only', async () => {
  const f = await fixture(21);
  try {
    assert.equal((await f.call(undefined, '')).status, 401);
    assert.equal((await f.call(undefined, 'qs_session=ordinary')).status, 401);
    assert.equal((await f.call(undefined, 'qs_admin=ordinary')).status, 401);
    for (const method of ['POST', 'PUT', 'DELETE'])
      assert.equal((await f.call(undefined, undefined, method)).status, 405);
    const r = await f.call();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    const p = await r.json();
    assert.equal(p.total, 21);
    assert.equal(p.users.length, 20);
    assert.ok(p.nextCursor);
    const r2 = await f.call('/api/admin/data-inventory?cursor=' + p.nextCursor);
    const p2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(p2.users.length, 1);
    assert.equal(p2.nextCursor, null);
    const text = JSON.stringify([p, p2]);
    for (const secret of [
      'raw-user',
      'secret@example',
      'password',
      'apiKey',
      'credentials',
      'tag',
      'private-key'
    ])
      assert.ok(!text.includes(secret));
    assert.equal(f.auth.initializing, undefined);
    assert.equal((await f.call('/api/v1/admin/data-inventory?cursor=bad')).status, 400);
    assert.equal(
      (await f.call('/api/v1/admin/data-inventory?cursor=' + 'a'.repeat(64))).status,
      400
    );
    assert.equal((await f.call('/api/v1/admin/data-inventory?cursor=x&cursor=y')).status, 400);
    assert.notEqual((await f.call('/api/authorize-inventory')).status, 200);
    const task = f.env.TASKS.get('raw-user-00');
    const denied = await task.fetch('https://internal/', {
      method: 'POST',
      body: JSON.stringify({
        path: '/admin-history-inventory',
        user: 'raw-user-00',
        adminToken: 'ordinary'
      })
    });
    assert.equal(denied.status, 401);
    assert.equal(compareInventories([p, p2], [p, p2]).differences.length, 0);
    assert.equal(compareInventories([p, p2], [p, p2]).partial, true);
    assert.throws(() => compareInventories(p, p));
    assert.throws(() => compareInventories([p, p], [p, p2]));
    const broken = structuredClone(p2);
    broken.total = 22;
    assert.throws(() => compareInventories([p, broken], [p, p2]));
    f.env.TASKS.get = () => ({ fetch: () => new Response('{}', { status: 500 }) });
    assert.equal((await f.call()).status, 503);
  } finally {
    await f.db.close();
  }
});
test('catalog inventory reads all scopes in native and chunked blobs without legacy migration', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    for (const native of [true, false]) {
      const storage = db.store('history:' + native),
        root = 'history:v1:' + (await digest('raw'));
      if (!native) {
        storage.getBlob = undefined;
        storage.putBlob = undefined;
        storage.deleteBlob = undefined;
      }
      const accounts = [1, 2].map((n) => ({
        key: root + ':account:' + n,
        scope: 'scope-' + n,
        tag: 'Secret#123',
        password: 'never-return',
        credentials: { apiKey: 'never-return' },
        content: 'never-read-history',
        count: n,
        batchIds: [String(n).repeat(64)],
        revision: String(n).repeat(64)
      }));
      await putBlob(storage, root + ':catalog', { accounts });
      await putBlob(storage, accounts[0].key, {
        batches: { secret: { content: 'never-read-history' } }
      });
      const originalGet = storage.get.bind(storage),
        originalBlob = storage.getBlob?.bind(storage);
      storage.get = (key) => {
        assert.ok(key.startsWith(root + ':catalog:'));
        return originalGet(key);
      };
      if (native)
        storage.getBlob = (key) => {
          assert.equal(key, root + ':catalog');
          return originalBlob(key);
        };
      const result = await historyInventory(denyWrite(storage), 'raw');
      assert.equal(result.accountCount, 2);
      assert.equal(result.matchCount, 3);
      assert.equal(result.batchCount, 2);
      assert.equal(result.accounts[0].anonymousId.length, 64);
      assert.ok(!JSON.stringify(result).includes('Secret'));
      const aId = await inventoryId('game-account', accounts[0].key);
      const userId = await inventoryId('user', 'raw');
      const report = {
        version: 1,
        coverage: 'catalog-metadata-only',
        scopes: 'all',
        snapshot: false,
        metadataRevision: 'a'.repeat(64),
        cursor: null,
        nextCursor: null,
        total: 1,
        statusTotals: { approved: 1 },
        users: [{ anonymousId: userId, status: 'approved', history: result }],
        pageTotals: { users: 1, gameAccounts: 2, batches: 2, matches: 3 }
      };
      const other = structuredClone(report);
      const item = other.users[0].history.accounts.find((a) => a.anonymousId === aId);
      item.batchIds = ['f'.repeat(64)];
      const diff = compareInventories(report, other);
      assert.equal(diff.differences.length, 1);
      assert.equal(diff.differences[0].batchMissingLeft[0], 'f'.repeat(64));
      item.batchIds.push(item.batchIds[0]);
      assert.throws(() => compareInventories(report, other));
      const changed = structuredClone(report);
      changed.users[0].history.accounts[0].revision = 'e'.repeat(64);
      assert.equal(compareInventories(report, changed).differences[0].metadataChanged, true);
      for (const secret of ['tag', 'password', 'credentials', 'apiKey', 'never-'])
        assert.ok(!JSON.stringify(result).includes(secret));
    }
  } finally {
    await db.close();
  }
});
test('SQLite bounded list honors prefix, exclusive cursor and limit', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const s = db.store('list');
    for (const k of ['a:1', 'a:2', 'a:3', 'b:1']) await s.put(k, k);
    assert.deepEqual(
      [...(await s.list({ prefix: 'a:', limit: 2 }))].map(([k]) => k),
      ['a:1', 'a:2']
    );
    assert.deepEqual(
      [...(await s.list({ prefix: 'a:', startAfter: 'a:2', limit: 2 }))].map(([k]) => k),
      ['a:3']
    );
    assert.equal((await s.list({ prefix: 'a:', limit: 0 })).size, 0);
    assert.equal((await s.list({ prefix: 'missing', limit: 20 })).size, 0);
  } finally {
    await db.close();
  }
});
