// Starts a synthetic Node data source on 8792 and a CF-style web proxy on 8793.
import './preview-query-control.mjs';
import path from 'node:path';
import { createHttpServer } from '../server/http.mjs';
import { staticAssets } from '../server/assets.mjs';

const origin = 'http://127.0.0.1:8793';
const runtime = {
  ready: Promise.resolve(),
  env: {
    API_ORIGIN: 'http://127.0.0.1:8792',
    ASSETS: staticAssets(path.resolve(import.meta.dirname, '../public'))
  }
};
createHttpServer(runtime, { origin }).listen(8793, '127.0.0.1', () => {
  console.log('Synthetic Cloudflare proxy: ' + origin + '/admin');
  console.log('Uses the same accounts and control state as the Node preview on port 8792.');
});
