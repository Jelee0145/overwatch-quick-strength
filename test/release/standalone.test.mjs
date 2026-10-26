import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SqliteDatabase } from '../../server/storage.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { createHttpServer } from '../../server/http.mjs';
import { staticAssets } from '../../server/assets.mjs';
import { createScheduler, pacedFetch } from '../../server/limiter.mjs';
import { putBlob, getBlob, passwordHash } from '../../src/security.mjs';
import { createMatchService } from '../../src/services/matches.mjs';
import { analysisService } from '../../src/services/runtime.mjs';
import { canonical, digest, token } from '../../src/security.mjs';
import { service } from '../query-fixture.mjs';
import { importMigration } from '../../server/migration.mjs';
import { signSnapshot } from '../../src/security.mjs';
import { migrationBridge } from '../../scripts/migration-bridge.mjs';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('SQLite preserves namespace isolation, atomic blobs, rollback and durable alarms through reopen', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-sqlite-')),
    filename = path.join(dir, 'state.sqlite3');
  let db = new SqliteDatabase(filename);
  try {
    const a = db.store('a'),
      b = db.store('b');
    await a.put('same', { n: 1 });
    await b.put('same', { n: 2 });
    assert.equal((await a.get('same')).n, 1);
    assert.equal((await b.get('same')).n, 2);
    const blob = { matches: ['中文'.repeat(40000)] };
    await putBlob(a, 'history', blob);
    assert.deepEqual(await getBlob(a, 'history'), blob);
    await assert.rejects(
      a.transaction(async (tx) => {
        await tx.put('same', { n: 3 });
        await putBlob(tx, 'history', { bad: true });
        throw Error('rollback');
      })
    );
    assert.equal((await a.get('same')).n, 1);
    assert.deepEqual(await getBlob(a, 'history'), blob);
    const order = [];
    await Promise.all([
      a.transaction(async (tx) => {
        await tx.put('same', { n: 4 });
        await new Promise((r) => setTimeout(r, 10));
        order.push('commit');
      }),
      b.get('same').then(() => order.push('read'))
    ]);
    assert.deepEqual(order, ['commit', 'read']);
    await a.setAlarm(1234);
    await db.close();
    db = new SqliteDatabase(filename);
    assert.equal((await db.store('a').get('same')).n, 4);
    assert.equal(await db.store('a').getAlarm(), 1234);
    assert.deepEqual(await db.due(1234), [{ ns: 'a', at: 1234 }]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider identities are calculated once per token per query without changing query results', async () => {
  const mock = service();
  let calls = 0;
  const matches = createMatchService({
    provider: mock.call,
    pick: analysisService.pick,
    digest,
    canonical,
    createId: token,
    playerIdentity: async (_, ct) => {
      calls++;
      return digest(ct);
    }
  });
  const state = matches.createQuery('Main#100', 10, undefined, [], {
    supplementOtherMatches: false
  });
  while (state.phase !== 'done') await matches.runQuery(state, {}, { minIntervalMs: 0 });
  assert.equal(calls, 10);
  assert.equal(state.result.matches.length, 10);
  assert.ok(!JSON.stringify(state.result).includes('-private'));
});

test('aggregate fetch pacing limits starts and concurrency and recovers from aborted queue entries', async () => {
  const times = [];
  let active = 0,
    max = 0;
  // 12ms spacing proves the wrapper routes every fetch through the shared schedule.
  const scheduler = createScheduler({ ratePerSecond: 1000 / 12, burst: 1, concurrency: 2 });
  const call = pacedFetch(
    async () => {
      times.push(Date.now());
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 35));
      active--;
      return new Response('ok');
    },
    { scheduler }
  );
  await Promise.all(Array.from({ length: 6 }, () => call('https://example.test')));
  assert.ok(max <= 2);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 9);
  assert.equal(scheduler.stats().active, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(call('https://example.test', { signal: controller.signal }));
  assert.equal((await call('https://example.test')).status, 200);
  assert.equal(scheduler.stats().active, 0);
  assert.equal(scheduler.stats().waiting, 0);
});

test('one runtime schedule serves every user, caps the rate below the operator ceiling and keeps priority', async () => {
  const runtime = createRuntime(
    {},
    {
      filename: ':memory:',
      assets: staticAssets(os.tmpdir()),
      // An over-large request is clamped, so no configuration can open a second budget.
      ratePerSecond: 500,
      // Only the ceilings below the rate may be tuned; one slot forces a real queue.
      upstreamRates: { burst: 1, concurrency: 1 },
      upstreamFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response('ok');
      }
    }
  );
  try {
    const scheduler = runtime.scheduler,
      stats = scheduler.stats();
    assert.equal(stats.ratePerSecond, 8);
    assert.ok(stats.burst <= 2);
    assert.equal(runtime.env.UPSTREAM_SCHEDULER, scheduler);
    const order = [];
    await Promise.all([
      runtime.env
        .UPSTREAM_FETCH('https://example.test', undefined, 'low')
        .then(() => order.push('low')),
      // The first call already owns the only slot, so the queue decides what runs next.
      new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
        Promise.all([
          runtime.env
            .UPSTREAM_FETCH('https://example.test', undefined, 'low')
            .then(() => order.push('low')),
          runtime.env
            .UPSTREAM_FETCH('https://example.test', undefined, 'high')
            .then(() => order.push('high'))
        ])
      )
    ]);
    // First arrival takes the free slot; under contention the queued high request goes first.
    assert.deepEqual(order, ['low', 'high', 'low']);
    assert.ok(scheduler.stats().active <= 1);
    assert.equal(scheduler.stats().active, 0);
    assert.equal(scheduler.stats().waiting, 0);
  } finally {
    await runtime.close();
  }
});

test('standalone HTTP supports secure login, approval, Bot query, history and restart; rejects forged hosts and secret paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-http-'));
  await mkdir(path.join(dir, 'public'));
  await writeFile(path.join(dir, 'public/login.html'), '<h1>login</h1>');
  const config = {
    PASSWORD_PEPPER: 'test-pepper',
    CACHE_SIGNING_KEY: 'test-sign',
    API_KEY_ENCRYPTION_KEY: 'test-encrypt',
    DASHEN_SERVER: '1',
    DASHEN_DTS: '2026',
    DASHEN_TOKEN: 'test-token',
    DASHEN_ROLE_ID: 'test-role'
  };
  config.ADMIN_PASSWORD_HASH = JSON.stringify(
    await passwordHash('admin-password', config.PASSWORD_PEPPER)
  );
  const mock = service();
  const upstreamFetch = async (url, init) => {
    const u = new URL(url);
    return Response.json({
      code: 0,
      data: await mock.call(
        config,
        u.pathname.replace('/v1/a19ld5tool', ''),
        Object.fromEntries(u.searchParams),
        init.body ? JSON.parse(init.body) : undefined
      )
    });
  };
  let runtime = createRuntime(config, {
    filename: path.join(dir, 'state.sqlite3'),
    assets: staticAssets(path.join(dir, 'public')),
    upstreamFetch,
    ratePerSecond: Infinity
  });
  const server = createHttpServer(runtime, {
    origin: 'https://owqs.test:8443',
    allowLoopback: true
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const api = async (url, body, cookie = '', csrf = '') => {
    const r = await fetch(base + url, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', Origin: 'https://owqs.test:8443' } : {}),
        Cookie: cookie,
        'X-CSRF-Token': csrf
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { r, v: await r.json() };
  };
  try {
    assert.equal((await fetch(base + '/login')).status, 200);
    assert.equal((await fetch(base + '/.private/config')).status, 404);
    assert.equal((await fetch(base + '/_headers')).status, 404);
    const forged = await new Promise((resolve) =>
      http.get(base + '/api/health', { headers: { Host: 'attacker.test' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
    );
    assert.equal(forged, 421);
    const admin = await api('/api/admin/login', { password: 'admin-password' }),
      adminCookie = admin.r.headers.get('Set-Cookie').split(';')[0];
    assert.match(admin.r.headers.get('Set-Cookie'), /Secure/);
    const player = await api('/api/auth/register', {
        email: 'player@example.test',
        password: 'player-password'
      }),
      cookie = player.r.headers.get('Set-Cookie').split(';')[0];
    assert.equal(
      (
        await api(
          '/api/admin/access',
          { id: player.v.user.id, status: 'approved' },
          adminCookie,
          admin.v.csrf
        )
      ).r.status,
      200
    );
    const key = await api('/api/auth/api-key', { action: 'regenerate' }, cookie, player.v.csrf);
    assert.equal(key.r.status, 200);
    assert.ok(key.v.key);
    const bot = async (url, body) => {
      const r = await fetch(base + url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + key.v.key,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { r, v: await r.json() };
    };
    const start = await bot('/api/v1/query', { battletag: 'Main#100', limit: 5 });
    assert.equal(start.r.status, 200);
    const task = runtime.instance('tasks:' + player.v.user.id),
      state = await getBlob(task.storage, 'data:' + start.v.id);
    state.minIntervalMs = 0;
    await putBlob(task.storage, 'data:' + start.v.id, state);
    // Restart between enqueue and execution: both the alarm and account state must survive.
    await new Promise((r) => server.close(r));
    await runtime.close();
    runtime = createRuntime(config, {
      filename: path.join(dir, 'state.sqlite3'),
      assets: staticAssets(path.join(dir, 'public')),
      upstreamFetch,
      ratePerSecond: Infinity
    });
    await runtime.instance('tasks:' + player.v.user.id).alarm();
    const status = await runtime.env.TASKS.get('tasks:' + player.v.user.id).fetch(
      'https://internal/',
      {
        method: 'POST',
        body: JSON.stringify({
          path: '/status',
          body: { id: start.v.id },
          user: player.v.user.id,
          version: 1
        })
      }
    );
    const result = await status.json();
    assert.equal(result.state, 'done');
    assert.equal(result.result.matches.length, 5);
    assert.ok(!JSON.stringify(result.result).includes('-private'));
    const history = await taskHistory(runtime, player.v.user.id);
    assert.equal(history.accounts[0].count, 5);
    const auth = await runtime.env.AUTH.get().fetch('https://internal/', {
      method: 'POST',
      body: JSON.stringify({ path: '/api-key-auth', body: { key: key.v.key } })
    });
    assert.equal(auth.status, 200);
  } finally {
    if (server.listening) await new Promise((r) => server.close(r));
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
async function taskHistory(runtime, user) {
  const r = await runtime.env.TASKS.get('tasks:' + user).fetch('https://internal/', {
    method: 'POST',
    body: JSON.stringify({ path: '/history', body: { action: 'list' }, user, version: 1 })
  });
  return r.json();
}

test('migration validates old signatures, converts chunks, imports once and rejects tampered or conflicting data', async () => {
  const user = await digest('player@example.test'),
    config = {
      PASSWORD_PEPPER: 'original-pepper',
      CACHE_SIGNING_KEY: 'original-sign',
      API_KEY_ENCRYPTION_KEY: 'original-key',
      ADMIN_PASSWORD_HASH: '{}',
      PUBLIC_ORIGIN: 'https://site.test',
      DASHEN_SERVER: '1',
      DASHEN_DTS: '2026'
    };
  const envelope = await signSnapshot(
    user,
    {
      battletag: 'Main#100',
      queriedAt: new Date().toISOString(),
      matches: [{ mid: 'long-match-id', t: 1, players: [] }]
    },
    config
  );
  const account = {
      batches: { batch: envelope },
      matches: [{ mid: 'long-match-id', batchId: 'batch' }]
    },
    body = JSON.stringify(account),
    key = 'history:v1:fixture:account:fixture';
  const input = {
    version: 1,
    config,
    namespaces: [
      { ns: 'auth', records: [['user:' + user, { id: user, status: 'approved' }]] },
      {
        ns: 'tasks:' + user,
        records: [
          [key + ':count', 2],
          [key + ':0', body.slice(0, 100)],
          [key + ':1', body.slice(100)]
        ]
      }
    ]
  };
  const db = new SqliteDatabase(':memory:');
  try {
    const tampered = structuredClone(input);
    tampered.namespaces[1].records[2][1] += 'x';
    await assert.rejects(importMigration(db, tampered));
    assert.equal((await db.store('auth').list()).size, 0);
    assert.deepEqual(await importMigration(db, input), {
      users: 1,
      batches: 1,
      matches: 1,
      namespaces: 2
    });
    assert.deepEqual(await getBlob(db.store('tasks:' + user), key), account);
    assert.equal((await db.store('tasks:' + user).list()).size, 0);
    await importMigration(db, input);
    const conflict = structuredClone(input);
    conflict.config.CACHE_SIGNING_KEY = 'wrong';
    await assert.rejects(importMigration(db, conflict));
  } finally {
    await db.close();
  }
});

test('temporary migration bridge requires its separate key and delegates normal requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-bridge-'));
  try {
    await writeFile(
      path.join(dir, 'original.mjs'),
      `export class AuthDirectory { constructor(ctx,env){this.storage=ctx.storage;this.env=env;} fetch(){return new Response('original');} alarm(){} }; export class UserTasks extends AuthDirectory {}; export default {fetch(){return new Response('website');}};`
    );
    await writeFile(
      path.join(dir, 'bridge.mjs'),
      migrationBridge({ original: 'original.mjs', expiresAt: Date.now() + 60000 })
    );
    const bridge = await import(pathToFileURL(path.join(dir, 'bridge.mjs')));
    const env = { OWQS_MIGRATION_KEY: 'test-only-random-key', PASSWORD_PEPPER: 'test-only-pepper' };
    assert.equal(
      (
        await bridge.default.fetch(
          new Request('https://site.test/__owqs_migration?op=secrets'),
          env
        )
      ).status,
      404
    );
    assert.equal(
      await (await bridge.default.fetch(new Request('https://site.test/'), env)).text(),
      'website'
    );
    assert.equal(
      (
        await bridge.default.fetch(
          new Request('https://site.test/api/query', { method: 'POST' }),
          env
        )
      ).status,
      503
    );
    const headers = { Authorization: 'Bearer ' + env.OWQS_MIGRATION_KEY },
      secrets = await bridge.default.fetch(
        new Request('https://site.test/__owqs_migration?op=secrets', { headers }),
        env
      );
    assert.equal((await secrets.json()).PASSWORD_PEPPER, env.PASSWORD_PEPPER);
    const obj = new bridge.AuthDirectory(
      { storage: { list: async () => new Map([['key', 'value']]) } },
      env
    );
    assert.deepEqual(
      (await (await obj.fetch(new Request('https://internal/', { headers }))).json()).records,
      [['key', 'value']]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration CLI preserves a large UTF-8 payload across stdin chunks and persists config privately', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-import-cli-')),
    user = 'a'.repeat(64),
    description = '中文玩家🦊'.repeat(15000);
  try {
    const config = {
      PASSWORD_PEPPER: 'test-only-pepper',
      CACHE_SIGNING_KEY: 'test-only-sign',
      API_KEY_ENCRYPTION_KEY: 'test-only-encryption',
      ADMIN_PASSWORD_HASH: '{}',
      PUBLIC_ORIGIN: 'https://site.test'
    };
    const input = {
      version: 1,
      config,
      namespaces: [{ ns: 'auth', records: [['user:' + user, { id: user, description }]] }]
    };
    const filename = path.join(dir, 'state.sqlite3'),
      configPath = path.join(dir, 'config.json');
    const child = spawnSync(process.execPath, [path.resolve('server/import.mjs')], {
      input: Buffer.from(JSON.stringify(input)),
      encoding: 'utf8',
      env: { ...process.env, OWQS_DATABASE: filename, OWQS_CONFIG: configPath },
      windowsHide: true,
      timeout: 10000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).users, 1);
    const db = new SqliteDatabase(filename);
    try {
      assert.equal((await db.store('auth').get('user:' + user)).description, description);
    } finally {
      await db.close();
    }
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
