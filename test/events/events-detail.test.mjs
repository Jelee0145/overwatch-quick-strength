import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../backend/src/worker.mjs';
import { EventCenter } from '../../backend/src/events/center.mjs';
import { parseDetailPage } from '../../backend/src/events/detail-parser.mjs';
import { detailPath, detailRoot } from '../../backend/src/events/source.mjs';
import { LOGO_ROUTE } from '../../backend/src/events/logos.mjs';
import { card, page, response } from '../events-fixture.mjs';
import { MemoryStorage as Storage } from '../helpers/storage.mjs';

import { BADGE, ROOT, SUB, rootHtml, subHtml } from './detail-fixture.mjs';

test('detail parser reads infobox, games, inferred pickers, bans, MVP, standings and rosters', () => {
  const root = parseDetailPage(rootHtml, ROOT),
    sub = parseDetailPage(subHtml, SUB);
  assert.equal(root.info.title, 'OWCS 2026 Korea Stage 3');
  assert.deepEqual(root.info.organizers, ['WDG', 'Blizzard']);
  assert.equal(root.info.prizePool, '$100,000 USD');
  const [match] = sub.matches;
  assert.equal(match.stage, 'Week 1 · Day 1');
  assert.equal(match.startsAt, new Date(1792339200 * 1000).toISOString());
  assert.equal(match.bestOf, 5);
  assert.deepEqual(match.scores, [3, 1]);
  assert.equal(match.winner, 0);
  assert.equal(match.teams[0].shortName, 'CR');
  assert.equal(match.teams[0].logo, BADGE);
  assert.equal(match.teams[1].logo, null);
  assert.deepEqual(
    match.games.map((g) => [g.map.name, g.map.mode, g.scores.join('-'), g.winner]),
    [
      ['釜山', '占领要点', '2-0', 0],
      ['国王大道', '攻击/护送', '2-3', 1],
      ['斗兽场', '机动推进', '1-0', 0],
      ['多拉多', '运载目标', '3-2', 0],
      ['', '', '-', null]
    ]
  );
  assert.ok(match.games[0].map.image === null || match.games[0].map.image.startsWith('/media/'));
  // Map 1 has no picker; afterwards the previous map's loser picks. Unplayed maps stay null.
  assert.deepEqual(
    match.games.map((g) => g.picker),
    [null, 1, 0, 1, null]
  );
  assert.equal(match.games[4].played, false);
  assert.deepEqual(
    match.games[0].bans.map((h) => h.name),
    ['猎空', '安娜']
  );
  assert.deepEqual(match.games[1].bans[0], { en: 'Shion', name: 'Shion', icon: null });
  assert.deepEqual(match.games[2].bans, [null, null]);
  assert.deepEqual(match.mvp, ['Proper']);

  const [table] = root.standings;
  assert.equal(table.kind, 'swiss');
  assert.equal(table.title, 'Swiss Standings');
  assert.deepEqual(table.columns, ['Matches', 'Maps']);
  assert.equal(table.rounds, 2);
  const [row] = table.rows;
  assert.equal(row.place, 1);
  assert.equal(row.status, 'up');
  assert.equal(row.team.name, 'Crazy Raccoon');
  assert.deepEqual(row.stats, ['2-0', '6-1']);
  assert.deepEqual(row.history, [{ score: '3-1', result: 'win', opponent: 'Team Falcons' }, null]);

  const [card] = root.participants;
  assert.equal(card.team.name, 'Crazy Raccoon');
  assert.equal(card.qualifier, 'Invited');
  assert.deepEqual(
    card.groups.map((g) => [g.label, g.members.map((m) => m.id + '/' + m.role)]),
    [
      ['Main', ['Proper/DPS', 'Rio/Support']],
      ['Staff', ['Coach1/Coach']]
    ]
  );
  assert.equal(card.groups[0].members[0].country, 'South Korea');
  assert.throws(() => parseDetailPage(null, ROOT));
});

test('detail paths are allowlisted and subpages roll up to their stage', () => {
  assert.equal(detailPath(ROOT), ROOT);
  for (const bad of [
    '',
    'Main_Page',
    'Overwatch_Champions_Series',
    'Overwatch_Champions_Series/../Special:Export',
    'Overwatch_Champions_Series/2026?action=raw',
    'https://liquipedia.net/overwatch/' + ROOT,
    'Overwatch_Champions_Series/' + 'a'.repeat(200)
  ])
    assert.throws(() => detailPath(bad), /赛事页面无效/);
  assert.equal(detailRoot('https://liquipedia.net/overwatch/' + SUB), ROOT);
  assert.equal(detailRoot('https://liquipedia.net/overwatch/' + ROOT + '/Playoffs'), ROOT);
  assert.equal(detailRoot('https://example.com/overwatch/' + ROOT), null);
  assert.equal(detailRoot('https://liquipedia.net/overwatch/Main_Page'), null);
});

function setup({ spacing } = {}) {
  const storage = new Storage(),
    calls = [];
  let clock = Date.parse('2026-11-06T00:00:00Z'),
    revid = 100;
  const env = {
    EVENTS_CONTACT: 'https://site.test',
    ...(spacing === undefined ? {} : { EVENTS_LP_SPACING_MS: spacing }),
    EVENTS_FETCH: async (url, init) => {
      const params = new URL(url).searchParams;
      calls.push({ action: params.get('action'), page: params.get('page'), at: Date.now(), init });
      if (params.get('action') === 'query')
        return Response.json({
          query: {
            pages: params
              .get('titles')
              .split('|')
              .map((title) => ({ title: title.replace(/_/g, ' '), lastrevid: revid }))
          }
        });
      if (params.get('page') === ROOT)
        return Response.json({
          parse: {
            text: { '*': rootHtml },
            revid,
            links: [
              { ns: 0, '*': SUB.replace(/_/g, ' ') },
              { ns: 0, '*': ROOT + '/Qualifier' },
              { ns: 2, '*': ROOT + '/Playoffs' }
            ]
          }
        });
      if (params.get('page') === SUB)
        return Response.json({ parse: { text: { '*': subHtml }, revid, links: [] } });
      return response(page());
    }
  };
  const center = new EventCenter({ storage }, env);
  center.now = () => clock;
  return {
    center,
    storage,
    calls,
    parses: () => calls.filter((c) => c.action === 'parse' && c.page).map((c) => c.page),
    advance: (ms) => (clock += ms),
    bump: () => revid++,
    get: (t = ROOT) =>
      center.fetch(new Request('https://events.internal/detail?' + new URLSearchParams({ t })))
  };
}

test('first visit is 202, background parses fill it in, and ready payloads attribute Liquipedia', async () => {
  const ctx = setup();
  await ctx.center.alarm();
  assert.equal(ctx.calls.length, 1, 'schedule sync only; nobody asked for details yet');
  await ctx.storage.put('logoSource:' + BADGE, {
    hash: 'a'.repeat(64),
    checkedAt: ctx.center.now()
  });

  const pending = await ctx.get();
  assert.equal(pending.status, 202);
  assert.ok(Number(pending.headers.get('Retry-After')) >= 10);
  const body = await pending.json();
  assert.equal(body.state, 'pending');
  assert.equal(body.root, ROOT);
  assert.ok(ctx.center.details.wanted);

  // A subpage link resolves to the same stage.
  assert.equal((await (await ctx.get(SUB)).json()).root, ROOT);
  assert.equal((await ctx.get('Main_Page')).status, 400);

  ctx.advance(31000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT]);
  // Parses hold the shared 30-second parse gate and keep two minutes between detail pages.
  assert.ok((await ctx.storage.get('refreshAfter')) >= ctx.center.now() + 30000);
  ctx.advance(60000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT]);
  ctx.advance(61000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT, SUB]);

  const ready = await ctx.get();
  assert.equal(ready.status, 200);
  const view = await ready.json();
  assert.equal(view.state, 'ready');
  assert.equal(view.partial, false);
  assert.equal(view.info.title, 'OWCS 2026 Korea Stage 3');
  assert.equal(view.matches.length, 1);
  assert.deepEqual(view.stages, ['Week 1 · Day 1']);
  assert.equal(view.matches[0].teams[0].logo, LOGO_ROUTE + 'a'.repeat(64));
  assert.equal(view.matches[0].teams[1].logo, null);
  assert.equal(view.standings[0].rows[0].team.logo, LOGO_ROUTE + 'a'.repeat(64));
  assert.equal(view.participants[0].team.logo, LOGO_ROUTE + 'a'.repeat(64));
  assert.ok(!JSON.stringify(view).includes('liquipedia.net/commons'));
  assert.deepEqual(view.source.pages, [
    'https://liquipedia.net/overwatch/' + ROOT,
    'https://liquipedia.net/overwatch/' + SUB
  ]);
  assert.equal(view.source.name, 'Liquipedia');
  assert.equal(view.source.license, 'CC BY-SA 3.0');
  assert.equal(view.source.licenseUrl, 'https://creativecommons.org/licenses/by-sa/3.0/');
  for (const call of ctx.calls) {
    assert.match(call.init.headers['User-Agent'], /site\.test/);
    assert.equal(call.init.redirect, 'manual');
  }
});

test('unchanged revisions are not parsed again; a new revid triggers one reparse', async () => {
  const ctx = setup();
  await ctx.center.alarm();
  await ctx.get();
  ctx.advance(31000);
  await ctx.center.alarm();
  ctx.advance(121000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT, SUB]);
  const queries = () => ctx.calls.filter((c) => c.action === 'query').length;

  // Idle pages are checked every six hours with one cheap action=query for all paths.
  ctx.advance(6 * 3600000);
  await ctx.center.alarm(); // schedule sync takes this alarm
  ctx.advance(31000);
  await ctx.center.alarm();
  assert.equal(queries(), 1);
  for (let i = 0; i < 4; i++) {
    ctx.advance(31000);
    await ctx.center.alarm();
  }
  assert.deepEqual(ctx.parses(), [ROOT, SUB]);
  assert.equal(queries(), 1);

  ctx.bump();
  ctx.advance(6 * 3600000);
  await ctx.center.alarm();
  ctx.advance(31000);
  await ctx.center.alarm();
  assert.equal(queries(), 2);
  ctx.advance(31000);
  await ctx.center.alarm();
  ctx.advance(121000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT, SUB, ROOT, SUB]);
});

test('detail work never shares an alarm with another Liquipedia request or delays live scores', async () => {
  const ctx = setup();
  await ctx.center.alarm();
  await ctx.get();
  // The schedule sync is due again in this alarm, so details must wait for the next one.
  ctx.advance(15 * 60000);
  await ctx.center.alarm();
  assert.equal(ctx.parses().length, 0);
  assert.equal(ctx.calls.length, 2);
  ctx.advance(31000);
  await ctx.center.alarm();
  assert.deepEqual(ctx.parses(), [ROOT]);

  // On a one-minute live cadence detail parses use the slot between two schedule
  // refreshes: the first visit is filled within minutes and no refresh slips by more than
  // the three-second slack. The clock follows the alarms the center sets, like a server.
  const live = setup(),
    soon = Math.floor((live.center.now() + 30 * 60000) / 1000),
    refreshes = [];
  live.center.env.EVENTS_FETCH = ((inner) => async (url, init) => {
    if (new URL(url).searchParams.get('page')) return inner(url, init);
    refreshes.push(live.center.now());
    return response(page(card({ timestamp: String(soon) }), ''));
  })(live.center.env.EVENTS_FETCH);
  await live.center.alarm();
  assert.equal(await live.storage.getAlarm(), live.center.now() + 60000);
  assert.equal((await live.get()).status, 202);
  const first = live.center.now();
  while (live.center.now() < first + 10 * 60000) {
    live.advance(Math.max(1, (await live.storage.getAlarm()) - live.center.now()));
    await live.center.alarm();
  }
  assert.deepEqual(live.parses().slice(0, 2), [ROOT, SUB]);
  assert.equal((await live.get()).status, 200);
  for (let i = 1; i < refreshes.length; i++)
    assert.ok(refreshes[i] - refreshes[i - 1] <= 60000 + 3000, 'schedule refresh delayed');
  assert.ok(refreshes.length >= 9);
});

test('a stage page that keeps failing is reported as stalled instead of pending forever', async () => {
  const ctx = setup();
  ctx.center.env.EVENTS_FETCH = ((inner) => async (url, init) =>
    new URL(url).searchParams.get('page')
      ? Response.json({ parse: { text: { '*': null }, revid: 1, links: [] } })
      : inner(url, init))(ctx.center.env.EVENTS_FETCH);
  await ctx.center.alarm();
  assert.equal((await (await ctx.get()).json()).stalled, undefined);
  for (let i = 0; i < 40 && !(await (await ctx.get()).json()).stalled; i++) {
    ctx.advance(Math.max(5 * 60000, (await ctx.storage.getAlarm()) - ctx.center.now()));
    await ctx.center.alarm();
  }
  const body = await (await ctx.get()).json();
  assert.equal(body.state, 'pending');
  assert.equal(body.stalled, true);
});

test('a visit registered while a parse is in flight is not lost when the parse saves', async () => {
  const ctx = setup(),
    OTHER = 'Overwatch_Champions_Series/2026/China/Stage_3';
  let visit;
  ctx.center.env.EVENTS_FETCH = ((inner) => async (url, init) => {
    if (new URL(url).searchParams.get('page') === ROOT) visit ||= ctx.get(OTHER);
    return inner(url, init);
  })(ctx.center.env.EVENTS_FETCH);
  await ctx.center.alarm();
  await ctx.get();
  ctx.advance(31000);
  await ctx.center.alarm();
  await visit;
  assert.ok((await ctx.storage.get('detailIndex')).roots[OTHER]);
});

test('every Liquipedia request waits its two-second slot', async () => {
  const ctx = setup({ spacing: 40 }),
    started = Date.now();
  await Promise.all([ctx.center.lpSlot(), ctx.center.lpSlot(), ctx.center.lpSlot()]);
  assert.ok(Date.now() - started >= 75);
  const real = new EventCenter({ storage: new Storage() }, {});
  assert.equal(real.lpSpacing, 2000);
});

test('API route forwards the detail path to the event center', async () => {
  const seen = [];
  const env = {
    DASHEN_SERVER: '1',
    DASHEN_DTS: '2026',
    AUTH: {
      idFromName: () => 'auth',
      get: () => ({
        fetch: async (input, init) => {
          const { path } = JSON.parse(init.body);
          if (path === '/authorize') return Response.json({ user: { id: 'u1' }, version: 1 });
          if (path === '/session')
            return Response.json({ user: { id: 'u1', status: 'approved' }, csrf: 'c' });
          return Response.json({ error: '接口不存在' }, { status: 404 });
        }
      })
    },
    EVENTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (input) => {
          seen.push(String(input));
          return Response.json({ state: 'pending', root: ROOT, retryAfter: 30 }, { status: 202 });
        }
      })
    },
    ASSETS: { fetch: async () => new Response('') }
  };
  const response = await worker.fetch(
    new Request('https://site.test/api/v1/events/detail?t=' + encodeURIComponent(ROOT), {
      headers: { Cookie: 'qs_session=token' }
    }),
    env
  );
  assert.equal(response.status, 202);
  assert.deepEqual(seen, ['https://events.internal/detail?t=' + encodeURIComponent(ROOT)]);
});

test('events list links to the in-site detail page with the same root and match id as the backend', async () => {
  await import('../../frontend/web/events-model.js');
  const model = globalThis.EventsModel,
    [parsed] = parseDetailPage(subHtml, SUB).matches;
  const href = model.detailHref({
    series: 'owcs',
    sourceUrl: 'https://liquipedia.net/overwatch/' + SUB,
    startsAt: parsed.startsAt,
    teams: [{ name: 'Crazy Raccoon' }, { name: 'Team Falcons' }]
  });
  const url = new URL(href, 'https://site.test');
  assert.equal(url.pathname, '/tools/event.html');
  assert.equal(url.searchParams.get('t'), ROOT);
  assert.equal(decodeURIComponent(url.hash.slice(3)), parsed.id);
  for (const sourceUrl of [
    'https://liquipedia.net/overwatch/' + SUB,
    'https://liquipedia.net/overwatch/' + ROOT + '/Playoffs',
    'https://liquipedia.net/overwatch/Main_Page',
    'https://example.com/overwatch/' + ROOT
  ])
    assert.equal(model.detailRoot(sourceUrl), detailRoot(sourceUrl));
  assert.equal(
    model.detailHref({ series: 'other', sourceUrl: 'https://liquipedia.net/overwatch/' + ROOT }),
    null
  );
});

test('region standings list the schedule stages, register them for parsing and fill in', async () => {
  const ctx = setup();
  ctx.center.env.EVENTS_FETCH = ((inner) => async (url, init) => {
    if (new URL(url).searchParams.get('page')) return inner(url, init);
    const now = Math.floor(ctx.center.now() / 1000);
    return response(
      page(
        card({ path: SUB, timestamp: String(now + 3 * 3600) }) +
          card({
            path: 'Overwatch_Champions_Series/2026/China/Stage_3',
            name: 'OWCS China Stage 3',
            timestamp: String(now + 5 * 3600)
          }) +
          card({ path: 'Some_Other_Cup/2026', name: 'Other', timestamp: String(now + 3600) }),
        ''
      )
    );
  })(ctx.center.env.EVENTS_FETCH);
  await ctx.center.alarm();
  const read = async () =>
    (await ctx.center.fetch(new Request('https://events.internal/standings'))).json();
  let value = await read();
  assert.deepEqual(
    value.regions.map((r) => [r.region, r.root, r.state]),
    [
      ['中国', 'Overwatch_Champions_Series/2026/China/Stage_3', 'pending'],
      ['韩国', ROOT, 'pending']
    ]
  );
  assert.equal(value.source.license, 'CC BY-SA 3.0');
  // Stage pages are parsed before subpages, one per free parse slot.
  for (let i = 0; i < 6; i++) {
    ctx.advance(Math.max(31000, (await ctx.storage.getAlarm()) - ctx.center.now()));
    await ctx.center.alarm();
  }
  assert.deepEqual(ctx.parses().slice(0, 2).sort(), [
    ROOT,
    'Overwatch_Champions_Series/2026/China/Stage_3'
  ]);
  value = await read();
  const korea = value.regions.find((r) => r.root === ROOT);
  assert.equal(korea.state, 'ready');
  assert.equal(korea.standings[0].kind, 'swiss');
  assert.equal(korea.standings[0].rows[0].team.name, 'Crazy Raccoon');
  assert.equal(korea.source, 'https://liquipedia.net/overwatch/' + ROOT);
});
