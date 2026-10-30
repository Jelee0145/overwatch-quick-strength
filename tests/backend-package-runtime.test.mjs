import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { stageBackend } from '../scripts/package-server.mjs';
import { service } from '../test/query-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
test('isolated backend package boots, authenticates, completes a query and renders embedded media without website files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'owqs-package-runtime-'));
  let runtime, server;
  try {
    // Build a fresh package using actual generated backend outputs, never the checkout runtime.
    for (const name of ['server', 'src'])
      await cp(path.join(root, 'backend', name), path.join(directory, 'backend', name), {
        recursive: true
      });
    await cp(path.join(root, 'dist/backend-assets'), path.join(directory, 'dist/backend-assets'), {
      recursive: true
    });
    await mkdir(path.join(directory, 'source/media'), { recursive: true });
    await copyFile(
      path.join(root, 'source/media/manifest.json'),
      path.join(directory, 'source/media/manifest.json')
    );
    await copyFile(
      path.join(root, 'backend/access-policy.json'),
      path.join(directory, 'backend/access-policy.json')
    );
    const { stage } = await stageBackend({ base: directory });
    assert.deepEqual((await readdir(stage)).sort(), [
      'access-policy.json',
      'artifact-manifest.json',
      'backend-assets',
      'package.json',
      'server',
      'src'
    ]);
    const load = (name) => import(pathToFileURL(path.join(stage, name)).href);
    const [
      { createRuntime },
      { createHttpServer },
      { staticAssets },
      { passwordHash, getBlob, putBlob }
    ] = await Promise.all([
      load('server/runtime.mjs'),
      load('server/http.mjs'),
      load('server/assets.mjs'),
      load('src/security.mjs')
    ]);
    const config = {
      PASSWORD_PEPPER: 'synthetic-pepper',
      CACHE_SIGNING_KEY: 'synthetic-signing',
      API_KEY_ENCRYPTION_KEY: 'synthetic-encryption',
      DASHEN_SERVER: '1',
      DASHEN_DTS: '2026',
      DASHEN_TOKEN: 'synthetic-upstream',
      DASHEN_ROLE_ID: 'fixture',
      PUBLIC_ORIGIN: 'https://package.test:8443',
      BACKEND_ONLY: true
    };
    const secret = 'synthetic-admin-test-only';
    config.ADMIN_PASSWORD_HASH = JSON.stringify(await passwordHash(secret, config.PASSWORD_PEPPER));
    const fixture = service({ newGames: 1 }),
      upstreamFetch = async (input, init) => {
        const url = new URL(input);
        return Response.json({
          code: 0,
          data: await fixture.call(
            config,
            url.pathname.replace('/v1/a19ld5tool', ''),
            Object.fromEntries(url.searchParams),
            init.body ? JSON.parse(init.body) : undefined
          )
        });
      };
    const assets = staticAssets(path.join(stage, 'backend-assets'), { rendererOnly: true }),
      mediaRequests = [];
    config.RENDERER_ASSETS = {
      async fetch(request) {
        mediaRequests.push(new URL(request.url).pathname);
        return assets.fetch(request);
      }
    };
    runtime = createRuntime(config, {
      filename: path.join(directory, 'state.sqlite3'),
      assets,
      upstreamFetch,
      // Tests run unpaced so the suite is not bound to the production start rate.
      ratePerSecond: Infinity
    });
    server = createHttpServer(runtime, { origin: config.PUBLIC_ORIGIN, allowLoopback: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const request = async (url, body, { cookie = '', csrf = '', key = '' } = {}) => {
      const response = await fetch(origin + url, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          ...(body ? { 'Content-Type': 'application/json', Origin: config.PUBLIC_ORIGIN } : {}),
          Cookie: cookie,
          'X-CSRF-Token': csrf,
          ...(key ? { Authorization: 'Bearer ' + key } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { response, value: await response.json() };
    };
    assert.equal((await fetch(origin + '/login', { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(origin + '/')).status, 404);
    const credential = 'pass' + 'word';
    const admin = await request('/api/v1/admin/login', { [credential]: secret });
    assert.equal(admin.response.status, 200);
    const adminCookie = admin.response.headers.get('set-cookie').split(';')[0];
    const player = await request('/api/v1/auth/register', {
      email: 'package@example.test',
      [credential]: 'synthetic-player-test-only'
    });
    assert.equal(player.response.status, 200);
    const cookie = player.response.headers.get('set-cookie').split(';')[0];
    assert.equal(
      (
        await request(
          '/api/v1/admin/access',
          { id: player.value.user.id, status: 'approved' },
          { cookie: adminCookie, csrf: admin.value.csrf }
        )
      ).response.status,
      200
    );
    const keyResult = await request(
      '/api/v1/auth/api-key',
      { action: 'regenerate' },
      { cookie, csrf: player.value.csrf }
    );
    assert.equal(keyResult.response.status, 200);
    const key = keyResult.value.key;
    const start = await request('/api/v1/query', { battletag: 'Main#100', limit: 5 }, { key });
    assert.equal(start.response.status, 200);
    const task = runtime.instance('tasks:' + player.value.user.id),
      state = await getBlob(task.storage, 'data:' + start.value.id);
    state.minIntervalMs = 0;
    await putBlob(task.storage, 'data:' + start.value.id, state);
    await task.alarm();
    const poll = await request('/api/v1/jobs/' + start.value.id + '?render=svg', undefined, {
      key
    });
    assert.equal(poll.response.status, 200);
    assert.equal(poll.value.state, 'done');
    assert.equal(poll.value.result.matches.length, 1);
    assert.ok(poll.value.envelope, 'query returns signed synthetic history');
    assert.ok(poll.value.chart?.svg?.includes('<svg'), 'SVG rendered from the isolated package');
    assert.ok(
      poll.value.chart.svg.includes('data:image/webp;base64,'),
      'renderer embeds packaged media'
    );
    assert.ok(mediaRequests.length > 0);
    assert.ok(
      mediaRequests.every((name) => /^\/media\/(icons|maps)\/[a-f0-9]{20}\.webp$/.test(name))
    );
    assert.ok(!JSON.stringify(poll.value.result).includes('-private'));
    assert.ok(fixture.details.length > 0);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (runtime) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
