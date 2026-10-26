import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import {
  normalizeCredential,
  privateDirectory,
  probeCredential,
  requestReportCredential
} from '../../scripts/refresh-dashen-credentials.mjs';

const credential = {
  DASHEN_ROLE_ID: '12345',
  DASHEN_TOKEN: 'fixture-private-token',
  DASHEN_DTS: '2026',
  DASHEN_SERVER: '1'
};
const metadata = { roleId: '12345', dts: '2026', server: '1' };

test('credential normalization keeps only upstream fields and does not echo invalid input', () => {
  assert.deepEqual(
    normalizeCredential({
      result: {
        roleId: 12345,
        token: credential.DASHEN_TOKEN,
        day: 2026,
        server: 1,
        PASSWORD_PEPPER: 'unrelated-secret'
      }
    }),
    credential
  );
  assert.deepEqual(normalizeCredential(credential), credential);
  assert.throws(
    () => normalizeCredential({ token: 'never-echo-this' }),
    (error) => !error.message.includes('never-echo-this')
  );
});

test('credential and browser paths cannot escape the ignored private root', async () => {
  await assert.rejects(privateDirectory('public/credential-test'), /必须位于/);
  await assert.rejects(privateDirectory('../outside-credential-test'), /必须位于/);
});

function browser(fetcher, overrides = {}) {
  return vm.runInNewContext(`(${requestReportCredential.toString()})(metadata)`, {
    metadata,
    location: { origin: 'https://ds.163.com' },
    document: {
      cookie: ['GOD_UUID=fixture-uid', 'GL-XSRF-TOKEN=' + encodeURIComponent('fixture+csrf')].join(
        '; '
      )
    },
    localStorage: { getItem: () => 'fixture-device' },
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    AbortSignal,
    fetch: fetcher,
    ...overrides
  });
}

test('report credential request signs exactly its body plus decoded csrf and pins the endpoint', async () => {
  let calls = 0;
  const result = await browser(async (url, init) => {
    calls++;
    assert.equal(url, 'https://inf.ds.163.com/v1/web/game/report/getReportToken');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['GL-X-XSRF-TOKEN'], 'fixture+csrf');
    assert.equal(
      init.headers['GL-CheckSum'],
      createHash('sha1')
        .update(init.body + 'fixture+csrf')
        .digest('hex')
    );
    return Response.json({ code: 200, result: { token: credential.DASHEN_TOKEN } });
  });
  assert.equal(calls, 1);
  assert.equal(result.state, 'credential');
  assert.deepEqual(normalizeCredential(result.value), credential);
});

test('wrong-origin and logged-out pages never send credential requests', async () => {
  const unexpected = () => {
    throw Error('must not fetch');
  };
  assert.equal(
    (await browser(unexpected, { location: { origin: 'https://example.com' } })).state,
    'wrong-origin'
  );
  assert.equal((await browser(unexpected, { document: { cookie: '' } })).state, 'login-required');
});

test('failed issuance and network failures never return credentials or raw errors', async () => {
  const failed = await browser(async () =>
    Response.json({
      code: 825,
      errmsg: '签名无效 fixture-private-token',
      result: null
    })
  );
  assert.equal(failed.code, 825);
  assert.equal(failed.state, 'not-ready');
  assert.ok(!JSON.stringify(failed).includes('fixture-private-token'));
  const network = await browser(async () => {
    throw Error('token=fixture-private-token');
  });
  assert.equal(network.state, 'request-failed');
  assert.ok(!JSON.stringify(network).includes('fixture-private-token'));
});

test('empty, mismatching and failed account probes do not read match lists or leak provider data', async () => {
  for (const account of [undefined, { name: 'Other#200', customerToken: 'private-customer' }]) {
    let calls = 0;
    const result = await probeCredential(
      async () => {
        calls++;
        return account;
      },
      credential,
      'Own#100'
    );
    assert.equal(calls, 1);
    assert.equal(result.hasPlayer, false);
    assert.ok(!JSON.stringify(result).includes('private-customer'));
  }
  const error = await probeCredential(
    async () => {
      throw Object.assign(Error('fixture-private-token'), { status: 429 });
    },
    credential,
    'Own#100'
  );
  assert.deepEqual(error, { state: 'error', status: 429 });
});

test('successful exact-account probes expose only list readability and count', async () => {
  const paths = [];
  const result = await probeCredential(
    async (_env, endpoint, params, body) => {
      paths.push(endpoint);
      if (endpoint === '/searchBnetAccount') {
        assert.equal(body.name, 'Own#100');
        return { name: 'Own#100', customerToken: 'private-customer' };
      }
      assert.equal(params.token, 'private-customer');
      return { matchList: [{ matchId: 'private-match-1' }] };
    },
    credential,
    'Own#100'
  );
  assert.deepEqual(paths, ['/searchBnetAccount', '/customer/queryMatchList']);
  assert.deepEqual(result, {
    state: 'ok',
    hasPlayer: true,
    listReadable: true,
    recentMatchCount: 1
  });
  assert.ok(!JSON.stringify(result).includes('private-'));
});
