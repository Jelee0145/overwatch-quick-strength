import {
  createCipheriv, createECDH, createHmac, createPrivateKey, ECDH,
  randomBytes, sign,
} from 'node:crypto';

const MAX_ENDPOINT_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 3993; // 4096-byte service limit minus header, delimiter and GCM tag.
const TIMEOUT_MS = 10_000;
// Official broadcast destinations used by src/events-broadcasts.mjs. Paths are
// matched strictly so query, fragment, userinfo and port injection cannot fit.
const OFFICIAL_BROADCAST_URL = /^https:\/\/(?:www\.twitch\.tv\/[A-Za-z0-9_]{1,25}|live\.bilibili\.com\/[0-9]{1,20}|www\.sooplive\.co\.kr\/station\/[A-Za-z0-9_]{1,30})$/;

function decodeKey(value, size, name) {
  if (typeof value !== 'string' || value.length !== Math.ceil(size * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) {
    throw new TypeError(`Invalid ${name}`);
  }
  return bytes;
}

function publicPoint(value, name) {
  const bytes = decodeKey(value, 65, name);
  if (bytes[0] !== 4) throw new TypeError(`Invalid ${name}`);
  try {
    ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    throw new TypeError(`Invalid ${name}`);
  }
  return bytes;
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH
      || !/^https:\/\//.test(endpoint) || /[\s\\\u0000-\u001f\u007f]/.test(endpoint)) {
    throw new TypeError('Invalid push endpoint');
  }
  // Inspect the original authority: URL normalizes an explicit :443 away.
  const authority = endpoint.slice(8).split(/[/?#]/, 1)[0];
  if (!/^[a-z0-9.-]+$/i.test(authority)) throw new TypeError('Invalid push endpoint authority');
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('Invalid push endpoint'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com'
    || host.endsWith('.updates.push.services.mozilla.com')
    || host.endsWith('.notify.windows.com')
    || host === 'web.push.apple.com';
  if (!allowed || url.username || url.password || url.port || url.hash
      || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new TypeError('Push endpoint is not an allowed browser push service');
  }
  return url.href;
}

/** Validate untrusted PushSubscription.toJSON() input; return a fresh, normalized copy. */
export function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
    throw new TypeError('Invalid push subscription');
  }
  const endpoint = validateEndpoint(subscription.endpoint);
  const keys = subscription.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new TypeError('Invalid subscription keys');
  publicPoint(keys.p256dh, 'subscription p256dh');
  decodeKey(keys.auth, 16, 'subscription auth');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Generate once, persist securely, and use publicKey as PushManager applicationServerKey. */
export function generatePushKeys() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  // OpenSSL can omit a leading zero octet from the private scalar.
  const scalar = key.getPrivateKey();
  const padded = Buffer.alloc(32);
  scalar.copy(padded, 32 - scalar.length);
  return {
    publicKey: key.getPublicKey().toString('base64url'),
    privateKey: padded.toString('base64url'),
  };
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function expand(key, info, length) {
  // All RFC 8291 outputs fit in the first SHA-256 HKDF block.
  return hmac(key, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

function encrypt(subscription, plaintext) {
  const receiver = Buffer.from(subscription.keys.p256dh, 'base64url');
  const auth = Buffer.from(subscription.keys.auth, 'base64url');
  const ephemeral = createECDH('prime256v1');
  const sender = ephemeral.generateKeys();
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]);
  const ikm = expand(hmac(auth, ephemeral.computeSecret(receiver)), keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = sender.length;
  return Buffer.concat([header, sender, ciphertext]);
}

function encodePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid push payload');
  const limits = { title: 120, body: 500, url: 2048, tag: 128, id: 128 };
  const safe = {};
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    // body is optional and may be empty for title-only system notifications.
    if (!Object.hasOwn(limits, key) || typeof value !== 'string'
        || (key !== 'body' && !value.length) || value.length > limits[key]
        || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError(`Invalid push payload field: ${key}`);
    }
    safe[key] = value;
  }
  if (!safe.title) throw new TypeError('Push payload requires title');
  if (safe.body === undefined) safe.body = '';
  if (safe.url) {
    // Notification clicks stay on the app origin, or target a known official broadcast.
    const relative = safe.url.startsWith('/') && !safe.url.startsWith('//')
      && !/\\|%2f|%5c/i.test(safe.url)
      && new URL(safe.url, 'https://push.invalid').origin === 'https://push.invalid';
    if (!relative && !OFFICIAL_BROADCAST_URL.test(safe.url)) {
      throw new TypeError('Push payload url must be a safe app-relative or official broadcast URL');
    }
  }
  const bytes = Buffer.from(JSON.stringify(safe));
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new TypeError('Push payload is too large');
  return bytes;
}

/**
 * Returns send(subscription, {title, body, url?, tag?, id?}).
 * Result: {ok, expired, statusCode}; only 404/410 return ok:false.
 * All other failures throw (HTTP errors carry statusCode) for caller-managed retry.
 */
export function createPushSender({ publicKey, privateKey, subject, fetchImpl = fetch } = {}) {
  const point = publicPoint(publicKey, 'VAPID public key');
  const secret = decodeKey(privateKey, 32, 'VAPID private key');
  const pair = createECDH('prime256v1');
  try { pair.setPrivateKey(secret); } catch { throw new TypeError('Invalid VAPID private key'); }
  if (!pair.getPublicKey().equals(point)) throw new TypeError('VAPID keys do not match');
  if (typeof subject !== 'string' || subject.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(subject)) {
    throw new TypeError('Invalid VAPID subject');
  }
  let contact;
  try { contact = new URL(subject); } catch { throw new TypeError('Invalid VAPID subject'); }
  if (!((contact.protocol === 'https:' && contact.hostname && !contact.username && !contact.password)
      || (contact.protocol === 'mailto:' && /^[^@/?#]+@[^@/?#]+$/.test(contact.pathname)))) {
    throw new TypeError('VAPID subject must be an https: or mailto: contact URI');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const signingKey = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'), d: secret.toString('base64url') },
    format: 'jwk',
  });

  return async (subscription, payload) => {
    const validated = validateSubscription(subscription);
    const plaintext = encodePayload(payload);
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
      aud: new URL(validated.endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: subject,
    })).toString('base64url');
    const unsigned = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(unsigned), {
      key: signingKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const body = encrypt(validated, plaintext);
    const response = await fetchImpl(validated.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `vapid t=${unsigned}.${signature}, k=${publicKey}`,
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: '180', Urgency: 'high',
      },
      body,
    });
    // The push service body is unused; cancel it to release the connection promptly.
    if (response.body) await response.body.cancel();
    const statusCode = response.status;
    if (statusCode === 404 || statusCode === 410) return { ok: false, expired: true, statusCode };
    if (statusCode < 200 || statusCode >= 300) {
      const error = new Error(`Web Push service returned HTTP ${statusCode}`);
      error.statusCode = statusCode;
      throw error;
    }
    return { ok: true, expired: false, statusCode };
  };
}
