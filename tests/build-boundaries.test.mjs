import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  cp,
  symlink,
  realpath,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { stageBackend } from '../scripts/package-server.mjs';
import { stageWeb } from '../scripts/package-web.mjs';
import { rendererMediaPaths } from '../scripts/build-backend.mjs';
import { staticAssets } from '../backend/server/assets.mjs';
import {
  validateRelease,
  switchRelease,
  backupDatabase,
  verifyHealth,
  verifyWeb
} from '../deploy/split-release.mjs';
import { artifactManifest } from '../scripts/package-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function releaseFixture(kind) {
  const { base } = await fixture(),
    deployment = path.join(base, 'deployment'),
    releases = path.join(deployment, kind === 'backend' ? 'releases' : 'web-releases');
  const { stage } = kind === 'backend' ? await stageBackend({ base }) : await stageWeb({ base });
  const old = path.join(releases, 'old'),
    next = path.join(releases, 'next');
  await mkdir(releases, { recursive: true });
  await cp(stage, old, { recursive: true });
  await cp(stage, next, { recursive: true });
  if (kind === 'backend')
    for (const [directory, revision] of [
      [old, 'old-revision'],
      [next, 'next-revision']
    ]) {
      await put(
        directory,
        'src/release.mjs',
        'export const release={revision:' + JSON.stringify(revision) + '};'
      );
      await rm(path.join(directory, 'artifact-manifest.json'));
      await artifactManifest(directory, kind);
    }
  const pointer = path.join(deployment, kind === 'backend' ? 'current' : 'web-current');
  await symlink(old, pointer, 'junction');
  const configPath = path.join(base, 'config.json');
  await writeFile(configPath, JSON.stringify({ PUBLIC_ORIGIN: 'https://release.test:8443' }));
  return {
    base,
    old,
    next,
    pointer,
    options: {
      kind,
      directory: next,
      root: deployment,
      configPath,
      data: path.join(base, 'data'),
      activate: true,
      ...(process.platform === 'win32'
        ? {
            replace: async (pointer, target) => {
              await unlink(pointer);
              await symlink(target, pointer, 'junction');
            }
          }
        : {})
    }
  };
}
async function put(base, name, body = 'fixture') {
  const file = path.join(base, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'owqs-build-boundary-'));
  const media = {
    avatar: '/media/icons/' + 'a'.repeat(20) + '.webp',
    ranks: {},
    maps: {
      map: {
        preview: '/media/maps/' + 'b'.repeat(20) + '.webp',
        export: '/media/maps/' + 'c'.repeat(20) + '.webp'
      }
    }
  };
  await put(base, 'source/media/manifest.json', JSON.stringify(media));
  for (const url of rendererMediaPaths(media))
    await put(base, 'dist/backend-assets' + url, 'renderer ' + url);
  for (const name of [
    'backend/server/main.mjs',
    'backend/src/worker.mjs',
    'backend/src/shared/events-html.mjs',
    'backend/src/shared/chart.mjs',
    'backend/src/prompt.mjs'
  ])
    await put(base, name, 'export {};');
  await put(base, 'backend/access-policy.json', '{}');
  for (const name of [
    'index.html',
    'login.html',
    'admin.html',
    'tools/strength.html',
    'event-reminders-sw.js'
  ])
    await put(base, 'public/' + name);
  await put(base, 'public/static/app.' + 'a'.repeat(16) + '.js', 'web script');
  for (const name of [
    '.private/secret.json',
    'local/.private/secret.json',
    '.dev.vars',
    'dist/user-artifact.txt'
  ])
    await put(base, name, 'must survive outside package');
  return { base, media };
}

test('backend stage has renderer media and generated modules without website or private trees', async () => {
  const { base, media } = await fixture();
  try {
    const { stage, manifest } = await stageBackend({ base });
    assert.equal(manifest.kind, 'backend');
    assert.deepEqual((await readdir(stage)).sort(), [
      'access-policy.json',
      'artifact-manifest.json',
      'backend-assets',
      'package.json',
      'server',
      'src'
    ]);
    for (const url of rendererMediaPaths(media))
      assert.equal(
        await readFile(path.join(stage, 'backend-assets', url), 'utf8'),
        'renderer ' + url
      );
    assert.ok(!manifest.files.some((file) => /^(public|source|local|\.private)\//.test(file.path)));
    assert.equal(
      await readFile(path.join(base, 'dist/user-artifact.txt'), 'utf8'),
      'must survive outside package'
    );
    assert.equal((await validateRelease(stage, 'backend')).kind, 'backend');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('web stage only contains public outputs, leaves backend outputs intact and detects tampering', async () => {
  const { base } = await fixture();
  try {
    const before = await readFile(path.join(base, 'backend/src/prompt.mjs'), 'utf8');
    const { stage, manifest } = await stageWeb({ base });
    assert.equal(manifest.kind, 'web');
    assert.deepEqual((await readdir(stage)).sort(), ['artifact-manifest.json', 'public']);
    assert.equal(await readFile(path.join(base, 'backend/src/prompt.mjs'), 'utf8'), before);
    assert.equal((await validateRelease(stage, 'web')).kind, 'web');
    await put(stage, 'public/index.html', 'tampered');
    await assert.rejects(validateRelease(stage, 'web'), /checksum/);
    await put(base, 'public/secret.sqlite3', 'unwanted');
    await assert.rejects(stageWeb({ base }), /Unexpected web package root/);
    assert.equal(
      await readFile(path.join(base, 'dist/user-artifact.txt'), 'utf8'),
      'must survive outside package'
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('renderer binding serves only hashed local map and icon assets', async () => {
  const { base, media } = await fixture();
  try {
    const directory = path.join(base, 'dist/backend-assets');
    await put(directory, 'index.html', 'not renderer');
    const assets = staticAssets(directory, { rendererOnly: true });
    assert.equal((await assets.fetch(new Request('https://site.test' + media.avatar))).status, 200);
    for (const name of [
      '/index.html',
      '/media/heroes/example.png',
      '/media/icons/unhashed.webp',
      '/%2eprivate/config',
      '/media/icons/%5csecret'
    ])
      assert.equal((await assets.fetch(new Request('https://site.test' + name))).status, 404);
    assert.throws(
      () => rendererMediaPaths({ ...media, avatar: '/../.private/secret' }),
      /Unexpected renderer/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('backend release backs up before switch, restarts and rolls back on revision failure', async () => {
  const ctx = await releaseFixture('backend'),
    calls = [];
  try {
    await assert.rejects(
      switchRelease({
        ...ctx.options,
        backup: async () => {
          assert.equal(await realpath(ctx.pointer), ctx.old);
          calls.push('backup');
        },
        restart: async () => {
          calls.push('restart:' + path.basename(await realpath(ctx.pointer)));
        },
        health: async ({ origin, revision }) => {
          assert.equal(origin, 'https://release.test:8443');
          calls.push('health:' + revision);
          if (revision === 'next-revision') throw Error('bad candidate');
        }
      }),
      /previous release restored/
    );
    assert.equal(await realpath(ctx.pointer), ctx.old);
    assert.deepEqual(calls, [
      'backup',
      'restart:next',
      'health:next-revision',
      'restart:old',
      'health:old-revision'
    ]);
    const record = (await readdir(ctx.options.root)).find((name) => name.endsWith('.json'));
    assert.equal(
      JSON.parse(await readFile(path.join(ctx.options.root, record), 'utf8')).status,
      'rolled-back'
    );
  } finally {
    await rm(ctx.base, { recursive: true, force: true });
  }
});

test('backup failure prevents activation and web acceptance failure restores independent web pointer', async () => {
  const backend = await releaseFixture('backend'),
    web = await releaseFixture('web');
  try {
    await assert.rejects(
      switchRelease({
        ...backend.options,
        backup: async () => {
          throw Error('backup unavailable');
        },
        restart: async () => assert.fail('must not restart')
      }),
      /backup unavailable/
    );
    assert.equal(await realpath(backend.pointer), backend.old);
    const seen = [];
    await assert.rejects(
      switchRelease({
        ...web.options,
        web: async ({ directory }) => {
          seen.push(directory);
          if (directory === web.next) throw Error('static mismatch');
        }
      }),
      /previous release restored/
    );
    assert.deepEqual(seen, [web.next, web.old]);
    assert.equal(await realpath(web.pointer), web.old);
  } finally {
    await rm(backend.base, { recursive: true, force: true });
    await rm(web.base, { recursive: true, force: true });
  }
});

test('successful backend and web releases retain their independently accepted pointers', async () => {
  const backend = await releaseFixture('backend'),
    web = await releaseFixture('web');
  try {
    let backups = 0,
      restarts = 0;
    const result = await switchRelease({
      ...backend.options,
      backup: async () => {
        backups++;
      },
      restart: async () => {
        restarts++;
      },
      health: async ({ revision }) => assert.equal(revision, 'next-revision')
    });
    assert.equal(backups, 1);
    assert.equal(restarts, 1);
    assert.equal(await realpath(backend.pointer), backend.next);
    assert.equal(JSON.parse(await readFile(result.record, 'utf8')).status, 'accepted');
    await switchRelease({
      ...web.options,
      web: async ({ directory }) => assert.equal(directory, web.next),
      backup: async () => assert.fail('web must not back up SQLite'),
      restart: async () => assert.fail('web must not restart backend')
    });
    assert.equal(await realpath(web.pointer), web.next);
  } finally {
    await rm(backend.base, { recursive: true, force: true });
    await rm(web.base, { recursive: true, force: true });
  }
});

test('online SQLite backup includes committed WAL content and remains independently readable', async () => {
  const { DatabaseSync } = await import('node:sqlite'),
    directory = await mkdtemp(path.join(os.tmpdir(), 'owqs-backup-')),
    filename = path.join(directory, 'state.sqlite3'),
    destination = path.join(directory, 'backups/state.sqlite3');
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('committed');"
    );
    await backupDatabase(filename, destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'committed');
    } finally {
      copy.close();
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('canonical acceptance rejects a wrong backend revision and mismatched static content', async () => {
  await assert.rejects(
    verifyHealth({
      origin: 'https://release.test',
      revision: 'expected',
      attempts: 1,
      fetcher: async () => Response.json({ ok: true, revision: 'wrong' })
    }),
    /revision verification/
  );
  await verifyHealth({
    origin: 'https://release.test',
    revision: 'expected',
    attempts: 1,
    fetcher: async () => Response.json({ ok: true, revision: 'expected' })
  });
  const { base } = await fixture();
  try {
    const { stage, manifest } = await stageWeb({ base });
    await assert.rejects(
      verifyWeb({
        origin: 'https://release.test',
        manifest,
        directory: stage,
        fetcher: async () => new Response('wrong', { headers: { 'cache-control': 'no-store' } })
      }),
      /artifact verification/
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('independent build commands exclude full website and Bot capture from backend and ordinary web build', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['server:build'],
    'npm run backend:build && node scripts/package-server.mjs'
  );
  assert.equal(pkg.scripts['web:build'], 'node scripts/build.mjs --web-only');
  assert.equal(pkg.scripts['bot:capture'], 'node scripts/build.mjs --web-only --bot-capture');
  const source = await readFile(path.join(root, 'scripts/build.mjs'), 'utf8'),
    webSource = await readFile(path.join(root, 'scripts/build-web.mjs'), 'utf8');
  assert.match(source, /if\s*\(!process\.argv\.includes\('--web-only'\)\)\s*await buildBackend/);
  assert.match(source, /buildWeb/);
  assert.match(webSource, /if\s*\(capture\)\s*await buildApiCapture/);
  assert.doesNotMatch(source, /writeFile\(path\.join\(base,'src\//);
});
