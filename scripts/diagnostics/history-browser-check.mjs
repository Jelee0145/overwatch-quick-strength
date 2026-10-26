// Optional real-browser acceptance, using an in-memory server and synthetic data only.
// Set OWQS_PLAYWRIGHT_MODULE to a Playwright module path when it is not installed locally.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRuntime } from '../../server/runtime.mjs';
import { createHttpServer } from '../../server/http.mjs';
import { staticAssets } from '../../server/assets.mjs';
import { signSnapshot } from '../../src/security.mjs';
import { performanceArchive } from './history-performance-benchmark.mjs';

const require = createRequire(import.meta.url),
  { chromium } = require(process.env.OWQS_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '../..'),
  outputArg = process.argv.indexOf('--output'),
  output = path.resolve(
    outputArg >= 0 ? process.argv[outputArg + 1] : path.join(root, 'dist/history-qa')
  );
const origin = 'http://127.0.0.1:18947',
  runtime = createRuntime(
    {
      PUBLIC_ORIGIN: origin,
      PASSWORD_PEPPER: 'synthetic-browser-pepper',
      CACHE_SIGNING_KEY: 'synthetic-browser-signing',
      API_KEY_ENCRYPTION_KEY: 'synthetic-browser-encryption',
      DASHEN_SERVER: 'fixture',
      DASHEN_DTS: 'season'
    },
    {
      filename: ':memory:',
      assets: staticAssets(path.join(root, 'public')),
      eventsFetch: async () => new Response('', { status: 503 })
    }
  );
const server = createHttpServer(runtime, { origin });
let browser;
try {
  await mkdir(output, { recursive: true });
  const internal = async (path, body = {}, rest = {}) => {
    const response = await runtime.env.AUTH.get().fetch('https://internal/', {
      method: 'POST',
      body: JSON.stringify({ path, body, ip: 'browser-fixture', ...rest })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const registration = await internal('/register', {
      email: 'browser-fixture@example.test',
      password: 'synthetic-browser-password'
    }),
    auth = runtime.database.store('auth'),
    record = await auth.get('user:' + registration.user.id);
  record.status = 'approved';
  await auth.put('user:' + record.id, record);
  const archive = performanceArchive(500),
    history = runtime.instance('tasks:' + registration.user.id).history;
  for (const envelope of Object.values(archive.batches))
    await history.handle(registration.user.id, {
      action: 'push',
      envelopes: [await signSnapshot(registration.user.id, envelope.content.data, runtime.env)]
    });
  await new Promise((resolve) => server.listen(18947, '127.0.0.1', resolve));
  browser = await chromium.launch({
    headless: true,
    channel: process.env.OWQS_BROWSER_CHANNEL || 'chrome'
  });
  const reports = [];
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    const context = await browser.newContext({ viewport }),
      page = await context.newPage(),
      errors = [],
      consoleErrors = [],
      analysisCalls = [],
      detailCalls = [];
    await context.addCookies([{ name: 'qs_session', value: registration.token, url: origin }]);
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.fulfill({
            status: 200,
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg"/>'
          })
    );
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/history/analysis')) analysisCalls.push(request.postDataJSON());
      if (request.url().endsWith('/matches/detail')) detailCalls.push(request.postDataJSON());
    });
    await page.goto(origin + '/tools/strength', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('#chart .match-hit').length === 10, {
      timeout: 30000
    });
    await page.waitForFunction(() => window.OWQS_APP && window.CloudHistory, { timeout: 10000 });
    if (await page.locator('#changelogDialog').evaluate((el) => el.open))
      await page.locator('#changelogAcknowledge').click();
    assert.match(await page.title(), /对局分析/);
    assert.equal(await page.locator('#players tr').count(), 10);
    await page.screenshot({ path: path.join(output, name + '-chart.png'), fullPage: false });
    if (name === 'desktop') {
      await page.locator('#players [data-performance]').first().click();
      await page.waitForFunction(() => !document.getElementById('performancePanel').hidden);
      assert.ok((await page.locator('#performancePanel tbody tr').count()) > 0);
    } else {
      await page.locator('#mobileTab-data').click();
      await page.locator('#mobilePlayers [data-player]').first().click();
      await page.waitForFunction(() => document.getElementById('mobileHeroDialog').open);
      await page.locator('#mobileHeroRatingTab').click();
      assert.ok((await page.locator('#mobileHeroRating tbody tr').count()) > 0);
      await page.screenshot({ path: path.join(output, name + '-detail.png'), fullPage: false });
      await page.locator('#mobileHeroDialog .mobile-modal-head button').click();
      await page.locator('#mobileTab-chart').click();
      await page.locator('#mobileChartOpen').click();
      assert.equal(await page.locator('#mobileChartDialog').evaluate((el) => el.open), true);
      await page.locator('#mobileChartClose').click();
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const before = (await cdp.send('Runtime.getHeapUsage')).usedSize,
      latencies = [];
    for (let i = 0; i < 20; i++) {
      const previous = await page.locator('#timelinePosition').textContent(),
        start = performance.now();
      await page.locator('#timelineOlder').click();
      await page.waitForFunction(
        (old) => document.getElementById('timelinePosition').textContent !== old,
        previous
      );
      latencies.push(performance.now() - start);
    }
    await page.waitForTimeout(200);
    await cdp.send('HeapProfiler.collectGarbage');
    const after = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    for (let i = 0; i < 20; i++) {
      const previous = await page.locator('#timelinePosition').textContent();
      await page.locator('#timelineOlder').click();
      await page.waitForFunction(
        (old) => document.getElementById('timelinePosition').textContent !== old,
        previous
      );
    }
    await page.waitForTimeout(200);
    await cdp.send('HeapProfiler.collectGarbage');
    const plateau = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    await page.evaluate(() => {
      document.getElementById('statisticsRange').value = '5';
      document.getElementById('statisticsRange').dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => window.OWQS_APP.timeline.analysis.statisticsRange === '5');
    const panelStart = performance.now();
    await page.evaluate(() => document.getElementById('historyOpen').click());
    await page.waitForFunction(() => document.getElementById('historyDialog').open);
    await page.evaluate(() => CloudHistory.sync());
    const historyPanelMs = performance.now() - panelStart;
    await page.locator('#historyClose').click();
    assert.deepEqual(errors, [], 'uncaught browser errors');
    assert.deepEqual(consoleErrors, [], 'console errors');
    reports.push({
      name,
      url: page.url(),
      viewport,
      analysisRequests: analysisCalls.length,
      detailRequests: detailCalls.length,
      windowP95Ms: +latencies.sort((a, b) => a - b)[18].toFixed(1),
      historyPanelMs: +historyPanelMs.toFixed(1),
      heapBefore: before,
      heapAfter20: after,
      heapAfter40: plateau,
      errors,
      consoleErrors
    });
    await context.close();
  }
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        fixture: 'synthetic 500 matches; local in-memory SQLite; external images stubbed',
        browser: 'Browser plugin not available; bundled Playwright',
        reports
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser?.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await runtime.close();
}
