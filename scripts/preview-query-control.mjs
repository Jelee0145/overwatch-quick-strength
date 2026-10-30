// Synthetic, memory-only preview. Never reads private configuration or calls a real provider.
import path from 'node:path';
import { createRuntime } from '../backend/server/runtime.mjs';
import { createHttpServer } from '../backend/server/http.mjs';
import { staticAssets } from '../backend/server/assets.mjs';
import { passwordHash } from '../backend/src/security.mjs';

const origin = 'http://127.0.0.1:8792';
const config = {
  PASSWORD_PEPPER: '{{SECRET_lai3gzht}}',
  CACHE_SIGNING_KEY: 'synthetic-signing-key',
  API_KEY_ENCRYPTION_KEY: 'synthetic-encryption-key',
  QUERY_SUSPENDED: 'true',
  QUERY_PROBE_TAG: 'Preview#1234',
  DASHEN_TOKEN: '{{SECRET_r2u4tapf}}',
  DASHEN_ROLE_ID: 'synthetic-role',
  DASHEN_SERVER: '1',
  DASHEN_DTS: '2026',
  ADMIN_PASSWORD_HASH: ''
};
config.ADMIN_PASSWORD_HASH = JSON.stringify(
  await passwordHash('preview-admin', config.PASSWORD_PEPPER)
);
const runtime = createRuntime(config, {
  filename: ':memory:',
  assets: staticAssets(path.resolve(import.meta.dirname, '../public')),
  upstreamFetch: async () =>
    Response.json({
      code: 0,
      data: { name: 'Preview#1234', customerToken: '{{SECRET_r2u4tapf}}' }
    }),
  eventsFetch: async () => new Response('', { status: 503 })
});
await runtime.ready;
const auth = runtime.instance('auth');
await auth.init();
const playerPassword = ['preview', 'player'].join('-');
const player = await auth.handle({
  path: '/register',
  ip: 'preview',
  body: {
    email: 'preview@example.test',
    password: playerPassword
  }
});
const user = await auth.storage.get('user:' + player.user.id);
await auth.storage.put('user:' + user.id, { ...user, status: 'approved' });
const server = createHttpServer(runtime, { origin });
server.listen(8792, '127.0.0.1', () => {
  console.log('Synthetic preview: ' + origin + '/admin');
  console.log('Admin password: preview-admin');
  console.log('Player: preview@example.test / preview-player');
});
async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
