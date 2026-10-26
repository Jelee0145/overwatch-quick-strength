// Worker/Node adapter. source/ remains the authoritative cloud algorithm snapshot.
import '../shared/core.js';
import '../shared/benchmarks.js';
import '../shared/rating-rules.js';
import '../shared/resource-rating.js';
import '../shared/performance.js';
import { heroes } from '../shared/data.mjs';
import { createDataService } from './data.mjs';
import { createAnalysisService } from './analysis.mjs';
export const dataService = createDataService({ normalizeSnapshot: globalThis.QS.normalize });
export const analysisService = createAnalysisService({
  core: globalThis.QS,
  performance: globalThis.QS_PERFORMANCE,
  heroes,
  benchmarks: globalThis.QS_BENCHMARKS,
  data: dataService
});
