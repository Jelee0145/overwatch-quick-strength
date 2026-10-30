import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventCenter, EVENTS_API, nextEventSync } from '../../backend/src/events/center.mjs';
import { nextEventRefresh } from '../../backend/src/events/freshness.mjs';
import { parseEvents, liquipediaLink, liquipediaLogo } from '../../backend/src/events/parser.mjs';
import worker from '../../backend/src/worker.mjs';
import { createRuntime } from '../../backend/server/runtime.mjs';
import { card, page, response } from '../events-fixture.mjs';
import { filterEvents } from '../../backend/src/events/filter.mjs';

import { MemoryStorage as Storage } from '../helpers/storage.mjs';
function setup(fetcher = async () => response(page())) {
  const storage = new Storage(),
    env = { EVENTS_CONTACT: 'https://site.test', EVENTS_FETCH: fetcher },
    center = new EventCenter({ storage }, env);
  let now = 1792310400000;
  center.now = () => now;
  return {
    center,
    storage,
    env,
    advance: (ms) => {
      now += ms;
    }
  };
}
const request = () => new Request('https://events.internal/');

test('source filters OWCS before its row cap; Saturday WBG survives date and team filters in API and webpage', async () => {
  const query = new URL(EVENTS_API).searchParams,
    ticker = query.get('text');
  assert.equal(query.get('action'), 'parse');
  assert.equal(query.get('contentmodel'), 'wikitext');
  assert.equal((ticker.match(/limit=50\|additionalConditions=/g) || []).length, 2);
  assert.equal((ticker.match(/\[\[pagename::>Overwatch_Champions_Series\/\]\]/g) || []).length, 2);
  assert.equal((ticker.match(/\[\[pagename::<Overwatch_Champions_Series0\]\]/g) || []).length, 2);
  const timestamp = String(Date.parse('2026-10-24T11:00:00Z') / 1000),
    wbg = card({
      path: 'Overwatch_Champions_Series/2026/China/Stage_3/Regular_Season',
      name: 'OWCS China Stage 3',
      timestamp,
      teams: ['Weibo Gaming', 'All Gamers']
    })
      .replace('>Wei</a>', '>WBG</a>')
      .replace('>All</a>', '>AG</a>');
  const ctx = setup(async () =>
    response(page(card({ path: 'Other_Cup/2026' }).repeat(50) + wbg, ''))
  );
  await ctx.center.alarm();
  const data = await ctx.center.read();
  assert.equal(data.matches.length, 1);
  const params = new URLSearchParams({
    from: '2026-10-19',
    to: '2026-10-25',
    team: 'wbg',
    region: 'CN',
    status: 'scheduled'
  });
  assert.equal(filterEvents(data, params).total, 1);
  const context = { window: {}, Intl };
  vm.runInNewContext(
    await readFile(new URL('../../frontend/web/events-model.js', import.meta.url), 'utf8'),
    context
  );
  assert.equal(
    context.window.EventsModel.select(data.matches, {
      from: '2026-10-19',
      to: '2026-10-25',
      team: 'WBG',
      region: '中国'
    }).length,
    1
  );
  assert.equal(
    context.window.EventsModel.select(data.matches, {
      from: '2026-10-25',
      to: '2026-10-26',
      team: 'WBG'
    }).length,
    0
  );
});

test('a source upgrade replaces a same-hour truncated snapshot without bypassing persisted pacing', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    return response(page());
  });
  await ctx.center.alarm();
  const saved = await ctx.storage.get('snapshot');
  await ctx.storage.put('snapshot', { ...saved, sourceVersion: 1 });
  await ctx.center.alarm();
  assert.equal(calls, 1);
  ctx.advance(30000);
  await ctx.center.alarm();
  assert.equal(calls, 2);
  assert.equal((await ctx.storage.get('snapshot')).sourceVersion, 3);
});

test('events parser covers OWCS regions, scores including zero, entities and unknown time/opponent; ignores other events', () => {
  const regions = [
    ['China', '中国'],
    ['Asia/Stage_3/Korea', '韩国'],
    ['Asia/Stage_3/Japan', '日本'],
    ['Asia/Stage_3/Pacific', '太平洋'],
    ['North_America', '北美'],
    ['EMEA', 'EMEA'],
    ['World_Finals', '国际赛']
  ];
  const html =
    regions.map(([r]) => card({ path: 'Overwatch_Champions_Series/2026/' + r })).join('') +
    card({ path: 'Other_Cup/2026' }) +
    card({
      path: 'Overwatch_Champions_Series/2026/Asia',
      timestamp: null,
      teams: ['A &amp; B', 'TBD']
    });
  const matches = parseEvents(page(html));
  assert.equal(matches.length, 9);
  for (const [i, [, r]] of regions.entries()) assert.equal(matches[i].region, r);
  assert.equal(matches[7].teams[0].name, 'A & B');
  assert.equal(matches[7].teams[1].name, 'TBD');
  assert.equal(matches[7].startsAt, null);
  assert.deepEqual(matches.at(-1).scores, [3, 0]);
  assert.equal(matches.at(-1).status, 'completed');
  assert.equal(matches[0].bestOf, 5);
  assert.equal(parseEvents(page('', '')).length, 0);
  assert.throws(() => parseEvents('<p>maintenance</p>'));
  assert.throws(() => parseEvents(page('<div class="new-match">Changed</div>')));
  assert.throws(() => parseEvents(page(card().replace('match-info-tournament-name', 'renamed'))));
  assert.equal(parseEvents(page(card() + card(), '')).length, 1);
  const duplicate = parseEvents(page(card(), card({ scores: [0, 3] })));
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].status, 'completed');
  assert.deepEqual(duplicate[0].scores, [0, 3]);
  for (const u of [
    'javascript:alert(1)',
    'https://evil.test/overwatch/a',
    'https://liquipedia.net.evil.test/overwatch/a',
    'https://evil@liquipedia.net/overwatch/a',
    'https://liquipedia.net:444/overwatch/a'
  ])
    assert.equal(liquipediaLink(u), null);
  assert.equal(liquipediaLink('/overwatch/Test'), 'https://liquipedia.net/overwatch/Test');
});

test('events team badges use the light variant and reject off-site or non-image sources', () => {
  const withIcons = card().replace(
    '<span class="name">',
    '<span class="team-template-image-icon team-template-darkmode"><img src="/commons/images/dark.png"></span><span class="team-template-image-icon team-template-lightmode"><img src="/commons/images/light.svg.png"></span><span class="name">'
  );
  const match = parseEvents(page(withIcons, ''))[0];
  assert.equal(match.teams[0].logo, 'https://liquipedia.net/commons/images/light.svg.png');
  assert.equal(match.teams[1].logo, null);
  for (const url of [
    'javascript:alert(1)',
    'data:image/svg+xml,anything',
    'https://evil.test/commons/images/logo.png',
    'https://liquipedia.net/overwatch/logo.png',
    'https://liquipedia.net/commons/images/page.html'
  ])
    assert.equal(liquipediaLogo(url), null);
});

test('events model filters without requests, sorts results, and uses Beijing midnight in every host timezone', async () => {
  const context = { window: {}, Intl };
  vm.runInNewContext(
    await readFile(new URL('../../frontend/web/events-model.js', import.meta.url), 'utf8'),
    context
  );
  const model = context.window.EventsModel;
  assert.equal(model.day('2026-10-17T16:00:00Z'), '2026-10-18');
  assert.equal(model.day(null), '');
  const matches = parseEvents(
    page(
      card({ timestamp: '1792252800' }) +
        card({ timestamp: '1792339200' }) +
        card({ timestamp: null }),
      card({ timestamp: '1792166400', finished: true, scores: [3, 0] })
    )
  );
  assert.equal(model.select(matches).at(-1).startsAt, null);
  assert.equal(model.select(matches, { team: 'FALCONS' }).length, 3);
  assert.equal(model.select(matches, { team: 'cRa', region: '韩国' }).length, 3);
  assert.equal(model.select(matches, { from: '2026-10-18', to: '2026-10-18' }).length, 1);
  assert.equal(model.select(matches, { view: 'completed' }).length, 1);
  assert.equal(model.select(matches, { tournament: 'none' }).length, 0);
  assert.equal(model.select(matches, { region: '中国' }).length, 0);
  const results = parseEvents(
    page(
      '',
      card({ timestamp: '1792166400', scores: [3, 0] }) +
        card({ timestamp: '1792252800', scores: [0, 3] })
    )
  );
  assert.equal(
    model.select(results, { view: 'completed' })[0].startsAt,
    '2026-10-17T16:00:00.000Z'
  );
});

test('visitor GET is cache-only, adaptive sync single-flights and restart reuses fresh data', async () => {
  let calls = 0;
  const ctx = setup(async (url, init) => {
    calls++;
    assert.equal(url, EVENTS_API);
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers['User-Agent'], /site.test/);
    await new Promise((r) => setTimeout(r, 5));
    return response(page());
  });
  assert.equal((await ctx.center.fetch(request())).status, 503);
  assert.equal(calls, 0);
  await Promise.all(Array.from({ length: 8 }, () => ctx.center.refresh()));
  assert.equal(calls, 1);
  for (let i = 0; i < 8; i++) assert.equal((await ctx.center.fetch(request())).status, 200);
  assert.equal(calls, 1);
  ctx.advance(60000);
  await ctx.center.fetch(request());
  assert.equal(calls, 1);
  const restarted = new EventCenter({ storage: ctx.storage }, ctx.env);
  restarted.now = ctx.center.now;
  await restarted.alarm();
  assert.equal(calls, 1);
  const saved = await ctx.storage.get('snapshot');
  assert.equal(
    await ctx.storage.getAlarm(),
    nextEventRefresh(saved.matches, saved.updatedAt, ctx.center.now())
  );
  ctx.advance(3600000);
  await restarted.alarm();
  assert.equal(calls, 2);
});

test('idle sync interval is fifteen minutes, failures retain prior data for 48 hours and GET never retries', async () => {
  assert.equal(
    nextEventSync(Date.parse('2026-10-18T15:59:59Z')),
    Date.parse('2026-10-18T16:14:59Z')
  );
  let calls = 0,
    fail = false;
  const ctx = setup(async () => {
    calls++;
    if (fail) throw Error('offline');
    return response(page());
  });
  await ctx.center.alarm();
  const saved = await ctx.storage.get('snapshot');
  ctx.advance(3600000);
  fail = true;
  await ctx.center.alarm();
  assert.deepEqual(await ctx.storage.get('snapshot'), saved);
  assert.equal((await ctx.center.read()).stale, true);
  assert.equal(calls, 2);
  await ctx.center.alarm();
  await ctx.center.fetch(request());
  assert.equal(calls, 2);
  ctx.advance(48 * 3600000);
  assert.equal((await ctx.center.fetch(request())).status, 503);
  assert.equal(calls, 2);
});

test('hourly scheduler honors Retry-After beyond an hour and parse spacing at an hour boundary', async () => {
  const ctx = setup();
  await ctx.center.alarm();
  ctx.advance(86400000);
  const until = ctx.center.now() + 3 * 86400000;
  let calls = 0;
  ctx.env.EVENTS_FETCH = async () => {
    calls++;
    return new Response('', {
      status: 429,
      headers: { 'Retry-After': new Date(until).toUTCString() }
    });
  };
  await ctx.center.alarm();
  assert.ok((await ctx.storage.getAlarm()) >= until - 1000);
  ctx.advance(86400000);
  await ctx.center.alarm();
  assert.equal(calls, 1);
  const edge = setup();
  edge.center.now = () => Date.parse('2026-10-18T15:59:59Z');
  await edge.center.alarm();
  assert.ok((await edge.storage.getAlarm()) >= edge.center.now() + 30000);
});

test('invalid upstream responses never replace the last valid hourly snapshot', async () => {
  const failures = [
    () => response('<p>changed</p>'),
    () => new Response('challenge', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'application/json' }
      }),
    () => new Response('bad', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('', { status: 302 }),
    () => {
      throw Error('network');
    }
  ];
  for (const fail of failures) {
    const ctx = setup();
    await ctx.center.alarm();
    const saved = await ctx.storage.get('snapshot');
    ctx.advance(86400000);
    ctx.env.EVENTS_FETCH = fail;
    await ctx.center.alarm();
    assert.deepEqual(await ctx.storage.get('snapshot'), saved);
    assert.equal((await ctx.center.read()).stale, true);
  }
});

test('background sync times out at ten seconds and failed attempts survive process restart', async () => {
  const ctx = setup(
    (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
      )
  );
  const original = globalThis.setTimeout;
  let delay;
  globalThis.setTimeout = (fn, ms) => {
    delay = ms;
    return original(fn, 1);
  };
  try {
    await ctx.center.alarm();
    assert.equal(delay, 10000);
  } finally {
    globalThis.setTimeout = original;
  }
  let calls = 0;
  const restarted = new EventCenter(
    { storage: ctx.storage },
    {
      ...ctx.env,
      EVENTS_FETCH: () => {
        calls++;
        throw Error('must not fetch');
      }
    }
  );
  restarted.now = ctx.center.now;
  await restarted.alarm();
  assert.equal(calls, 0);
  assert.equal((await restarted.fetch(request())).status, 503);
});

test('website refresh is authenticated and origin protected; scheduled and manual sync never create tasks', async () => {
  let approved = false;
  const calls = [];
  const env = {
    AUTH: {
      idFromName: () => '',
      get: () => ({
        fetch: async () =>
          approved
            ? Response.json({ user: { id: 'user' } })
            : Response.json({ error: '请先登录' }, { status: 401 })
      })
    },
    EVENTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (url, init) => {
          calls.push({ url, method: init?.method || 'GET', headers: init?.headers || {} });
          return Response.json({ matches: [] });
        }
      })
    },
    TASKS: {
      get: () => {
        throw Error('must not create query tasks');
      }
    },
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname) }
  };
  assert.equal((await worker.fetch(new Request('https://site.test/api/events'), env)).status, 401);
  assert.equal(calls.length, 0);
  approved = true;
  assert.equal(
    (
      await worker.fetch(
        new Request('https://site.test/api/events', { headers: { 'X-OWQS-Event-User': 'forged' } }),
        env
      )
    ).status,
    200
  );
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers['X-OWQS-Event-User'], 'user');
  assert.equal(
    (
      await worker.fetch(
        new Request('https://site.test/api/events/refresh', {
          method: 'POST',
          headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
          body: '{}'
        }),
        env
      )
    ).status,
    403
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await worker.fetch(
        new Request('https://site.test/api/events/refresh', {
          method: 'POST',
          headers: { Origin: 'https://site.test', 'Content-Type': 'application/json' },
          body: '{}'
        }),
        env
      )
    ).status,
    200
  );
  assert.equal(new URL(calls[1].url).pathname, '/refresh');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers['X-OWQS-Event-User'], 'user');
  let work;
  await worker.scheduled({}, env, {
    waitUntil: (promise) => {
      work = promise;
    }
  });
  await work;
  assert.equal(calls[2].url, 'https://events.internal/sync');
  assert.equal(calls[2].method, 'POST');
});

test('standalone startup synchronizes without visitors, schedules the next hour and restart reads the persisted snapshot', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-events-'));
  let calls = 0;
  const options = {
    filename: path.join(dir, 'state.sqlite3'),
    eventsFetch: async () => {
      calls++;
      return response(page());
    },
    upstreamFetch: () => {
      throw Error('not match data');
    }
  };
  const config = { PUBLIC_ORIGIN: 'https://site.test' };
  let runtime = createRuntime(config, options);
  try {
    await runtime.startEvents();
    assert.equal(calls, 1);
    assert.ok((await runtime.database.store('events').getAlarm()) > Date.now());
    await runtime.close();
    runtime = createRuntime(config, options);
    await runtime.startEvents();
    assert.equal(calls, 1);
    assert.equal((await runtime.env.EVENTS.get().fetch('https://events.internal/')).status, 200);
    assert.equal(calls, 1);
    runtime.instance('events').now = () => Date.now() + 3600000;
    await runtime.database.store('events').setAlarm(Date.now() - 1);
    await runtime.tick();
    for (let i = 0; i < 20 && calls < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manual sync coalesces, persists minimum spacing and ignores the obsolete daily gate', async () => {
  let calls = 0;
  const ctx = setup(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return response(page());
  });
  await ctx.storage.put('nextAttempt', ctx.center.now() + 86400000);
  await ctx.storage.put('lastAttemptDay', '2026-10-18');
  await ctx.center.alarm();
  assert.equal(calls, 1);
  ctx.advance(30000);
  const manual = () =>
    ctx.center.fetch(new Request('https://events.internal/refresh', { method: 'POST' }));
  await Promise.all(Array.from({ length: 8 }, manual));
  assert.equal(calls, 2);
  await manual();
  assert.equal(calls, 2);
  const restarted = new EventCenter({ storage: ctx.storage }, ctx.env);
  restarted.now = ctx.center.now;
  await restarted.refresh(true);
  assert.equal(calls, 2);
  ctx.advance(30000);
  await restarted.refresh(true);
  assert.equal(calls, 3);
});

test('failed manual refresh retains data with an explicit notice and five-minute persistent backoff', async () => {
  let calls = 0,
    fail = false;
  const ctx = setup(async () => {
    calls++;
    if (fail) throw Error('offline');
    return response(page());
  });
  await ctx.center.alarm();
  const saved = await ctx.storage.get('snapshot');
  ctx.advance(30000);
  fail = true;
  const manual = () =>
    ctx.center.fetch(new Request('https://events.internal/refresh', { method: 'POST' }));
  const failed = await manual();
  assert.equal(failed.status, 200);
  assert.match((await failed.json()).refreshError, /更新失败/);
  assert.deepEqual(await ctx.storage.get('snapshot'), saved);
  ctx.advance(299999);
  await manual();
  assert.equal(calls, 2);
  ctx.advance(1);
  fail = false;
  assert.equal((await (await manual()).json()).refreshError, undefined);
  assert.equal(calls, 3);
});

test('events UI has a manual action, refreshes once on entry and explains pending results', async () => {
  const html = await readFile(new URL('../../frontend/web/events.html', import.meta.url), 'utf8'),
    script = await readFile(new URL('../../frontend/web/events.js', import.meta.url), 'utf8');
  assert.ok(html.includes('eventsRefresh'));
  assert.match(script, /await refresh\(false\)/);
  assert.match(script, /setInterval\(updateTimeStatus,\s*15000\)/);
  assert.match(html, /CC BY-SA 3\.0/);
  assert.doesNotMatch(html, /动态同步|events-reminders-help/);
  assert.match(script, /赛果待公布/);
});

test('events local status interval updates due labels without API polling and resumes after BFCache restore', async () => {
  const script = await readFile(new URL('../../frontend/web/events.js', import.meta.url), 'utf8');
  let now = Date.parse('2026-10-24T05:59:50Z'),
    networkCalls = 0,
    sequence = 0;
  const intervals = new Map(),
    nodes = new Map(),
    windowListeners = {},
    documentListeners = {};
  const node = () => ({
    children: [],
    value: '',
    textContent: '',
    setAttribute() {},
    addEventListener() {},
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    }
  });
  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    createElement: node,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (documentListeners[type] ||= []).push(fn);
    }
  };
  const reservation = {
    id: 'test',
    state: 'active',
    deliveryStatus: 'pending',
    match: { startsAt: new Date(now + 10000).toISOString(), teams: [{ name: 'A' }, { name: 'B' }] }
  };
  const state = {
    ready: true,
    enabled: true,
    pending: false,
    deviceEnabled: true,
    reservations: [reservation]
  };
  const cloud = {
    boot: () => new Promise(() => {}),
    api: () => {
      networkCalls++;
      throw Error('local interval must not request data');
    }
  };
  const window = {
    EventsModel: {},
    EventReminders: { state },
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    }
  };
  const context = {
    window,
    document,
    Cloud: cloud,
    Intl,
    URL,
    URLSearchParams,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setInterval(fn, ms) {
      assert.equal(ms, 15000);
      const id = ++sequence;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout() {
      throw Error('local status updates must not schedule requests');
    },
    clearTimeout() {}
  };
  vm.runInNewContext(script, context);
  const text = (element) => element.textContent + element.children.map(text).join('');
  const tick = () => {
    now += 15000;
    for (const fn of [...intervals.values()]) fn();
  };
  const dispatch = (listeners, type, event = {}) => {
    for (const fn of listeners[type] || []) fn({ type, ...event });
  };
  assert.equal(intervals.size, 1);
  assert.match(text(nodes.get('eventsReservations')), /已预约/);
  tick();
  assert.match(text(nodes.get('eventsReservations')), /已到预定时间.*待核实/);
  assert.equal(networkCalls, 0);
  assert.equal(
    state.reservations[0].state,
    'active',
    'a clock tick does not synthesize a verified notification'
  );
  document.visibilityState = 'hidden';
  reservation.match.startsAt = new Date(now + 60000).toISOString();
  tick();
  assert.match(text(nodes.get('eventsReservations')), /已到预定时间/, 'hidden pages do not redraw');
  document.visibilityState = 'visible';
  dispatch(documentListeners, 'visibilitychange');
  assert.match(text(nodes.get('eventsReservations')), /已预约/);
  dispatch(windowListeners, 'pagehide', { persisted: true });
  assert.equal(intervals.size, 0);
  now += 120000;
  dispatch(windowListeners, 'pageshow', { persisted: true });
  assert.equal(intervals.size, 1);
  assert.match(text(nodes.get('eventsReservations')), /已到预定时间/);
  dispatch(windowListeners, 'pageshow', { persisted: true });
  assert.equal(intervals.size, 1, 'restore does not duplicate timers');
  tick();
  assert.equal(
    networkCalls,
    0,
    'periodic render and lifecycle restoration never fetch the events API'
  );
});

test('Bot events API combines filters, preserves Beijing date boundaries and caps results without using query tasks', async () => {
  const data = {
    matches: parseEvents(
      page(
        card({ timestamp: '1792252800' }) +
          card({
            path: 'Overwatch_Champions_Series/2026/China/Stage_3',
            name: 'OWCS China Stage 3',
            teams: ['All Gamers', 'OU Gaming']
          }),
        card({ timestamp: '1792166400', scores: [3, 0] })
      )
    ),
    updatedAt: '2026-10-18T00:00:00Z',
    stale: false
  };
  const filtered = filterEvents(
    data,
    new URLSearchParams({
      region: 'KR',
      team: 'CRa',
      tournament: 'stage 3',
      from: '2026-10-18',
      to: '2026-10-18',
      limit: '1',
      status: 'scheduled'
    })
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.matches.length, 1);
  assert.equal(
    filterEvents(data, new URLSearchParams({ region: 'CN', team: 'All Gamers' })).total,
    1
  );
  assert.equal(
    filterEvents(data, new URLSearchParams({ status: 'completed' })).matches[0].scores[1],
    0
  );
  for (const params of [
    { from: '2026-02-30' },
    { from: '2026-10-19', to: '2026-10-18' },
    { limit: '21' },
    { status: 'live' },
    { refresh: 'true' }
  ])
    assert.throws(() => filterEvents(data, new URLSearchParams(params)));
  let calls = 0;
  const env = {
    AUTH: {
      idFromName: () => '',
      get: () => ({ fetch: async () => Response.json({ user: { id: 'user' }, tier: 'free' }) })
    },
    TASKS: {
      get: () => {
        throw Error('must not create query task');
      }
    },
    EVENTS: {
      idFromName: () => '',
      get: () => ({
        fetch: async (url, init) => {
          calls++;
          assert.equal(init.headers['X-OWQS-Event-User'], 'user');
          return Response.json(data);
        }
      })
    }
  };
  const api = (url) =>
    worker.fetch(
      new Request('https://site.test/api/v1/events' + url, {
        headers: { Authorization: 'Bearer owqs_' + 'a'.repeat(64), 'X-OWQS-Event-User': 'forged' }
      }),
      env
    );
  const response = await api('?region=CN&team=All%20Gamers');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 1);
  assert.equal(calls, 1);
  assert.equal(
    (await worker.fetch(new Request('https://site.test/api/v1/events'), env)).status,
    401
  );
});
