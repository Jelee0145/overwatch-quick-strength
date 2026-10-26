import test from 'node:test';
import assert from 'node:assert/strict';
import { UserTasks } from '../../src/actors/tasks.mjs';
import { putBlob, getBlob } from '../../src/security.mjs';
import { setup, request, start } from '../helpers/tasks.mjs';

const policies = [
  { name: 'legacy web', path: '/query', version: 1, api: false },
  { name: 'persisted legacy API', path: '/api-query', version: 1, api: true },
  { name: 'unified web', path: '/unified-query', version: 2, api: false },
  { name: 'API v2', path: '/api-query', version: 2, api: true }
];
for (const policy of policies)
  for (const outcome of ['failed', 'cancelled', 'expired', 'creating', 'cache-only'])
    test(`${policy.name}: ${outcome} settlement survives restart`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T00:00:00Z') });
      const ctx = await setup(),
        created = await request(ctx.task, policy.path, {
          battletag: 'Main#100',
          limit: 5,
          requestId: 'matrix'
        });
      assert.equal(created.status, 200);
      const job = await ctx.storage.get('job:' + created.id);
      if (policy.version === 1) delete job.policyVersion;
      job.api = policy.api;
      if (outcome === 'cancelled') {
        job.state = 'paused';
        job.resumeAfter = Date.now() + 60000;
      } else if (outcome === 'expired') job.until = Date.now() - 1;
      else if (outcome === 'cache-only') {
        const result = {
          battletag: 'Main#100',
          queriedAt: new Date().toISOString(),
          matches: [],
          recentHistory: [],
          syncStatus: { fetchedMatches: 0, rankFetches: 0 },
          historyStatus: { requests: 0 },
          queryCache: {}
        };
        await putBlob(ctx.storage, 'data:' + job.id, {
          version: 2,
          tag: 'Main#100',
          limit: 5,
          phase: 'done',
          selected: [],
          mainDone: {},
          result
        });
      } else job.state = outcome;
      await ctx.storage.put('job:' + job.id, job);
      ctx.task = new UserTasks({ storage: ctx.storage }, ctx.env);
      if (outcome === 'cancelled')
        assert.equal((await request(ctx.task, '/cancel', { id: job.id })).status, 200);
      await ctx.task.alarm();
      await ctx.task.alarm();
      const refunded =
        outcome === 'creating' ||
        (outcome === 'cache-only'
          ? !policy.api || policy.version === 2
          : policy.api || policy.version === 2);
      assert.equal((await ctx.ledger.get('usage:u')).query, refunded ? 0 : 1);
      const saved = await ctx.storage.get('job:' + job.id);
      if (outcome === 'expired') {
        assert.equal(saved, undefined);
        assert.equal(await getBlob(ctx.storage, 'data:' + job.id), null);
        assert.equal(await ctx.storage.get(job.dedupeStorageKey), undefined);
      } else {
        assert.equal(
          saved.quota,
          refunded ? 'released' : outcome === 'cache-only' ? 'charged' : 'reserved'
        );
        assert.equal(
          saved.state,
          outcome === 'cache-only' ? 'done' : outcome === 'creating' ? 'failed' : outcome
        );
      }
    });

test('v2 request keys reuse terminal jobs until expiry; legacy active conflict remains independent', async () => {
  const ctx = await setup(),
    legacy = await request(ctx.task, '/query', { battletag: 'Main#100', limit: 5 });
  assert.equal(
    (await request(ctx.task, '/query', { battletag: 'Other#100', limit: 5 })).status,
    409
  );
  const unified = await start(ctx.task, { requestId: 'terminal' });
  assert.notEqual(unified.id, legacy.id);
  const job = await ctx.storage.get('job:' + unified.id);
  job.state = 'failed';
  await ctx.storage.put('job:' + job.id, job);
  assert.equal((await start(ctx.task, { requestId: 'terminal' })).id, job.id);
  job.until = Date.now() - 1;
  await ctx.storage.put('job:' + job.id, job);
  assert.notEqual((await start(ctx.task, { requestId: 'terminal' })).id, job.id);
});
