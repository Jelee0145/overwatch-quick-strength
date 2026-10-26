import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.mjs';

const ORIGIN = 'https://site.test';
const MATCHES = [
  {
    id: 'match-1',
    series: 'owcs',
    sourceUrl: 'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/China/Stage_3',
    tournament: 'OWCS 2026 中国赛区 Stage 3',
    region: '中国',
    teams: [
      { name: 'Team A', shortName: 'A' },
      { name: 'Team B', shortName: 'B' }
    ],
    startsAt: '2026-10-21T12:00:00.000Z',
    status: 'scheduled',
    scores: [null, null],
    bestOf: 5
  },
  {
    id: 'match-2',
    series: 'owcs',
    sourceUrl:
      'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Asia/Stage_3/Korea',
    tournament: 'OWCS 2026 韩国赛区 Stage 3',
    region: '韩国',
    teams: [
      { name: 'Team C', shortName: 'C' },
      { name: 'Team D', shortName: 'D' }
    ],
    startsAt: '2026-10-22T12:00:00.000Z',
    status: 'scheduled',
    scores: [null, null],
    bestOf: 5
  }
];

function setup({ authorized = true, userId = 'session-user', reminders = true } = {}) {
  const authCalls = [];
  const eventCalls = [];
  const handled = [];
  const decorated = [];
  const env = {
    DASHEN_SERVER: '1',
    DASHEN_DTS: '2026',
    AUTH: {
      idFromName: () => 'auth',
      get: () => ({
        fetch: async (input, init) => {
          const payload = JSON.parse(init.body);
          authCalls.push(payload);
          if (payload.path === '/authorize') {
            if (!authorized) return Response.json({ error: '请先登录' }, { status: 401 });
            return Response.json({ user: { id: userId }, version: 1 });
          }
          if (payload.path === '/session') {
            if (!authorized) return Response.json({ error: '请先登录' }, { status: 401 });
            return Response.json({
              user: { id: userId, email: 'demo@example.invalid', status: 'approved' },
              csrf: 'session-csrf'
            });
          }
          return Response.json({ error: '接口不存在' }, { status: 404 });
        }
      })
    },
    EVENTS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async (input, init) => {
          eventCalls.push({ url: String(input), method: init?.method || 'GET' });
          return Response.json({ matches: structuredClone(MATCHES) });
        }
      })
    },
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname) }
  };
  if (reminders) {
    env.REMINDERS = {
      handle: async (user, action, body) => {
        handled.push({ user, action, body });
        return {
          enabled: true,
          publicKey: 'preview-public-key',
          reservations: [],
          notices: [],
          user,
          action
        };
      },
      decorate: async (matches) => {
        decorated.push(matches);
        return matches.map((match) => ({
          ...match,
          reminderId: 'reminder-' + match.id,
          reservable: true
        }));
      }
    };
  }
  return { env, authCalls, eventCalls, handled, decorated };
}

const get = (path, headers = {}) => new Request(ORIGIN + path, { headers });
const post = (path, body = {}, headers = {}) =>
  new Request(ORIGIN + path, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      Cookie: 'qs_session=session-token',
      ...headers
    },
    body: JSON.stringify(body)
  });
const sessionCookie = { Cookie: 'qs_session=session-token' };

test('unauthenticated event and reminder requests are rejected before any service call', async () => {
  const ctx = setup({ authorized: false });
  for (const path of ['/api/events', '/api/events/reminders']) {
    const response = await worker.fetch(get(path), ctx.env);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /登录/);
  }
  const reserve = await worker.fetch(
    post('/api/events/reminders/reserve', { matchId: 'match-1' }),
    ctx.env
  );
  assert.equal(reserve.status, 401);
  assert.equal(ctx.eventCalls.length, 0);
  assert.equal(ctx.handled.length, 0);
  assert.equal(ctx.decorated.length, 0);
  // The session token comes from the HttpOnly cookie, never from the request body or query.
  assert.equal(ctx.authCalls.at(-1).userToken, 'session-token');
  assert.equal(ctx.authCalls.at(-1).adminToken, '');
});

test('mutating reminder routes require same-origin JSON but reads do not demand an Origin', async () => {
  const ctx = setup();
  const crossOrigin = await worker.fetch(
    post('/api/events/reminders/reserve', { matchId: 'match-1' }, { Origin: 'https://evil.test' }),
    ctx.env
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(ctx.handled.length, 0);

  const plain = await worker.fetch(
    post('/api/events/reminders/reserve', { matchId: 'match-1' }, { 'Content-Type': 'text/plain' }),
    ctx.env
  );
  assert.equal(plain.status, 403);
  assert.equal(ctx.handled.length, 0);

  const missingOrigin = await worker.fetch(
    new Request(ORIGIN + '/api/events/reminders/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionCookie },
      body: JSON.stringify({ matchId: 'match-1' })
    }),
    ctx.env
  );
  assert.equal(missingOrigin.status, 403);
  assert.equal(ctx.handled.length, 0);

  const read = await worker.fetch(get('/api/events/reminders', sessionCookie), ctx.env);
  assert.equal(read.status, 200);
  assert.deepEqual(
    ctx.handled.map((item) => item.action),
    ['list']
  );

  const valid = await worker.fetch(
    post('/api/events/reminders/reserve', { matchId: 'match-1' }),
    ctx.env
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    ctx.handled.map((item) => item.action),
    ['list', 'reserve']
  );
});

test('the reminder identity is derived from the authorized session, not client input', async () => {
  const ctx = setup({ userId: 'account-from-session' });
  const response = await worker.fetch(
    post('/api/events/reminders/reserve', {
      matchId: 'match-1',
      user: 'attacker',
      userId: 'attacker'
    }),
    ctx.env
  );
  assert.equal(response.status, 200);
  assert.deepEqual(ctx.handled, [
    {
      user: 'account-from-session',
      action: 'reserve',
      body: { matchId: 'match-1', user: 'attacker', userId: 'attacker' }
    }
  ]);
  const value = await response.json();
  assert.equal(value.user, 'account-from-session');
  // Reads and every action share the same authenticated route.
  const list = await worker.fetch(
    get('/api/events/reminders', {
      ...sessionCookie,
      Cookie: 'qs_session=session-token; qs_admin=admin-token'
    }),
    ctx.env
  );
  assert.equal(list.status, 200);
  assert.equal(ctx.handled.at(-1).user, 'account-from-session');
  assert.equal(ctx.handled.at(-1).action, 'list');
  assert.equal(ctx.authCalls.at(-1).adminToken, 'admin-token');
});

test('reminder route method gates reject the wrong verb before the service is called', async () => {
  const ctx = setup();
  const listAsPost = await worker.fetch(post('/api/events/reminders', {}), ctx.env);
  assert.equal(listAsPost.status, 405);
  const actionAsGet = await worker.fetch(
    get('/api/events/reminders/reserve', sessionCookie),
    ctx.env
  );
  assert.equal(actionAsGet.status, 405);
  assert.equal(ctx.handled.length, 0);
});

test('an unconfigured REMINDERS binding reports disabled for reads and rejects mutations', async () => {
  const ctx = setup({ reminders: false });
  const list = await worker.fetch(get('/api/events/reminders', sessionCookie), ctx.env);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    enabled: false,
    publicKey: '',
    reservations: [],
    notices: []
  });

  for (const [path, body] of [
    ['/api/events/reminders/reserve', { matchId: 'match-1' }],
    [
      '/api/events/reminders/subscribe',
      { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' } }
    ],
    ['/api/events/reminders/cancel', { id: 'reminder-match-1' }]
  ]) {
    const response = await worker.fetch(post(path, body), ctx.env);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /尚未启用/);
  }
});

test('the events list is decorated by REMINDERS and filtered before decoration', async () => {
  const ctx = setup();
  const response = await worker.fetch(
    get('/api/events?series=owcs&region=KR', sessionCookie),
    ctx.env
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(ctx.eventCalls.length, 1);
  assert.equal(new URL(ctx.eventCalls[0].url).searchParams.get('status'), 'all');
  assert.equal(ctx.decorated.length, 1);
  assert.equal(ctx.decorated[0].length, 1);
  assert.equal(ctx.decorated[0][0].id, 'match-2');
  assert.equal(value.matches.length, 1);
  assert.equal(value.matches[0].reminderId, 'reminder-match-2');
  assert.equal(value.matches[0].reservable, true);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(ctx.handled.length, 0);
});

test('without REMINDERS the events list still receives broadcasts and is not reservable', async () => {
  const ctx = setup({ reminders: false });
  const response = await worker.fetch(
    get('/api/events?series=owcs&region=KR', sessionCookie),
    ctx.env
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.matches.length, 1);
  assert.equal(value.matches[0].reservable, false);
  assert.deepEqual(value.matches[0].broadcasts, [
    {
      id: 'owcs-kr',
      label: '官方韩语直播（SOOP）',
      url: 'https://www.sooplive.co.kr/station/owesports',
      platform: 'soop'
    }
  ]);
});
