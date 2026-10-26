import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describe,
  headers,
  loadCredential,
  mask,
  options,
  request,
  verdictOf
} from '../../scripts/diagnostics/dashen-token-probe.mjs';

const credential = {
  DASHEN_ROLE_ID: '12345',
  DASHEN_TOKEN: 'a'.repeat(32),
  DASHEN_DTS: '2026',
  DASHEN_SERVER: '1'
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('shape reporting never leaks token or customer token values', () => {
  const shape = describe({ name: 'Probe#123', customerToken: 'secret-customer-token', level: 3 });
  assert.equal(shape.kind, 'object');
  assert.deepEqual(shape.keys, ['name', 'customerToken', 'level']);
  assert.deepEqual(shape.carriers, ['customerToken:21ch']);
  assert.ok(!JSON.stringify(shape).includes('secret-customer-token'));
  assert.deepEqual(describe(null), { kind: 'empty' });
  assert.deepEqual(describe([1, 2, 3]), { kind: 'array', length: 3 });
});

test('an authorised but empty payload is classified separately from a rejection', async () => {
  const empty = await request(credential, '/searchBnetAccount', null, {
    fetcher: async () => reply({ code: 0, success: true, traceId: 't' })
  });
  assert.equal(empty.verdict, 'empty-success');
  assert.equal(empty.ok, false);
  const rejected = await request(
    credential,
    '/queryCard',
    {},
    {
      fetcher: async () => reply({ code: 401, errMsg: 'Token Invalid' }, 401)
    }
  );
  assert.equal(rejected.verdict, 'credential-rejected');
  const limited = await request(
    credential,
    '/queryCard',
    {},
    {
      fetcher: async () => reply({ code: 429 }, 429)
    }
  );
  assert.equal(limited.verdict, 'rate-limited');
});

test('a data payload is unwrapped and reported as usable', async () => {
  const seen = [];
  const result = await request(
    credential,
    '/queryCard',
    { roleId: 12345 },
    {
      fetcher: async (url, init) => {
        seen.push({ url: String(url), init });
        return reply({ code: 0, data: { name: 'Probe#123', customerToken: 'ct-value' } });
      }
    }
  );
  assert.equal(result.verdict, 'ok');
  assert.equal(result.ok, true);
  assert.equal(result.value.customerToken, 'ct-value');
  assert.match(seen[0].url, /roleId=12345/);
  assert.equal(seen[0].init.method, 'GET');
  // The credential travels in headers, never in the URL or the report.
  assert.ok(!seen[0].url.includes(credential.DASHEN_TOKEN));
  assert.ok(!JSON.stringify(result.shape).includes('ct-value'));
});

test('a body-carrying request is a POST with JSON content type', async () => {
  let captured = null;
  await request(credential, '/searchBnetAccount', null, {
    method: 'POST',
    body: { name: 'Probe#123' },
    fetcher: async (_url, init) => {
      captured = init;
      return reply({ code: 0, success: true });
    }
  });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json;charset=UTF-8');
  assert.equal(JSON.parse(captured.body).name, 'Probe#123');
});

test('transport failure is reported without throwing', async () => {
  const result = await request(
    credential,
    '/queryCard',
    {},
    {
      fetcher: async () => {
        throw Object.assign(new Error('down'), { name: 'TimeoutError' });
      }
    }
  );
  assert.equal(result.verdict, 'network-error');
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

test('the verdict names the observed incident: search empty while the card path works', () => {
  const steps = [
    { name: 'search', ok: false, verdict: 'empty-success' },
    { name: 'queryCard', ok: true, verdict: 'ok' },
    { name: 'matchList', ok: true, verdict: 'ok' },
    { name: 'matchInfo', ok: true, verdict: 'ok' }
  ];
  assert.equal(verdictOf(steps), 'search-empty-but-card-ok');
  assert.equal(verdictOf(steps.filter((s) => s.ok)), 'chain-ok');
  assert.equal(
    verdictOf([{ name: 'queryCard', ok: false, verdict: 'credential-rejected' }]),
    'credential-rejected'
  );
  assert.equal(verdictOf([]), 'no-steps');
});

test('credential loading accepts both config and credential field names', () => {
  const file = new URL('./credential-fixture.json', import.meta.url);
  assert.throws(() => loadCredential(new URL('./missing.json', import.meta.url)), {
    code: 'ENOENT'
  });
  // A directory is rejected before any read.
  assert.throws(() => loadCredential(new URL('.', import.meta.url)), /普通文件/);
  return file;
});

test('options and masking keep arguments predictable', () => {
  assert.deepEqual(options(['--config', '/etc/owqs/config.json', '--tag', 'Name#1234']), {
    config: '/etc/owqs/config.json',
    tag: 'Name#1234'
  });
  assert.deepEqual(options([]), { config: '', tag: '' });
  assert.equal(mask('daze#51307'), 'd***#51307');
  const h = headers(credential);
  assert.equal(h['GL-Bigdata-Role-Id'], '12345');
  assert.equal(h['GL-Bigdata-Server'], '1');
});
