import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.mjs';
import { AuthDirectory } from '../../src/actors/auth.mjs';
import { UserTasks } from '../../src/actors/tasks.mjs';
import { MemoryStorage } from '../helpers/storage.mjs';

// Durable Object bindings, without the Node-only env.QUERY_CONTROL injection.
test('Cloudflare persists hot control and probes while sharing its auth cleanup alarm', async () => {
  const storage = new MemoryStorage(),
    tasks = new Map(),
    env = {
      QUERY_SUSPENDED: 'true',
      PASSWORD_PEPPER: 'synthetic-pepper',
      CACHE_SIGNING_KEY: 'synthetic-sign',
      QUERY_PROBE_TAG: 'probe#1234',
      DASHEN_TOKEN: 'synthetic-token',
      DASHEN_ROLE_ID: 'synthetic-role',
      DASHEN_SERVER: '1',
      DASHEN_DTS: '2026'
    };
  let auth = new AuthDirectory({ storage }, env);
  env.AUTH = {
    idFromName: (n) => n,
    get: () => ({ fetch: (url, init) => auth.fetch(new Request(url, init)) })
  };
  env.TASKS = {
    idFromName: (n) => n,
    get: (id) => ({
      fetch: (url, init) => {
        if (!tasks.has(id)) tasks.set(id, new UserTasks({ storage: new MemoryStorage() }, env));
        return tasks.get(id).fetch(new Request(url, init));
      }
    })
  };
  await auth.init();
  const user = {
    id: 'cf-user',
    email: 'cf@example.test',
    status: 'approved',
    version: 1,
    queryDaily: 100,
    aiDaily: 100
  };
  await storage.put('user:' + user.id, user);
  const admin = await auth.issue(null, true),
    player = await auth.issue(user);
  async function api(path, body, session = admin) {
    const isAdmin = session === admin;
    const r = await worker.fetch(
      new Request('https://cf.test/api/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: (isAdmin ? 'qs_admin=' : 'qs_session=') + session.token,
          Origin: 'https://cf.test',
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrf
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      }),
      env
    );
    assert.equal(r.status, 200, path);
    return r.json();
  }
  assert.equal((await api('account', null, player)).capabilities.queries, true);
  assert.equal((await api('admin/query-control', { mode: 'paused' })).forced, false);
  assert.equal((await api('auth/session', null, player)).capabilities.queries, false);
  assert.equal(
    (await api('query', { battletag: 'probe#1234', limit: 5 }, player)).state,
    'suspended'
  );
  assert.equal((await tasks.get(user.id).storage.list({ prefix: 'job:' })).size, 0);
  assert.equal((await storage.list({ prefix: 'quota:' })).size, 0);
  auth = new AuthDirectory({ storage }, env);
  await auth.init();
  assert.equal((await api('admin/query-control')).manual, 'paused');
  await api('admin/query-control', { mode: 'auto' });
  assert.equal((await api('account', null, player)).capabilities.queries, true);
  const control = auth.queryControl;
  let now = Date.parse('2100-10-27T00:00:00Z'),
    calls = 0,
    response = { name: 'probe#1234', customerToken: 'synthetic-customer' };
  control.now = () => now;
  control.call = async () => {
    calls++;
    return response;
  };
  await storage.put('rate:expired', { until: 1 });
  await auth.alarm();
  await auth.alarm();
  assert.equal(calls, 1);
  assert.equal(await storage.get('rate:expired'), undefined);
  const deadline = await storage.getAlarm();
  await auth.init();
  assert.equal(await storage.getAlarm(), deadline, 'init must not postpone an existing alarm');
  assert.ok(deadline <= Date.now() + 3600000);
  now += 86400000;
  response = null;
  await auth.alarm();
  assert.equal((await api('account', null, player)).capabilities.queries, false);
  auth = new AuthDirectory({ storage }, env);
  await auth.init();
  assert.equal(auth.queryControl.snapshot().autoSuspended, true);
  auth.queryControl.now = () => now;
  auth.queryControl.call = async () => {
    calls++;
    return response;
  };
  await auth.alarm();
  assert.equal(calls, 2, 'restart preserves the daily claim');
  now += 86400000;
  response = { name: 'PROBE#1234', customerToken: 'synthetic-customer' };
  await auth.alarm();
  assert.equal((await api('auth/session', null, player)).capabilities.queries, true);
  assert.equal((await api('admin/query-control')).supported, true);
  assert.equal(env.QUERY_CONTROL, undefined);
});
