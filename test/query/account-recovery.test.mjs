import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuery,
  queryStep,
  queryCheckpoint,
  restoreQuery,
  accountRecords
} from '../../src/query/query.mjs';
import { Fault } from '../../src/security.mjs';
import { setup, start, finish, fixture } from '../helpers/tasks.mjs';

const shared = (mid, target = 'Other#200', time = 1) => ({
  mid,
  t: time,
  duration: 600,
  hasGameData: true,
  resourceDataChecked: true,
  players: [{ name: 'Main#100' }, { name: target }]
});
const roster = (target = 'Other#200') => ({
  teammateList: [
    { name: 'Main#100' },
    { name: target, bnetId: '200', customerToken: 'roster-private' }
  ],
  enemyList: []
});
function provider(overrides = {}) {
  const seen = [];
  const call = async (_env, path, params, body, options) => {
    seen.push({ path, params, body, priority: options?.priority });
    if (overrides[path]) return overrides[path](params);
    if (path === '/searchBnetAccount') return undefined;
    if (path === '/queryCard') return { name: 'Main#100', customerToken: 'owner-private' };
    if (path === '/customer/queryMatchInfo') return roster();
    if (path === '/customer/queryCard')
      return { name: 'Other#200', bnetId: '200', customerToken: 'verified-private' };
    throw Error('Unexpected path');
  };
  return { seen, call };
}
async function startRecovery(state, mock, options = {}) {
  for (let i = 0; !state.accountRecovery && i < 8; i++)
    await queryStep(state, {}, mock.call, options);
  assert.ok(state.accountRecovery);
}

test('shared-history route verifies full profile identity and resumes without rereading the roster', async () => {
  let s = createQuery('other#200', 5),
    historyReads = 0;
  const mock = provider();
  const options = {
    accountMatches: async (owner) => {
      assert.equal(owner, 'Main#100');
      historyReads++;
      return [shared('older'), shared('latest', 'Other#200', 3), shared('latest', 'Other#200', 3)];
    }
  };
  await startRecovery(s, mock, options);
  assert.deepEqual(s.accountRecovery.mids, ['latest', 'older']);
  await queryStep(s, {}, mock.call, options);
  assert.equal(s.accountRecovery.candidate.token, 'roster-private');
  s = restoreQuery(queryCheckpoint(s), s.prior);
  await queryStep(s, {}, mock.call, options);
  assert.equal(s.phase, 'list');
  assert.equal(s.tag, 'Other#200');
  assert.equal(s.mainToken, 'verified-private');
  assert.equal(historyReads, 1);
  assert.equal(mock.seen.filter((r) => r.path === '/customer/queryMatchInfo').length, 1);
  assert.ok(mock.seen.every((r) => r.priority === 'high'));
  assert.deepEqual(
    accountRecords(s).map((r) => r.name),
    ['Other#200']
  );
  assert.ok(!JSON.stringify(queryCheckpoint(s)).includes('owner-private'));
});

test('only complete, readable, shared history is a recovery source; unrelated history cannot trigger scans', async () => {
  const cases = [
    [],
    [shared('wrong-number', 'Other#201')],
    [{ ...shared('no-owner'), players: [{ name: 'Other#200' }] }],
    [{ ...shared('no-data'), resourceDataChecked: false }],
    [{ ...shared('invalid-id'), mid: undefined }]
  ];
  for (const history of cases) {
    const s = createQuery('other#200', 5),
      mock = provider();
    await assert.rejects(
      startRecovery(s, mock, { accountMatches: async () => history }),
      (error) => error.status === 400
    );
    assert.ok(!mock.seen.some((r) => r.path === '/customer/queryMatchInfo'));
    assert.equal(s.mainToken, undefined);
  }
});

test('current roster must contain the owner and the full target; profile discriminator and bnet ID are checked', async () => {
  for (const overrides of [
    {
      '/customer/queryMatchInfo': () => ({
        teammateList: [{ name: 'Other#200', customerToken: 'private' }]
      })
    },
    { '/customer/queryMatchInfo': () => roster('Other#201') },
    {
      '/customer/queryCard': () => ({ name: 'Other#201', bnetId: '200', customerToken: 'private' })
    },
    {
      '/customer/queryCard': () => ({ name: 'Other#200', bnetId: '201', customerToken: 'private' })
    },
    { '/customer/queryCard': () => ({ name: 'Other#200', bnetId: '200' }) }
  ]) {
    const s = createQuery('other#200', 5),
      mock = provider(overrides);
    const options = { accountMatches: async () => [shared('known')] };
    await startRecovery(s, mock, options);
    await assert.rejects(
      async () => {
        for (let i = 0; i < 3; i++) await queryStep(s, {}, mock.call, options);
      },
      (error) => error.status === 502
    );
    assert.equal(s.mainToken, undefined);
  }
});

test('failed recovery is bounded to two existing matches and does not crawl newly seen players', async () => {
  const s = createQuery('other#200', 5);
  const mock = provider({
    '/customer/queryCard': () => ({ name: 'Different#300', customerToken: 'private' })
  });
  const options = {
    accountMatches: async () => Array.from({ length: 8 }, (_, i) => shared('m' + i, 'Other#200', i))
  };
  await startRecovery(s, mock, options);
  assert.deepEqual(s.accountRecovery.mids, ['m7', 'm6']);
  await assert.rejects(
    async () => {
      for (let i = 0; i < 6; i++) await queryStep(s, {}, mock.call, options);
    },
    (error) => error.status === 502
  );
  assert.equal(mock.seen.filter((r) => r.path === '/customer/queryMatchInfo').length, 2);
  assert.equal(mock.seen.filter((r) => r.path === '/customer/queryCard').length, 2);
  assert.equal(s.mainToken, undefined);
});

test('cancellation/deadlines stop verification and 429 resumes from its existing private checkpoint', async () => {
  let s = createQuery('other#200', 5);
  const mock = provider(),
    options = { accountMatches: async () => [shared('known')] };
  await startRecovery(s, mock, options);
  await queryStep(s, {}, mock.call, options);
  const before = mock.seen.length;
  await queryStep(s, {}, mock.call, { shouldStop: async () => true });
  await queryStep(s, {}, mock.call, { deadline: Date.now() - 1 });
  assert.equal(mock.seen.length, before);
  await assert.rejects(
    queryStep(s, {}, async (_env, path) => {
      assert.equal(path, '/customer/queryCard');
      throw new Fault('limited', 429);
    }),
    (error) => error.status === 429
  );
  s = restoreQuery(queryCheckpoint(s), s.prior);
  await queryStep(s, {}, mock.call);
  assert.equal(s.phase, 'list');
  assert.equal(mock.seen.filter((r) => r.path === '/customer/queryMatchInfo').length, 1);
});

test('private history read errors remain retryable instead of becoming player-not-found', async () => {
  const s = createQuery('other#200', 5),
    mock = provider();
  await assert.rejects(
    startRecovery(s, mock, {
      accountMatches: async () => {
        throw Error('storage unavailable');
      }
    }),
    (error) => error.status === 502 && error.message.includes('历史身份参考')
  );
  assert.equal(s.mainToken, undefined);
});

test('actor recovery reads only the current job user history and completes an archived other-player query', async () => {
  const ctx = await setup(),
    reads = [];
  ctx.task.priorFromHistory = async (user, name) => {
    reads.push({ user, name });
    assert.equal(user, 'u');
    return name === 'Main#100' ? { matches: [shared('known', 'T1#100')] } : null;
  };
  await fixture(async (mock) => {
    const raw = mock.call;
    mock.call = async (env, path, params, body) => {
      if (path === '/searchBnetAccount') return undefined;
      if (path === '/queryCard') return { name: 'Main#100', customerToken: 'main-private' };
      if (path === '/customer/queryCard') return { name: 'T1#100', customerToken: 'T1-private' };
      return raw(env, path, params, body);
    };
    const created = await start(ctx.task, { battletag: 'T1#100', syncHistory: true });
    assert.equal(created.status, 200);
    assert.equal((await finish(ctx.task, created.id)).state, 'done');
  });
  assert.deepEqual(reads, [
    { user: 'u', name: 'T1#100' },
    { user: 'u', name: 'Main#100' }
  ]);
});

test('history opt-out never reads archived owner evidence while resolving an account', async () => {
  const ctx = await setup();
  let reads = 0;
  ctx.task.priorFromHistory = async () => {
    reads++;
    return { matches: [shared('private', 'T1#100')] };
  };
  await fixture(async (mock) => {
    const raw = mock.call;
    mock.call = async (env, path, params, body) => {
      if (path === '/searchBnetAccount') return undefined;
      if (path === '/queryCard') return { name: 'Main#100', customerToken: 'main-private' };
      return raw(env, path, params, body);
    };
    const created = await start(ctx.task, { battletag: 'T1#100', syncHistory: false });
    const job = await finish(ctx.task, created.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.message, '未找到可查询玩家');
  });
  assert.equal(reads, 0);
});
