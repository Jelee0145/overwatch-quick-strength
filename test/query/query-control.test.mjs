import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueryControl, queryCheckSchedule } from '../../server/query-control.mjs';
import { SqliteDatabase } from '../../server/storage.mjs';
import { MemoryStorage } from '../helpers/storage.mjs';
import { Fault } from '../../src/security.mjs';
import { querySuspended } from '../../src/query/suspension.mjs';

const DAY = 86400000,
  date = Date.parse('2100-10-27T00:00:00Z'),
  config = {
    QUERY_PROBE_TAG: 'daze#51307',
    DASHEN_TOKEN: 'private-report-token',
    DASHEN_ROLE_ID: 'private-role',
    DASHEN_SERVER: '1',
    DASHEN_DTS: '2026'
  };
async function fixture(options = {}) {
  let now = options.now ?? date,
    response = { name: 'daze#51307', customerToken: 'private-customer-token' };
  const env = { ...config, ...options.config },
    seen = [],
    control = new QueryControl(options.storage || new MemoryStorage(), env, {
      now: () => now,
      call: async (...args) => {
        seen.push(args);
        if (response instanceof Error) throw response;
        return response;
      }
    });
  env.QUERY_CONTROL = control;
  await control.recover();
  return {
    control,
    env,
    seen,
    time(value) {
      now = value;
    },
    reply(value) {
      response = value;
    },
    async next(value) {
      now += DAY;
      response = value;
      await control.alarm();
    }
  };
}

test('08:00 Beijing schedule waits before the deadline and catches up once after it', async () => {
  const f = await fixture({ now: date - 1 });
  assert.deepEqual(queryCheckSchedule(date - 1), { day: date / DAY, due: date });
  assert.equal(await f.control.storage.getAlarm(), date);
  await f.control.alarm();
  assert.equal(f.seen.length, 0);
  f.time(date + 3600000);
  await f.control.alarm();
  await f.control.alarm();
  assert.equal(f.seen.length, 1);
  assert.equal(f.control.snapshot().nextCheckAt, date + DAY);
  const [env, endpoint, params, body, settings] = f.seen[0];
  assert.equal(env, f.env);
  assert.equal(endpoint, '/searchBnetAccount');
  assert.equal(params, null);
  assert.equal(body.name, 'daze#51307');
  assert.equal(settings.priority, 'low');
  assert.ok(!JSON.stringify(f.control.snapshot()).includes('private-'));
  assert.ok(!JSON.stringify(await f.control.storage.get('state')).includes('private-'));
});

test('unverified empty response preserves availability; verified empty pauses and healthy recovers', async () => {
  const f = await fixture();
  f.reply(null);
  await f.control.alarm();
  assert.equal(f.control.snapshot().verdict, 'empty-unverified');
  assert.equal(querySuspended(f.env), false);
  await f.next({ name: 'DaZe#51307', customerToken: 'private-customer-token' });
  assert.equal(f.control.snapshot().verified, true);
  await f.next(undefined);
  assert.equal(querySuspended(f.env), true);
  await f.next({ name: 'daze#51307', customerToken: 'private-customer-token' });
  assert.equal(querySuspended(f.env), false);
});

test('only empty success changes verified state; uncertain errors never reopen or close it', async () => {
  const f = await fixture();
  await f.control.alarm();
  for (const paused of [false, true]) {
    if (paused) await f.next({});
    for (const response of [
      { name: 'other#51307', customerToken: 'wrong-token' },
      { name: 'daze#99999', customerToken: 'wrong-token' },
      { customerToken: 'private-customer-token' },
      { name: 'daze#51307', customerToken: '' },
      'unexpected',
      new Fault('private-provider-message', 429),
      new Fault('private-provider-message', 503),
      new Fault('private-provider-message', 504),
      new Fault('private-provider-message', 502),
      new TypeError('private-provider-message')
    ]) {
      await f.next(response);
      assert.equal(querySuspended(f.env), paused);
      assert.ok(!JSON.stringify(f.control.snapshot()).includes('private-'));
    }
  }
});

test('runtime hot control ignores legacy config; manual pause outranks healthy probes', async () => {
  const f = await fixture({ config: { QUERY_SUSPENDED: 'true' } });
  await f.control.setManual('paused');
  await f.control.alarm();
  assert.equal(querySuspended(f.env), true);
  await f.control.setManual('auto');
  assert.equal(querySuspended(f.env), false);
  assert.equal(f.control.snapshot().forced, false);
  await f.control.setManual('auto');
  assert.equal(querySuspended(f.env), false);
  await f.next(null);
  await f.control.setManual('paused');
  await f.control.setManual('auto');
  assert.equal(querySuspended(f.env), true);
  await assert.rejects(f.control.setManual('open'), /模式无效/);
});

test('manual pause during an in-flight healthy probe is preserved', async () => {
  const f = await fixture();
  let finish, started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  f.control.call = async () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const work = f.control.alarm();
  await waiting;
  await f.control.setManual('paused');
  finish({ name: 'daze#51307', customerToken: 'private-customer-token' });
  await work;
  assert.equal(querySuspended(f.env), true);
  assert.equal(f.control.snapshot().verdict, 'healthy');
});

test('missing config and a changed probe scope cannot use an old baseline', async () => {
  const f = await fixture({ config: { QUERY_PROBE_TAG: '' } });
  await f.control.alarm();
  assert.equal(f.seen.length, 0);
  assert.equal(f.control.snapshot().verdict, 'probe-not-configured');
  f.env.QUERY_PROBE_TAG = 'daze#51307';
  await f.next({ name: 'daze#51307', customerToken: 'private-customer-token' });
  f.env.QUERY_PROBE_TAG = 'other#1234';
  await f.next(null);
  assert.equal(f.control.snapshot().verified, false);
  assert.equal(f.control.snapshot().verdict, 'empty-unverified');
  assert.equal(querySuspended(f.env), false);
});

test('SQLite restart preserves control and daily claim, including interruption during a probe', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-query-control-')),
    filename = path.join(dir, 'state.sqlite3');
  let db = new SqliteDatabase(filename);
  try {
    const first = await fixture({ storage: db.store('query-control') });
    await first.control.alarm();
    await first.next(null);
    await first.control.setManual('paused');
    await db.close();
    db = new SqliteDatabase(filename);
    const second = await fixture({ storage: db.store('query-control'), now: date + DAY + 1000 });
    assert.equal(querySuspended(second.env), true);
    assert.equal(second.control.snapshot().manual, 'paused');
    await second.control.setManual('auto');
    assert.equal(querySuspended(second.env), true);
    await second.control.alarm();
    assert.equal(second.seen.length, 0);
    // Reproduce a process interruption after the daily claim, before a response was saved.
    await second.control.change(() => ({ lastDay: date / DAY + 2, verdict: 'checking' }));
    const third = await fixture({ storage: db.store('query-control'), now: date + DAY * 2 + 1000 });
    await third.control.alarm();
    assert.equal(third.seen.length, 0);
    assert.equal(third.control.snapshot().verdict, 'checking');
    await third.next({ name: 'daze#51307', customerToken: 'private-customer-token' });
    assert.equal(querySuspended(third.env), false);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
