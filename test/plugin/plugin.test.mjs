import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createChartService, ServiceError } from '../../src/services/index.mjs';
import { analysisService } from '../../src/services/runtime.mjs';
import { analysisFixture } from '../services-fixture.mjs';
import { service as fixture } from '../query-fixture.mjs';
import {
  chartModel,
  renderSnapshot,
  runJob
} from '../../plugins/astrbot_plugin_owqs/core/runner.mjs';
import { chartServiceSource } from '../../scripts/build/chart-service-source.mjs';
import { buildPlugin } from '../../scripts/build-plugin.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const credentials = {
  DASHEN_SERVER: '1',
  DASHEN_DTS: 'test-season',
  DASHEN_ROLE_ID: 'fake-role',
  DASHEN_TOKEN: 'fake-token'
};
const request = { version: 1, credentials, request: { tag: 'Main#100', limit: 10, mode: 'fast' } };
const temp = await mkdtemp(path.join(os.tmpdir(), 'owqs-plugin-'));
const assets = path.join(temp, 'assets');
await mkdir(assets, { recursive: true });
// Empty packaged metadata is sufficient for query fixtures with unknown map IDs.
await writeFile(
  path.join(assets, 'manifest.json'),
  JSON.stringify({ avatar: null, ranks: {}, maps: {} })
);
process.on('exit', () => {});
test.after(async () => {
  await rm(temp, { recursive: true, force: true });
});

test('injected chart service preserves the legacy SVG exactly and does not leak dependencies between renders', async () => {
  const c = vm.createContext({});
  c.window = c;
  vm.runInContext(await readFile(path.join(root, 'source/core.js'), 'utf8'), c);
  vm.runInContext(await readFile(path.join(root, 'web/base/data.js'), 'utf8'), c);
  vm.runInContext(await readFile(path.join(root, 'local/chart.js'), 'utf8'), c);
  const raw = analysisFixture(),
    model = analysisService.analyzeBatch(raw);
  const maps = JSON.parse(JSON.stringify(c.QS_DATA.maps));
  const a = createChartService({ core: globalThis.QS, maps });
  assert.equal(
    a.render(model, { showArt: false, title: 'test' }),
    c.renderChart(model, {}, false, 'test')
  );
  const changed = createChartService({ core: globalThis.QS, maps: { map: { name: '独立地图' } } });
  assert.match(changed.render(model), /独立地图/);
  assert.doesNotMatch(a.render(model), /独立地图/);
  // Manual local synchronization must retain the new service API.
  const wrapped = chartServiceSource(await readFile(path.join(root, 'local/chart.js'), 'utf8'));
  const b = vm.createContext({});
  vm.runInContext(wrapped, b);
  assert.equal(typeof b.OWQS_CREATE_CHART_SERVICE, 'function');
  assert.equal(chartServiceSource(wrapped), wrapped);
});

test('Bot uses latest ten evaluated games and summarizes only the visible window', () => {
  const raw = analysisFixture(),
    model = chartModel(raw),
    all = analysisService.analyzeBatch(raw);
  const expected = analysisService.summarize(raw, all.matches.slice(-10));
  assert.deepEqual(
    model.matches.map((m) => m.mid),
    all.matches.slice(-10).map((m) => m.mid)
  );
  assert.deepEqual(model.summary, expected.summary);
  assert.equal(model.personalPrediction.selected.games, expected.personalPrediction.selected.games);
  assert.equal(chartModel({ ...raw, matches: raw.matches.slice(0, 3) }).matches.length, 3);
});

test('standalone querying reuses successful private cache and recovers from 429 without restarting', async () => {
  const mock = fixture(),
    events = [],
    sleeps = [];
  let limited = false;
  const provider = async (...args) => {
    if (!limited) {
      limited = true;
      throw new ServiceError('limited', 429);
    }
    return mock.call(...args);
  };
  const options = {
    assetRoot: assets,
    provider,
    emit: (e) => events.push(e),
    sleep: async (ms) => sleeps.push(ms),
    serviceOptions: { sleep: async () => {}, now: Date.now }
  };
  // Disable pacing only in this injected test clock; CLI has no such input option.
  options.serviceOptions.now = (() => {
    let clock = Date.now();
    return () => (clock += 10);
  })();
  const first = await runJob(structuredClone(request), options);
  assert.ok(events.some((e) => e.type === 'paused'));
  assert.ok(sleeps.includes(30000));
  assert.equal(first.displayed, 10);
  assert.equal(first.cache.snapshot.syncStatus.mode, 'fast');
  assert.doesNotMatch(first.svg, /fake-token|private/);
  const details = mock.details.length;
  const second = await runJob({ ...structuredClone(request), prior: first.cache }, options);
  assert.equal(mock.details.length, details);
  assert.equal(second.cache.snapshot.syncStatus.reusedMatches, 10);
  assert.deepEqual(chartModel(first.cache.snapshot).summary, first.summary);
  const changed = await runJob(
    {
      ...structuredClone(request),
      credentials: { ...credentials, DASHEN_DTS: 'new-season' },
      prior: first.cache
    },
    options
  );
  assert.notEqual(changed.cache.scope, first.cache.scope);
  assert.ok(mock.details.length > details);
});

test('slow queries use existing supplemental sampling and keep scores equal to shared analysis', async () => {
  const mock = fixture({ dense: false });
  let clock = Date.now();
  const result = await runJob(
    { ...structuredClone(request), request: { tag: 'Main#100', limit: 5, mode: 'slow' } },
    {
      provider: mock.call,
      assetRoot: assets,
      serviceOptions: { sleep: async () => {}, now: () => (clock += 10) }
    }
  );
  assert.equal(result.cache.snapshot.syncStatus.mode, 'slow');
  assert.ok(result.cache.snapshot.historyStatus.requests > 0);
  assert.deepEqual(result.summary, chartModel(result.cache.snapshot).summary);
  assert.equal(result.displayed, 5);
  await assert.rejects(runJob({ ...request, request: { tag: 'Main#100', limit: 7 } }, {}), /场数/);
  await assert.rejects(renderSnapshot({ ...analysisFixture(), matches: [] }, assets), /暂无/);
});

test('ZIP is self-contained, contains only allowlisted paths and runs outside the repository', async () => {
  const destination = path.join(temp, 'installed'),
    archivePath = path.join(temp, 'plugin.zip');
  const packaged = await buildPlugin({ destination, archivePath });
  assert.ok(packaged.files > 100);
  const archive = await readFile(archivePath),
    names = [];
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18),
      length = archive.readUInt16LE(offset + 26),
      extra = archive.readUInt16LE(offset + 28);
    names.push(archive.subarray(offset + 30, offset + 30 + length).toString());
    offset += 30 + length + extra + size;
  }
  assert.ok(names.includes('astrbot_plugin_owqs/main.py'));
  assert.ok(names.includes('astrbot_plugin_owqs/runtime.mjs'));
  assert.ok(
    names.every(
      (n) => !/(?:\.private|\.dev.vars|node_modules|state.sqlite|__pycache__|\/core\/)/.test(n)
    )
  );
  const check = spawnSync(process.execPath, [path.join(destination, 'runtime.mjs'), '--check'], {
    cwd: temp,
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /"type":"ready"/);
  const invalid = spawnSync(process.execPath, [path.join(destination, 'runtime.mjs')], {
    cwd: temp,
    encoding: 'utf8',
    input: JSON.stringify({ version: 1, credentials })
  });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).message, /昵称/);
  assert.doesNotMatch(invalid.stdout, /fake-token|fake-role/);
  const manifest = JSON.parse(
    await readFile(path.join(destination, 'assets/manifest.json'), 'utf8')
  );
  const raw = analysisFixture();
  raw.battletag = '<长昵称&中文>#123';
  raw.matches = raw.matches.slice(0, 3).map((m) => ({
    ...m,
    mapGuid: Object.keys(manifest.maps).find((k) => manifest.maps[k].export)
  }));
  const picture = await renderSnapshot(raw, path.join(destination, 'assets'));
  assert.match(picture.svg, /data:image\/webp;base64/);
  assert.doesNotMatch(picture.svg, /<image[^>]+href="https?:/);
  assert.match(picture.svg, /&lt;长昵称&amp;中文&gt;/);
  assert.equal(picture.displayed, 3);
  await writeFile(path.join(temp, 'preview.svg'), picture.svg);
});
test('standalone plugin charts only the requested quick-play pool', async () => {
  const mock = fixture({ mixedModes: true }),
    request = {
      version: 1,
      credentials,
      request: { tag: 'Main#100', limit: 10, mode: 'fast', pool: '66' }
    };
  const result = await runJob(request, {
    assetRoot: assets,
    provider: mock.call,
    emit: () => {},
    sleep: async () => {},
    serviceOptions: { sleep: async () => {}, now: Date.now }
  });
  assert.ok(result.cache.snapshot.matches.length > 0);
  assert.ok(
    result.cache.snapshot.matches.every((m) => m.gameMode === 'Leisure6v6'),
    JSON.stringify(result.cache.snapshot.matches.map((m) => m.gameMode))
  );
  const chart = chartModel(result.cache.snapshot, '66');
  assert.ok(chart.matches.every((m) => m.gameMode === 'Leisure6v6'));
  assert.equal(chartModel(result.cache.snapshot, '55').matches.length, 0);
});
