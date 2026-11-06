import { Fault } from '../security.mjs';

export const EVENT_SOURCE = 'https://liquipedia.net/overwatch/api.php';
export const EVENT_SOURCE_VERSION = 3;
export const EVENT_LIMIT = 200;
const DAY = 86400000;
export function eventQuery(params) {
  const series = (params.get('series') || 'owcs').trim().toLowerCase();
  if (!['owcs', 'all'].includes(series)) throw new Fault('赛事范围只支持 owcs 或 all');
  const from = (params.get('from') || '').trim(),
    to = (params.get('to') || '').trim();
  for (const value of [from, to])
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
        new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)
    )
      throw new Fault('日期请使用有效的 YYYY-MM-DD');
  if (from && to && from > to) throw new Fault('开始日期不能晚于结束日期');
  if (from && to && Date.parse(to) - Date.parse(from) > 365 * DAY)
    throw new Fault('日期范围最多为 366 天，请分段查询');
  return { series, from: from && to ? from : '', to: from && to ? to : '' };
}
export function eventApi({ series = 'owcs', from = '', to = '' } = {}, limit = 50) {
  let conditions =
    series === 'owcs'
      ? ' AND [[pagename::>Overwatch_Champions_Series/]] AND [[pagename::<Overwatch_Champions_Series0]]'
      : '';
  if (from && to) {
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
      start = Date.parse(from + 'T00:00:00+08:00'),
      end = Date.parse(to + 'T00:00:00+08:00') + DAY;
    conditions +=
      ' AND ([[date::>' +
      stamp(start) +
      ']] OR [[date::' +
      stamp(start) +
      ']]) AND [[date::<' +
      stamp(end) +
      ']]';
  }
  const text = ['upcoming', 'recent']
    .map(
      (type) =>
        '<div data-filter-expansion-template="#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=' +
        type +
        '">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=' +
        type +
        (type === 'upcoming' ? '|upcoming=true|ongoing=true' : '|completed=true') +
        '|limit=' +
        limit +
        '|additionalConditions=' +
        conditions +
        '}}</div>'
    )
    .join('\n');
  // Ask HTTP caches to revalidate; this cannot force fresh Liquipedia DB/editor
  // data and intentionally does not use random URLs or bypass the shared gate.
  return (
    EVENT_SOURCE +
    '?' +
    new URLSearchParams({
      action: 'parse',
      text,
      contentmodel: 'wikitext',
      prop: 'text',
      format: 'json',
      title: 'Liquipedia:Matches',
      maxage: '0',
      smaxage: '0'
    })
  );
}
export function trackedEventApi(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Fault('赛事来源无效');
  }
  if (
    url.origin !== 'https://liquipedia.net' ||
    url.username ||
    url.password ||
    url.search ||
    !url.pathname.startsWith('/overwatch/Overwatch_Champions_Series/') ||
    !/^[A-Za-z0-9_\/-]+$/.test(url.pathname)
  )
    throw new Fault('赛事来源无效');
  const page = decodeURIComponent(url.pathname.slice('/overwatch/'.length));
  const text = ['upcoming', 'recent']
    .map(
      (type) =>
        '<div data-filter-expansion-template="type=' +
        type +
        '">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=' +
        type +
        (type === 'upcoming' ? '|upcoming=true|ongoing=true' : '|completed=true') +
        '|limit=200|additionalConditions= AND [[pagename::' +
        page +
        ']]}}</div>'
    )
    .join('\n');
  return (
    EVENT_SOURCE +
    '?' +
    new URLSearchParams({
      action: 'parse',
      text,
      contentmodel: 'wikitext',
      prop: 'text',
      format: 'json',
      title: 'Liquipedia:Matches',
      maxage: '0',
      smaxage: '0'
    })
  );
}
export function splitEventRange(range) {
  if (!range.from || range.from === range.to) return null;
  const first = Date.parse(range.from),
    last = Date.parse(range.to),
    mid = first + Math.floor((last - first) / DAY / 2) * DAY,
    date = (ms) => new Date(ms).toISOString().slice(0, 10);
  return [
    { ...range, to: date(mid) },
    { ...range, from: date(mid + DAY) }
  ];
}

// Event detail pages: one OWCS tournament (stage) page and its subpages, fetched only
// through api.php. The allowlist keeps the endpoint from proxying arbitrary wiki pages.
const DETAIL_PATH = /^Overwatch_Champions_Series\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+){0,4}$/;
const SUBPAGES =
  /\/(?:Regular_Season|Playoffs|Regional_Playoffs|Group_Stage|Main_Event|Swiss_Stage|Knockout_Stage|Play-?Ins?|Playoff)$/i;
export function detailPath(value) {
  const path = String(value || '').trim();
  if (path.length > 160 || !DETAIL_PATH.test(path)) throw new Fault('赛事页面无效');
  return path;
}
/** The tournament page a ticker match belongs to (subpages roll up to their stage). */
export function detailRoot(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.origin !== 'https://liquipedia.net' || !url.pathname.startsWith('/overwatch/'))
    return null;
  const path = decodeURIComponent(url.pathname.slice('/overwatch/'.length)).replace(SUBPAGES, '');
  try {
    return detailPath(path);
  } catch {
    return null;
  }
}
export function detailParseApi(path) {
  return (
    EVENT_SOURCE +
    '?' +
    new URLSearchParams({
      action: 'parse',
      page: detailPath(path),
      prop: 'text|links|revid',
      redirects: '1',
      disabletoc: '1',
      disableeditsection: '1',
      disablelimitreport: '1',
      format: 'json'
    })
  );
}
export function detailRevisionApi(paths) {
  return (
    EVENT_SOURCE +
    '?' +
    new URLSearchParams({
      action: 'query',
      prop: 'info',
      titles: paths.map(detailPath).join('|'),
      format: 'json',
      formatversion: '2'
    })
  );
}
