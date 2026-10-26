import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// local/ -> source/ sync guardrail.
// source/ is the cloud authority; a careless sync can silently replace cloud
// algorithm changes. The default run only reports status; writing requires an
// explicit --apply --only=<file> for a single file. source/chart.js is the
// cloud-only chart authority and is not synced.

export const CATALOG = Object.freeze([
  'core.js',
  'benchmarks.js',
  'rating-rules.js',
  'resource-rating.js',
  'performance.js',
  'data/heroes.json',
  'data/maps.json',
  'ai_review.py',
  'AI锐评-游戏常识.md'
]);

export const USAGE = `Usage: node scripts/sync-local.mjs [--apply --only=<file>]

本机(local/) -> 云端(source/) 同步护栏。默认只预检，不写入任何文件。
只同步算法、数据与提示词；网页文件归 web/base/，图表以 source/chart.js 为准。

  (无参数)               列出每个文件状态（same/changed/missing/dirty）
  --apply --only=<file>  只写入指定的单个文件
  -h, --help             显示本帮助`;

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

async function tryRead(io, target) {
  try {
    return await io.readFile(target);
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const opts = { apply: false, help: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--only') {
      const value = argv[++i];
      if (!value) throw Error('--only requires exactly one file');
      opts.only = value;
    } else if (arg.startsWith('--only=')) opts.only = arg.slice('--only='.length);
    else throw Error(`unknown argument: ${arg}`);
  }
  if (opts.only !== null && !opts.only.trim()) throw Error('--only requires exactly one file');
  return opts;
}

// Pure planning step: decides statuses and the bytes to write, but never
// writes. `io` is injected so tests can avoid the real filesystem and git.
export async function planSync({ localDir, sourceDir, only = null, apply = false, io }) {
  const entries = [];
  const blockers = [];

  if (apply && !only) blockers.push('--apply requires --only=<file>');
  if (only && !CATALOG.includes(only)) blockers.push(`unknown --only target: ${only}`);

  for (const file of CATALOG) {
    if (only && file !== only) continue;

    const localPath = path.join(localDir, ...file.split('/'));
    const sourcePath = path.join(sourceDir, ...file.split('/'));
    const rec = { file, status: 'same', writable: false, blocked: false, sourcePath };
    entries.push(rec);

    const localContent = await tryRead(io, localPath);
    if (localContent === null) {
      rec.status = 'missing';
      rec.blocked = true;
      blockers.push(`local file missing: ${file}`);
      continue;
    }

    if (await io.isDirty(sourcePath)) {
      rec.status = 'dirty';
      rec.blocked = true;
      blockers.push(`source has uncommitted changes: ${file}`);
      continue;
    }

    const sourceContent = await tryRead(io, sourcePath);
    if (sourceContent === null) {
      rec.status = 'missing';
    } else {
      rec.status = normalize(sourceContent) === normalize(localContent) ? 'same' : 'changed';
    }
    rec.writable = rec.status === 'changed' || rec.status === 'missing';
    rec.content = localContent;
  }

  const differences = entries
    .filter((entry) => (entry.status === 'changed' || entry.status === 'missing') && !entry.blocked)
    .map((entry) => entry.file);
  const writes =
    apply && !blockers.length && only
      ? entries
          .filter((entry) => entry.writable)
          .map((entry) => ({ file: entry.file, path: entry.sourcePath, content: entry.content }))
      : [];
  return { entries, blockers, blocked: blockers.length > 0, differences, writes };
}

export function resolveCheckExitCode(plan) {
  return plan.blockers.length > 0 || plan.differences.length > 0 ? 1 : 0;
}

export async function applyPlan(plan, io) {
  const item = plan.writes[0];
  if (!item) return { written: [], errors: [] };
  try {
    await io.writeFile(item.path, item.content);
    return { written: [item.file], errors: [] };
  } catch (error) {
    return { written: [], errors: [{ file: item.file, message: error.message }] };
  }
}

function createRealIo({ repoRoot }) {
  return {
    readFile: (target) => readFile(target, 'utf8'),
    writeFile: (target, content) => writeFile(target, content),
    isDirty(target) {
      const relative = path.relative(repoRoot, target).split(path.sep).join('/');
      try {
        const out = execFileSync('git', ['status', '--porcelain', '--', relative], {
          cwd: repoRoot,
          encoding: 'utf8'
        });
        return out.trim().length > 0;
      } catch {
        return true;
      }
    }
  };
}

function printPlan(plan) {
  for (const entry of plan.entries) console.log(`${entry.status.padEnd(10)} ${entry.file}`);
  if (plan.blockers.length) {
    console.log('\nBlocked:');
    for (const message of plan.blockers) console.log(`  ! ${message}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(`\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const repoRoot = path.resolve(import.meta.dirname, '..');
  const io = createRealIo({ repoRoot });
  const plan = await planSync({
    localDir: path.join(repoRoot, 'local'),
    sourceDir: path.join(repoRoot, 'source'),
    only: opts.only,
    apply: opts.apply,
    io
  });
  printPlan(plan);

  if (!opts.apply) {
    process.exitCode = resolveCheckExitCode(plan);
    return;
  }
  if (plan.blocked) {
    process.exitCode = 1;
    return;
  }
  if (!plan.writes.length) {
    console.log('\nNothing to sync.');
    process.exitCode = 0;
    return;
  }

  const { written, errors } = await applyPlan(plan, io);
  if (errors.length) {
    console.log(`\nWrite failed for ${errors[0].file}: ${errors[0].message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nSynced ${written.length} file(s): ${written.join(', ')}`);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
