import { analysisService, dataService } from '../services/runtime.mjs';
import { heroes, maps } from '../shared/data.mjs';
import { ServiceError as Fault } from './errors.mjs';
import { statKeys } from '../services/data.mjs';

export function selectApiMatch(snapshot, index, options = {}) {
  if (!Number.isInteger(index) || index < 1 || index > 10)
    throw new Fault('编号只能是图中从左到右的 1—10');
  const raw = dataService.normalize(snapshot),
    matches = analysisService.analyzeBatch(raw, options).matches.slice(-10);
  if (index > matches.length)
    throw new Fault('本次图中只有 ' + matches.length + ' 场，请选择 1—' + matches.length);
  const match = matches[index - 1];
  return {
    raw,
    match,
    detail: projectApiMatch(raw, match, options, { index, count: matches.length })
  };
}

/** Project an already analyzed match; archive callers preserve its original batch evidence. */
export function projectApiMatch(raw, match, options = {}, { index = 1, count = 1 } = {}) {
  return {
    index,
    count,
    mid: match.mid,
    battletag: raw.battletag,
    t: match.t,
    mapName: maps[match.mapGuid]?.name || match.mapName || '未知地图',
    ret: match.ret,
    duration: match.duration,
    teamScore: match.teamScore,
    opponentScore: match.opponentScore,
    hasGameData: !!match.hasGameData,
    players: (match.combatPlayers || match.players || []).map((p) => ({
      name: p.name,
      side: p.side,
      hero: heroes[p.hero]?.name || '未知英雄',
      role: heroes[p.hero]?.roleType || p.role,
      stats: Object.fromEntries(statKeys.map((k) => [k, p.stats?.[k] ?? null])),
      performance: {
        score: p.performance?.score ?? null,
        grade: p.performance?.grade ?? null,
        coverage: p.performance?.coverage ?? null
      }
    })),
    webView: {
      raw: { battletag: raw.battletag, queriedAt: raw.queriedAt },
      options: { strategy: options.strategy || 'legacy' },
      match: {
        ...Object.fromEntries(
          [
            'mid',
            'duration',
            'teamScore',
            'opponentScore',
            'mean',
            'estimateSource',
            'estimateRange',
            'estimateDetails',
            'observedMean',
            'confidenceEvidence',
            'combatQuality',
            'hasGameData',
            'resourceDataChecked'
          ].map((k) => [k, match[k]])
        ),
        known: match.known.map(() => null),
        players: match.players.map((p) => ({
          ...Object.fromEntries(
            [
              'name',
              'side',
              'hero',
              'role',
              'score',
              'status',
              'rawScore',
              'season',
              'crossRole',
              'rankRole'
            ].map((k) => [k, p[k]])
          ),
          stats: Object.fromEntries(statKeys.map((k) => [k, p.stats?.[k] ?? null])),
          res: { rankQueriedAt: p.res?.rankQueriedAt },
          performance: p.performance
        }))
      }
    }
  };
}
