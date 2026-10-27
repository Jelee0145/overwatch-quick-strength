import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../server/runtime.mjs';
import { createHttpServer } from '../../server/http.mjs';
import { passwordHash } from '../../src/security.mjs';

test('admin hot switch and daily probes reach sessions and Bot admission through HTTP', async () => {
  const origin = 'https://owqs.test',
    config = {
      PASSWORD_PEPPER: 'fixture-pepper',
      CACHE_SIGNING_KEY: 'fixture-sign',
      API_KEY_ENCRYPTION_KEY: 'fixture-encrypt',
      DASHEN_TOKEN: 'private-report-token',
      DASHEN_ROLE_ID: 'private-role',
      DASHEN_SERVER: '1',
      DASHEN_DTS: '2026',
      QUERY_PROBE_TAG: 'daze#51307'
    };
  config.ADMIN_PASSWORD_HASH = JSON.stringify(
    await passwordHash('admin-password', config.PASSWORD_PEPPER)
  );
  let now = Date.parse('2100-10-27T00:00:00Z'),
    response = { code: 0, data: { name: 'daze#51307', customerToken: 'private-customer-token' } };
  const seen = [],
    runtime = createRuntime(config, {
      filename: ':memory:',
      assets: { fetch: async () => new Response('', { status: 404 }) },
      upstreamFetch: async (url, init) => {
        seen.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
        return Response.json(response);
      }
    });
  runtime.env.QUERY_CONTROL.now = () => now;
  await runtime.ready;
  const control = runtime.env.QUERY_CONTROL,
    server = createHttpServer(runtime, { origin, allowLoopback: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function api(path, { body, cookie = '', csrf = '', bearer = '', source = origin } = {}) {
    const r = await fetch(base + '/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { Origin: source, 'Content-Type': 'application/json' }),
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { r, value: await r.json(), cookie: r.headers.get('Set-Cookie')?.split(';')[0] };
  }
  try {
    const admin = await api('admin/login', { body: { password: 'admin-password' } }),
      player = await api('auth/register', {
        body: { email: 'control@example.test', password: 'player-password' }
      }),
      administrator = { cookie: admin.cookie, csrf: admin.value.csrf };
    assert.equal((await api('admin/query-control')).r.status, 401);
    assert.equal((await api('admin/query-control', { cookie: player.cookie })).r.status, 401);
    assert.equal(
      (await api('admin/query-control', { cookie: admin.cookie, body: { mode: 'paused' } })).r
        .status,
      403
    );
    assert.equal(
      (
        await api('admin/query-control', {
          ...administrator,
          source: 'https://attacker.test',
          body: { mode: 'paused' }
        })
      ).r.status,
      403
    );
    assert.equal(
      (await api('admin/query-control', { ...administrator, body: { mode: 'open' } })).r.status,
      400
    );
    await api('admin/access', {
      ...administrator,
      body: { id: player.value.user.id, status: 'approved' }
    });
    const key = await api('auth/api-key', {
      cookie: player.cookie,
      csrf: player.value.csrf,
      body: { action: 'regenerate' }
    });
    await control.alarm();
    assert.equal(control.snapshot().verdict, 'healthy');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/v1/a19ld5tool/searchBnetAccount');
    assert.equal(seen[0].body.name, 'daze#51307');
    assert.equal(
      (await api('account', { bearer: key.value.key })).value.capabilities.queries,
      true
    );
    const paused = await api('admin/query-control', { ...administrator, body: { mode: 'paused' } });
    assert.equal(paused.value.suspended, true);
    assert.ok(!JSON.stringify(paused.value).includes('private-'));
    assert.equal(
      (await api('auth/session', { cookie: player.cookie })).value.capabilities.queries,
      false
    );
    const blocked = await api('query', {
      bearer: key.value.key,
      body: { battletag: 'daze#51307', limit: 5 }
    });
    assert.equal(blocked.r.status, 200);
    assert.equal(blocked.value.state, 'suspended');
    assert.equal(blocked.value.quota, 'none');
    const task = runtime.instance('tasks:' + player.value.user.id);
    assert.equal((await task.storage.list({ prefix: 'job:' })).size, 0);
    assert.equal((await runtime.database.store('auth').list({ prefix: 'quota:' })).size, 0);
    assert.equal(seen.length, 1);
    now += 86400000;
    await control.alarm();
    assert.equal(control.snapshot().suspended, true);
    await api('admin/query-control', { ...administrator, body: { mode: 'auto' } });
    assert.equal(
      (await api('account', { bearer: key.value.key })).value.capabilities.queries,
      true
    );
    response = { code: 0, success: true, data: null };
    now += 86400000;
    await control.alarm();
    assert.equal(
      (await api('account', { bearer: key.value.key })).value.capabilities.queries,
      false
    );
    response = { code: 401, success: false };
    now += 86400000;
    await control.alarm();
    assert.equal(control.snapshot().suspended, true);
    assert.equal(control.snapshot().verdict, 'credential-error');
    response = { code: 0, data: { name: 'DaZe#51307', customerToken: 'private-customer-token' } };
    now += 86400000;
    await control.alarm();
    assert.equal(
      (await api('auth/session', { cookie: player.cookie })).value.capabilities.queries,
      true
    );
    assert.ok(
      [...(await runtime.database.store('auth').list({ prefix: 'audit:' }))].some(
        ([, row]) => row.action === 'query-control:paused'
      )
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  }
});
