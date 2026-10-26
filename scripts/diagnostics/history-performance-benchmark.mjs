// Synthetic, deterministic fixtures only. Run after backend:build, with --expose-gc.
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { analysisFixture } from '../../test/services-fixture.mjs';
import {
  analyzeArchive,
  analyzeCachedArchive,
  historyComputationCache
} from '../../src/history/analysis.mjs';
import { webAnalysisView } from '../../src/history/view.mjs';

export function performanceArchive(count) {
  const fixture = analysisFixture(),
    batches = {};
  for (let offset = 0; offset < count; offset += 10) {
    const queriedAt = new Date(Date.UTC(2026, 9, 1) + offset * 60000).toISOString();
    batches['batch-' + offset] = {
      content: {
        scope: { server: 'fixture', dts: 'season', battletag: fixture.battletag },
        data: {
          ...fixture,
          queriedAt,
          matches: fixture.matches
            .slice(0, Math.min(10, count - offset))
            .map((m, i) => ({ ...m, mid: 'match-' + (offset + i), t: offset + i }))
        }
      }
    };
  }
  return { tag: fixture.battletag, batches };
}
function baseline(view) {
  const fields = [
    'mid',
    't',
    'ret',
    'duration',
    'mapGuid',
    'mapName',
    'mean',
    'observedMean',
    'estimateSource',
    'estimateRange',
    'roleRange',
    'allRoleRange',
    'allRoleScores',
    'scores',
    'confidenceEvidence'
  ];
  const out = {
    ...view,
    series: view.matches.map((m) => ({
      light: true,
      known: [],
      players: [],
      ...Object.fromEntries(fields.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]))
    })),
    matches: view.matches.slice(view.window.start, view.window.end).map((m) => {
      const copy = { ...m };
      if (m.players.length === m.combatPlayers.length) delete copy.players;
      return copy;
    }),
    model: { ...view.model },
    raw: {
      ...view.raw,
      matches: view.raw.matches.filter((m) =>
        view.matches.slice(view.window.start, view.window.end).some((w) => w.mid === m.mid)
      )
    }
  };
  delete out.chartView;
  delete out.personalRecords;
  delete out.personalExcluded;
  delete out.model.matches;
  return out;
}
const sizes = (value) => {
  const text = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(text),
    gzip: gzipSync(text).length,
    brotli: brotliCompressSync(text).length
  };
};
if (process.argv[1]?.endsWith('history-performance-benchmark.mjs')) {
  const results = [];
  for (const count of [118, 500]) {
    historyComputationCache.clear();
    const archive = performanceArchive(count),
      load = async () => archive,
      start = performance.now(),
      full = await analyzeArchive(archive, { strategy: 'role' }),
      coldMs = performance.now() - start;
    const old = sizes(baseline(full)),
      slim = sizes(webAnalysisView(full));
    await analyzeCachedArchive(
      load,
      { strategy: 'role', statisticsRange: '10' },
      'benchmark-' + count,
      { slim: true }
    );
    const windows = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now(),
        view = await analyzeCachedArchive(
          load,
          { strategy: 'role', statisticsRange: '10', start: (i * 10) % Math.max(1, count - 10) },
          'benchmark-' + count,
          { slim: true }
        );
      JSON.stringify(webAnalysisView(view));
      windows.push(performance.now() - start);
    }
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20; i++)
      await analyzeCachedArchive(
        load,
        { strategy: 'role', statisticsRange: '10', start: i * 5 },
        'benchmark-' + count,
        { slim: true }
      );
    globalThis.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    results.push({
      count,
      old,
      slim,
      coldMs: +coldMs.toFixed(1),
      windowP95Ms: +windows.sort((a, b) => a - b)[Math.ceil(windows.length * 0.95) - 1].toFixed(1),
      heapDeltaAfterSecond20Windows: heapAfter - heapBefore,
      computationCache: historyComputationCache.stats()
    });
  }
  console.log(
    JSON.stringify({ fixture: 'synthetic; no production/user archive data', results }, null, 2)
  );
}
