import { Fault } from '../security.mjs';
export { statKeys } from '../services/data.mjs';
const num = (v) =>
  v === null ||
  v === undefined ||
  v === '' ||
  typeof v === 'boolean' ||
  !Number.isFinite(Number(v)) ||
  Number(v) < 0
    ? null
    : Number(v);
const text = (v, n = 100) => String(v ?? '').slice(0, n);
export function unwrap(v) {
  for (
    let i = 0;
    i < 3 &&
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    v.data &&
    !['guideCountData', 'teammateList', 'matchId'].some((k) => k in v);
    i++
  )
    v = v.data;
  return v;
}
// Cooldown after an upstream refusal: never retry immediately, and honour Retry-After when sent.
const COOLDOWN_MS = 3000,
  MAX_COOLDOWN_MS = 60000,
  cooldownOf = (response) => {
    const value = Number(response?.headers?.get?.('Retry-After'));
    return Number.isFinite(value) && value > 0
      ? Math.min(MAX_COOLDOWN_MS, value * 1000)
      : COOLDOWN_MS;
  };
/**
 * @param {object} env
 * @param {string} path
 * @param {object} params
 * @param {object} [body]
 * @param {object} [options]
 * @param {string} [options.priority] Shared-schedule class: 'high', 'normal' or 'low'.
 * @param {Function} [options.fetcher] Transport override; defaults to the shared schedule or fetch.
 */
export async function upstream(
  env,
  path,
  params,
  body,
  { priority = 'normal', fetcher = fetch } = {}
) {
  fetcher = env.UPSTREAM_FETCH || fetcher;
  if (!env.DASHEN_TOKEN || !env.DASHEN_ROLE_ID)
    throw new Fault('查询凭证尚未配置，请联系管理员', 503);
  const url = new URL('https://datamsapi.ds.163.com/v1/a19ld5tool' + path);
  for (const [k, v] of Object.entries(params || {}))
    if (v !== '' && v !== null && v !== undefined) url.searchParams.set(k, v);
  const headers = {
    Accept: 'application/json',
    'GL-Bigdata-Role-Id': env.DASHEN_ROLE_ID,
    'GL-Bigdata-Auth-Token': env.DASHEN_TOKEN,
    'GL-Bigdata-Dts': env.DASHEN_DTS,
    'GL-Bigdata-Server': env.DASHEN_SERVER,
    'GL-ClientType': '60',
    Origin: 'https://act.ds.163.com',
    Referer: 'https://act.ds.163.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) app/df_client dfVersion/100111'
  };
  if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';
  let r;
  const started = Date.now();
  try {
    // The priority travels beside RequestInit, never inside it: only this host's shared schedule
    // understands it, while the platform fetch keeps receiving a spec-valid init.
    r = await fetcher(
      url,
      {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25000),
        redirect: 'manual'
      },
      priority
    );
  } catch (e) {
    const name = ['TimeoutError', 'AbortError', 'TypeError'].includes(e?.name)
      ? e.name
      : 'NetworkError';
    let message = String(e?.message || '');
    for (const value of [
      env.DASHEN_TOKEN,
      env.DASHEN_ROLE_ID,
      params?.token,
      body?.token,
      body?.name
    ])
      if (value) message = message.replaceAll(String(value), '[redacted]');
    message = message
      .replace(/https?:\/\/[^\s)]+/g, '[redacted-url]')
      .replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]')
      .slice(0, 180);
    console.warn(
      'dashen-fetch-failed',
      JSON.stringify({ path, elapsedMs: Date.now() - started, type: name, message })
    );
    throw new Fault(
      (name === 'TimeoutError' || name === 'AbortError' ? '大神请求超时' : '大神网络连接失败') +
        '（' +
        {
          '/searchBnetAccount': '搜索账号',
          '/customer/queryMatchList': '对局列表',
          '/customer/queryMatchInfo': '对局详情',
          '/customer/queryCountInfo': '竞技段位'
        }[path] +
        '），请稍后重试',
      504
    );
  }
  if (r.status >= 300 && r.status < 400) throw new Fault('大神接口发生重定向，已拒绝转发凭证', 502);
  if ([401, 403].includes(r.status)) throw new Fault('大神凭证已失效，请联系管理员更新', 503);
  // Hold the whole shared schedule, not just this task: other tasks would otherwise keep
  // starting requests into a refusal and the pause would never take effect.
  if (r.status === 429) {
    env.UPSTREAM_SCHEDULER?.coolDown(cooldownOf(r));
    throw new Fault('大神接口限流，当前任务已暂停，稍后继续', 429);
  }
  if (!r.ok) throw new Fault('大神接口暂不可用（HTTP ' + r.status + '）', 502);
  let v;
  try {
    v = await r.json();
  } catch {
    throw new Fault('大神返回格式异常', 502);
  }
  if ([401, 403].includes(v.code)) throw new Fault('大神凭证已失效，请联系管理员更新', 503);
  if (v.code === 429) {
    env.UPSTREAM_SCHEDULER?.coolDown(cooldownOf(r));
    throw new Fault('大神接口限流，当前任务已暂停，稍后继续', 429);
  }
  if (![0, 200].includes(v.code) || v.success === false)
    throw new Fault('大神返回业务错误（' + text(v.code, 20) + '）', 502);
  return unwrap(v.data);
}
