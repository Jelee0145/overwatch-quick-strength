import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.mjs';
import { analysisResponseCache } from '../../src/api/v1.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { signSnapshot, putBlob } from '../../src/security.mjs';
import { analysisFixture } from '../services-fixture.mjs';
import { warmHistoryAnalysis } from '../../src/history/response.mjs';
import { createHttpServer } from '../../server/http.mjs';
import http from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

async function setup() {
  const env = {
    PASSWORD_PEPPER: 'fixture-pepper',
    CACHE_SIGNING_KEY: 'fixture-signing',
    API_KEY_ENCRYPTION_KEY: 'fixture-encryption',
    DASHEN_SERVER: '1',
    DASHEN_DTS: '2026'
  };
  const runtime = createRuntime(env, {
    filename: ':memory:',
    assets: { fetch: () => new Response('static') },
    eventsFetch: async () => new Response('', { status: 503 })
  });
  async function internal(path, body = {}, rest = {}) {
    const response = await runtime.env.AUTH.get().fetch('https://auth.internal/', {
      method: 'POST',
      body: JSON.stringify({ path, body, ip: 'fixture', ...rest })
    });
    return { status: response.status, value: await response.json() };
  }
  const registration = (
    await internal('/register', {
      email: 'unified@example.test',
      password: 'fixture-password-long'
    })
  ).value;
  const store = runtime.database.store('auth'),
    record = await store.get('user:' + registration.user.id);
  record.status = 'approved';
  await store.put('user:' + record.id, record);
  const key = (
    await internal(
      '/api-key',
      { action: 'regenerate' },
      { userToken: registration.token, csrf: registration.csrf, mutation: true }
    )
  ).value.key;
  const request = (
    path,
    { method = 'GET', body, bearer = false, csrf = true, origin = true, headers = {} } = {}
  ) =>
    worker.fetch(
      new Request('https://site.test' + path, {
        method,
        headers: {
          ...(bearer
            ? { Authorization: 'Bearer ' + key }
            : { Cookie: 'qs_session=' + registration.token }),
          ...(method === 'POST'
            ? {
                'Content-Type': 'application/json',
                ...(origin ? { Origin: 'https://site.test' } : {}),
                ...(!bearer && csrf ? { 'X-CSRF-Token': registration.csrf } : {})
              }
            : {}),
          ...headers
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      }),
      runtime.env
    );
  return { runtime, registration, key, request, internal };
}
test('Cookie and Bearer share authenticated API history and analysis while cookie writes require CSRF', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  assert.equal(
    (
      await ctx.request('/api/v1/history', {
        method: 'POST',
        body: { action: 'list' },
        csrf: false
      })
    ).status,
    403
  );
  assert.equal(
    (
      await ctx.request('/api/v1/history', {
        method: 'POST',
        body: { action: 'list' },
        origin: false
      })
    ).status,
    403
  );
  const raw = analysisFixture(),
    envelope = await signSnapshot(ctx.registration.user.id, raw, ctx.runtime.env);
  const pushed = await ctx.request('/api/v1/history', {
    method: 'POST',
    body: { action: 'push', envelopes: [envelope] }
  });
  assert.equal(pushed.status, 200, await pushed.text());
  const web = await (await ctx.request('/api/v1/history/accounts')).json(),
    bot = await (await ctx.request('/api/v1/history/accounts', { bearer: true })).json();
  assert.deepEqual(web, bot);
  assert.equal(web.accounts[0].tag, raw.battletag);
  const body = { battletag: raw.battletag, options: { statisticsRange: 'all' } };
  const left = await ctx.request('/api/v1/history/analysis', { method: 'POST', body }),
    right = await ctx.request('/api/v1/history/analysis', { method: 'POST', body, bearer: true });
  assert.equal(left.status, 200);
  assert.deepEqual(await left.json(), await right.json());
  const conflictingKey = await ctx.request('/api/v1/query', {
    method: 'POST',
    body: { battletag: 'Main#100', requestId: 'one', idempotencyKey: 'two' }
  });
  assert.equal(conflictingKey.status, 409);
  assert.equal((await conflictingKey.json()).code, 'CONFLICT');
  const stale = await ctx.request('/api/v1/history/analysis', {
    method: 'POST',
    body: { ...body, revision: '0'.repeat(64) }
  });
  assert.equal(stale.status, 409);
  const auth = await ctx.request('/api/v1/auth/session');
  assert.equal(auth.status, 200);
  assert.equal((await auth.json()).user.id, ctx.registration.user.id);
  const page = await ctx.request('/api/internal/page-session');
  assert.equal(page.status, 204);
  const anonymous = await worker.fetch(
    new Request('https://site.test/api/internal/page-session'),
    ctx.runtime.env
  );
  assert.equal(anonymous.status, 401);
});

test('query prewarming populates the exact slim response; changing range reuses authenticated object context', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  const user = ctx.registration.user.id,
    raw = analysisFixture(),
    envelope = await signSnapshot(user, raw, ctx.runtime.env);
  const instance = ctx.runtime.instance('tasks:' + user);
  await instance.history.handle(user, { action: 'push', envelopes: [envelope] });
  const options = {
    side: 'all',
    strategy: 'role',
    estimate: true,
    pool: '',
    statisticsRange: 'all'
  };
  await warmHistoryAnalysis(user, ctx.runtime.env, instance.history, raw.battletag, options);
  const original = instance.history.handle.bind(instance.history);
  let pulls = 0;
  instance.history.handle = (user, body) => {
    if (body.action === 'pull') pulls++;
    return original(user, body);
  };
  for (const selection of [
    options,
    { ...options, start: 0, statisticsRange: '5' },
    { ...options, start: 2, statisticsRange: '10' }
  ]) {
    const response = await ctx.request('/api/v1/history/analysis', {
      method: 'POST',
      body: { battletag: raw.battletag, slim: true, options: selection }
    });
    assert.equal(response.status, 200);
  }
  assert.equal(pulls, 0, 'warm responses and object contexts bypass archive IO');
});

test('standalone HTTP serves negotiated cached gzip/brotli bytes with Vary and leaves auth failures unencoded', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  const raw = analysisFixture(),
    envelope = await signSnapshot(ctx.registration.user.id, raw, ctx.runtime.env);
  await ctx.request('/api/v1/history', {
    method: 'POST',
    body: { action: 'push', envelopes: [envelope] }
  });
  const server = createHttpServer(ctx.runtime, { origin: 'http://site.test', allowLoopback: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = (encoding, key = ctx.key) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ battletag: raw.battletag, slim: true });
      const request = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/api/v1/history/analysis',
          method: 'POST',
          headers: {
            Host: 'site.test',
            'Content-Type': 'application/json',
            'Accept-Encoding': encoding,
            Authorization: 'Bearer ' + key
          }
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks)
            })
          );
        }
      );
      request.on('error', reject);
      request.end(body);
    });
  const plain = await send('identity');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  for (const encoding of ['gzip', 'br']) {
    const first = await send(encoding),
      second = await send(encoding);
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-encoding'], encoding);
    assert.match(first.headers.vary, /Accept-Encoding/);
    assert.deepEqual(first.body, second.body);
    assert.deepEqual(
      encoding === 'gzip' ? gunzipSync(first.body) : brotliDecompressSync(first.body),
      plain.body
    );
  }
  assert.equal((await send('*;q=0')).status, 406);
  const denied = await send('br', 'invalid');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['content-encoding'], undefined);
});
test('unified API rejects conflicting identities and backend-only mode serves no webpage assets', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  const other = (
    await ctx.internal('/register', {
      email: 'other-unified@example.test',
      password: 'fixture-password-long'
    })
  ).value;
  const response = await ctx.request('/api/v1/account', {
    bearer: true,
    headers: { Cookie: 'qs_session=' + other.token }
  });
  assert.ok([401, 403].includes(response.status));
  ctx.runtime.env.BACKEND_ONLY = true;
  assert.equal((await ctx.request('/')).status, 404);
  assert.equal((await ctx.request('/api/health')).status, 200);
});

test('completed query analysis survives archive failure, retains references and rejects other owners', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  const id = 'a'.repeat(64),
    raw = analysisFixture(),
    envelope = await signSnapshot(ctx.registration.user.id, raw, ctx.runtime.env),
    store = ctx.runtime.database.store('tasks:' + ctx.registration.user.id);
  await store.put('job:' + id, {
    id,
    user: ctx.registration.user.id,
    version: 1,
    kind: 'query',
    state: 'done',
    until: Date.now() + 60000,
    archiveWarning: '云端历史空间已满'
  });
  await putBlob(store, 'result:' + id, envelope);
  const response = await ctx.request('/api/v1/jobs/' + id + '/analysis', {
    method: 'POST',
    body: { battletag: raw.battletag, options: { statisticsRange: '5' } }
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.matches.length, raw.matches.length);
  assert.equal(view.sourceJob, id);
  assert.match(view.archiveWarning, /空间已满/);
  assert.equal(view.matchRefs[0].sourceJob, id);
  const detail = await ctx.request('/api/v1/matches/detail', {
    method: 'POST',
    body: { ref: view.matchRefs[0] }
  });
  assert.equal(detail.status, 200);
  const stale = await ctx.request('/api/v1/matches/detail', {
    method: 'POST',
    body: { ref: { ...view.matchRefs[0], revision: '0'.repeat(64) } }
  });
  assert.equal(stale.status, 409);
  const absent = await ctx.request('/api/v1/history/accounts');
  assert.deepEqual((await absent.json()).accounts, []);
  const other = (
      await ctx.internal('/register', {
        email: 'job-other@example.test',
        password: 'fixture-password-long'
      })
    ).value,
    auth = ctx.runtime.database.store('auth'),
    record = await auth.get('user:' + other.user.id);
  record.status = 'approved';
  await auth.put('user:' + record.id, record);
  const denied = await ctx.request('/api/v1/jobs/' + id + '/analysis', {
    method: 'POST',
    body: {},
    headers: { Cookie: 'qs_session=' + other.token, 'X-CSRF-Token': other.csrf }
  });
  assert.equal(denied.status, 404);
});

test('a repeated analysis window is served from the revision cache and follows new batches', async (t) => {
  analysisResponseCache.clear();
  const ctx = await setup();
  t.after(() => ctx.runtime.close());
  const raw = analysisFixture(),
    envelope = await signSnapshot(ctx.registration.user.id, raw, ctx.runtime.env);
  const pushed = await ctx.request('/api/v1/history', {
    method: 'POST',
    body: { action: 'push', envelopes: [envelope] }
  });
  assert.equal(pushed.status, 200);
  const body = { battletag: raw.battletag, slim: true, options: { statisticsRange: 'all' } };
  const before = analysisResponseCache.stats().entries;
  const first = await (
    await ctx.request('/api/v1/history/analysis', { method: 'POST', body })
  ).text();
  assert.equal(analysisResponseCache.stats().entries, before + 1);
  const second = await (
    await ctx.request('/api/v1/history/analysis', { method: 'POST', body })
  ).text();
  assert.equal(second, first);
  assert.equal(analysisResponseCache.stats().entries, before + 1, 'a repeat window adds no entry');
  const later = await signSnapshot(
    ctx.registration.user.id,
    { ...raw, queriedAt: '2026-10-16T00:00:00Z' },
    ctx.runtime.env
  );
  await ctx.request('/api/v1/history', {
    method: 'POST',
    body: { action: 'push', envelopes: [later] }
  });
  const third = await (
    await ctx.request('/api/v1/history/analysis', { method: 'POST', body })
  ).text();
  assert.notEqual(third, first, 'a new batch changes the revision and must not reuse stale bytes');
  assert.equal(analysisResponseCache.stats().entries, before + 2);
});
