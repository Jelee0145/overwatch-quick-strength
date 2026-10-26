import { ServiceError } from './errors.mjs';

export const statKeys = [
  'kill',
  'assist',
  'death',
  'heroDamage',
  'cure',
  'resistDamage',
  'finalHit',
  'soloKill',
  'targetCompetingTime',
  'healingTaken',
  'damageTaken'
];
export const nameKey = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .trim();
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
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const usableMatch = (m, name) =>
  !!(
    m?.hasGameData &&
    m.resourceDataChecked &&
    m.duration > 0 &&
    m.players?.some((p) => p.name === name)
  );

/** @typedef {{battletag?:string, matches:Array<object>, recentHistory?:Array<object>}} Snapshot */
/** Pure transformations. normalizeSnapshot is the existing cloud algorithm's normalizer. */
export function createDataService({ normalizeSnapshot } = {}) {
  function rankRows(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return [];
    if (!Array.isArray(v?.guideCountData)) throw new ServiceError('竞技职责列表异常', 502);
    return v.guideCountData.slice(0, 20).map((r) => ({
      r: text(r.roleType, 20),
      s: r.lastRankInfo?.rankScore ?? 0,
      n: text(r.lastRankInfo?.rankName, 40),
      d: num(r.lastRankInfo?.rankSubTier),
      season: ''
    }));
  }
  function matchList(v) {
    const a = Array.isArray(v) ? v : v?.matchList || v?.recentMatchList;
    if (!Array.isArray(a)) throw new ServiceError('快速对局列表异常', 502);
    return a
      .slice(0, 100)
      .map((m) => ({
        mid: text(m.matchId),
        t: num(m.beginTs) || 0,
        ret: [-1, 0, 1].includes(m.matchRet) ? m.matchRet : 0,
        mapGuid: text(m.mapGuid, 80),
        gameMode: text(m.gameMode, 40)
      }))
      .filter((m) => m.mid);
  }
  function player(p, side, { name = nameKey(text(p.name)), playerKey, res = { rows: [] } } = {}) {
    return {
      name,
      side,
      hero: text(p.heroGuid, 80),
      playerKey,
      stats: Object.fromEntries(
        statKeys.map((k) => [k, num(p[k] ?? (k === 'soloKill' ? p.soloKills : null))])
      ),
      res: structuredClone(res)
    };
  }
  function matchDetail(v, m, players, queriedAt) {
    if (!v || !('teammateList' in v || 'enemyList' in v))
      throw new ServiceError('对局详情异常', 502);
    return {
      ...structuredClone(m),
      players: structuredClone(players),
      hasGameData: true,
      resourceDataChecked: true,
      duration: num(v.gameTimeSec),
      teamScore: num(v.teamScore),
      opponentScore: num(v.opponentScore),
      dataQueriedAt: queriedAt
    };
  }
  function projectBattle(record, owner, listed) {
    if (!record || !usableMatch(record.game, owner)) return null;
    const sides = new Set(record.game.players.filter((p) => p.name === owner).map((p) => p.side)),
      sourceSides = new Set(
        record.game.players.filter((p) => p.name === record.owner).map((p) => p.side)
      );
    if (sides.size !== 1 || sourceSides.size !== 1 || !sourceSides.has('T')) return null;
    const flip = sides.has('E'),
      g = structuredClone(record.game);
    if (flip) {
      for (const p of g.players) p.side = p.side === 'T' ? 'E' : 'T';
      [g.teamScore, g.opponentScore] = [g.opponentScore, g.teamScore];
    }
    // Older artifacts carry no gameMode; fall back to the mode already stored on the battle.
    return { ...g, ...structuredClone(listed), gameMode: listed?.gameMode || g.gameMode || '' };
  }
  /** Later records win by match ID, as in the incremental query engine. */
  function mergeMatches(previous, incoming, limit = 50) {
    return structuredClone(
      [...new Map([...previous, ...incoming].map((m) => [m.mid, m])).values()]
        .sort((a, b) => b.t - a.t)
        .slice(0, limit)
    );
  }
  /** Index only; never normalize or rewrite signed batch contents. */
  function indexHistory(batches, { previous = [], limit = 500, compareIds = compare } = {}) {
    const index = new Map(previous.map((m) => [m.mid, { ...m }]));
    for (const [batchId, envelope] of Object.entries(batches)) {
      const data = envelope.content.data,
        stamp = Date.parse(data.queriedAt);
      for (const m of data.matches) {
        const mid = String(m.mid),
          old = index.get(mid);
        if (
          old &&
          (Date.parse(old.queriedAt) > stamp ||
            (Date.parse(old.queriedAt) === stamp && old.batchId >= batchId))
        )
          continue;
        index.set(mid, {
          mid,
          t: Number(m.t) || 0,
          mapGuid: m.mapGuid,
          mapName: m.mapName,
          gameMode: String(m.gameMode || ''),
          ret: m.ret,
          batchId,
          queriedAt: data.queriedAt
        });
      }
    }
    return [...index.values()].sort((a, b) => a.t - b.t || compareIds(a.mid, b.mid)).slice(-limit);
  }
  function mergeArchive(previous, envelope, batchId, scope) {
    return mergeArchiveBatches(previous, { [batchId]: envelope }, scope);
  }
  function mergeArchiveBatches(previous, incoming, scope) {
    let account = previous?.tag,
      updatedAt = previous?.updatedAt;
    for (const envelope of Object.values(incoming)) {
      const data = envelope?.content?.data;
      if (!data || !Array.isArray(data.matches) || data.matches.length > 50)
        throw Error('历史归档缺少有效查询结果');
      const name = nameKey(data.battletag);
      if (!name || (account && account !== name) || (previous && previous.scope !== scope))
        throw Error('历史归档账号或范围不一致');
      account = name;
      for (const m of data.matches)
        if (!String(m.mid) || !Array.isArray(m.players)) throw Error('历史对局数据不完整');
      if (!updatedAt || Date.parse(data.queriedAt) > Date.parse(updatedAt))
        updatedAt = data.queriedAt;
    }
    const matches = indexHistory(incoming, {
        previous: previous?.matches,
        compareIds: (a, b) => a.localeCompare(b)
      }),
      used = new Set(matches.map((m) => m.batchId));
    const batches = Object.fromEntries(
      Object.entries({ ...previous?.batches, ...incoming }).filter(([id]) => used.has(id))
    );
    return structuredClone({ version: 1, scope, tag: account, updatedAt, matches, batches });
  }
  /** @param {Snapshot} input @returns {Snapshot} Analysis view, never a signing payload. */
  function normalize(input) {
    if (!normalizeSnapshot) throw Error('缺少分析数据转换器');
    return normalizeSnapshot(structuredClone(input));
  }
  return Object.freeze({
    rankRows,
    matchList,
    player,
    matchDetail,
    projectBattle,
    mergeMatches,
    indexHistory,
    mergeArchive,
    mergeArchiveBatches,
    normalize
  });
}
