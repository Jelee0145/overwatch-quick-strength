import { createDataService } from './data.mjs';
const RANGES = new Set(['all', '5', '10', '20']),
  SIDES = new Set(['all', 'T', 'E']),
  STRATEGIES = new Set(['legacy', 'role', 'highest']),
  POOLS = new Set(['55', '66']);
/** @typedef {{side?:'all'|'T'|'E',strategy?:'legacy'|'role'|'highest',estimate?:boolean,statisticsRange?:string}} AnalysisOptions */
/** Bind the existing algorithms once; no I/O or global runtime lookups in callers. */
export function createAnalysisService({
  core,
  performance,
  heroes,
  benchmarks,
  data = createDataService({ normalizeSnapshot: core.normalize })
}) {
  const common = (options) => ({
    side: SIDES.has(options.side) ? options.side : 'all',
    strategy: STRATEGIES.has(options.strategy) ? options.strategy : 'legacy',
    estimate: options.estimate !== false,
    pool: POOLS.has(String(options.pool || '')) ? String(options.pool) : ''
  });
  const evaluate = (p, m) => performance.evaluate(p, m, heroes, benchmarks);
  const buildNormalized = (raw, options) =>
    core.build(raw, { ...common(options), limit: 50 }, heroes, evaluate);
  /** @param {import('./data.mjs').Snapshot} input @param {AnalysisOptions} options */
  function analyzeBatch(input, options = {}) {
    return buildNormalized(data.normalize(input), options);
  }
  /** Summarize already evaluated matches, preserving their original batch evidence. */
  function summarize(raw, matches, options = {}, frozenPrediction) {
    const ids = new Set(matches.map((m) => m.mid)),
      context = structuredClone({ ...raw, matches: raw.matches.filter((m) => ids.has(m.mid)) });
    return core.summarize(
      context,
      structuredClone(matches),
      { ...common(options), limit: matches.length },
      heroes,
      evaluate,
      undefined,
      structuredClone(frozenPrediction)
    );
  }
  /** Analyze each signed source batch separately before selecting historical winners. */
  function analyzeHistory(archive, options = {}) {
    const originals = new Map(),
      models = new Map(),
      histories = new Map();
    let latest = null;
    for (const [id, envelope] of Object.entries(archive.batches)) {
      const raw = data.normalize(envelope.content.data);
      originals.set(id, raw);
      models.set(id, buildNormalized(raw, options));
      if (!latest || Date.parse(raw.queriedAt) > Date.parse(latest.queriedAt)) latest = raw;
      for (const h of raw.recentHistory || []) {
        const old = histories.get(h.name);
        if (!old || Date.parse(h.queriedAt) > Date.parse(old.queriedAt)) histories.set(h.name, h);
      }
    }
    const matches = [],
      rawMatches = [],
      personalRecords = [],
      personalExcluded = [];
    for (const entry of archive.matches) {
      const raw = originals.get(entry.batchId),
        model = models.get(entry.batchId),
        m = raw?.matches.find((m) => m.mid === entry.mid),
        analyzed = model?.matches.find((m) => m.mid === entry.mid);
      if (m && analyzed) {
        rawMatches.push(m);
        matches.push(analyzed);
        const record = model.personalPrediction.byRole
          .flatMap((r) => r.records)
          .find((r) => r.mid === entry.mid);
        if (record) personalRecords.push(record);
        else {
          const excluded = model.personalPrediction.excluded.find((r) => r.mid === entry.mid);
          if (excluded) personalExcluded.push(excluded);
        }
      }
    }
    return {
      raw: {
        ...latest,
        battletag: archive.tag,
        matches: rawMatches,
        recentHistory: [...histories.values()]
      },
      matches,
      personalRecords,
      personalExcluded
    };
  }
  /** Existing Bot wire shape: latest 10 shown; statistics independently selected. */
  function analyzeResult(input, options = {}) {
    const raw = data.normalize(input),
      all = buildNormalized(raw, options).matches,
      end = all.length;
    const selection = RANGES.has(String(options.statisticsRange))
      ? String(options.statisticsRange)
      : 'all';
    const start = selection === 'all' ? 0 : Math.max(0, end - Number(selection)),
      statsMatches = all.slice(start, end),
      analysis = summarize(raw, statsMatches, options);
    const windowStart = Math.max(0, end - 10),
      chartMatches = all.slice(windowStart, end);
    return {
      version: analysis.algorithmVersion,
      options: analysis.options,
      summary: analysis.summary,
      confidence: analysis.confidence,
      personalPrediction: analysis.personalPrediction,
      matches: chartMatches,
      statsMatches,
      windowOffset: windowStart,
      displayLimit: 10,
      statisticsRange: selection,
      statisticsLabel:
        (selection === 'all' ? '全部历史' : '窗口末尾向前') + ' · ' + statsMatches.length + ' 场'
    };
  }
  return Object.freeze({
    analyzeBatch,
    analyzeHistory,
    summarize,
    analyzeResult,
    pick: (player, strategy) => core.pick(structuredClone(player), strategy, heroes)
  });
}
