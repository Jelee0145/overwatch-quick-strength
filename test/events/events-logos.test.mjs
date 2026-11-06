import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventCenter } from '../../backend/src/events/center.mjs';
import { LOGO_ROUTE } from '../../backend/src/events/logos.mjs';
import { card, page, response } from '../events-fixture.mjs';
import { MemoryStorage as Storage } from '../helpers/storage.mjs';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const badge = (src) =>
  `<span class="team-template-image-icon team-template-lightmode"><img src="${src}"></span><span class="name">`;
function schedule() {
  // Left team gets a badge, right team has none.
  return page(
    card().replace('<span class="name">', badge('/commons/images/thumb/a/ab/CR.png/50px-CR.png')),
    ''
  );
}
function setup(logoFetch) {
  const storage = new Storage(),
    calls = [],
    env = {
      EVENTS_CONTACT: 'https://site.test',
      EVENTS_FETCH: async () => response(schedule()),
      EVENTS_LOGO_FETCH: async (url, init) => {
        calls.push({ url, init });
        return logoFetch(url, init);
      }
    },
    center = new EventCenter({ storage }, env);
  let now = 1792310400000;
  center.now = () => now;
  return { center, storage, calls, advance: (ms) => (now += ms) };
}
const png = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
const get = (center, path = '/') => center.fetch(new Request('https://events.internal' + path));

test('event badges are copied once and served same-origin with immutable caching', async () => {
  const ctx = setup(png);
  await ctx.center.alarm();
  assert.equal(ctx.calls.length, 1);
  assert.equal(
    ctx.calls[0].url,
    'https://liquipedia.net/commons/images/thumb/a/ab/CR.png/50px-CR.png'
  );
  assert.equal(ctx.calls[0].init.redirect, 'manual');
  assert.match(ctx.calls[0].init.headers['User-Agent'], /OWQS-EventCenter.*site\.test/);
  const data = await (await get(ctx.center)).json(),
    [left, right] = data.matches[0].teams;
  assert.match(left.logo, new RegExp('^' + LOGO_ROUTE + '[a-f0-9]{64}$'));
  assert.equal(right.logo, null);
  assert.ok(
    !JSON.stringify(data).includes('commons/images'),
    'no upstream image URL reaches visitors'
  );
  const image = await get(ctx.center, '/logo/' + left.logo.slice(LOGO_ROUTE.length));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.match(image.headers.get('Cache-Control'), /immutable/);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG);
  // Fresh copies are not downloaded again on later syncs.
  ctx.advance(3600000);
  await ctx.center.alarm();
  assert.equal(ctx.calls.length, 1);
  assert.equal((await get(ctx.center, '/logo/' + 'f'.repeat(64))).status, 404);
  assert.equal((await get(ctx.center, '/logo/snapshot')).status, 404);
});

test('event badges reject non-images, svg and oversized bodies, then back off', async () => {
  for (const bad of [
    () => new Response('<svg onload=alert(1)>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response('<html>', { headers: { 'Content-Type': 'image/png' } }),
    () =>
      new Response(new Uint8Array(70 * 1024).fill(0x89), {
        headers: { 'Content-Type': 'image/png' }
      }),
    () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/x.png' } })
  ]) {
    const ctx = setup(bad);
    await ctx.center.alarm();
    const data = await (await get(ctx.center)).json();
    assert.equal(data.matches[0].teams[0].logo, null);
    assert.equal((await ctx.storage.list({ prefix: 'logo:' })).size, 0);
    // Backoff: an immediate retry does not hit the upstream again.
    await ctx.center.alarm();
    assert.equal(ctx.calls.length, 1);
    ctx.advance(11 * 60000);
    await ctx.center.alarm();
    assert.equal(ctx.calls.length, 2);
  }
});

test('event badge rate limits pause downloads; a failed recheck keeps the stored copy', async () => {
  let reply = () => new Response('', { status: 429, headers: { 'Retry-After': '120' } });
  const ctx = setup(() => reply());
  await ctx.center.alarm();
  assert.equal(await ctx.storage.get('logoAfter'), ctx.center.now() + 120000);
  await ctx.center.alarm();
  assert.equal(ctx.calls.length, 1, 'no download while limited');
  reply = png;
  ctx.advance(121000);
  await ctx.center.alarm();
  const first = (await (await get(ctx.center)).json()).matches[0].teams[0].logo;
  assert.ok(first);
  reply = () => new Response('', { status: 500 });
  ctx.advance(31 * 86400000);
  await ctx.center.alarm();
  assert.equal((await (await get(ctx.center)).json()).matches[0].teams[0].logo, first);
});

test('a visitor seeing an uncached badge schedules an early badge sync', async () => {
  const ctx = setup(png);
  // Snapshot exists but the badge has never been downloaded (e.g. right after an upgrade).
  ctx.center.logos.sync = async () => {};
  await ctx.center.alarm();
  delete ctx.center.logos.sync;
  await get(ctx.center);
  assert.ok(ctx.center.logos.pending());
  await ctx.center.schedule();
  assert.ok(ctx.storage.alarmTime <= ctx.center.now() + 30000);
});

test('pages no longer allow third-party images and only render same-origin badges', async () => {
  const worker = await readFile(new URL('../../backend/src/worker.mjs', import.meta.url), 'utf8'),
    nginx = await readFile(new URL('../../deploy/nginx-https.conf', import.meta.url), 'utf8'),
    build = await readFile(new URL('../../scripts/build-web.mjs', import.meta.url), 'utf8'),
    ui = await readFile(new URL('../../frontend/web/events.js', import.meta.url), 'utf8');
  for (const text of [worker, nginx, build]) {
    assert.match(text, /img-src 'self' data: blob:;/);
    assert.ok(!/img-src[^;]*liquipedia/.test(text));
  }
  assert.ok(ui.includes('\\/api\\/v1\\/events\\/logos\\/[a-f0-9]{64}$'));
  assert.ok(
    !/hostname === 'liquipedia\.net' &&\s*!url\.port &&\s*!url\.username &&\s*!url\.password &&\s*url\.pathname\.startsWith\('\/commons/.test(
      ui
    )
  );
});
