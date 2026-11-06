// Full-site local demo: the real backend in memory, one approved fixture account with signed history,
// mock game-data upstream and fixture event pages run through the real Liquipedia parser.
// Loopback only. Never reads .dev.vars, .private or any real credential, and never calls a real provider.
import path from 'node:path';
import { createRuntime } from '../../backend/server/runtime.mjs';
import { createHttpServer } from '../../backend/server/http.mjs';
import { staticAssets } from '../../backend/server/assets.mjs';
import { analysisFixture } from '../../test/services-fixture.mjs';
import { service } from '../../test/query-fixture.mjs';
import { card, page, response } from '../../test/events-fixture.mjs';
import { ROOT, SUB, rootHtml, subHtml } from '../../test/events/detail-fixture.mjs';
import { signSnapshot } from '../../backend/src/security.mjs';
import { parseDetailPage } from '../../backend/src/events/detail-parser.mjs';

const port = Number(process.env.PORT) || 8793,
  origin = 'http://127.0.0.1:' + port;
// Synthetic test values only; they exist nowhere but in this process.
const DEMO_EMAIL = 'demo@example.test',
  DEMO_PASSWORD = 'demo-password-local';
const config = {
  PASSWORD_PEPPER: 'demo-only-pepper',
  CACHE_SIGNING_KEY: 'demo-only-signing',
  API_KEY_ENCRYPTION_KEY: 'demo-only-key',
  DASHEN_SERVER: '1',
  DASHEN_DTS: '2026',
  DASHEN_ROLE_ID: 'fixture-role',
  DASHEN_TOKEN: 'fixture-token',
  PUBLIC_ORIGIN: origin
};

// Schedule: a mix of finished, live-soon and later matches across regions, relative to now.
const now = Math.floor(Date.now() / 1000),
  at = (hours) => String(now + Math.round(hours * 3600));
const stage = (region, name) => ({
  path: 'Overwatch_Champions_Series/2026/' + region,
  name
});
const korea = { path: SUB, name: 'OWCS Korea Stage 3 - Regular Season' },
  china = stage('China/Stage_3/Regular_Season', 'OWCS China Stage 3 - Regular Season'),
  na = stage('North_America/Stage_3/Regular_Season', 'OWCS NA Stage 3 - Regular Season'),
  emea = stage('EMEA/Stage_3/Regular_Season', 'OWCS EMEA Stage 3 - Regular Season'),
  japan = stage('Asia/Stage_3/Japan/Regular_Season', 'OWCS Japan Stage 3 - Regular Season');
const upcoming = [
  card({ ...korea, timestamp: at(0.6), teams: ['Crazy Raccoon', 'Team Falcons'] }),
  card({ ...china, timestamp: at(1.5), teams: ['Weibo Gaming', 'All Gamers'] }),
  card({ ...korea, timestamp: at(3), teams: ['T1', 'ZETA DIVISION'] }),
  card({ ...japan, timestamp: at(5), teams: ['VARREL', 'REJECT'] }),
  card({ ...na, timestamp: at(26), teams: ['Spacestation Gaming', 'Team Liquid'] }),
  card({ ...emea, timestamp: at(28), teams: ['Virtus.pro', 'Twisted Minds'] }),
  card({ ...china, timestamp: at(50), teams: ['JD Gaming', 'Ultra Prime'] })
].join('');
const recent = [
  card({
    ...korea,
    finished: true,
    scores: [3, 1],
    timestamp: at(-20),
    teams: ['Crazy Raccoon', 'Team Falcons']
  }),
  card({
    ...china,
    finished: true,
    scores: [2, 3],
    timestamp: at(-23),
    teams: ['Weibo Gaming', 'JD Gaming']
  }),
  card({
    ...na,
    finished: true,
    scores: [3, 0],
    timestamp: at(-44),
    teams: ['Team Liquid', 'Shopify Rebellion']
  })
].join('');
const details = new Map([
  [ROOT, rootHtml],
  [SUB, subHtml]
]);
const eventsFetch = async (url) => {
  const target = new URL(url).searchParams.get('page');
  if (!target) return response(page(upcoming, recent));
  // The stage root must list its subpages, or a scheduled re-parse drops the match list.
  return Response.json({
    parse: {
      text: { '*': details.get(target) || '<div class="mw-parser-output"></div>' },
      links: target === ROOT ? [{ ns: 0, '*': SUB }] : []
    }
  });
};

const mock = service({ newGames: 5 });
const runtime = createRuntime(config, {
  filename: ':memory:',
  assets: staticAssets(path.resolve(import.meta.dirname, '../../public')),
  ratePerSecond: Infinity,
  eventsFetch,
  upstreamFetch: async (url, init) => {
    const value = new URL(url),
      body = init?.body ? JSON.parse(init.body) : undefined;
    return Response.json({
      code: 0,
      data: await mock.call(
        config,
        value.pathname.replace('/v1/a19ld5tool', ''),
        Object.fromEntries(value.searchParams),
        body
      )
    });
  }
});
const invoke = async (route, body = {}) => {
  const res = await runtime.env.AUTH.get().fetch('https://internal/', {
    method: 'POST',
    body: JSON.stringify({ path: route, body, ip: 'demo' })
  });
  if (!res.ok) throw Error('Demo setup failed: ' + route);
  return res.json();
};
const account = await invoke('/register', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
const store = runtime.database.store('auth'),
  record = await store.get('user:' + account.user.id);
record.status = 'approved';
await store.put('user:' + record.id, record);
const tasks = runtime.env.TASKS.get(runtime.env.TASKS.idFromName(record.id));
await tasks.fetch('https://internal/', {
  method: 'POST',
  body: JSON.stringify({
    path: '/history',
    user: record.id,
    version: record.version,
    body: {
      action: 'push',
      envelopes: [await signSnapshot(record.id, analysisFixture(), runtime.env)]
    }
  })
});
// Pull the schedule once now instead of waiting for the first alarm, and pre-parse the Korea stage
// pages so detail and standings open immediately (production paces these fetches minutes apart).
const center = runtime.instance('events');
await center.alarm();
const eventStore = runtime.database.store('events');
for (const [target, html] of details)
  await eventStore.put('detailPage:' + target, {
    revid: null,
    fetchedAt: Date.now(),
    data: parseDetailPage(html, target),
    subpages: target === ROOT ? [SUB] : undefined
  });

const server = createHttpServer(runtime, { origin, allowLoopback: true });
server.listen(port, '127.0.0.1', () => {
  console.log('Local demo: ' + origin + '/login');
  console.log('Login: ' + DEMO_EMAIL + ' / ' + DEMO_PASSWORD + ' (synthetic, memory only)');
});
async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
}
process.on('SIGTERM', () => stop().then(() => process.exit(0)));
process.on('SIGINT', () => stop().then(() => process.exit(0)));
