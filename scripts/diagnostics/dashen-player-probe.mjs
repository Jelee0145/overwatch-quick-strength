#!/usr/bin/env node
// Answers one question: with the nickname search endpoint returning empty payloads, can another
// player's data still be reached through the /queryCard + customerToken path?
//
// The chain being tested:
//   1. /queryCard (credential)            -> the credential's own profile and customerToken
//   2. /customer/queryMatchList (own ct)  -> the credential's own recent matches
//   3. /customer/queryMatchInfo (own ct)  -> a match whose participants carry customerToken
//   4. /customer/queryCard (their ct)     -> a *different* player's profile
//   5. /customer/queryMatchList (their ct)-> that player's matches
//
// Step 4 and 5 are the answer. Everything is read-only, rate limited to 1 request/second and
// bounded; no names, tokens or raw bodies are printed in clear.
//
//   node scripts/diagnostics/dashen-player-probe.mjs --config /etc/owqs/config.json
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://datamsapi.ds.163.com/v1/a19ld5tool';
export const REQUEST_BUDGET = 12;

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
export const mask = (tag) =>
  String(tag || '').replace(/^(.).*?(#\d+)$/, (_all, first, suffix) => first + '***' + suffix);
/** Participant rows from a match detail, keeping only what the next step needs. */
export function participants(detail) {
  const rows = [];
  for (const [key, side] of [
    ['teammateList', 'T'],
    ['enemyList', 'E']
  ])
    for (const player of (detail?.[key] || []).slice(0, 15))
      if (player && typeof player.customerToken === 'string' && player.customerToken)
        rows.push({ name: String(player.name || ''), side, token: player.customerToken });
  return rows;
}
/** Direct token holders: a row whose token differs from the caller's own token. */
export function otherPlayers(rows, ownToken) {
  return rows.filter((player) => player.token !== ownToken);
}

export async function get(credential, apiPath, params, { fetcher = fetch } = {}) {
  const url = new URL(API + apiPath);
  for (const [key, value] of Object.entries(params || {}))
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, value);
  let status = 0,
    text = '';
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: headers(credential),
      redirect: 'manual',
      signal: AbortSignal.timeout(20000)
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    return { ok: false, status: 0, verdict: 'network-error', detail: error?.name };
  }
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
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
          : !text.includes('"data"')
            ? 'empty-success'
            : 'ok';
  return {
    ok: verdict === 'ok' && value !== undefined && value !== null,
    status,
    verdict,
    bytes: text.length,
    value
  };
}
const rowsOf = (value) =>
  Array.isArray(value) ? value : value?.matchList || value?.recentMatchList || [];

function loadCredential(file) {
  const info = statSync(file);
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

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--config');
  const file = index >= 0 ? args[index + 1] : '';
  if (!file) {
    console.error('用法: node scripts/diagnostics/dashen-player-probe.mjs --config <配置>');
    process.exitCode = 2;
    return;
  }
  const credential = loadCredential(file);
  const fetcher = (url, init) => fetch(url, init);
  // Stay far below the shared ceiling: this is a diagnostic, not a crawl.
  let used = 0;
  const call = async (label, apiPath, params) => {
    if (used >= REQUEST_BUDGET) throw Error('已达到诊断请求上限');
    if (used) await new Promise((resolve) => setTimeout(resolve, 1000));
    used++;
    const result = await get(credential, apiPath, params, { fetcher });
    console.log(
      String(used).padStart(2),
      label.padEnd(30),
      '|',
      String(result.status).padEnd(3),
      '|',
      String(result.verdict).padEnd(13),
      '| bytes',
      String(result.bytes ?? 0)
    );
    return result;
  };

  console.log(
    'credential: roleId',
    credential.DASHEN_ROLE_ID,
    '| dts',
    credential.DASHEN_DTS,
    '| token',
    credential.DASHEN_TOKEN.length + 'ch'
  );

  // 1. Own profile.
  const card = await call('queryCard (own)', '/queryCard', {
    token: credential.DASHEN_TOKEN,
    roleId: Number(credential.DASHEN_ROLE_ID),
    dts: credential.DASHEN_DTS,
    server: credential.DASHEN_SERVER
  });
  const own = card.value || {};
  const ownToken = typeof own.customerToken === 'string' ? own.customerToken : '';
  console.log(
    '   own account:',
    mask(own.name),
    '| own customerToken:',
    ownToken ? ownToken.length + 'ch' : 'missing'
  );
  if (!ownToken) {
    console.log('\n结论: 取不到本人 customerToken，无法继续。');
    process.exitCode = 1;
    return;
  }

  // 2. Own match list, so there is a match to read a detail from.
  const list = await call('matchList (own)', '/customer/queryMatchList', {
    token: ownToken,
    gameMode: 'leisure',
    page: 1,
    season: ''
  });
  const matches = rowsOf(list.value);
  const matchId = String(matches[0]?.matchId ?? '');
  console.log('   own matches:', matches.length, '| first mid:', matchId || 'none');
  if (!matchId) {
    console.log('\n结论: 本人列表为空，无法取得对局参与者。');
    process.exitCode = 1;
    return;
  }

  // 3. One detail: every participant carries its own customerToken.
  const detail = await call('matchInfo (own)', '/customer/queryMatchInfo', {
    token: ownToken,
    matchId,
    season: ''
  });
  const rows = participants(detail.value);
  const others = otherPlayers(rows, ownToken);
  console.log('   participants:', rows.length, '| with a different customerToken:', others.length);
  if (!others.length) {
    console.log('\n结论: 该对局没有可用的他人 customerToken。');
    process.exitCode = 1;
    return;
  }
  const target = others.find((player) => /^.+#\d+$/.test(player.name)) || others[0];
  console.log('   sample other player:', mask(target.name), '| token:', target.token.length + 'ch');

  // 4. THE QUESTION: does another player's customerToken open their profile?
  const otherCard = await call('queryCard (other player)', '/customer/queryCard', {
    token: target.token
  });
  const their = otherCard.value || {};
  console.log(
    '   returned name matches:',
    String(their.name || '').toLowerCase() === target.name.toLowerCase(),
    '| has customerToken:',
    typeof their.customerToken === 'string' && !!their.customerToken
  );

  // 5. ... and their matches?
  const otherList = await call('matchList (other player)', '/customer/queryMatchList', {
    token: target.token,
    gameMode: 'leisure',
    page: 1,
    season: ''
  });
  const theirMatches = rowsOf(otherList.value);

  console.log('\n=== 结论 ===');
  if (otherCard.ok && theirMatches.length)
    console.log(
      '可以：他人 customerToken 能取到其资料与对局列表（列表 ' +
        theirMatches.length +
        ' 场），无需昵称搜索。'
    );
  else if (otherCard.ok) console.log('部分可以：他人资料可取，但其对局列表为空。');
  else console.log('不可以：他人 customerToken 未能打开资料，链路到此为止。');
  console.log('请求数:', used, '/', REQUEST_BUDGET);
  if (!(otherCard.ok && theirMatches.length)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || '探测失败');
    process.exitCode = 1;
  });
}
