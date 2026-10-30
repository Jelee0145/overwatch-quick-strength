#!/usr/bin/env node
// In-place release for the Tencent standalone host: the repository is the
// running application (systemd WorkingDirectory and the Nginx web root both
// point at this checkout). Rollback is a git checkout plus the same command.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const run = (command, args = []) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const output = (command, args = []) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
const quiet = (command, args = []) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
function retrySync(fn, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (Date.now() >= end) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

// Build output (dist/, public/) is untracked; only tracked edits block a release.
if (output('git', ['status', '--porcelain', '--untracked-files=no']))
  throw Error('工作区有未提交改动，先提交再发布');
run('npm', ['run', 'backend:build']);
run('npm', ['run', 'web:build']);
// The service runs as the owqs user from this checkout, so source modules and the
// directories that contain them must stay readable: a 0600 file or 0700 directory
// would otherwise break the restart and leave Nginx answering 502.
run('bash', [
  '-c',
  'find public dist/backend-assets backend/src backend/server -type d -exec chmod 755 {} +; find public dist/backend-assets backend/src backend/server -type f -exec chmod 644 {} +'
]);
// Restarting into a tree the service cannot read takes the site down until someone
// notices, so prove it loads while the previous process is still serving.
const probe = path.join(root, 'backend/src/worker.mjs');
if (process.platform === 'linux' && process.getuid?.() === 0) {
  try {
    execFileSync(
      'runuser',
      [
        '-u',
        'owqs',
        '--',
        process.execPath,
        '--input-type=module',
        '-e',
        'await import(' + JSON.stringify(pathToFileURL(probe).href) + ')'
      ],
      { cwd: root, stdio: 'pipe' }
    );
  } catch {
    throw Error('服务用户无法加载 ' + probe + '，已停止发布并保留当前运行版本');
  }
}
run('systemctl', ['restart', 'owqs']);

// Nginx answers 502 for the moment between restart and the port binding.
const health = retrySync(
  () =>
    quiet('curl', [
      '--fail',
      '--silent',
      '--max-time',
      '5',
      '--resolve',
      '106.55.47.68:8443:127.0.0.1',
      'https://106.55.47.68:8443/api/health'
    ]),
  20000
);
const value = JSON.parse(health),
  revision = output('git', ['rev-parse', 'HEAD']);
if (value.revision !== revision) throw Error('线上版本与当前提交不一致：' + value.revision);

const page = output('curl', [
  '--fail',
  '--silent',
  '--show-error',
  '--max-time',
  '15',
  '--resolve',
  '106.55.47.68:8443:127.0.0.1',
  'https://106.55.47.68:8443/login'
]);
if (page !== readFileSync(path.join(root, 'public/login.html'), 'utf8'))
  throw Error('线上登录页与构建产物不一致');

// A 403 here is invisible in HTML but leaves the page stuck before it boots.
const index = readFileSync(path.join(root, 'public/index.html'), 'utf8');
for (const [, asset] of index.matchAll(/(?:src|href)="(\/(?:static|media)\/[^"?]+)"/g)) {
  const target = path.join(root, 'public', asset),
    copy = path.join('/tmp', 'owqs-asset-' + Buffer.from(asset).toString('hex').slice(-24));
  quiet('curl', [
    '--fail',
    '--silent',
    '--max-time',
    '10',
    '--resolve',
    '106.55.47.68:8443:127.0.0.1',
    '-o',
    copy,
    'https://106.55.47.68:8443' + asset
  ]);
  if (!readFileSync(copy).equals(readFileSync(target)))
    throw Error('静态资源不可读或不一致：' + asset);
}

// Timestamped so several releases in one day each keep their own rollback point.
const tag = 'deploy/' + new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
output('git', ['tag', '-f', tag, revision]);
console.log('已发布 ' + revision.slice(0, 7) + '：服务与网页均来自当前仓库目录。');
