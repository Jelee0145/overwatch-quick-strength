import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { migrationBridge } from './migration-bridge.mjs';
import { account } from './cf-api.mjs';

const base = path.resolve(import.meta.dirname, '..'),
  backup = path.join(base, 'dist/migration-code-backup');
const script = 'quick-strength-friends',
  api = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/' + script;
const credentials = await readFile(
    path.join(base, '.private/config/.wrangler/config/default.toml'),
    'utf8'
  ),
  oauth = credentials.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if (!oauth) throw Error('Cloudflare login unavailable');
async function cf(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + oauth, ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw Error('Cloudflare API HTTP ' + response.status);
  return response;
}
const digest = (code) => createHash('sha256').update(code).digest('hex');
async function upload(modules, main) {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: main }));
  for (const [name, code] of modules)
    form.set(name, new Blob([code], { type: 'application/javascript+module' }), name);
  await cf(api + '/content', {
    method: 'PUT',
    body: form,
    headers: { 'CF-WORKER-MAIN-MODULE-PART': main }
  });
}
async function restore() {
  const original = await readFile(path.join(backup, 'worker.js'), 'utf8');
  await upload([['worker.js', original]], 'worker.js');
  await cf(api + '/secrets/OWQS_MIGRATION_KEY', { method: 'DELETE' }).catch(() => {});
  console.log('Original Cloudflare code restored');
}
if (process.argv.includes('--restore')) {
  await restore();
  process.exit(0);
}
const host = process.env.OWQS_SSH_HOST,
  keyPath = process.env.OWQS_SSH_KEY,
  origin = process.env.OWQS_PUBLIC_ORIGIN;
if (!/^root@\d+\.\d+\.\d+\.\d+$/.test(host || '') || !keyPath || !origin?.startsWith('https://'))
  throw Error('Set OWQS_SSH_HOST, OWQS_SSH_KEY and OWQS_PUBLIC_ORIGIN');
const settings = await (await cf(api + '/settings')).json();
const content = await (await cf(api)).formData();
const original = content.get('worker.js');
if (
  [...content].length !== 1 ||
  typeof original !== 'string' ||
  !original.includes('AuthDirectory') ||
  !original.includes('UserTasks')
)
  throw Error('Unexpected live Worker module layout');
await mkdir(backup, { recursive: true });
await writeFile(path.join(backup, 'worker.js'), original);
await writeFile(
  path.join(backup, 'manifest.json'),
  JSON.stringify({ sha256: digest(original), at: new Date().toISOString() })
);
const subdomain = await (
  await cf('https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/subdomain')
).json();
const cloud = 'https://' + script + '.' + subdomain.result.subdomain + '.workers.dev';
const migrationKey = randomBytes(32).toString('hex');
let installed = false;
try {
  await cf(api + '/secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'OWQS_MIGRATION_KEY', text: migrationKey, type: 'secret_text' })
  });
  installed = true;
  await upload(
    [
      ['worker.js', original],
      ['migration-entry.mjs', migrationBridge({ expiresAt: Date.now() + 15 * 60000 })]
    ],
    'migration-entry.mjs'
  );
  async function exported(op, params = {}) {
    const url = new URL('/__owqs_migration', cloud);
    url.searchParams.set('op', op);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + migrationKey },
      redirect: 'error',
      signal: AbortSignal.timeout(45000)
    });
    if (!r.ok) throw Error('Migration source HTTP ' + r.status);
    return r.json();
  }
  // Allow any previous-version query burst to finish before taking the snapshot.
  await new Promise((resolve) => setTimeout(resolve, 9000));
  const config = await exported('secrets');
  config.PUBLIC_ORIGIN = origin;
  async function namespace(op, params = {}) {
    const records = [];
    let after;
    do {
      const page = await exported(op, { ...params, ...(after ? { after } : {}) });
      records.push(...page.records);
      after = page.next;
    } while (after);
    return records;
  }
  const auth = await namespace('auth'),
    users = auth.filter(([key]) => key.startsWith('user:')).map(([, user]) => user.id);
  const namespaces = [{ ns: 'auth', records: auth }];
  for (const user of users)
    namespaces.push({ ns: 'tasks:' + user, records: await namespace('tasks', { user }) });
  const child = spawn(
    'ssh',
    ['-i', keyPath, '-o', 'BatchMode=yes', host, 'node /opt/owqs/current/server/import.mjs'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  let output = '',
    errorOutput = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (errorOutput += chunk));
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ version: 1, config, namespaces }));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) {
    const diagnostic = errorOutput
      .split('\n')
      .find((line) => line.startsWith('OWQS_MIGRATION_ERROR '));
    if (diagnostic) console.error(diagnostic);
    throw Error('Server rejected migration; source unchanged');
  }
  const summary = JSON.parse(output);
  if (!summary.imported) throw Error('Missing destination receipt');
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (installed) {
    await restore();
    const restored = await (await cf(api)).formData();
    if (digest(String(restored.get('worker.js'))) !== digest(original))
      throw Error('Cloudflare restoration checksum failed');
    const after = await (await cf(api + '/settings')).json();
    const bindingNames = (x) =>
      x.result.bindings
        .map((b) => b.name)
        .filter((n) => n !== 'OWQS_MIGRATION_KEY')
        .sort();
    if (JSON.stringify(bindingNames(settings)) !== JSON.stringify(bindingNames(after)))
      throw Error('Cloudflare bindings changed');
    console.log('Cloudflare source checksum and bindings verified');
  }
}
