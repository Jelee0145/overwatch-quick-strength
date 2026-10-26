import { ServiceError as Fault } from '../services/errors.mjs';
import { hex } from './crypto.mjs';
const enc = new TextEncoder();
const unhex = (s) => {
  if (typeof s !== 'string' || s.length % 2) throw new Fault('密钥数据无效', 503);
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) {
    const v = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(v)) throw new Fault('密钥数据无效', 503);
    a[i] = v;
  }
  return a;
};
// API keys are stored encrypted under a dedicated Worker Secret; the lookup index uses only a digest.
export async function encryptSecret(value, secret) {
  if (!secret) throw new Fault('API 密钥加密尚未配置，请联系管理员', 503);
  if (typeof value !== 'string' || !value) throw new Fault('密钥内容无效');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret)),
    key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value));
  return { v: 1, iv: hex(iv), data: hex(new Uint8Array(data)) };
}
export async function decryptSecret(record, secret) {
  if (!secret) throw new Fault('API 密钥加密尚未配置，请联系管理员', 503);
  try {
    if (record?.v !== 1) throw 0;
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret)),
      key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']),
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unhex(record.iv) },
        key,
        unhex(record.data)
      );
    return new TextDecoder().decode(plain);
  } catch (e) {
    if (e?.status === 503) throw e;
    throw new Fault('API 密钥无法解密，请重新生成', 503);
  }
}
