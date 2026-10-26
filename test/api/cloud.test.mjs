import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthDirectory } from '../../src/actors/auth.mjs';
import { UserTasks } from '../../src/actors/tasks.mjs';
import worker from '../../src/worker.mjs';
import {
  passwordHash,
  mac,
  signSnapshot,
  verifySnapshot,
  putBlob,
  getBlob,
  deleteBlob,
  day
} from '../../src/security.mjs';
import { createQuery, queryStep } from '../../src/query/query.mjs';
import { prepareReview, callReview } from '../../src/adapters/review.mjs';
import { heroes } from '../../src/shared/data.mjs';
import { service } from '../query-fixture.mjs';
import { mintCacheRecords, cacheEntries } from '../../src/query/cache-records.mjs';
import { MemoryStorage } from '../helpers/storage.mjs';
export { MemoryStorage };
const hero = Object.keys(heroes)[0],
  player = (name, side = 'T') => ({
    name,
    hero,
    side,
    stats: {
      kill: 20,
      assist: 8,
      death: 4,
      heroDamage: 10000,
      cure: 500,
      resistDamage: 6000,
      finalHit: 10,
      soloKill: null,
      targetCompetingTime: 10,
      healingTaken: 5000,
      damageTaken: 9000
    },
    res: { rows: [] }
  });
const match = (mid = 'm1', tag = 'Test#123') => ({
  mid,
  t: 100,
  ret: -1,
  mapGuid: '576460752303425366',
  duration: 300,
  teamScore: 2,
  opponentScore: 0,
  hasGameData: true,
  resourceDataChecked: true,
  players: [player(tag), player('Other#124', 'E')]
});
const snapshot = (tag = 'Test#123') => ({
  battletag: tag,
  matches: [match('m1', tag)],
  recentHistory: [],
  queriedAt: new Date().toISOString()
});
async function setup() {
  const storage = new MemoryStorage(),
    env = {
      PASSWORD_PEPPER: 'test-only-pepper',
      CACHE_SIGNING_KEY: 'test-only-signing-key',
      DASHEN_DTS: '2026',
      DASHEN_SERVER: '1'
    };
  env.ADMIN_PASSWORD_HASH = JSON.stringify(
    await passwordHash('admin-password', env.PASSWORD_PEPPER)
  );
  const dir = new AuthDirectory({ storage }, env);
  env.AUTH = {
    idFromName: (n) => n,
    get: () => ({ fetch: (input, init) => dir.fetch(new Request(input, init)) })
  };
  const tasks = new Map();
  env.TASKS = {
    idFromName: (n) => n,
    get: (id) => {
      if (!tasks.has(id)) tasks.set(id, new UserTasks({ storage: new MemoryStorage() }, env));
      return { fetch: (input, init) => tasks.get(id).fetch(new Request(input, init)) };
    }
  };
  env.ASSETS = { fetch: () => new Response('static') };
  return { storage, env, dir, tasks };
}
async function internal(obj, path, body = {}, rest = {}) {
  const r = await obj.fetch(
    new Request('https://internal/', {
      method: 'POST',
      body: JSON.stringify({ path, body, ip: 'test-ip', ...rest })
    })
  );
  const v = await r.json();
  return { r, v };
}
async function approve(ctx, address = 'a@example.test') {
  const register = (
    await internal(ctx.dir, '/register', { email: address, password: 'player-password' })
  ).v;
  const login = (await internal(ctx.dir, '/admin/login', { password: 'admin-password' })).v;
  const result = await internal(
    ctx.dir,
    '/admin/access',
    { id: register.user.id, status: 'approved' },
    { adminToken: login.token, csrf: login.csrf, mutation: true }
  );
  assert.equal(result.r.status, 200);
  return { register, login };
}
test('toolbox and both tools require approval, including direct HTML routes; revocation blocks visits', async () => {
  const ctx = await setup(),
    { register, login } = await approve(ctx),
    pending = (
      await internal(ctx.dir, '/register', {
        email: 'tool-pending@example.test',
        password: 'player-password'
      })
    ).v;
  ctx.env.ASSETS.fetch = (request) =>
    new Response(new URL(request.url).pathname, { headers: { 'Content-Type': 'text/html' } });
  const pages = {
    '/': '/index.html',
    '/index.html': '/index.html',
    '/tools/strength': '/tools/strength.html',
    '/tools/strength/': '/tools/strength.html',
    '/tools/strength.html': '/tools/strength.html',
    '/tools/draw': '/tools/draw.html',
    '/tools/draw/': '/tools/draw.html',
    '/tools/draw.html': '/tools/draw.html'
  };
  for (const [page, asset] of Object.entries(pages)) {
    for (const token of ['', pending.token]) {
      const response = await worker.fetch(
        new Request('https://site.test' + page, { headers: { Cookie: 'qs_session=' + token } }),
        ctx.env
      );
      assert.equal(response.status, 302, page);
      assert.equal(new URL(response.headers.get('Location')).pathname, '/login');
    }
    const response = await worker.fetch(
      new Request('https://site.test' + page, {
        headers: { Cookie: 'qs_session=' + register.token }
      }),
      ctx.env
    );
    assert.equal(response.status, 200, page);
    assert.equal(await response.text(), asset);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  await internal(
    ctx.dir,
    '/admin/access',
    { id: register.user.id, status: 'revoked' },
    { adminToken: login.token, csrf: login.csrf, mutation: true }
  );
  assert.equal(
    (
      await worker.fetch(
        new Request('https://site.test/tools/draw', {
          headers: { Cookie: 'qs_session=' + register.token }
        }),
        ctx.env
      )
    ).status,
    302
  );
});
test('auth approval, persistent sessions, isolation, revoke and redeploy', async () => {
  const ctx = await setup();
  const { register, login } = await approve(ctx);
  assert.equal(
    (await internal(ctx.dir, '/authorize', {}, { userToken: register.token })).r.status,
    200
  );
  assert.equal(
    (await internal(ctx.dir, '/admin/users', {}, { userToken: register.token })).r.status,
    401
  );
  assert.equal(
    (
      await internal(
        ctx.dir,
        '/admin/access',
        { id: register.user.id, status: 'revoked' },
        { adminToken: login.token, mutation: true, csrf: 'bad' }
      )
    ).r.status,
    403
  );
  const restarted = new AuthDirectory({ storage: ctx.storage }, ctx.env);
  assert.equal(
    (await internal(restarted, '/authorize', {}, { userToken: register.token })).r.status,
    200
  );
  await internal(
    ctx.dir,
    '/admin/access',
    { id: register.user.id, status: 'revoked' },
    { adminToken: login.token, mutation: true, csrf: login.csrf }
  );
  assert.equal(
    (await internal(ctx.dir, '/authorize', {}, { userToken: register.token })).r.status,
    401
  );
});
test('reset request generic; single-use reset link; old login revoked', async () => {
  const ctx = await setup(),
    { register, login } = await approve(ctx);
  const a = await internal(ctx.dir, '/reset/request', { email: 'a@example.test' }),
    b = await internal(ctx.dir, '/reset/request', { email: 'unknown@example.test' });
  assert.deepEqual(a.v, b.v);
  const issue = (
    await internal(
      ctx.dir,
      '/admin/reset',
      { id: register.user.id, action: 'issue' },
      { adminToken: login.token, mutation: true, csrf: login.csrf }
    )
  ).v;
  assert.equal(
    (await internal(ctx.dir, '/authorize', {}, { userToken: register.token })).r.status,
    401
  );
  assert.equal(
    (await internal(ctx.dir, '/reset/confirm', { code: issue.code, password: 'new-password-123' }))
      .r.status,
    200
  );
  assert.equal(
    (await internal(ctx.dir, '/reset/confirm', { code: issue.code, password: 'new-password-123' }))
      .r.status,
    400
  );
  assert.equal(
    (await internal(ctx.dir, '/login', { email: 'a@example.test', password: 'new-password-123' })).r
      .status,
    200
  );
});
test('reset expiry and failure throttling', async () => {
  const ctx = await setup(),
    { register, login } = await approve(ctx);
  const issue = (
    await internal(
      ctx.dir,
      '/admin/reset',
      { id: register.user.id, action: 'issue' },
      { adminToken: login.token, mutation: true, csrf: login.csrf }
    )
  ).v;
  const entries = await ctx.storage.list({ prefix: 'reset:' });
  for (const [k, v] of entries) await ctx.storage.put(k, { ...v, until: Date.now() - 1 });
  assert.equal(
    (await internal(ctx.dir, '/reset/confirm', { code: issue.code, password: 'new-password-123' }))
      .r.status,
    400
  );
  for (let n = 0; n < 6; n++) {
    const r = await internal(ctx.dir, '/admin/login', { password: 'wrong-password' });
    if (n === 5) assert.equal(r.r.status, 429);
  }
});
test('signed browser cache rejects tampering and cross user; large blob survives', async () => {
  const ctx = await setup(),
    value = await signSnapshot('u', snapshot(), ctx.env);
  assert.equal((await verifySnapshot(value, 'u', ctx.env)).battletag, 'Test#123');
  await assert.rejects(() => verifySnapshot(value, 'other', ctx.env));
  value.content.data.matches[0].players[0].stats.kill = 9000;
  await assert.rejects(() => verifySnapshot(value, 'u', ctx.env));
  const big = { text: '测试'.repeat(100000) };
  await putBlob(ctx.storage, 'blob', big);
  assert.deepEqual(await getBlob(ctx.storage, 'blob'), big);
  await deleteBlob(ctx.storage, 'blob');
  assert.equal(await getBlob(ctx.storage, 'blob'), null);
});
test('per-user one query, duplicate reuse, other user parallel and quota', async () => {
  const ctx = await setup(),
    a = await approve(ctx),
    b = await approve(ctx, 'b@example.test');
  const ta = ctx.env.TASKS.get(a.register.user.id),
    tb = ctx.env.TASKS.get(b.register.user.id);
  const req = { user: a.register.user.id, version: 1 };
  const one = await internal(ta, '/query', { battletag: 'Test#123', limit: 10 }, req),
    dup = await internal(ta, '/query', { battletag: 'Test#123', limit: 10 }, req);
  assert.equal(one.v.id, dup.v.id);
  assert.equal(
    (await internal(ta, '/query', { battletag: 'Other#123', limit: 10 }, req)).r.status,
    409
  );
  assert.equal(
    (
      await internal(
        tb,
        '/query',
        { battletag: 'Other#123', limit: 10 },
        { user: b.register.user.id, version: 1 }
      )
    ).r.status,
    200
  );
  assert.equal(
    (await internal(tb, '/status', { id: one.v.id }, { user: b.register.user.id, version: 1 })).r
      .status,
    404
  );
  const u = await ctx.storage.get('user:' + a.register.user.id);
  assert.equal(u.aiDaily, 100);
  for (let n = 0; n < 100; n++)
    assert.equal(
      (await internal(ctx.dir, '/quota', { user: u.id, kind: 'ai', job: 'j' + n })).r.status,
      200
    );
  assert.equal(
    (await internal(ctx.dir, '/quota', { user: u.id, kind: 'ai', job: 'extra' })).r.status,
    429
  );
  await internal(ctx.dir, '/quota', { user: u.id, kind: 'ai', job: 'j0', refund: true });
  await internal(ctx.dir, '/quota', { user: u.id, kind: 'ai', job: 'j0', refund: true });
  assert.equal((await ctx.storage.get('usage:' + u.id)).ai, 99);
  assert.equal((await ctx.storage.get('usage:' + u.id)).day, day());
});
test('5 new games + 5 cached only query 5 details; no customer credentials in output', async () => {
  const prior = snapshot();
  prior.matches = Array.from({ length: 5 }, (_, i) => ({ ...match('old' + i), t: 100 - i }));
  const s = createQuery('Test#123', 10, prior);
  let details = 0;
  const call = async (env, path, params) => {
    if (path === '/searchBnetAccount') return { customerToken: 'private-customer-token' };
    if (path === '/customer/queryMatchList')
      return {
        matchList: [
          ...Array.from({ length: 5 }, (_, i) => ({
            matchId: 'new' + i,
            beginTs: 200 - i,
            matchRet: 1,
            mapGuid: 'map'
          })),
          ...prior.matches.map((m) => ({
            matchId: m.mid,
            beginTs: m.t,
            matchRet: m.ret,
            mapGuid: m.mapGuid
          }))
        ]
      };
    if (path === '/customer/queryMatchInfo') {
      details++;
      return {
        gameTimeSec: 300,
        teamScore: 3,
        opponentScore: 0,
        teammateList: [{ name: 'Test#123', heroGuid: hero, kill: 20, death: 4 }],
        enemyList: []
      };
    }
    throw Error('Unexpected');
  };
  for (let i = 0; i < 100 && s.phase !== 'done'; i++) {
    if (s.phase === 'history-start') s.candidates = [];
    await queryStep(s, {}, call);
  }
  assert.equal(s.phase, 'done');
  assert.equal(details, 5);
  assert.equal(s.result.syncStatus.reusedMatches, 5);
  assert.equal(s.result.syncStatus.fetchedMatches, 5);
  assert.ok(!JSON.stringify(s.result).includes('private-customer-token'));
});
test('AI raw unit semantics full roster missing metrics and anonymity; output unconstrained', async () => {
  const { payload, fingerprint } = await prepareReview(snapshot(), 'm1');
  assert.equal(payload.players.length, 2);
  assert.equal(payload.players[0].alias, '你');
  assert.equal(payload.players[0].stats.kill, 20);
  assert.equal(payload.duration, 300);
  assert.equal(payload.players[0].stats.soloKill, null);
  assert.ok(!JSON.stringify(payload).includes('Test#123'));
  let sent;
  const review = await callReview(
    { DEEPSEEK_KEY: 'fake-key' },
    payload,
    fingerprint,
    async (url, init) => {
      sent = JSON.parse(init.body);
      assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
      return Response.json({
        choices: [{ message: { content: '非常短的正文' }, finish_reason: 'stop' }]
      });
    }
  );
  assert.equal(review.text, '非常短的正文');
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.thinking.type, 'enabled');
  assert.ok(sent.messages[0].content.includes('3:0'));
  await assert.rejects(
    () =>
      callReview({ DEEPSEEK_KEY: 'fake-key' }, payload, fingerprint, async () =>
        Response.json({ error: 'x' }, { status: 429 })
      ),
    (e) => e.status === 429
  );
});
test('HTTP same origin, CSRF, no admin token in JSON and no credentials endpoints', async () => {
  const ctx = await setup();
  const cross = await worker.fetch(
    new Request('https://site.test/api/auth/register', {
      method: 'POST',
      headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
      body: '{}'
    }),
    ctx.env
  );
  assert.equal(cross.status, 403);
  const login = await worker.fetch(
    new Request('https://site.test/api/admin/login', {
      method: 'POST',
      headers: { Origin: 'https://site.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' })
    }),
    ctx.env
  );
  const data = await login.json();
  assert.ok(!data.token);
  assert.match(login.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal(login.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    (await worker.fetch(new Request('https://site.test/api/credentials'), ctx.env)).status,
    401
  );
});
test('AI alarm duplicate delivery never sends twice; signed review cache does not use quota', async () => {
  const ctx = await setup(),
    { register } = await approve(ctx),
    u = register.user.id,
    rest = { user: u, version: 1 };
  const task = new UserTasks({ storage: new MemoryStorage() }, ctx.env),
    envelope = await signSnapshot(u, snapshot(), ctx.env);
  ctx.env.DEEPSEEK_KEY = 'fake-key';
  const start = await internal(
    task,
    '/ai-review',
    { battletag: 'Test#123', matchId: 'm1', envelope, requestId: 'request-1' },
    rest
  );
  assert.equal(start.r.status, 200);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '测试锐评' } }] });
  };
  try {
    await task.alarm();
    await task.alarm();
    assert.equal(calls, 1);
    const done = (await internal(task, '/status', { id: start.v.id }, rest)).v;
    assert.equal(done.state, 'done');
    const cached = await internal(
      task,
      '/ai-review',
      {
        battletag: 'Test#123',
        matchId: 'm1',
        envelope,
        cachedReview: done.reviewEnvelope,
        requestId: 'request-2'
      },
      rest
    );
    assert.equal(cached.v.cached, true);
    assert.equal((await ctx.storage.get('usage:' + u)).ai, 1);
    const crash = await internal(
      task,
      '/ai-review',
      { battletag: 'Test#123', matchId: 'm1', envelope, requestId: 'request-3', force: true },
      rest
    );
    const j = await task.storage.get('job:' + crash.v.id);
    await task.storage.put('job:' + j.id, { ...j, dispatched: true });
    await task.alarm();
    assert.equal(calls, 1);
    assert.equal((await task.storage.get('job:' + j.id)).state, 'failed');
  } finally {
    globalThis.fetch = original;
  }
});
test('rate limit pauses only its own query, resume and cancellation work; cleanup deletes blobs', async () => {
  const ctx = await setup(),
    { register } = await approve(ctx),
    u = register.user.id,
    rest = { user: u, version: 1 };
  ctx.env.DASHEN_ROLE_ID = 'fake-role';
  ctx.env.DASHEN_TOKEN = 'fake-token';
  const task = new UserTasks({ storage: new MemoryStorage() }, ctx.env);
  const start = await internal(task, '/query', { battletag: 'Test#123', limit: 10 }, rest);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ code: 429 }, { status: 429 });
  };
  try {
    await task.alarm();
    await task.alarm();
    assert.equal(calls, 1);
    assert.equal((await internal(task, '/status', { id: start.v.id }, rest)).v.state, 'paused');
    assert.equal((await internal(task, '/resume', { id: start.v.id }, rest)).r.status, 429);
    await internal(task, '/cancel', { id: start.v.id }, rest);
    assert.equal((await internal(task, '/status', { id: start.v.id }, rest)).v.state, 'cancelled');
    const j = await task.storage.get('job:' + start.v.id);
    await task.storage.put('job:' + j.id, { ...j, until: Date.now() - 1 });
    await task.alarm();
    assert.equal(await task.storage.get('job:' + j.id), undefined);
    assert.equal(await getBlob(task.storage, 'data:' + j.id), null);
  } finally {
    globalThis.fetch = original;
  }
});
test('Beijing quota rollover and signing scopes', async () => {
  const ctx = await setup(),
    { register } = await approve(ctx),
    u = register.user.id;
  await ctx.storage.put('usage:' + u, { day: '2000-01-01', query: 10, ai: 100 });
  assert.equal(
    (await internal(ctx.dir, '/quota', { user: u, kind: 'ai', job: 'new-day' })).r.status,
    200
  );
  assert.equal((await ctx.storage.get('usage:' + u)).ai, 1);
  const signed = await signSnapshot(u, snapshot(), ctx.env);
  await assert.rejects(() => verifySnapshot(signed, u, { ...ctx.env, DASHEN_SERVER: '2' }));
  await assert.rejects(() => verifySnapshot(signed, u, ctx.env, 'Other#456'));
});
test('new query after completion refreshes; replay of same request returns previous task', async () => {
  const ctx = await setup(),
    { register } = await approve(ctx),
    task = new UserTasks({ storage: new MemoryStorage() }, ctx.env),
    rest = { user: register.user.id, version: 1 };
  const first = (
    await internal(task, '/query', { battletag: 'Test#123', limit: 10, requestId: 'first' }, rest)
  ).v;
  const j = await task.storage.get('job:' + first.id);
  await task.storage.put('job:' + j.id, { ...j, state: 'done' });
  await task.storage.delete('active:query');
  assert.equal(
    (await internal(task, '/query', { battletag: 'Test#123', limit: 10, requestId: 'first' }, rest))
      .v.id,
    first.id
  );
  const second = (
    await internal(task, '/query', { battletag: 'Test#123', limit: 10, requestId: 'second' }, rest)
  ).v;
  assert.notEqual(second.id, first.id);
});
test('saving quotas of pending or approved player never changes approval status', async () => {
  const ctx = await setup();
  const u = (
    await internal(ctx.dir, '/register', {
      email: 'pending@example.test',
      password: 'player-password'
    })
  ).v;
  const admin = (await internal(ctx.dir, '/admin/login', { password: 'admin-password' })).v,
    rest = { adminToken: admin.token, csrf: admin.csrf, mutation: true };
  const saved = await internal(
    ctx.dir,
    '/admin/quota',
    { id: u.user.id, queryDaily: 7, aiDaily: 100 },
    rest
  );
  assert.equal(saved.r.status, 200);
  assert.equal(saved.v.user.status, 'pending');
  await internal(ctx.dir, '/admin/access', { id: u.user.id, status: 'approved' }, rest);
  const again = await internal(
    ctx.dir,
    '/admin/quota',
    { id: u.user.id, queryDaily: 8, aiDaily: 100 },
    rest
  );
  assert.equal(again.v.user.status, 'approved');
  assert.equal(
    (
      await internal(
        ctx.dir,
        '/admin/quota',
        { id: u.user.id, queryDaily: 9, aiDaily: 100 },
        { userToken: u.token, csrf: u.csrf, mutation: true }
      )
    ).r.status,
    401
  );
});

test('independent task alarms overlap, compact results stay private until completion, hot cache refunds quota', async () => {
  const ctx = await setup();
  ctx.env.DASHEN_ROLE_ID = 'fake-role';
  ctx.env.DASHEN_TOKEN = 'fake-token';
  const a = await approve(ctx),
    b = await approve(ctx, 'b@example.test');
  const tasks = [a, b].map(() => new UserTasks({ storage: new MemoryStorage() }, ctx.env)),
    users = [a, b].map((x) => ({ user: x.register.user.id, version: 1 }));
  const jobs = [];
  for (let i = 0; i < 2; i++) {
    jobs[i] = (
      await internal(tasks[i], '/query', { battletag: 'Main#100', limit: 10 }, users[i])
    ).v;
    const saved = await getBlob(tasks[i].storage, 'data:' + jobs[i].id);
    saved.minIntervalMs = 0;
    await putBlob(tasks[i].storage, 'data:' + jobs[i].id, saved);
    const status = (
      await internal(tasks[i], '/status', { id: jobs[i].id, compact: true }, users[i])
    ).v;
    assert.equal(status.envelope, undefined);
  }
  const mock = service({ delay: 15 }),
    original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    const value = await mock.call(
      ctx.env,
      u.pathname.replace('/v1/a19ld5tool', ''),
      Object.fromEntries(u.searchParams),
      init.body ? JSON.parse(init.body) : undefined
    );
    return Response.json({ code: 0, data: value });
  };
  try {
    await Promise.all(tasks.map((t) => t.alarm()));
    assert.equal(mock.active.max, 6);
    const done = (await internal(tasks[0], '/status', { id: jobs[0].id, compact: true }, users[0]))
      .v;
    assert.equal(done.state, 'done');
    assert.equal(done.result, undefined);
    assert.equal(done.envelope.content.user, users[0].user);
    assert.equal(done.envelope.content.data.matches.length, 10);
    assert.equal((await internal(tasks[1], '/status', { id: jobs[0].id }, users[1])).r.status, 404);
    const restarted = new UserTasks({ storage: tasks[0].storage }, ctx.env),
      warm = (
        await internal(
          restarted,
          '/query',
          { battletag: 'Main#100', limit: 10, envelope: done.envelope, requestId: 'warm' },
          users[0]
        )
      ).v;
    const before = Object.values(mock.counts).reduce((a, b) => a + b, 0);
    await restarted.alarm();
    assert.equal(Object.values(mock.counts).reduce((a, b) => a + b, 0) - before, 1);
    assert.equal((await ctx.storage.get('usage:' + users[0].user)).query, 1);
    const final = (await internal(restarted, '/status', { id: warm.id }, users[0])).v;
    assert.deepEqual(final.result, final.envelope.content.data);
    assert.equal(final.result.syncStatus.cachedOnly, true);
    ctx.env.DASHEN_TOKEN = 'changed-fake-token';
    assert.deepEqual(
      await new UserTasks({ storage: tasks[0].storage }, ctx.env).readAccounts(),
      []
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('alarm checkpoints successful requests across restart; 429 resumes only unfinished work', async () => {
  const ctx = await setup(),
    { register } = await approve(ctx),
    user = { user: register.user.id, version: 1 };
  ctx.env.DASHEN_ROLE_ID = 'fake-role';
  ctx.env.DASHEN_TOKEN = 'fake-token';
  const task = new UserTasks({ storage: new MemoryStorage() }, ctx.env),
    job = (await internal(task, '/query', { battletag: 'Main#100', limit: 10 }, user)).v;
  const initial = await getBlob(task.storage, 'data:' + job.id);
  initial.minIntervalMs = 0;
  await putBlob(task.storage, 'data:' + job.id, initial);
  let limited = false;
  const mock = service({ delay: 8 }),
    original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url),
      p = Object.fromEntries(u.searchParams);
    if (u.pathname.endsWith('queryMatchInfo') && p.matchId === 'm1' && !limited) {
      limited = true;
      return Response.json({ code: 429 }, { status: 429 });
    }
    return Response.json({
      code: 0,
      data: await mock.call(
        ctx.env,
        u.pathname.replace('/v1/a19ld5tool', ''),
        p,
        init.body ? JSON.parse(init.body) : undefined
      )
    });
  };
  try {
    await task.alarm();
    assert.equal((await internal(task, '/status', { id: job.id }, user)).v.state, 'paused');
    const saved = await getBlob(task.storage, 'data:' + job.id);
    assert.ok(saved.mainDone.m0);
    assert.equal(saved.prior, undefined);
    const paused = await task.storage.get('job:' + job.id);
    paused.resumeAfter = 0;
    await task.storage.put('job:' + job.id, paused);
    const restarted = new UserTasks({ storage: task.storage }, ctx.env);
    assert.equal((await internal(restarted, '/resume', { id: job.id }, user)).r.status, 200);
    for (let i = 0; i < 6 && (await task.storage.get('job:' + job.id)).state === 'running'; i++)
      await restarted.alarm();
    assert.equal((await task.storage.get('job:' + job.id)).state, 'done');
    assert.equal(mock.details.filter((id) => id === 'm0').length, 1);
    assert.equal(mock.details.length, 10);
    assert.equal(await getBlob(task.storage, 'prior:' + job.id), null);
    const done = await task.storage.get('job:' + job.id);
    done.until = Date.now() - 1;
    await task.storage.put('job:' + job.id, done);
    await restarted.alarm();
    assert.equal(await getBlob(task.storage, 'result:' + job.id), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('cache handoff survives timeout and restart, ignores tampering and accepts only requested records', async () => {
  const ctx = await setup(),
    a = await approve(ctx),
    b = await approve(ctx, 'b@example.test'),
    u = { user: a.register.user.id, version: 1 };
  ctx.env.DASHEN_ROLE_ID = 'fake-role';
  ctx.env.DASHEN_TOKEN = 'fake-token';
  const task = new UserTasks({ storage: new MemoryStorage() }, ctx.env);
  const snap = snapshot('Test#123');
  snap.matches[0].players[0].res = { rows: [], rankQueriedAt: new Date().toISOString() };
  const records = await mintCacheRecords(u.user, snap, ctx.env),
    m = records.find((r) => r.content.type === 'match');
  const start = (
      await internal(
        task,
        '/query',
        {
          battletag: 'Test#123',
          limit: 1,
          supplementOtherMatches: false,
          cacheManifest: [{ type: 'match', key: 'm1' }]
        },
        u
      )
    ).v,
    original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith('searchBnetAccount')
      ? Response.json({ code: 0, data: { customerToken: 'private' } })
      : Response.json({
          code: 0,
          data: { matchList: [{ matchId: 'm1', beginTs: 100, matchRet: -1, mapGuid: 'map' }] }
        });
  try {
    await task.alarm();
    const waiting = (await internal(task, '/status', { id: start.id }, u)).v;
    assert.equal(waiting.state, 'awaiting-cache');
    assert.ok(waiting.cacheRequest);
    assert.equal(waiting.envelope, undefined);
    assert.equal(
      (
        await internal(
          task,
          '/cache',
          { id: start.id, batch: waiting.cacheRequest.id, records: [m] },
          { user: b.register.user.id, version: 1 }
        )
      ).r.status,
      404
    );
    const job = await task.storage.get('job:' + start.id);
    job.cacheRequest.until = Date.now() - 1;
    await task.storage.put('job:' + start.id, job);
    await task.alarm();
    assert.equal((await task.storage.get('job:' + start.id)).state, 'paused');
    const restarted = new UserTasks({ storage: task.storage }, ctx.env),
      changed = structuredClone(m);
    changed.content.value.game.players[0].stats.kill = 999;
    assert.equal(
      (await internal(restarted, '/cache', { id: start.id, batch: '0'.repeat(64), records: [] }, u))
        .r.status,
      409
    );
    assert.equal(
      (
        await internal(
          restarted,
          '/cache',
          { id: start.id, batch: waiting.cacheRequest.id, records: [changed], complete: false },
          u
        )
      ).r.status,
      200
    );
    let state = await getBlob(task.storage, 'data:' + start.id);
    assert.equal(Object.keys(state.generatedBattles).length, 0);
    assert.equal(
      (
        await internal(
          restarted,
          '/cache',
          { id: start.id, batch: waiting.cacheRequest.id, records: [m] },
          u
        )
      ).r.status,
      200
    );
    state = await getBlob(task.storage, 'data:' + start.id);
    assert.equal(Object.keys(state.generatedBattles).length, 1);
    assert.equal(state.cacheRequest, null);
    assert.equal(
      (
        await internal(
          restarted,
          '/cache',
          { id: start.id, batch: waiting.cacheRequest.id, records: [] },
          u
        )
      ).v.replayed,
      true
    );
    // A legacy whole snapshot is accepted only under its original signature.
    const legacy = await signSnapshot(u.user, snap, ctx.env);
    state.cacheRequest = {
      id: 'a'.repeat(64),
      keys: [{ type: 'profile', key: 'n:Test#123' }],
      until: Date.now() + 15000
    };
    await putBlob(task.storage, 'data:' + start.id, state);
    const latest = await task.storage.get('job:' + start.id);
    await task.storage.put('job:' + start.id, {
      ...latest,
      state: 'awaiting-cache',
      cacheRequest: state.cacheRequest
    });
    assert.equal(
      (
        await internal(
          restarted,
          '/cache',
          { id: start.id, batch: state.cacheRequest.id, records: [], legacyEnvelopes: [legacy] },
          u
        )
      ).r.status,
      200
    );
    state = await getBlob(task.storage, 'data:' + start.id);
    assert.ok(state.profiles['Test#123']);
    assert.equal(state.profiles['Other#124'], undefined);
  } finally {
    globalThis.fetch = original;
  }
});
