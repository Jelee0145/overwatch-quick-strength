import { Fault } from '../security.mjs';

// The page only draws one ten-match window at a time, so the wire carries that window's
// detail plus a light index of the whole archive (for the strength line, the axis and the
// rank histogram). API consumers keep the documented full view.
const LIGHT = [
  'mid',
  't',
  'ret',
  'mapGuid',
  'mapName',
  'mean',
  'observedMean',
  'estimateSource',
  'estimateRange',
  'roleRange',
  'allRoleRange'
];
const light = (match) => {
  const out = { light: true, known: [], players: [] };
  for (const key of LIGHT) if (match && match[key] !== undefined) out[key] = match[key];
  return out;
};
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]])
  );
// Desktop renders all eleven stats, including final hits and resource totals. Keep them;
// the expensive rating evidence and competitive source rows are fetched on expansion.
const player = (p) => ({
  ...pick(p, ['name', 'side', 'hero', 'role', 'score', 'status', 'crossRole', 'sourceSeason']),
  stats: p.stats,
  performance: pick(p.performance, ['score', 'grade', 'coverage', 'profileName', 'reason']),
  detailPending: true
});
export const compactWebMatch = (match) => {
  if (!match) return match;
  const copy = {
    ...match,
    known: (match.known || []).map((p) => (typeof p === 'number' ? p : p.score))
  };
  const combat = match.combatPlayers || match.players || [];
  copy.combatPlayers = combat.map(player);
  // Indexes preserve side filtering without serializing a second roster.
  copy.playerIndices = (match.players || []).map((p) => combat.indexOf(p));
  if (copy.playerIndices.some((i) => i < 0))
    copy.playerIndices = (match.players || []).map((p) =>
      combat.findIndex((q) => q.name === p.name && q.side === p.side && q.hero === p.hero)
    );
  delete copy.players;
  return copy;
};

export function webAnalysisView(view) {
  const out = { ...view };
  delete out.chartView;
  // Per-match personal evidence is for API consumers; the page renders the server summary.
  delete out.personalRecords;
  delete out.personalExcluded;
  const matches = Array.isArray(view.matches) ? view.matches : [];
  const start = view.window?.start ?? 0,
    end = view.window?.end ?? matches.length;
  // One light row per analysed match keeps totals, window maths and the histogram intact.
  out.series = matches.map(light);
  // Only the visible window ships full detail; `players` is the side-filtered view of
  // `combatPlayers`, so keep one copy whenever no side filter removed anyone.
  out.matches = matches.slice(start, end).map(compactWebMatch);
  out.matchRefs = (view.matchRefs || []).slice(start, end);
  if (out.model) {
    const model = { ...out.model },
      bins = Array(45).fill(0);
    for (const match of view.model.matches || [])
      for (const score of match.scores || [])
        if (Number.isFinite(score))
          bins[Math.min(44, Math.max(0, Math.floor((score - 500) / 100)))]++;
    delete model.matches;
    model.histogram = bins;
    out.model = model;
    delete model.recentHistory;
    if (model.personalPrediction) {
      const report = {
        ...model.personalPrediction,
        byRole: model.personalPrediction.byRole.map((role) => ({
          ...role,
          records: role.records.map((record) => ({
            ...pick(record, ['mid', 'performance', 'ratio', 'value']),
            context: pick(record.context, ['base', 'quality', 'anchorNames'])
          }))
        }))
      };
      delete report.selected;
      model.personalPrediction = report;
    }
  }
  if (out.raw && Array.isArray(out.raw.matches)) {
    const ids = new Set(out.matches.map((match) => match.mid));
    out.raw = {
      ...out.raw,
      matches: out.raw.matches
        .filter((match) => ids.has(match.mid))
        .map((match) => ({
          ...pick(match, [
            'mid',
            't',
            'duration',
            'hasGameData',
            'resourceDataChecked',
            'mapGuid',
            'gameMode',
            'ret'
          ]),
          players: (match.players || []).map((p) => ({ name: p.name }))
        }))
    };
    delete out.raw.recentHistory;
    delete out.raw.queryCache;
  }
  return out;
}

export function requireSlimFlag(input) {
  if (input.slim !== undefined && typeof input.slim !== 'boolean') throw new Fault('slim 参数无效');
  return input.slim === true;
}
