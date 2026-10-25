#!/usr/bin/env node
// Anonymous, loopback-only preview for the events + reminders UI.
// All state is synthetic and in memory. This script never reads .dev.vars,
// .private, public configuration snapshots or any other real credentials/data.
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {staticAssets} from '../server/assets.mjs';
import {generatePushKeys} from '../server/web-push.mjs';
import {broadcastsFor} from '../src/events/broadcasts.mjs';
import {matchIdentity} from '../server/event-reminders.mjs';
import {filterEvents} from '../src/events/filter.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT) || 8790;
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const assets = staticAssets(path.join(root, 'public'));
// Only the public VAPID key leaves this process; the private half is discarded.
const pushPublicKey = generatePushKeys().publicKey;

const definitions = [
  {region: '中国', tournament: 'OWCS 2026 中国赛区 Stage 3', path: 'China/Stage_3/Regular_Season', teams: ['Weibo Gaming', 'All Gamers'], short: ['WBG', 'AG'], bestOf: 5},
  {region: '韩国', tournament: 'OWCS 2026 韩国赛区 Stage 3', path: 'Asia/Stage_3/Korea', teams: ['T1', 'ZETA DIVISION'], short: ['T1', 'ZETA'], bestOf: 5},
  {region: '日本', tournament: 'OWCS 2026 日本赛区 Stage 3', path: 'Asia/Stage_3/Japan', teams: ['VANTA', 'REJECT'], short: ['VANTA', 'RC'], bestOf: 5},
  {region: '太平洋', tournament: 'OWCS 2026 太平洋赛区 Stage 3', path: 'Asia/Stage_3/Pacific', teams: ['Fukuoka SoftBank HAWKS', 'Team Falcons'], short: ['HSK', 'FLCN'], bestOf: 5},
  {region: '北美', tournament: 'OWCS 2026 北美赛区 Stage 3', path: 'North_America/Stage_3/Regular_Season', teams: ['Spacestation Gaming', 'Team Liquid'], short: ['SSG', 'TL'], bestOf: 5},
  {region: 'EMEA', tournament: 'OWCS 2026 EMEA Stage 3', path: 'EMEA/Stage_3/Regular_Season', teams: ['Virtus.pro', 'Twisted Minds'], short: ['VP', 'TM'], bestOf: 5},
  {region: '国际赛', tournament: 'OWCS 2026 Midseason Championship', path: '2026/Midseason', teams: ['Crazy Raccoon', 'Team Falcons'], short: ['CR', 'FLCN'], bestOf: 7}
];

const base = Date.now();
const matches = definitions.map((definition, index) => {
  const match = {
    id: `preview-match-${index + 1}`,
    series: 'owcs',
    sourceUrl: `https://liquipedia.net/overwatch/Overwatch_Champions_Series/${definition.path}`,
    tournament: definition.tournament,
    region: definition.region,
    teams: definition.teams.map((name, team) => ({
      name,
      shortName: definition.short[team],
      logo: null
    })),
    startsAt: new Date(base + (index + 2) * 95 * 60 * 1000).toISOString(),
    status: 'scheduled',
    scores: [null, null],
    bestOf: definition.bestOf
  };
  return {
    ...match,
    broadcasts: broadcastsFor(match),
    reminderId: matchIdentity(match),
    reservable: true
  };
});

const catalog = new Map(matches.map(match => [match.reminderId, match]));
const snapshot = {
  matches,
  updatedAt: new Date().toISOString(),
  stale: false,
  coverage: '匿名本地预览 · 合成 OWCS 数据，不是真实赛程或赛果',
  source: {name: 'preview', url: '', license: ''}
};

// Simple in-memory reminder state. It intentionally skips Web Push delivery.
const reminders = {subscriptions: new Set(), reservations: new Map(), notices: []};

function reminderView() {
  const now = Date.now();
  reminders.notices = reminders.notices.filter(notice => now - notice.createdAt < 3 * 60 * 1000);
  return {
    enabled: true,
    publicKey: pushPublicKey,
    reservations: [...reminders.reservations.values()].map(reservation => ({
      id: reservation.id,
      match: catalog.get(reservation.id),
      changed: false,
      state: 'active'
    })),
    notices: reminders.notices
  };
}

function addNotice() {
  const reservation = [...reminders.reservations.keys()][0];
  const match = catalog.get(reservation) || matches[0];
  const notice = {
    id: randomUUID(),
    matchId: match.reminderId,
    url: broadcastsFor(match)[0]?.url || '/tools/events',
    createdAt: Date.now()
  };
  reminders.notices.push(notice);
  return notice;
}

function findCatalog(matchId) {
  for (const [id, match] of catalog) {
    if (id === matchId || match.id === matchId) return [id, match];
  }
  return null;
}

function events(url, refresh = false) {
  const params = new URLSearchParams(url.searchParams);
  if (!params.has('status')) params.set('status', 'all');
  const value = filterEvents(snapshot, params, {paginate: false});
  if (refresh) snapshot.updatedAt = new Date().toISOString();
  return {
    ...value,
    updatedAt: snapshot.updatedAt,
    stale: false,
    coverage: snapshot.coverage,
    matches: value.matches.map(match => ({
      ...match,
      broadcasts: broadcastsFor(match),
      reminderId: matchIdentity(match),
      reservable: true
    }))
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, {error: message});
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(Error('Payload too large'), {status: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request) {
  const text = await readBody(request);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw Object.assign(Error('请求格式错误'), {status: 400});
  }
}

function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

async function serveAsset(request, response) {
  const asset = await assets.fetch(request);
  const headers = Object.fromEntries(asset.headers);
  headers['X-Content-Type-Options'] = 'nosniff';
  headers['Referrer-Policy'] = 'no-referrer';
  headers['X-Frame-Options'] = 'DENY';
  headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()';
  response.writeHead(asset.status, headers);
  response.end(Buffer.from(await asset.arrayBuffer()));
}

const server = http.createServer(async (request, response) => {
  try {
    if (!isLoopback(request.socket.remoteAddress)) return sendError(response, 403, '仅允许本机访问');
    const requestHost = String(request.headers.host || '').toLowerCase();
    if (!allowedHosts.has(requestHost)) return sendError(response, 421, 'Host 不受支持');
    if (!['GET', 'POST'].includes(request.method)) return sendError(response, 405, '不支持的请求方法');

    const requestOrigin = `http://${requestHost}`;
    const url = new URL(request.url, requestOrigin);
    if (url.origin !== requestOrigin) return sendError(response, 421, '请求来源不受支持');

    // Mutations must be same-origin JSON, matching the production worker gate.
    if (request.method === 'POST') {
      if (request.headers.origin !== requestOrigin
          || !String(request.headers['content-type'] || '').startsWith('application/json')) {
        return sendError(response, 403, '请求来源或格式不正确');
      }
    }

    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      return sendJson(response, 200, {
        user: {
          id: 'preview-user',
          email: 'demo@example.invalid',
          status: 'approved',
          apiKey: {exists: false}
        },
        csrf: 'preview-csrf',
        scope: {server: '1', dts: '2026'},
        usage: {day: new Date().toISOString().slice(0, 10), query: 0, ai: 0}
      });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      await readBody(request);
      return sendJson(response, 200, {ok: true});
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      return sendJson(response, 200, events(url));
    }
    if (url.pathname === '/api/events/refresh') {
      if (request.method !== 'POST') return sendError(response, 405, '请求方法错误');
      await readBody(request);
      return sendJson(response, 200, events(url, true));
    }

    if (url.pathname === '/api/events/reminders') {
      if (request.method !== 'GET') return sendError(response, 405, '请求方法错误');
      if (url.searchParams.has('preview-notice')) addNotice();
      return sendJson(response, 200, reminderView());
    }
    if (url.pathname.startsWith('/api/events/reminders/')) {
      if (request.method !== 'POST') return sendError(response, 405, '请求方法错误');
      const action = url.pathname.slice('/api/events/reminders/'.length);
      const body = await readJson(request);
      if (action === 'subscribe') {
        const endpoint = body.subscription?.endpoint;
        if (typeof endpoint !== 'string' || !endpoint) return sendError(response, 400, '通知设备格式错误');
        reminders.subscriptions.add(endpoint);
      } else if (action === 'unsubscribe') {
        if (typeof body.endpoint === 'string') reminders.subscriptions.delete(body.endpoint);
      } else if (action === 'reserve') {
        const found = findCatalog(body.matchId);
        if (!found) return sendError(response, 400, '这场比赛暂不支持预约，请刷新赛程');
        reminders.reservations.set(found[0], {id: found[0], createdAt: Date.now()});
      } else if (action === 'cancel') {
        if (typeof body.id === 'string') {
          reminders.reservations.delete(body.id);
          reminders.notices = reminders.notices.filter(notice => notice.matchId !== body.id);
        }
      } else {
        return sendError(response, 404, '接口不存在');
      }
      return sendJson(response, 200, reminderView());
    }

    // Test hook: the next real frontend poll (every 15s while visible) shows a toast.
    if (url.pathname === '/__preview__/notice' && request.method === 'POST') {
      await readBody(request);
      return sendJson(response, 200, {ok: true, notice: addNotice()});
    }

    if (url.pathname === '/__preview__/state' && request.method === 'GET') {
      return sendJson(response, 200, {
        userId: 'preview-user',
        matches: matches.length,
        subscriptions: reminders.subscriptions.size,
        reservations: [...reminders.reservations.keys()],
        notices: reminderView().notices
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__preview__/')) {
      return sendError(response, 404, '接口不存在');
    }
    if (url.pathname === '/') url.pathname = '/index.html';
    if (url.pathname === '/login') url.pathname = '/login.html';
    if (url.pathname === '/admin') url.pathname = '/admin.html';
    if (url.pathname === '/tools/events' || url.pathname === '/tools/events/') url.pathname = '/tools/events.html';
    return serveAsset(new Request(url, {method: 'GET'}), response);
  } catch (error) {
    if (!response.headersSent) sendError(response, error.status || 500, error.message || '预览服务暂不可用');
    else response.destroy();
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.listen(port, host, () => {
  console.log(`Events reminders preview: ${origin}/tools/events`);
  console.log('Anonymous synthetic session: preview-user / demo@example.invalid');
  console.log(`Trigger a notice: curl -X POST -H "Origin: ${origin}" -H "Content-Type: application/json" -d "{}" ${origin}/__preview__/notice`);
});
