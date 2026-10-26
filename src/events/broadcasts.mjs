// Official destinations verified 2026-10-20. Keep URLs as an HTTPS allowlist;
// sourceUrl identifies the competition and is never used as a broadcast link.
// Twitch (EN/JP/TH) and Korea SOOP:
// https://overwatch.blizzard.com/en-us/news/24246297/
// https://overwatch.blizzard.com/en-us/news/24264002/owcs-2026-stage-1-/
// China/international Chinese coverage: Blizzard lists bilibili for OWCS Midseason:
// https://ow.blizzard.cn/owcs/news/20260716/41789_1308069.html
// Bilibili's Tokyo Major campaign explicitly names 守望先锋电竞 room 23612045:
// https://live.bilibili.com/blackboard/era/ExxPYjsLYBlh8g0T.html
const channels = {
  bilibili: {
    id: 'owcs-bilibili',
    label: '官方中文直播（B站）',
    url: 'https://live.bilibili.com/23612045',
    platform: 'bilibili'
  },
  english: {
    id: 'owcs-en',
    label: '官方英语直播（Twitch）',
    url: 'https://www.twitch.tv/ow_esports',
    platform: 'twitch'
  },
  japan: {
    id: 'owcs-jp',
    label: '官方日语直播（Twitch）',
    url: 'https://www.twitch.tv/ow_esports_jp',
    platform: 'twitch'
  },
  pacific: {
    id: 'owcs-th',
    label: '官方泰语直播（Twitch）',
    url: 'https://www.twitch.tv/ow_esports_th',
    platform: 'twitch'
  },
  korea: {
    id: 'owcs-kr',
    label: '官方韩语直播（SOOP）',
    url: 'https://www.sooplive.co.kr/station/owesports',
    platform: 'soop'
  }
};
const regions = new Map([
  ['中国', ['bilibili']],
  ['国际赛', ['bilibili', 'english']],
  ['北美', ['english']],
  ['EMEA', ['english']],
  ['日本', ['japan']],
  ['太平洋', ['pacific']],
  ['韩国', ['korea']]
]);
function isOwcs(match) {
  if (match.sourceUrl !== undefined && match.sourceUrl !== null && match.sourceUrl !== '') {
    if (typeof match.sourceUrl !== 'string') return false;
    try {
      const url = new URL(match.sourceUrl);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'liquipedia.net' &&
        !url.username &&
        !url.password &&
        !url.port &&
        /^\/overwatch\/Overwatch_Champions_Series\/[^/]/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }
  return (
    typeof match.tournament === 'string' &&
    /\bOWCS\b|\bOverwatch Champions Series\b|守望先锋冠军系列赛|守望先锋全球冠军赛/i.test(
      match.tournament
    )
  );
}

// These are official channel destinations, not a guarantee that a match is live.
// Unverified competitions/regions (including the broad 亚洲 bucket) have no link.
export function broadcastsFor(match) {
  if (!match || typeof match !== 'object' || !isOwcs(match)) return [];
  return (regions.get(match.region) || []).map((key) => ({ ...channels[key] }));
}
