import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstream } from '../../backend/src/adapters/dashen.mjs';
import { createScheduler } from '../../backend/src/services/scheduler.mjs';

const settings = {
  DASHEN_TOKEN: 'fixture-token',
  DASHEN_ROLE_ID: 'fixture-role',
  DASHEN_DTS: '2026',
  DASHEN_SERVER: '1'
};
function spy({ status = 200, body = { code: 0, data: {} }, headers = {} } = {}) {
  const seen = [];
  const fetcher = async (url, init, priority) => {
    seen.push({ url, init, priority });
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fetcher, seen };
}

test('upstream requests carry their priority class into the transport', async () => {
  const priorities = [];
  for (const priority of ['high', 'low', undefined]) {
    const { fetcher, seen } = spy();
    await upstream({ ...settings }, '/customer/queryMatchInfo', { matchId: 'm1' }, undefined, {
      fetcher,
      priority
    });
    priorities.push(seen[0].priority);
  }
  assert.deepEqual(priorities, ['high', 'low', 'normal']);
});

test('a refused request pauses the whole schedule and honours Retry-After', async () => {
  for (const [headers, expected] of [
    [{}, 3000],
    [{ 'Retry-After': '12' }, 12000],
    [{ 'Retry-After': 'abc' }, 3000]
  ]) {
    const scheduler = createScheduler({ ratePerSecond: 8, burst: 1 }),
      { fetcher } = spy({ status: 429, body: { code: 429 }, headers });
    await assert.rejects(
      () =>
        upstream(
          { ...settings, UPSTREAM_SCHEDULER: scheduler },
          '/searchBnetAccount',
          null,
          {},
          { fetcher }
        ),
      (error) => error.status === 429
    );
    assert.ok(scheduler.stats().holdMs >= expected - 50, 'hold ' + scheduler.stats().holdMs);
    assert.equal(scheduler.stats().tokens, 0);
  }
});

test('a rate limit signalled in the body with HTTP 200 also pauses the schedule', async () => {
  const scheduler = createScheduler({ ratePerSecond: 8, burst: 1 }),
    { fetcher } = spy({ status: 200, body: { code: 429 }, headers: { 'Retry-After': '5' } });
  await assert.rejects(
    () =>
      upstream(
        { ...settings, UPSTREAM_SCHEDULER: scheduler },
        '/customer/queryMatchList',
        {},
        undefined,
        { fetcher }
      ),
    (error) => error.status === 429
  );
  assert.ok(scheduler.stats().holdMs >= 4950);
});

test('a successful request clears nothing it should not and never throws the credentials', async () => {
  const scheduler = createScheduler({ ratePerSecond: 8, burst: 2 }),
    { fetcher, seen } = spy({ body: { code: 0, data: { customerToken: 'ct', matchList: [] } } });
  const value = await upstream(
    { ...settings, UPSTREAM_SCHEDULER: scheduler },
    '/searchBnetAccount',
    null,
    { name: 'Main#100' },
    { fetcher, priority: 'high' }
  );
  assert.deepEqual(value, { customerToken: 'ct', matchList: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].priority, 'high');
  // The platform fetch must never receive a field it does not understand.
  assert.deepEqual(Object.keys(seen[0].init).sort(), [
    'body',
    'headers',
    'method',
    'redirect',
    'signal'
  ]);
  // A body makes the search a POST; list and detail reads stay GET requests.
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(scheduler.stats().holdMs, 0);
  // The adapter still rejects an upstream error without pausing the schedule.
  await assert.rejects(
    () =>
      upstream(
        { ...settings, UPSTREAM_SCHEDULER: scheduler },
        '/customer/queryMatchInfo',
        {},
        undefined,
        { fetcher: spy({ status: 401 }).fetcher }
      ),
    (error) => error.status === 503
  );
  assert.equal(scheduler.stats().holdMs, 0);
});
