import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UserTasks, QUERY_SUSPENDED_MESSAGE, querySuspended } from '../../src/actors/tasks.mjs';
import { setup, request, start } from '../helpers/tasks.mjs';

const root = new URL('../../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('the suspension is a config switch, not a hardcoded stop', () => {
  assert.equal(querySuspended({}), false);
  assert.equal(querySuspended({ QUERY_SUSPENDED: '' }), false);
  assert.equal(querySuspended({ QUERY_SUSPENDED: 'false' }), false);
  assert.equal(querySuspended({ QUERY_SUSPENDED: 'true' }), true);
  assert.equal(querySuspended({ QUERY_SUSPENDED: '1' }), true);
  assert.equal(querySuspended({ QUERY_SUSPENDED: 'TRUE' }), true);
  assert.match(QUERY_SUSPENDED_MESSAGE, /暂停/);
  assert.match(QUERY_SUSPENDED_MESSAGE, /历史/);
});

test('a suspended server answers with a job-shaped result and reserves no quota', async () => {
  const ctx = await setup();
  ctx.env.QUERY_SUSPENDED = 'true';
  const task = new UserTasks({ storage: ctx.storage }, ctx.env);
  const created = await start(task, { requestId: 'suspended' });
  // One readable record, not an error: state, message and no billing.
  assert.equal(created.status, 200);
  assert.equal(created.state, 'suspended');
  assert.equal(created.suspended, true);
  assert.match(created.message, /暂停/);
  assert.equal(created.quota, 'none');
  assert.ok(created.id);
  // Nothing was reserved, and no job was persisted for it.
  assert.equal(await ctx.ledger.get('usage:u'), undefined);
  assert.equal((await ctx.storage.list({ prefix: 'job:' })).size, 0);
});

test('the legacy route is suspended the same way and AI review keeps working', async () => {
  const ctx = await setup();
  ctx.env.QUERY_SUSPENDED = 'true';
  const task = new UserTasks({ storage: ctx.storage }, ctx.env);
  const legacy = await request(task, '/query', { battletag: 'Main#100', limit: 5 });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.state, 'suspended');
  // AI review must not be caught by the query switch.
  const review = await request(task, '/ai-review', {});
  assert.notEqual(review.state, 'suspended');
});

test('an open environment still creates real queries', async () => {
  const ctx = await setup();
  const created = await start(ctx.task, { requestId: 'open' });
  assert.equal(created.status, 200);
  assert.notEqual(created.state, 'suspended');
  assert.equal((await ctx.storage.get('job:' + created.id)).state, 'running');
});

test('the page has no hardcoded stop, so a config change reopens it', async () => {
  const page = await read('web/pages/strength.html');
  const button = page.match(/<button[^>]*id="query"[^>]*>/)?.[0];
  // The server capability decides; a baked-in disabled attribute would keep it grey forever.
  assert.ok(!/\bdisabled\b/.test(button), 'the built page must not hardcode disabled');
  assert.match(button, /aria-describedby="querySuspended"/);
  assert.match(page, /id="querySuspended"[^>]*hidden/);
  const client = await read('web/app/query.js');
  // Mirrors the server flag both ways, so reopening needs no redeploy.
  assert.match(client, /let querySuspended = false/);
  assert.match(client, /if \(r\.state === 'suspended'\)/);
  assert.match(client, /setSuspended\(false\)/);
  assert.match(client, /setSuspended\(value\)/);
  // Reading saved data stays available.
  for (const id of ['historyOpen', 'statisticsRange', 'svg', 'json', 'png'])
    assert.ok(page.includes('id="' + id + '"'), id);
});

test('the session endpoint publishes the authoritative query capability', async () => {
  const source = await read('src/actors/auth.mjs');
  assert.match(source, /capabilities: \{ queries: !querySuspended\(this\.env\), reads: true \}/);
  const boot = await read('web/app/boot.js');
  // The page applies the flag on boot, before the user can click anything.
  assert.match(boot, /setSuspended\(!session\.capabilities\.queries\)/);
  const v1 = await read('src/api/v1.mjs');
  assert.match(v1, /queries: !querySuspended\(env\)/);
});

test('the suspended button looks unavailable instead of busy', async () => {
  const css = await read('web/cloud.css');
  const rule = css.match(/\.primary:disabled[^}]*}/)?.[0];
  assert.ok(rule, 'a disabled primary rule must exist');
  assert.match(rule, /cursor:not-allowed/);
  assert.match(css, /\.status\.notice[^}]*}/);
});
