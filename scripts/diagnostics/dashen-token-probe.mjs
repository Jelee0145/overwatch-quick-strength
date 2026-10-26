#!/usr/bin/env node
// Standalone probe for the working upstream path. The account search endpoint currently answers
// 200/code=0 with no data, but /queryCard still returns the credential's own profile together
// with a real customerToken, and that token reads matches, details and ranks normally.
//
// This script proves the chain end to end without touching the server runtime, the config file,
// the database or any user job. It never prints a token, customer token or raw provider body.
//
//   node scripts/diagnostics/dashen-token-probe.mjs --config /etc/owqs/config.json
//   node scripts/diagnostics/dashen-token-probe.mjs --config <file> --tag 'Name#1234'
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://datamsapi.ds.163.com/v1/a19ld5tool';
// Fields carrying identity or secrets are reported by presence and length only.
const CARRIER_FIELDS = ['token', 'customerToken'];

export function headers(credential) {
  return {
    Accept: 'application/json',
    'GL-Bigdata-Role-Id': credential.DASHEN_ROLE_ID,
    'GL-Bigdata-Auth-Token': credential.DASHEN_TOKEN,
    'GL-Bigdata-Dts': credential.DASHEN_DTS,
    'GL-Bigdata-Server': credential.DASHEN_SERVER,
    'GL-ClientType': '60',
    Origin: 'https://act.ds.163.com',
    Referer: 'https://act.ds.163.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) app/df_client dfVersion/100111'
  };
}
/** Only shape information leaves this module; values are never included. */
export function describe(value) {
  if (value === null || value === undefined) return { kind: 'empty' };
  if (Array.isArray(value)) return { kind: 'array', length: value.length };
  if (typeof value !== 'object') return { kind: typeof value };
  return {
    kind: 'object',
    keys: Object.keys(value),
    // Presence and size, never the value itself.
    carriers: CARRIER_FIELDS.filter((key) => typeof value[key] === 'string' && value[key]).map(
      (key) => key + ':' + value[key].length + 'ch'
    )
  };
}
export function verdictOf(steps) {
  if (!steps.length) return 'no-steps';
  const failed = steps.filter((step) => !step.ok);
  if (!failed.length) return 'chain-ok';
  if (failed.some((step) => step.verdict === 'credential-rejected')) return 'credential-rejected';
  if (failed.some((step) => step.verdict === 'network-error')) return 'network-error';
  const search = steps.find((step) => step.name === 'search');
  const card = steps.find((step) => step.name === 'queryCard');
  if (search && !search.ok && search.verdict === 'empty-success' && card?.ok)
    return 'search-empty-but-card-ok';
  return 'chain-broken';
}

/**
 * One upstream call; `fetcher` is injectable so the logic stays testable.
 * `method`/`body` exist because the search endpoint only accepts a JSON body, while the
 * profile and match endpoints are plain GETs.
 */
export async function request(
  credential,
  apiPath,
  params,
  { fetcher = fetch, method = 'GET', body } = {}
) {
  const url = new URL(API + apiPath);
  for (const [key, value] of Object.entries(params || {}))
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, value);
  const started = Date.now();
  const init = {
    method,
    headers: headers(credential),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000)
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'Content-Type': 'application/json;charset=UTF-8' };
  }
  let status = 0,
    text = '';
  try {
    const response = await fetcher(url, init);
    status = response.status;
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      verdict: 'network-error',
      detail: error?.name,
      ms: Date.now() - started
    };
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  const hasData = text.includes('"data"');
  // The adapter unwraps `data` up to three levels; mirror that so shapes match production.
  let value = payload?.data;
  for (
    let i = 0;
    i < 2 && value && typeof value === 'object' && !Array.isArray(value) && value.data;
    i++
  )
    value = value.data;
  const verdict =
    status === 401 || status === 403 || payload?.code === 401 || payload?.code === 403
      ? 'credential-rejected'
      : status === 429 || payload?.code === 429
        ? 'rate-limited'
        : status !== 200
          ? 'upstream-error'
          : !hasData
            ? 'empty-success'
            : 'ok';
  return {
    ok: verdict === 'ok' && value !== undefined && value !== null,
    status,
    verdict,
    bytes: text.length,
    ms: Date.now() - started,
    code: typeof payload?.code === 'number' ? payload.code : undefined,
    shape: describe(value),
    value
  };
}

export function loadCredential(file) {
  const info = statSync(file);
  // A directory, symlink or device here would read the wrong file.
  if (!info.isFile()) throw Error('--config 必须指向普通文件');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const credential = {
    DASHEN_ROLE_ID: String(raw.DASHEN_ROLE_ID ?? raw.roleId ?? ''),
    DASHEN_TOKEN: String(raw.DASHEN_TOKEN ?? raw.token ?? ''),
    DASHEN_DTS: String(raw.DASHEN_DTS ?? raw.dts ?? ''),
    DASHEN_SERVER: String(raw.DASHEN_SERVER ?? raw.server ?? '')
  };
  for (const [key, value] of Object.entries(credential)) if (!value) throw Error('配置缺少 ' + key);
  return credential;
}
export function options(argv) {
  const parsed = { config: '', tag: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = { '--config': 'config', '--tag': 'tag' }[argv[i]];
    if (!key) continue;
    parsed[key] = argv[++i] ?? '';
  }
  return parsed;
}
export const mask = (tag) =>
  String(tag).replace(/^(.).*?(#\d+)$/, (_all, first, suffix) => first + '***' + suffix);

async function main() {
  const settings = options(process.argv.slice(2));
  if (!settings.config) {
    console.error(
      '用法: node scripts/diagnostics/dashen-token-probe.mjs --config <配置> [--tag 昵称#编号]'
    );
    process.exitCode = 2;
    return;
  }
  const credential = loadCredential(settings.config);
  console.log(
    'credential: roleId',
    credential.DASHEN_ROLE_ID,
    '| dts',
    credential.DASHEN_DTS,
    '| server',
    credential.DASHEN_SERVER,
    '| token',
    credential.DASHEN_TOKEN.length + 'ch'
  );
  const steps = [];
  const record = (name, result) => {
    steps.push({ name, ok: result.ok, verdict: result.verdict });
    console.log(
      name.padEnd(12),
      '| status',
      String(result.status).padEnd(3),
      '|',
      String(result.verdict).padEnd(13),
      '| bytes',
      String(result.bytes ?? 0).padEnd(5),
      '| ms',
      String(result.ms ?? 0).padEnd(5),
      result.shape?.keys
        ? '| keys ' + result.shape.keys.join(',')
        : result.shape?.kind
          ? '| ' + result.shape.kind
          : ''
    );
    return result;
  };

  // 1. The search endpoint that is currently broken; reported first so the failure stays visible.
  // It only accepts a JSON body, exactly as the adapter sends it.
  const tag = settings.tag || 'owqs-probe#00000';
  record(
    'search',
    await request(credential, '/searchBnetAccount', null, {
      method: 'POST',
      body: {
        name: tag,
        token: credential.DASHEN_TOKEN,
        roleId: credential.DASHEN_ROLE_ID,
        dts: credential.DASHEN_DTS,
        server: credential.DASHEN_SERVER
      }
    })
  );

  // 2. The working method: /queryCard returns the credential's own profile and a customerToken.
  const card = record(
    'queryCard',
    await request(credential, '/queryCard', {
      token: credential.DASHEN_TOKEN,
      roleId: Number(credential.DASHEN_ROLE_ID),
      dts: credential.DASHEN_DTS,
      server: credential.DASHEN_SERVER
    })
  );
  const profile = card.value || {};
  const customerToken = typeof profile.customerToken === 'string' ? profile.customerToken : '';
  if (profile.name) console.log('bound account |', mask(profile.name));
  if (!customerToken) {
    console.log('\n结论: 未能通过 /queryCard 取得 customerToken，后续链路无法验证。');
    process.exitCode = 1;
    return;
  }
  console.log('customerToken |', customerToken.length + 'ch (value withheld)');
  if (settings.tag && profile.name && profile.name.toLowerCase() !== settings.tag.toLowerCase())
    console.log('注意: 指定 ID 与凭证绑定账号不同；后续步骤仍按凭证账号执行。');

  // 3. Read the match list with the customer token taken from the profile.
  const list = record(
    'matchList',
    await request(credential, '/customer/queryMatchList', {
      token: customerToken,
      gameMode: 'leisure',
      page: 1,
      season: ''
    })
  );
  const rows = Array.isArray(list.value)
    ? list.value
    : list.value?.matchList || list.value?.recentMatchList || [];
  const matches = Array.isArray(rows) ? rows : [];
  console.log('matches       |', matches.length);

  // 4. Read one detail with the same token to prove the full query path works.
  const matchId = String(matches[0]?.matchId ?? '');
  if (matchId) {
    const detail = record(
      'matchInfo',
      await request(credential, '/customer/queryMatchInfo', {
        token: customerToken,
        matchId,
        season: ''
      })
    );
    const teammates = Array.isArray(detail.value?.teammateList)
      ? detail.value.teammateList.length
      : 0;
    const enemies = Array.isArray(detail.value?.enemyList) ? detail.value.enemyList.length : 0;
    console.log('detail        |', teammates + 'T/' + enemies + 'E');
  } else console.log('matchInfo     | skipped (no match id)');

  const verdict = verdictOf(steps);
  console.log('\n结论:', verdict);
  console.log(
    {
      'chain-ok': '凭证与 customerToken 链路完整：卡片资料可取，且该 token 能读对局列表与详情。',
      'search-empty-but-card-ok':
        '搜索接口仍是空响应，但 /queryCard + customerToken 链路可用；这正是查询回退可用的依据。',
      'credential-rejected': '凭证被上游拒绝，需要重新获取凭证。',
      'network-error': '网络不可达，凭证未被验证。',
      'chain-broken': '链路有失败步骤，请按 verdict 列定位。',
      'no-steps': '没有执行任何步骤。'
    }[verdict] || '按上面的步骤结果定位。'
  );
  if (verdict !== 'chain-ok' && verdict !== 'search-empty-but-card-ok') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || '探测失败');
    process.exitCode = 1;
  });
}
