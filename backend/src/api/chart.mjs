import { createChartService } from '../services/chart.mjs';
import { analysisService, dataService } from '../services/runtime.mjs';
import { avatarUrl } from '../services/data.mjs';
import { maps } from '../shared/data.mjs';
import media from '../shared/media.mjs';

export function compactAnalysis(analysis) {
  const fields = [
    'version',
    'options',
    'summary',
    'confidence',
    'statisticsRange',
    'statisticsLabel',
    'windowOffset',
    'displayLimit'
  ];
  return {
    ...Object.fromEntries(fields.map((k) => [k, analysis[k]])),
    personalPrediction: { selected: analysis.personalPrediction?.selected },
    matches: analysis.matches.map((m) =>
      Object.fromEntries(
        [
          'mid',
          't',
          'ret',
          'mapName',
          'gameMode',
          'gameModeLabel',
          'hasSubstitutes',
          'mean',
          'observedMean'
        ].map((k) => [k, m[k]])
      )
    )
  };
}
/** Render only the existing latest-ten analysis; static assets never need a user's credentials. */
export async function renderApiChart(snapshot, options, assets) {
  const raw = dataService.normalize(snapshot),
    all = analysisService.analyzeBatch(raw, options),
    model = analysisService.summarize(raw, all.matches.slice(-10), options);
  return renderModel(raw.avatar ? { ...model, avatar: raw.avatar } : model, assets, {
    statisticsRange: '10'
  });
}

/** Render a server-analyzed archive view without selecting or evaluating matches again. */
export async function renderAnalysisChart(view, assets) {
  if (
    !view ||
    view.version !== 1 ||
    !view.chartView ||
    !Array.isArray(view.chartView.matches) ||
    view.chartView.matches.length > 10
  )
    throw Error('历史分析视图无效');
  return renderModel(view.chartView, assets, {
    statisticsRange: view.statisticsRange,
    revision: view.revision,
    window: view.window,
    statistics: view.statistics,
    axis: view.axis
  });
}
/** Embed the player's own portrait; any failure keeps the bundled default. */
async function portrait(src) {
  if (!avatarUrl(src)) return '';
  try {
    const response = await fetch(src, { redirect: 'manual', signal: AbortSignal.timeout(5000) }),
      type = (response.headers.get('Content-Type') || '').split(';')[0];
    if (!response.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 512 * 1024) return '';
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return 'data:' + type + ';base64,' + btoa(binary);
  } catch {
    return '';
  }
}
async function renderModel(model, assets, metadata) {
  if (!model.matches.length) return null;
  const needed = new Set(
    [
      media.avatar,
      ...Object.values(media.ranks),
      ...model.matches.map((m) => media.maps[m.mapGuid]?.export)
    ].filter(Boolean)
  );
  const embedded = new Map(),
    missing = [];
  let total = 0;
  const queue = [...needed];
  async function load() {
    while (queue.length) {
      const url = queue.shift();
      try {
        if (!/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/.test(url)) throw Error('asset path');
        const response = await assets.fetch(new Request('https://assets.internal' + url));
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/webp'))
          throw Error('asset unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 512 * 1024 || total + bytes.length > 4 * 1024 * 1024)
          throw Error('asset budget');
        total += bytes.length;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        embedded.set(url, 'data:image/webp;base64,' + btoa(binary));
      } catch {
        missing.push(url);
      }
    }
  }
  await Promise.all([
    ...Array.from({ length: Math.min(4, queue.length) }, load),
    portrait(model.avatar).then((uri) => uri && embedded.set('player', uri))
  ]);
  const art = Object.fromEntries(
    model.matches.map((m) => [m.mapGuid, embedded.get(media.maps[m.mapGuid]?.export) || ''])
  );
  const rankArt = Object.fromEntries(
    Object.entries(media.ranks).map(([rank, url]) => [rank, embedded.get(url) || ''])
  );
  const chart = createChartService({
    core: globalThis.QS,
    maps,
    avatar: embedded.get('player') || embedded.get(media.avatar) || '',
    rankArt
  });
  return {
    version: 1,
    format: 'svg',
    mimeType: 'image/svg+xml',
    width: 1440,
    height: 1100,
    displayed: model.matches.length,
    ...metadata,
    missingAssets: missing.length,
    svg: chart.render(model, { art, title: '狸狸天眼查 · 快速强度图' })
  };
}
