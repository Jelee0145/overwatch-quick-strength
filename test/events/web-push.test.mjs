import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, randomBytes, verify, webcrypto } from 'node:crypto';
import {
  createPushSender,
  generatePushKeys,
  validateSubscription
} from '../../backend/server/web-push.mjs';

const { subtle } = webcrypto;
const endpoint = 'https://fcm.googleapis.com/fcm/send/test-only-token';
const payload = {
  title: '比赛提醒',
  body: '你预约的比赛即将开赛',
  url: '/?event=123',
  tag: 'event-123',
  id: '123'
};
const vapid = generatePushKeys();
const options = { ...vapid, subject: 'mailto:push@example.com' };
function receiver(url = endpoint) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    ecdh,
    subscription: {
      endpoint: url,
      expirationTime: null,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url')
      }
    }
  };
}
async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return Buffer.from(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8)
  );
}
// Independent receiver: Web Crypto HKDF and AES-GCM, rather than sender helpers.
async function decrypt(body, subscription, ecdh) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  assert.equal(recordSize, 4096);
  assert.equal(body[20], 65);
  const sender = body.subarray(21, 86);
  const receiverKey = Buffer.from(subscription.keys.p256dh, 'base64url');
  const ikm = await hkdf(
    ecdh.computeSecret(sender),
    Buffer.from(subscription.keys.auth, 'base64url'),
    Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, sender]),
    32
  );
  const cek = await hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plaintext = Buffer.from(
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.subarray(86))
  );
  assert.equal(plaintext.at(-1), 2, 'final RFC 8188 record delimiter');
  assert.ok(body.length <= 4096);
  return JSON.parse(plaintext.subarray(0, -1).toString());
}

test('generated VAPID keys are canonical base64url P-256 keys with a matching private scalar', () => {
  const keys = generatePushKeys();
  assert.match(keys.publicKey, /^[\w-]{87}$/);
  assert.match(keys.privateKey, /^[\w-]{43}$/);
  const pair = createECDH('prime256v1');
  pair.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
  assert.equal(pair.getPublicKey().toString('base64url'), keys.publicKey);
  assert.notEqual(keys.publicKey, vapid.publicKey);
});

test('RFC 8291 payload decrypts with independent Web Crypto receiver; VAPID ES256 verifies', async () => {
  const { subscription, ecdh } = receiver();
  const requests = [];
  const send = createPushSender({
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 201 });
    }
  });
  const before = Math.floor(Date.now() / 1000);
  assert.deepEqual(await send(subscription, payload), {
    ok: true,
    expired: false,
    statusCode: 201
  });
  await send(subscription, payload);
  const { url, init } = requests[0];
  assert.equal(url, endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.TTL, '180');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(await decrypt(init.body, subscription, ecdh), payload);
  assert.deepEqual(await decrypt(requests[1].init.body, subscription, ecdh), payload);
  assert.notDeepEqual(
    init.body.subarray(0, 16),
    requests[1].init.body.subarray(0, 16),
    'fresh salt'
  );
  assert.notDeepEqual(
    init.body.subarray(21, 86),
    requests[1].init.body.subarray(21, 86),
    'fresh ECDH key'
  );
  assert.notDeepEqual(
    init.body.subarray(21, 86),
    Buffer.from(vapid.publicKey, 'base64url'),
    'encryption key differs from VAPID key'
  );
  const match = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(init.headers.Authorization);
  assert.ok(match);
  assert.equal(match[2], vapid.publicKey);
  const [header, claims, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const jwt = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(jwt.aud, 'https://fcm.googleapis.com');
  assert.equal(jwt.sub, options.subject);
  assert.ok(jwt.exp >= before + 43200 && jwt.exp <= Math.floor(Date.now() / 1000) + 43200);
  const point = Buffer.from(vapid.publicKey, 'base64url');
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url')
    },
    format: 'jwk'
  });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url')
    )
  );
  const changed = Buffer.from(init.body);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(decrypt(changed, subscription, ecdh));
  const wrongAuth = {
    ...subscription,
    keys: { ...subscription.keys, auth: randomBytes(16).toString('base64url') }
  };
  await assert.rejects(decrypt(init.body, wrongAuth, ecdh));
});

test('subscription accepts only browser push service hosts and returns a detached normalized value', () => {
  for (const host of [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    'updates.autopush.updates.push.services.mozilla.com',
    'wns2-par02p.notify.windows.com',
    'web.push.apple.com'
  ]) {
    const input = receiver(`https://${host}/push/token?x=1`).subscription;
    const output = validateSubscription(input);
    assert.equal(output.endpoint, input.endpoint);
    assert.notEqual(output, input);
    assert.notEqual(output.keys, input.keys);
    assert.equal(output.expirationTime, undefined);
  }
});

test('subscription rejects SSRF destinations, authority tricks, ports, fragments and oversized endpoints', () => {
  const { subscription } = receiver();
  const urls = [
    'http://fcm.googleapis.com/push',
    'https://example.com/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://fcm.googleapis.com.evil.example/',
    'https://evilupdates.push.services.mozilla.com/',
    'https://notify.windows.com/',
    'https://evilnotify.windows.com/',
    'https://sub.web.push.apple.com/',
    'https://user@fcm.googleapis.com/',
    'https://user:pass@fcm.googleapis.com/',
    'https://fcm.googleapis.com:443/',
    'https://fcm.googleapis.com:8443/',
    'https://fcm.googleapis.com./',
    'https://%66cm.googleapis.com/',
    'https://fcm.googleapis.com\\@evil.example/',
    'https://fcm.googleapis.com/#fragment',
    ' https://fcm.googleapis.com/',
    'https://fcm.googleapis.com/\n',
    'https://.notify.windows.com/',
    'https://a..notify.windows.com/',
    `https://fcm.googleapis.com/${'x'.repeat(4096)}`
  ];
  for (const url of urls)
    assert.throws(() => validateSubscription({ ...subscription, endpoint: url }), TypeError, url);
  for (const input of [undefined, null, [], {}, { endpoint }])
    assert.throws(() => validateSubscription(input), TypeError);
});

test('subscription rejects malformed, noncanonical and off-curve keys', () => {
  const { subscription } = receiver();
  const invalid = [
    { p256dh: vapid.publicKey + '=' },
    { p256dh: 'A'.repeat(87) },
    { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') },
    { p256dh: Buffer.alloc(33).toString('base64url') },
    { auth: randomBytes(15).toString('base64url') },
    { auth: randomBytes(17).toString('base64url') },
    { auth: 'A'.repeat(21) + 'B' },
    { auth: 'A'.repeat(22) + '=' },
    { auth: 'A'.repeat(10_000) },
    { auth: null }
  ];
  for (const keys of invalid)
    assert.throws(
      () => validateSubscription({ ...subscription, keys: { ...subscription.keys, ...keys } }),
      TypeError
    );
});

test('sender validates VAPID settings and key pairing at construction', () => {
  for (const overrides of [
    { ...generatePushKeys(), publicKey: vapid.publicKey },
    { privateKey: 'A'.repeat(43) },
    { publicKey: 'A'.repeat(87) },
    { subject: 'http://example.com' },
    { subject: 'mailto:invalid' },
    { subject: 'https://user:pass@example.com' },
    { subject: 'mailto:a@example.com\n' },
    { subject: undefined },
    { fetchImpl: null }
  ])
    assert.throws(() => createPushSender({ ...options, ...overrides }), TypeError);
  assert.throws(() => createPushSender(), TypeError);
  assert.equal(
    typeof createPushSender({ ...options, subject: 'https://example.com/contact' }),
    'function'
  );
});

test('sender accepts only minimal reminder fields and safe click URLs before fetch', async () => {
  const { subscription } = receiver();
  let calls = 0;
  const send = createPushSender({
    ...options,
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 201 });
    }
  });
  for (const invalid of [
    null,
    [],
    {},
    { body: 'no title' },
    { ...payload, account: 'secret' },
    { ...payload, title: '' },
    { ...payload, body: 1 },
    { ...payload, tag: 'x'.repeat(129) },
    { ...payload, title: 'x'.repeat(121) },
    { ...payload, body: 'a\nb' },
    ...[
      'https://evil.example/',
      '//evil.example/',
      '/\\evil.example/',
      '/%2f/evil.example/',
      'javascript:alert(1)',
      'relative/path',
      '/%5cevil.example/'
    ].map((url) => ({ ...payload, url })),
    { title: '赛'.repeat(120), body: '赛'.repeat(500), url: `/${'赛'.repeat(2000)}` }
  ])
    await assert.rejects(send(subscription, invalid), TypeError);
  await assert.rejects(
    send({ ...subscription, endpoint: 'https://example.com' }, payload),
    TypeError
  );
  assert.equal(calls, 0);
  await send(subscription, { title: '即将开赛', body: '你预约的比赛即将开赛' });
  assert.equal(calls, 1);
});

test('title-only reminders are accepted and decrypt with an empty body', async () => {
  const { subscription, ecdh } = receiver();
  let body;
  const send = createPushSender({
    ...options,
    fetchImpl: async (_url, init) => {
      body = init.body;
      return new Response(null, { status: 201 });
    }
  });
  assert.deepEqual(
    await send(subscription, { title: '即将开赛', url: '/tools/events', tag: 'owqs-match-1' }),
    { ok: true, expired: false, statusCode: 201 }
  );
  assert.deepEqual(await decrypt(body, subscription, ecdh), {
    title: '即将开赛',
    url: '/tools/events',
    tag: 'owqs-match-1',
    body: ''
  });
  body = undefined;
  await send(subscription, { title: '即将开赛', body: '' });
  assert.deepEqual(await decrypt(body, subscription, ecdh), { title: '即将开赛', body: '' });
});

test('url accepts only the official broadcast channel allowlist', async () => {
  const { subscription } = receiver();
  const sent = [];
  const send = createPushSender({
    ...options,
    fetchImpl: async () => new Response(null, { status: 201 })
  });
  for (const url of [
    'https://www.twitch.tv/ow_esports',
    'https://www.twitch.tv/ow_esports_jp',
    'https://www.twitch.tv/ow_esports_th',
    'https://live.bilibili.com/23612045',
    'https://www.sooplive.co.kr/station/owesports',
    '/',
    '/tools/events?event=1'
  ]) {
    assert.deepEqual(await send(subscription, { ...payload, url }), {
      ok: true,
      expired: false,
      statusCode: 201
    });
    sent.push(url);
  }
  for (const url of [
    'http://www.twitch.tv/ow_esports',
    'https://twitch.tv/ow_esports',
    'https://www.twitch.tv.evil.example/ow_esports',
    'https://evil.example/www.twitch.tv/ow_esports',
    'https://user@www.twitch.tv/ow_esports',
    'https://user:pass@www.twitch.tv/ow_esports',
    'https://www.twitch.tv:443/ow_esports',
    'https://www.twitch.tv:8443/ow_esports',
    'https://www.twitch.tv/ow_esports?x=1',
    'https://www.twitch.tv/ow_esports#fragment',
    'https://www.twitch.tv/ow_esports/extra',
    'https://www.twitch.tv/',
    'https://www.twitch.tv',
    'https://live.bilibili.com/23612045/',
    'https://live.bilibili.com/abc',
    'https://live.bilibili.com/23612045?x=1',
    'https://live.bilibili.com.evil.example/23612045',
    'https://www.bilibili.com/23612045',
    'https://live.bilibili.com:8443/23612045',
    'https://live.bilibili.com@evil.example/23612045',
    'https://www.sooplive.co.kr/station/owesports/',
    'https://www.sooplive.co.kr/station/',
    'https://www.sooplive.co.kr/station/owesports?x=1',
    'https://www.sooplive.co.kr.evil.example/station/owesports',
    'https://sooplive.co.kr/station/owesports',
    'https://www.sooplive.co.kr:8443/station/owesports',
    'https://evil.example/station/owesports'
  ])
    await assert.rejects(send(subscription, { ...payload, url }), TypeError, url);
  assert.equal(sent.length, 7);
});

test('maximum payload fits the 4096-byte push service limit and one extra byte is rejected', async () => {
  const { subscription, ecdh } = receiver();
  const boundary = {
    title: '赛'.repeat(120),
    body: '赛'.repeat(500),
    url: '/',
    tag: '赛'.repeat(128),
    id: '赛'.repeat(128)
  };
  boundary.url += 'a'.repeat(3993 - Buffer.byteLength(JSON.stringify(boundary)));
  let calls = 0;
  const send = createPushSender({
    ...options,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.body.length, 4096);
      assert.deepEqual(await decrypt(init.body, subscription, ecdh), boundary);
      return new Response(null, { status: 201 });
    }
  });
  await send(subscription, boundary);
  await assert.rejects(send(subscription, { ...boundary, url: boundary.url + 'a' }), /too large/);
  assert.equal(calls, 1);
});

test('404 and 410 invalidate subscriptions; all other HTTP failures throw for caller retry', async () => {
  const { subscription } = receiver();
  for (const status of [200, 201, 202, 204, 404, 410, 301, 400, 401, 403, 413, 429, 500, 503]) {
    let canceled = false;
    const send = createPushSender({
      ...options,
      fetchImpl: async () => ({
        status,
        body: {
          cancel: async () => {
            canceled = true;
          }
        }
      })
    });
    if (status === 404 || status === 410)
      assert.deepEqual(await send(subscription, payload), {
        ok: false,
        expired: true,
        statusCode: status
      });
    else if (status >= 200 && status < 300)
      assert.deepEqual(await send(subscription, payload), {
        ok: true,
        expired: false,
        statusCode: status
      });
    else
      await assert.rejects(
        send(subscription, payload),
        (error) => error.statusCode === status && !error.message.includes(endpoint)
      );
    assert.equal(canceled, true);
  }
  const networkError = new TypeError('network failed');
  const send = createPushSender({
    ...options,
    fetchImpl: async () => {
      throw networkError;
    }
  });
  await assert.rejects(send(subscription, payload), (error) => error === networkError);
});

test('sender requests a ten-second abort signal and propagates timeout failure', async (t) => {
  const controller = new AbortController();
  let requested;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    requested = ms;
    return controller.signal;
  });
  const { subscription } = receiver();
  const send = createPushSender({
    ...options,
    fetchImpl: async (_url, { signal, redirect }) => {
      assert.equal(signal, controller.signal);
      assert.equal(redirect, 'error');
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      signal.throwIfAborted();
    }
  });
  await assert.rejects(send(subscription, payload), { name: 'TimeoutError' });
  assert.equal(requested, 10_000);
});
