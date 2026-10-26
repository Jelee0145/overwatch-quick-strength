// Import the two adapters directly: index.mjs also re-exports the chart service, whose module sets a
// global and pulls a second copy of the renderer into the browser bundle.
import { createDataService } from '../src/services/data.mjs';
import * as historyGeometry from '../src/services/history-geometry.mjs';
// The browser keeps normalization and display helpers; scoring runs in the server application.
const data = createDataService({ normalizeSnapshot: window.QS.normalize });
window.OWQS_SERVICES = Object.freeze({ data, historyGeometry });
