import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  probe,
  summarize,
  ADVICE
} from '../../scripts/diagnostics/upstream-credential-check.mjs';

const config = {
  DASHEN_TOKEN: 'a'.repeat(32),
  DASHEN_ROLE_ID: 'fixture-role',
  DASHEN_DTS: '2026',
  DASHEN_SERVER: '1'
};
const reply = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('the incident signature is an authorised but empty payload', () => {
  assert.equal(classify({ status: 200, code: 0, success: true, hasData: false }), 'empty-success');
  assert.equal(classify({ status: 200, code: 0, success: true, hasData: true }), 'ok');
  assert.equal(classify({ status: 401, code: 401, hasData: false }), 'credential-rejected');
  // The adapter also maps a 200 body carrying code 401 to a credential failure.
  assert.equal(classify({ status: 200, code: 401, hasData: false }), 'credential-rejected');
  assert.equal(classify({ status: 200, code: 403, hasData: false }), 'credential-rejected');
  assert.equal(classify({ status: 429, code: 429, hasData: false }), 'rate-limited');
  assert.equal(classify({ status: 502, code: 502, hasData: false }), 'upstream-error');
  assert.equal(classify({ status: 200, hasData: false }), 'empty-success');
});

test('a rejection on any endpoint outranks empty data, and mixed empties are not reported as ok', () => {
  assert.equal(
    summarize([{ verdict: 'empty-success' }, { verdict: 'credential-rejected' }]),
    'credential-rejected'
  );
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'ok' }]), 'ok');
  assert.equal(
    summarize([{ verdict: 'empty-success' }, { verdict: 'empty-success' }]),
    'empty-success-everywhere'
  );
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'empty-success' }]), 'partially-empty');
  assert.equal(summarize([{ verdict: 'network-error' }]), 'network-error');
  for (const verdict of [
    'ok',
    'credential-rejected',
    'empty-success-everywhere',
    'partially-empty',
    'rate-limited',
    'upstream-error',
    'network-error',
    'unknown'
  ])
    assert.equal(typeof ADVICE[verdict], 'string', verdict);
});

test('probe reports field names and status without ever returning token values', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), init });
    return reply(200, { code: 0, success: true, traceId: 'trace-value' });
  };
  const result = await probe(
    config,
    {
      kind: 'account',
      path: '/searchBnetAccount',
      body: (c, tag) => ({ name: tag, token: c.DASHEN_TOKEN })
    },
    { tag: 'Probe#1234', fetcher }
  );
  assert.equal(result.verdict, 'empty-success');
  assert.deepEqual(result.fields, ['code', 'success', 'traceId']);
  assert.equal(seen[0].init.method, 'POST');
  // The diagnostic must not echo the credential anywhere in its report.
  assert.ok(!JSON.stringify(result).includes(config.DASHEN_TOKEN));
  assert.ok(!seen[0].url.includes(config.DASHEN_TOKEN));
});

test('probe reads query parameters for GET endpoints and tolerates transport failure', async () => {
  let captured = '';
  const ok = await probe(
    config,
    {
      kind: 'list',
      path: '/customer/queryMatchList',
      query: (c) => ({ token: c.DASHEN_TOKEN, page: 1 })
    },
    {
      fetcher: async (url, init) => {
        captured = String(url);
        assert.equal(init.method, 'GET');
        return reply(200, { code: 0, data: { matchList: [] } });
      }
    }
  );
  assert.equal(ok.verdict, 'ok');
  assert.match(captured, /page=1/);
  // The token stays in the query string, never in the returned report.
  assert.ok(!JSON.stringify(ok).includes(config.DASHEN_TOKEN));
  const failed = await probe(
    config,
    { kind: 'rank', path: '/customer/queryCountInfo', query: () => ({}) },
    {
      fetcher: async () => {
        throw Object.assign(new Error('down'), { name: 'TimeoutError' });
      }
    }
  );
  assert.equal(failed.verdict, 'network-error');
  assert.equal(failed.status, 0);
});
