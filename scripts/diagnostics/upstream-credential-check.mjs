#!/usr/bin/env node
// Upstream credential diagnostic. Answers one question: are the Dashen credentials still
// valid, or is the upstream returning an empty successful payload for every caller?
//
// It never prints a token or role id; only fingerprints, lengths and status codes.
// Usage:
//   node scripts/diagnostics/upstream-credential-check.mjs --config /etc/owqs/config.json
//   node scripts/diagnostics/upstream-credential-check.mjs --config <file> --tag 'Name#1234'
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://datamsapi.ds.163.com/v1/a19ld5tool';
// Endpoints the query engine depends on; a credential that is valid for one but empty on all of
// them points at the upstream side, not at our request shape.
const ENDPOINTS = [
  { kind: 'account', path: '/searchBnetAccount', body: (c, tag) => ({ name: tag, ...creds(c) }) },
  {
    kind: 'list',
    path: '/customer/queryMatchList',
    query: (c) => ({ token: c.DASHEN_TOKEN, gameMode: 'leisure', page: 1, season: '' })
  },
  {
    kind: 'rank',
    path: '/customer/queryCountInfo',
    query: (c) => ({ token: c.DASHEN_TOKEN, gameMode: 'sport', season: '' })
  }
];

function creds(config) {
  return {
    token: config.DASHEN_TOKEN,
    roleId: config.DASHEN_ROLE_ID,
    dts: config.DASHEN_DTS,
    server: config.DASHEN_SERVER
  };
}
function headers(config, token = config.DASHEN_TOKEN) {
  return {
    Accept: 'application/json',
    'GL-Bigdata-Role-Id': config.DASHEN_ROLE_ID,
    'GL-Bigdata-Auth-Token': token,
    'GL-Bigdata-Dts': config.DASHEN_DTS,
    'GL-Bigdata-Server': config.DASHEN_SERVER,
    'GL-ClientType': '60',
    Origin: 'https://act.ds.163.com',
    Referer: 'https://act.ds.163.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) app/df_client dfVersion/100111',
    'Content-Type': 'application/json;charset=UTF-8'
  };
}
/** A token that passed authorisation but carries no data is the signature of this incident. */
export function classify(response) {
  if (response.status === 401 || response.status === 403) return 'credential-rejected';
  if (response.code === 401 || response.code === 403) return 'credential-rejected';
  if (response.status === 429 || response.code === 429) return 'rate-limited';
  if (response.status >= 500) return 'upstream-error';
  if (response.status !== 200) return 'unexpected-status';
  if (!response.hasData) return 'empty-success';
  return 'ok';
}
/** Probe one endpoint once, with the transport injectable so the logic stays testable. */
export async function probe(config, endpoint, { tag, fetcher = fetch } = {}) {
  const url = new URL(API + endpoint.path);
  for (const [k, v] of Object.entries(endpoint.query?.(config) || {}))
    if (v !== '' && v !== null && v !== undefined) url.searchParams.set(k, v);
  const init = {
    method: endpoint.body ? 'POST' : 'GET',
    headers: headers(config),
    redirect: 'manual'
  };
  if (endpoint.body) init.body = JSON.stringify(endpoint.body(config, tag));
  let text = '',
    status = 0;
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20000) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return { endpoint: endpoint.kind, status: 0, verdict: 'network-error', detail: error?.name };
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const shaped = {
    status,
    code: body?.code,
    success: body?.success,
    hasData: text.includes('"data"')
  };
  return {
    endpoint: endpoint.kind,
    status,
    bytes: text.length,
    verdict: classify(shaped),
    // Field names only: values may contain account tokens.
    fields: body && typeof body === 'object' ? Object.keys(body) : [],
    message: typeof body?.errMsg === 'string' ? body.errMsg.slice(0, 60) : undefined
  };
}

export function summarize(results) {
  const verdicts = new Set(results.map((r) => r.verdict));
  if (verdicts.has('credential-rejected')) return 'credential-rejected';
  if (verdicts.has('network-error')) return 'network-error';
  if (verdicts.has('upstream-error')) return 'upstream-error';
  if (verdicts.has('rate-limited')) return 'rate-limited';
  if (verdicts.size === 1 && verdicts.has('ok')) return 'ok';
  if (verdicts.has('empty-success') && !verdicts.has('ok')) return 'empty-success-everywhere';
  if (verdicts.has('empty-success')) return 'partially-empty';
  return 'unknown';
}
export const ADVICE = {
  ok: '凭证有效且上游仍在返回数据，查询失败应另找原因。',
  'credential-rejected':
    '凭证已失效：上游对 token 返回 401/403。需要重新获取 DASHEN_TOKEN / DASHEN_ROLE_ID 并更新配置后重启服务。',
  'empty-success-everywhere':
    '凭证通过鉴权但每个接口都只返回 code:0/success 而没有 data。这是上游数据侧问题（权限被收回、赛季或风控降级），不是本仓库代码缺陷，换凭证前请先用新凭证复测。',
  'partially-empty':
    '部分接口有数据、部分为空：更可能是该端点参数或账号状态问题，需要按空的那个端点单独排查。',
  'rate-limited': '上游返回 429：先降低请求速率或等待冷却，再重试凭证检查。',
  'upstream-error': '上游 5xx：临时故障，稍后重试。',
  'network-error': '网络不可达：检查出口网络、DNS 或代理，凭证未被验证。',
  unknown: '结果混合：按每条记录分别判断。'
};

function parse(argv) {
  const options = { config: '', tag: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') options.config = argv[++i] || '';
    else if (argv[i] === '--tag') options.tag = argv[++i] || '';
  }
  return options;
}
function load(configPath) {
  const info = statSync(configPath);
  // A directory or device here would make the check read the wrong file.
  if (!info.isFile()) throw Error('--config 必须指向普通文件');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const key of ['DASHEN_TOKEN', 'DASHEN_ROLE_ID', 'DASHEN_DTS', 'DASHEN_SERVER'])
    if (!config[key]) throw Error('配置缺少 ' + key);
  return config;
}
const fingerprint = (value) =>
  createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 16);

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options.config) {
    console.error(
      '用法: node scripts/diagnostics/upstream-credential-check.mjs --config <配置> [--tag 玩家#1234]'
    );
    process.exitCode = 2;
    return;
  }
  const config = load(options.config);
  console.log(
    'token fp',
    fingerprint(config.DASHEN_TOKEN),
    'len',
    String(config.DASHEN_TOKEN).length
  );
  console.log(
    'roleId fp',
    fingerprint(config.DASHEN_ROLE_ID),
    'dts',
    config.DASHEN_DTS,
    'server',
    config.DASHEN_SERVER
  );
  // RFC 2606 reserved domain: never a real account, so it separates "unknown player" from "no data at all".
  const tag = options.tag || 'owqs-diagnostic#00000';
  const results = [];
  for (const endpoint of ENDPOINTS) results.push(await probe(config, endpoint, { tag }));
  for (const result of results)
    console.log(
      result.endpoint.padEnd(8),
      '| status',
      String(result.status).padEnd(3),
      '| bytes',
      String(result.bytes ?? 0).padEnd(4),
      '|',
      result.verdict,
      result.fields?.length ? '| fields ' + result.fields.join(',') : ''
    );
  const verdict = summarize(results);
  console.log('\n结论:', verdict);
  console.log(ADVICE[verdict]);
  if (verdict !== 'ok') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
