// Import the two adapters directly: index.mjs also re-exports the chart service, whose module sets a
// global and pulls a second copy of the renderer into the browser bundle.
import {createDataService} from '../src/services/data.mjs';
import {createAnalysisService} from '../src/services/analysis.mjs';
// Browser adapter: bind legacy algorithm globals only at this boundary.
const data=createDataService({normalizeSnapshot:window.QS.normalize});
const analysis=createAnalysisService({core:window.QS,performance:window.QS_PERFORMANCE,heroes:window.QS_DATA.heroes,benchmarks:window.QS_BENCHMARKS,data});
window.OWQS_SERVICES=Object.freeze({data,analysis});
