// NetEase operates the China OWCS hub at https://ow.blizzard.cn/owcs/. Its page reads this
// unauthenticated JSON service. It publishes the *planned* time only (verified 2026-11-06:
// a match moved from 19:00 to 18:30 kept 19:00 here), so it is used solely for match state
// (0 upcoming, 1 finished, 2 in progress) and never replaces Liquipedia's schedule.
export const OFFICIAL_CN_BASE = 'https://webapi.blizzard.cn/ow-game-center-server-release-app';
const MAX_BYTES = 2 * 1024 * 1024;
const STATUS = { 0: 'scheduled', 1: 'completed', 2: 'live' };

async function getJson(fetchImpl, url, { identity, timeout }) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'OWQS-EventCenter/1.0 (' + identity + ')'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('Official schedule unavailable');
  }
  const text = await response.text();
  if (text.length > MAX_BYTES) throw Error('Official schedule too large');
  const value = JSON.parse(text);
  if (value?.code !== 0 || !value.data || typeof value.data !== 'object')
    throw Error('Official schedule rejected request');
  return value.data;
}

/** Return the latest stages of the newest season, newest last. */
export function latestStages(stages, count = 2) {
  const years = (Array.isArray(stages?.season_year_list) ? stages.season_year_list : [])
    .filter((y) => /^\d{4}$/.test(String(y?.year)) && Array.isArray(y.stage_list))
    .sort((a, b) => Number(a.year) - Number(b.year));
  const year = years.at(-1);
  if (!year) return [];
  return year.stage_list
    .map((s) => String(s?.comp_type || ''))
    .filter((type) => /^[A-Za-z0-9_-]{1,32}$/.test(type))
    .slice(-count)
    .map((compType) => ({ year: String(year.year), compType }));
}

export function normalizeOfficialCn(data) {
  const names = new Map(
    (Array.isArray(data?.team_detail_list) ? data.team_detail_list : [])
      .filter((t) => typeof t?.team_uuid === 'string' && typeof t.team_name === 'string')
      .map((t) => [t.team_uuid, t.team_name.slice(0, 80)])
  );
  return (Array.isArray(data?.match_list) ? data.match_list : []).flatMap((m) => {
    const time = Number(m?.match_time),
      status = STATUS[m?.status];
    const sides = [m?.home_team_info, m?.custom_team_info];
    if (typeof m?.match_uuid !== 'string' || !Number.isFinite(time) || !status) return [];
    return [
      {
        uuid: m.match_uuid.slice(0, 64),
        time,
        status,
        teams: sides.map((side) => names.get(side?.team_uuid) || ''),
        scores: sides.map((side) =>
          Number.isInteger(side?.team_score) && side.team_score >= 0 ? side.team_score : null
        )
      }
    ];
  });
}

export async function fetchOfficialCn(fetchImpl, { identity, timeout = 6000 } = {}) {
  if (!identity || /[\r\n]/.test(identity)) throw Error('Missing event API contact');
  const options = { identity, timeout };
  const stages = latestStages(await getJson(fetchImpl, OFFICIAL_CN_BASE + '/stage_list', options));
  if (!stages.length) throw Error('Official schedule has no stages');
  const matches = [];
  for (const { year, compType } of stages) {
    const url =
      OFFICIAL_CN_BASE +
      '/match_list?' +
      new URLSearchParams({ comp_type: compType, year, contain_unconfirmed: 'true' });
    matches.push(...normalizeOfficialCn(await getJson(fetchImpl, url, options)));
  }
  return matches;
}
