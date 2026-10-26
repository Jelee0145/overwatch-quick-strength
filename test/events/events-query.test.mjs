import test from 'node:test';
import assert from 'node:assert/strict';
import { EventCenter } from '../../src/events/center.mjs';
import { eventApi, eventQuery } from '../../src/events/source.mjs';
import { parseEvents } from '../../src/events/parser.mjs';
import worker from '../../src/worker.mjs';
import { card, page, response } from '../events-fixture.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../server/runtime.mjs';

import { MemoryStorage as Storage } from '../helpers/storage.mjs';
const stamp = (date) => String(Date.parse(date) / 1000);
const history = (days) =>
  page(
    '',
    days
      .map((day) =>
        card({
          timestamp: stamp('2026-10-' + day + 'T11:00:00Z'),
          teams: ['Weibo Gaming', 'All Gamers'],
          scores: [3, 0],
          finished: true
        })
      )
      .join('')
  );
function setup(fetcher, { snapshot = true } = {}) {
  const storage = new Storage(),
    env = { EVENTS_CONTACT: 'https://site.test', EVENTS_FETCH: fetcher },
    center = new EventCenter({ storage }, env);
  let now = Date.parse('2026-10-19T06:00:00Z');
  center.now = () => now;
  if (snapshot) storage.map.set('snapshot', { matches: [], updatedAt: now, sourceVersion: 3 });
  const query = (params = 'from=2026-10-01&to=2026-10-18') =>
    center.fetch(new Request('https://events.internal/?' + params));
  const owned = (params, owner, method = 'GET') =>
    center.fetch(
      new Request('https://events.internal/?' + params, {
        method,
        headers: { 'X-OWQS-Event-User': owner }
      })
    );
  const app = {
    ...env,
    AUTH: {
      idFromName: () => '',
      get: () => ({ fetch: async () => Response.json({ user: { id: 'u' } }) })
    },
    EVENTS: {
      idFromName: () => '',
      get: () => ({ fetch: (url, init) => center.fetch(new Request(url, init)) })
    },
    TASKS: {
      get: () => {
        throw Error('No quota/task access permitted');
      }
    }
  };
  const api = (params) =>
    worker.fetch(
      new Request('https://site.test/api/v1/events?' + params, {
        headers: { Authorization: 'Bearer owqs_' + 'a'.repeat(64) }
      }),
      app
    );
  return {
    center,
    storage,
    env,
    app,
    query,
    owned,
    api,
    advance: (ms) => {
      now += ms;
    }
  };
}

test('upstream date predicates include Beijing endpoints, series defaults OWCS and invalid input cannot enter wikitext', () => {
  const query = eventQuery(new URLSearchParams({ from: '2026-10-01', to: '2026-10-18' }));
  assert.equal(query.series, 'owcs');
  const text = new URL(eventApi(query, 200)).searchParams.get('text');
  assert.match(text, /date::>2026-09-30 16:00:00/);
  assert.match(text, /date::2026-09-30 16:00:00/);
  assert.match(text, /date::<2026-10-18 16:00:00/);
  assert.match(text, /limit=200/);
  assert.ok(!new URL(eventApi({ series: 'all' })).searchParams.get('text').includes('pagename::'));
  for (const params of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-19', to: '2026-10-18' },
    { from: '2020-01-01', to: '2026-01-01' },
    { series: 'OWCS|limit=9999' },
    { from: '2026-01-01]]', to: '2026-10-18' }
  ])
    assert.throws(() => eventQuery(new URLSearchParams(params)));
});

test('date query queues behind recent refresh, resumes after restart without a visitor, and is shared by Bot and website', async () => {
  let calls = 0;
  const ctx = setup(
    async (url) => {
      calls++;
      return response(
        new URL(url).searchParams.get('text').includes('date::')
          ? history(['03', '04', '10', '17', '18'])
          : page()
      );
    },
    { snapshot: false }
  );
  await ctx.center.alarm();
  const saved = await ctx.storage.get('snapshot');
  const params = 'from=2026-10-01&to=2026-10-18&team=Weibo&region=KR';
  let result = await ctx.api(params);
  assert.equal(result.status, 202);
  assert.equal((await result.json()).state, 'pending');
  assert.equal(calls, 1);
  const restarted = new EventCenter({ storage: ctx.storage }, ctx.env);
  ctx.advance(30000);
  restarted.now = ctx.center.now;
  await restarted.alarm();
  assert.equal(calls, 2);
  const data = await (await ctx.api(params)).json();
  assert.equal(data.total, 5);
  assert.equal(data.filters.status, 'completed');
  assert.equal(data.range.from, '2026-10-01');
  assert.deepEqual(await ctx.storage.get('snapshot'), saved);
  assert.equal((await (await ctx.query()).json()).matches.length, 5);
  assert.equal(calls, 2);
  const website = await worker.fetch(
    new Request('https://site.test/api/events?' + params),
    ctx.app
  );
  assert.equal(website.status, 200);
  assert.equal((await website.json()).matches.length, 5);
  assert.equal(calls, 2);
});

test('all competitions query includes non-OWCS, remains separate from OWCS cache and validates parameters before source access', async () => {
  let calls = 0;
  const ctx = setup(
    async () => {
      calls++;
      return response(page(card({ path: 'Other_Cup/2026' }) + card(), ''));
    },
    { snapshot: false }
  );
  await ctx.center.alarm();
  assert.equal((await ctx.center.read()).matches.length, 1);
  ctx.advance(30000);
  const all = await (await ctx.api('series=all&limit=20')).json();
  assert.equal(all.total, 2);
  assert.ok(all.matches.some((m) => m.series === 'other'));
  assert.equal((await ctx.center.read()).matches.length, 1);
  const before = calls;
  assert.equal((await ctx.api('series=bad')).status, 400);
  assert.equal((await ctx.api('from=2020-01-01&to=2026-10-18')).status, 400);
  assert.equal(calls, before);
  assert.equal(
    parseEvents(page(card({ path: 'Other_Cup/2026' }), ''), { series: 'all' }).length,
    1
  );
});

test('saturated ranges split and finish rather than silently returning the newest 200 results', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    return response(
      calls === 1
        ? page(
            '',
            Array.from({ length: 200 }, (_, i) =>
              card({ timestamp: String(1790800000 + i), scores: [3, 0] })
            ).join('')
          )
        : history(calls === 2 ? ['01'] : ['02'])
    );
  });
  const params = 'from=2026-10-01&to=2026-10-02';
  let result = await ctx.query(params);
  assert.equal(result.status, 202);
  ctx.advance(30000);
  assert.equal((await ctx.query(params)).status, 202);
  ctx.advance(30000);
  result = await ctx.query(params);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.matches.length, 2);
  assert.equal(data.truncated, false);
  assert.equal(calls, 3);
  assert.ok(
    [...ctx.storage.map]
      .filter(([k]) => k.startsWith('eventQuery:'))
      .every(([, v]) => new TextEncoder().encode(JSON.stringify(v)).length < 100000)
  );
});

test('single-day source saturation is explicitly marked incomplete', async () => {
  const ctx = setup(async () =>
    response(
      page(
        '',
        Array.from({ length: 200 }, (_, i) =>
          card({ timestamp: String(1790800000 + i), scores: [3, 0] })
        ).join('')
      )
    )
  );
  const data = await (await ctx.query('from=2026-10-01&to=2026-10-01')).json();
  assert.equal(data.truncated, true);
  assert.match(data.coverage, /不完整/);
});

test('simultaneous ranges coalesce without mixing results or bypassing the global source gate', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return response(history(['03']));
  });
  const [a, b, c] = await Promise.all([
    ctx.query(),
    ctx.query(),
    ctx.query('from=2026-09-01&to=2026-09-30')
  ]);
  assert.deepEqual([a.status, b.status, c.status].sort(), [200, 202, 202]);
  assert.equal(calls, 1);
  ctx.advance(30000);
  assert.equal((await ctx.query()).status, 200);
  assert.equal((await ctx.query('from=2026-09-01&to=2026-09-30')).status, 200);
  assert.equal(calls, 2);
});

test('continuous authenticated backfill cannot starve hourly recent snapshots', async () => {
  let dateCalls = 0,
    recentCalls = 0,
    ctx;
  const sourceTimes = [];
  ctx = setup(async (url) => {
    sourceTimes.push(ctx.center.now());
    const text = new URL(url).searchParams.get('text') || '';
    if (text.includes('date::')) {
      dateCalls++;
      return response(history(['03']));
    }
    recentCalls++;
    return response(page());
  });
  const snapshots = [];
  const dateAt = (index) =>
    new Date(Date.UTC(2025, 9, 20) + index * 86400000).toISOString().slice(0, 10);
  for (let step = 0; step < 360; step++) {
    const queued = eventQuery(new URLSearchParams({ from: dateAt(step), to: dateAt(step) }));
    try {
      await ctx.center.queries.ensure(queued, { owner: 'owner-' + (step % 2) });
    } catch {}
    ctx.advance(30000);
    if (ctx.center.now() % 3600000 === 0) {
      assert.equal(
        await ctx.center.queries.hasPending(),
        true,
        'backfill queue must remain active at the hour boundary'
      );
      await ctx.center.alarm();
      snapshots.push((await ctx.storage.get('snapshot')).updatedAt);
    } else await ctx.center.queries.work();
  }
  assert.equal(recentCalls, 3);
  assert.equal(snapshots.length, 3);
  for (const [index, updatedAt] of snapshots.entries())
    assert.equal(updatedAt, Date.parse('2026-10-19T06:00:00Z') + (index + 1) * 3600000);
  assert.ok(dateCalls > 0);
  for (let i = 1; i < sourceTimes.length; i++)
    assert.ok(sourceTimes[i] - sourceTimes[i - 1] >= 30000);
});

test('date requests, manual refresh, cron and reminder tracking share recent-refresh priority', async () => {
  const source =
    'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Asia/Stage_3/Korea/Regular_Season';
  const calls = { recent: 0, date: 0, track: 0 };
  const ctx = setup(async (url) => {
    const text = new URL(url).searchParams.get('text') || '';
    if (text.includes('date::')) {
      calls.date++;
      return response(history(['03']));
    }
    if (text.includes('pagename::Overwatch_Champions_Series/')) {
      calls.track++;
      return response(page());
    }
    calls.recent++;
    return response(page());
  });
  await ctx.storage.put('snapshot', {
    matches: [],
    updatedAt: ctx.center.now() - 3600000,
    sourceVersion: 3
  });
  assert.equal((await ctx.owned('from=2026-10-01&to=2026-10-01', 'account-a')).status, 202);
  const track = () =>
    ctx.center.fetch(
      new Request('https://events.internal/track?source=' + encodeURIComponent(source), {
        method: 'POST'
      })
    );
  assert.equal((await track()).status, 503);
  assert.deepEqual(calls, { recent: 0, date: 0, track: 0 });
  const manual = () =>
    ctx.center.fetch(new Request('https://events.internal/refresh', { method: 'POST' }));
  assert.equal((await manual()).status, 200);
  assert.equal(calls.recent, 1);
  ctx.advance(30000);
  assert.equal((await ctx.owned('from=2026-10-01&to=2026-10-01', 'account-a')).status, 200);
  assert.equal(calls.date, 1);
  ctx.advance(30000);
  assert.equal((await track()).status, 200);
  assert.equal(calls.track, 1);
  ctx.advance(3540000);
  assert.equal((await ctx.owned('from=2026-10-02&to=2026-10-02', 'account-b')).status, 202);
  assert.equal(calls.date, 1);
  const sync = await ctx.center.fetch(
    new Request('https://events.internal/sync', { method: 'POST' })
  );
  assert.equal(sync.status, 200);
  assert.equal(calls.recent, 2);
});

test('two accounts share admission fairly, deduplicate ranges and never spend source on cache reads', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    return response(history(['03']));
  });
  await ctx.storage.put('refreshAfter', ctx.center.now() + 3600000);
  for (const [date, owner] of [
    ['2026-08-01', 'owner-a'],
    ['2026-08-02', 'owner-a'],
    ['2026-08-03', 'owner-b']
  ])
    assert.equal((await ctx.owned('from=' + date + '&to=' + date, owner)).status, 202);
  assert.equal((await ctx.owned('from=2026-08-09&to=2026-08-09', 'owner-a')).status, 429);
  assert.equal(calls, 0);
  const completed = async (date) =>
    (await ctx.storage.get('eventQueries')).find((q) => q.query.from === date)?.cache;
  await ctx.storage.put('refreshAfter', 0);
  await ctx.center.queries.work();
  assert.ok(await completed('2026-08-01'));
  ctx.advance(30000);
  const restarted = new EventCenter({ storage: ctx.storage }, ctx.env);
  restarted.now = ctx.center.now;
  await restarted.queries.work();
  assert.ok(await completed('2026-08-03'));
  ctx.advance(30000);
  await restarted.queries.work();
  assert.ok(await completed('2026-08-02'));
  assert.equal(calls, 3);
  const run = (params, owner) =>
    restarted.fetch(
      new Request('https://events.internal/?' + params, { headers: { 'X-OWQS-Event-User': owner } })
    );
  ctx.advance(30000);
  const shared = 'from=2026-08-04&to=2026-08-04';
  const [a, b] = await Promise.all([run(shared, 'owner-a'), run(shared, 'owner-b')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(calls, 4);
  const entries = await ctx.storage.get('eventQueries');
  assert.equal(entries.filter((q) => q.query.from === '2026-08-04').length, 1);
  for (let i = 0; i < 5; i++) assert.equal((await run(shared, 'owner-a')).status, 200);
  assert.equal(calls, 4);
  const served = JSON.stringify(await ctx.storage.get('eventQueryServed'));
  assert.ok(!served.includes('owner-a'));
  assert.ok(!served.includes('owner-b'));
});

test('legacy pending queue entries remain runnable after the ownership upgrade', async () => {
  const ctx = setup(async () => response(history(['03'])));
  const query = eventQuery(new URLSearchParams({ from: '2026-08-01', to: '2026-08-01' }));
  await ctx.storage.put('eventQueries', [
    {
      key: 'owcs:2026-08-01:2026-08-01',
      query,
      usedAt: ctx.center.now(),
      job: { id: 'legacy-job', todo: [query], parts: [], truncated: false, failures: 0 }
    }
  ]);
  await ctx.center.queries.work();
  const entry = (await ctx.storage.get('eventQueries'))[0];
  assert.equal(entry.owner, 'legacy');
  assert.ok(entry.cache);
  assert.equal(entry.job, undefined);
});

test('failed-job retries obey per-owner admission without blocking cached reads', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    return response(history(['03']));
  });
  const now = ctx.center.now();
  const make = (date) => {
    const query = eventQuery(new URLSearchParams({ from: date, to: date }));
    return { key: 'owcs:' + date + ':' + date, query, usedAt: now, owner: 'account-a' };
  };
  const first = make('2026-08-01'),
    second = make('2026-08-02'),
    failed = make('2026-08-03');
  first.job = { id: 'first', todo: [first.query], parts: [], truncated: false, failures: 0 };
  second.job = { id: 'second', todo: [second.query], parts: [], truncated: false, failures: 0 };
  failed.job = { id: 'failed', todo: [failed.query], parts: [], truncated: false, failures: 3 };
  failed.cache = { parts: [], updatedAt: now, truncated: false };
  await ctx.storage.put('eventQueries', [first, second, failed]);
  await ctx.storage.put('refreshAfter', 0);
  assert.equal((await ctx.owned('from=2026-08-03&to=2026-08-03', 'owner-a')).status, 200);
  assert.equal(
    (await ctx.storage.get('eventQueries')).find((q) => q.key === failed.key).job.failures,
    3
  );
  const rows = await ctx.storage.get('eventQueries');
  delete rows.find((q) => q.key === first.key).job;
  await ctx.storage.put('eventQueries', rows);
  assert.equal((await ctx.owned('from=2026-08-03&to=2026-08-03', 'owner-a')).status, 200);
  assert.equal(calls, 1);
  assert.ok((await ctx.storage.get('eventQueries')).find((q) => q.key === failed.key).cache);
});

test('a concurrent refresh cannot release the source owner held by another request', async () => {
  let calls = 0,
    release;
  const ctx = setup(() => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve(response(page()));
    });
  });
  const first = ctx.center.source(
    'https://source.test',
    { series: 'owcs' },
    { priority: 'backfill' }
  );
  for (let i = 0; i < 20 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(release);
  await ctx.center.refresh();
  await ctx.storage.put('refreshAfter', 0);
  await assert.rejects(
    ctx.center.source('https://source.test', { series: 'owcs' }, { priority: 'backfill' }),
    (error) => error.retryAfter === 1
  );
  assert.equal(calls, 1);
  release();
  await first;
});

test('failed range refresh preserves the successful dataset and persists Retry-After across restarts', async () => {
  let fail = false,
    calls = 0;
  const ctx = setup(async () => {
    calls++;
    return fail
      ? new Response('', { status: 429, headers: { 'Retry-After': '3600' } })
      : response(history(['03']));
  });
  const data = await (await ctx.query()).json();
  assert.equal(data.matches.length, 1);
  ctx.advance(86400000);
  await ctx.storage.put('snapshot', { matches: [], updatedAt: ctx.center.now(), sourceVersion: 3 });
  fail = true;
  const stale = await (await ctx.query()).json();
  assert.equal(stale.matches.length, 1);
  assert.equal(stale.stale, true);
  assert.equal(calls, 2);
  const restarted = new EventCenter({ storage: ctx.storage }, ctx.env);
  restarted.now = ctx.center.now;
  await restarted.queries.work();
  assert.equal(calls, 2);
  assert.ok((await ctx.storage.get('refreshAfter')) >= ctx.center.now() + 3600000);
});

test('website returns all date results while Bot caps only the final filtered output', async () => {
  const ctx = setup(async () =>
    response(
      page(
        '',
        Array.from({ length: 80 }, (_, i) =>
          card({ timestamp: String(Date.parse('2026-10-10T00:00:00Z') / 1000 + i), scores: [3, 0] })
        ).join('')
      )
    )
  );
  const params = 'from=2026-10-01&to=2026-10-18';
  const bot = await (await ctx.api(params)).json();
  assert.equal(bot.total, 80);
  assert.equal(bot.matches.length, 10);
  const web = await (
    await worker.fetch(new Request('https://site.test/api/events?' + params), ctx.app)
  ).json();
  assert.equal(web.total, 80);
  assert.equal(web.matches.length, 80);
});

test('SQLite date work and chunked results recover after a real database reopen', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-event-range-'));
  let calls = 0;
  const now = Date.now(),
    options = {
      filename: path.join(dir, 'state.sqlite3'),
      eventsFetch: async (url) => {
        calls++;
        return response(
          new URL(url).searchParams.get('text').includes('date::') ? history(['03', '18']) : page()
        );
      }
    },
    config = { PUBLIC_ORIGIN: 'https://site.test' };
  let runtime = createRuntime(config, options);
  try {
    runtime.instance('events').now = () => now;
    await runtime.startEvents();
    const recent = await runtime.database.store('events').get('snapshot');
    const request = 'https://events.internal/?from=2026-10-01&to=2026-10-18';
    assert.equal((await runtime.env.EVENTS.get().fetch(request)).status, 202);
    await runtime.close();
    runtime = createRuntime(config, options);
    runtime.instance('events').now = () => now + 30000;
    await runtime.startEvents();
    assert.equal(calls, 2);
    const result = await (await runtime.env.EVENTS.get().fetch(request)).json();
    assert.equal(result.matches.length, 2);
    assert.deepEqual(await runtime.database.store('events').get('snapshot'), recent);
  } finally {
    await runtime.close();
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('owqs-event-range-'))
      await rm(dir, { recursive: true, force: true });
  }
});

test('pending query count is bounded and manual range refresh does not overwrite recent data', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    return response(history(['03']));
  });
  await ctx.storage.put('refreshAfter', ctx.center.now() + 3600000);
  const owned = (params, owner) =>
    ctx.center.fetch(
      new Request('https://events.internal/?' + params, { headers: { 'X-OWQS-Event-User': owner } })
    );
  for (let day = 1; day <= 8; day++) {
    const date = '2026-10-' + String(day).padStart(2, '0');
    assert.equal((await owned('from=' + date + '&to=' + date, 'owner-' + day)).status, 202);
  }
  assert.equal((await owned('from=2026-10-09&to=2026-10-09', 'owner-9')).status, 429);
  assert.equal(calls, 0);
  const other = setup(async () => response(history(['03'])));
  await other.query();
  other.advance(30000);
  const recent = await other.storage.get('snapshot');
  const refreshed = await other.center.fetch(
    new Request('https://events.internal/refresh?from=2026-10-01&to=2026-10-18', { method: 'POST' })
  );
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).matches.length, 1);
  assert.deepEqual(await other.storage.get('snapshot'), recent);
});

test('least-recently-used completed caches are evicted with their chunks', async () => {
  const ctx = setup(async () => response(history(['03'])));
  for (let day = 1; day <= 9; day++) {
    ctx.advance(30000);
    const date = '2026-10-' + String(day).padStart(2, '0');
    assert.equal((await ctx.query('from=' + date + '&to=' + date)).status, 200);
  }
  const entries = await ctx.storage.get('eventQueries');
  assert.equal(entries.length, 8);
  assert.ok(!entries.some((q) => q.query.from === '2026-10-01'));
  const referenced = entries.flatMap((q) => q.cache.parts);
  assert.equal(
    [...ctx.storage.map.keys()].filter((key) => key.startsWith('eventQuery:')).length,
    referenced.length
  );
});
