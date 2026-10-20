#!/usr/bin/env node
// Install the OWQS API plugin on the Tencent AstrBot and hot-reload it.
// Copies only the allowlisted plugin files into the existing installation, then asks
// the running AstrBot dashboard to reload just this plugin. No container restart, no
// website changes, no config rewrite.
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';

const FILES = ['main.py', 'api_client.py', 'renderer.py', 'documents.py', 'website.json', 'requirements.txt', 'metadata.yaml', '_conf_schema.json', 'README.md'];
const PLUGIN = 'astrbot_plugin_owqs_api';
const HOST = `/opt/astrbot/data/plugins/${PLUGIN}`;
const HELPER = `import json, time, urllib.request, jwt
cfg = json.load(open('/AstrBot/data/cmd_config.json', encoding='utf-8-sig'))
dash = cfg['dashboard']
token = jwt.encode({'username': dash['username'], 'exp': int(time.time()) + 120}, dash['jwt_secret'], algorithm='HS256')
request = urllib.request.Request(
    'http://127.0.0.1:6185/api/plugin/reload',
    data=json.dumps({'name': ${JSON.stringify(PLUGIN)}}).encode(),
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    method='POST',
)
with urllib.request.urlopen(request, timeout=120) as response:
    print(response.read().decode())
`;

const host = process.env.OWQS_HOST || 'tencent';
const source = path.resolve(import.meta.dirname, '..', 'plugins', PLUGIN);
const missing = FILES.filter(name => !existsSync(path.join(source, name)));
if (missing.length) {
  console.error('Missing plugin files: ' + missing.join(', '));
  process.exit(1);
}
if (process.argv.includes('--dry-run')) {
  console.log(`Would copy ${FILES.length} files to ${HOST} and hot-reload ${PLUGIN} on ${host}`);
  process.exit(0);
}
for (const name of FILES) execFileSync('scp', ['-q', path.join(source, name), `${host}:/tmp/owqs-${name}`], {stdio: 'inherit'});
const copy = FILES.map(name => `cp /tmp/owqs-${name} ${HOST}/${name}`).join(' && ');
execFileSync('ssh', [host, `${copy} && rm -rf ${HOST}/__pycache__ && rm -f ${FILES.map(name => `/tmp/owqs-${name}`).join(' ')}`], {stdio: 'inherit'});
const reload = execFileSync('ssh', [host, "docker exec -i astrbot python3 -"], {input: HELPER, encoding: 'utf8'});
console.log(reload.trim());
