import {createDataService,createAnalysisService} from '../src/services/index.mjs';
// Browser adapter: bind legacy algorithm globals only at this boundary.
const data=createDataService({normalizeSnapshot:window.QS.normalize});
const analysis=createAnalysisService({core:window.QS,performance:window.QS_PERFORMANCE,heroes:window.QS_DATA.heroes,benchmarks:window.QS_BENCHMARKS,data});
window.OWQS_SERVICES=Object.freeze({data,analysis});
