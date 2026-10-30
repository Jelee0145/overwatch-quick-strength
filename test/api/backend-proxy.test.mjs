import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { createHttpServer } from '../../server/http.mjs';
import { passwordHash } from '../../src/security.mjs';
import { AuthDirectory } from '../../src/actors/auth.mjs';
import { UserTasks } from '../../src/actors/tasks.mjs';
import { EventCenter } from '../../src/events/center.mjs';

const cfOrigin = 'https://cf.example.test';
function request(path, { body, cookie, csrf, origin = cfOrigin, headers = {} } = {}) {
  return new Request(cfOrigin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...headers,
      ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
function unavailableBinding() {
  throw Error('Local DO must never be accessed');
}
const localBindings = {
  AUTH: { get: unavailableBinding },
  TASKS: { get: unavailableBinding },
  EVENTS: { get: unavailableBinding }
};

test('Cloudflare proxy authenticates cookies and CSRF against a real synthetic Node server', async () => {
  const config = {
    PASSWORD_PEPPER: '{{SECRET_fmqcutzo}}',
    CACHE_SIGNING_KEY: 'synthetic-sign',
    API_KEY_ENCRYPTION_KEY: 'synthetic-encryption'
  };
  config.ADMIN_PASSWORD_HASH = JSON.stringify(
    await passwordHash('proxy-admin', config.PASSWORD_PEPPER)
  );
  const runtime = createRuntime(config, { filename: ':memory:' });
  await runtime.ready;
  const portProbe = createHttpServer(runtime, { origin: 'http://127.0.0.1' });
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const backend = 'http://127.0.0.1:' + port;
  const server = createHttpServer(runtime, { origin: backend });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const seen = [];
  const env = {
    ...localBindings,
    API_ORIGIN: backend,
    ASSETS: {
      fetch: async (req) =>
        new Response(new URL(req.url).pathname, { headers: { 'Content-Type': 'text/html' } })
    },
    BACKEND_FETCH: (url, init) => {
      seen.push({ url: String(url), init });
      return fetch(url, init);
    }
  };
  async function call(path, options) {
    const response = await worker.fetch(request(path, options), env);
    const text = await response.text();
    return {
      response,
      value: text ? JSON.parse(text) : null,
      cookie: response.headers.get('Set-Cookie')?.split(';')[0]
    };
  }
  try {
    const admin = await call('/api/v1/admin/login', { body: { password: 'proxy-admin' } });
    assert.equal(admin.response.status, 200);
    assert.match(admin.cookie, /^qs_admin=/);
    assert.match(admin.response.headers.get('Set-Cookie'), /HttpOnly/);
    assert.ok(!admin.response.headers.get('Set-Cookie').includes('Domain='));
    assert.equal(admin.response.headers.get('Cache-Control'), 'no-store');
    const player = await call('/api/auth/register', {
      body: { email: 'proxy@example.test', password: 'proxy-player' }
    });
    assert.equal(player.response.status, 200);
    const adminOptions = { cookie: admin.cookie, csrf: admin.value.csrf };
    const denied = await call('/api/v1/admin/query-control', {
      cookie: admin.cookie,
      body: { mode: 'paused' }
    });
    assert.equal(denied.response.status, 403);
    await call('/api/v1/admin/access', {
      ...adminOptions,
      body: { id: player.value.user.id, status: 'approved' }
    });
    await call('/api/v1/admin/query-control', { ...adminOptions, body: { mode: 'paused' } });
    const session = await call('/api/v1/auth/session', { cookie: player.cookie });
    assert.equal(session.value.capabilities.queries, false);
    const job = await call('/api/v1/query', {
      cookie: player.cookie,
      csrf: player.value.csrf,
      body: { battletag: 'Proxy#1234', limit: 5 }
    });
    assert.equal(job.value.state, 'suspended');
    assert.equal((await call('/api/latest', { cookie: player.cookie })).response.status, 200);
    assert.equal((await call('/api/v1/health')).value.ok, true);
    assert.ok(seen.some((entry) => entry.url.endsWith('/api/v1/health')));
    const page = await worker.fetch(request('/tools/strength', { cookie: player.cookie }), env);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '/tools/strength.html');
    assert.ok(seen.some((entry) => entry.url.endsWith('/api/v1/auth/session')));
    const gate = await worker.fetch(
      request('/api/internal/page-session', { cookie: player.cookie }),
      env
    );
    assert.equal(gate.status, 204);
    const anonymous = await worker.fetch(request('/tools/strength'), env);
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('Location'), /^https:\/\/cf.example.test\/login/);
    const before = seen.length;
    assert.equal(
      (
        await call('/api/v1/admin/query-control', {
          ...adminOptions,
          origin: 'https://evil.test',
          body: { mode: 'auto' }
        })
      ).response.status,
      403
    );
    assert.equal(seen.length, before);
    for (const path of [
      '/api/internal/private',
      '/api/v1/internal/private',
      '/api/%69nternal/private'
    ])
      assert.equal((await call(path)).response.status, 404);
    assert.equal(seen.length, before);
    await call('/api/v1/admin/query-control', { ...adminOptions, body: { mode: 'auto' } });
    assert.equal(
      (await call('/api/auth/session', { cookie: player.cookie })).value.capabilities.queries,
      true
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  }
});

test('proxy fixes target, strips forwarding identity, preserves all cookies and never follows redirects', async () => {
  let seen,
    calls = 0;
  const env = {
    ...localBindings,
    API_ORIGIN: 'https://backend.example:8443',
    BACKEND_FETCH: async (url, init) => {
      calls++;
      seen = { url, init };
      const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      });
      headers.append('Set-Cookie', 'one=1; Path=/; HttpOnly');
      headers.append('Set-Cookie', 'two=2; Path=/; HttpOnly');
      return new Response('{}', { headers });
    }
  };
  const response = await worker.fetch(
    request('/api/v1/admin/query-control?target=https://evil.test', {
      body: { mode: 'paused' },
      cookie: 'qs_admin=synthetic',
      csrf: 'synthetic-csrf',
      headers: {
        Host: 'evil.test',
        'X-Forwarded-For': '1.2.3.4',
        Forwarded: 'for=1.2.3.4',
        'CF-Connecting-IP': '1.2.3.4',
        'X-Real-IP': '1.2.3.4',
        Authorization: 'Bearer synthetic'
      }
    }),
    env
  );
  assert.equal(seen.url.origin, env.API_ORIGIN);
  assert.equal(seen.init.headers.get('Origin'), env.API_ORIGIN);
  assert.equal(seen.init.headers.get('Cookie'), 'qs_admin=synthetic');
  assert.equal(seen.init.headers.get('X-CSRF-Token'), 'synthetic-csrf');
  assert.equal(seen.init.headers.get('Authorization'), 'Bearer synthetic');
  for (const key of ['host', 'x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip'])
    assert.equal(seen.init.headers.has(key), false);
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const badFormat = new Request(cfOrigin + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: cfOrigin, 'Content-Type': 'text/plain' },
    body: '{}'
  });
  assert.equal((await worker.fetch(badFormat, env)).status, 403);
  assert.equal(calls, 1);
  env.BACKEND_FETCH = async () =>
    new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
  assert.equal((await worker.fetch(request('/api/v1/account'), env)).status, 502);
  env.BACKEND_FETCH = async () => {
    throw Error('private provider failure');
  };
  const failure = await worker.fetch(request('/tools/strength'), env);
  assert.equal(failure.status, 502);
  assert.ok(!(await failure.text()).includes('private provider'));
  env.BACKEND_FETCH = async () => new Response('unavailable', { status: 503 });
  assert.equal((await worker.fetch(request('/api/v1/health'), env)).status, 503);
});

test('proxy mode cron and old Durable Object alarms leave local data untouched', async () => {
  const env = { ...localBindings, API_ORIGIN: 'https://backend.example:8443' };
  await worker.scheduled({}, env, { waitUntil: unavailableBinding });
  const storage = new Proxy({}, { get: unavailableBinding });
  await new AuthDirectory({ storage }, env).alarm();
  await new UserTasks({ storage }, env).alarm();
  await new EventCenter({ storage }, env).alarm();
});
