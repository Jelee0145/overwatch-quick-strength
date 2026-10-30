import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
async function modules(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) result.push(...(await modules(file)));
    else if (/\.[cm]?js$/.test(file)) result.push(file);
  }
  return result;
}

test('domain modules do not depend on transport routes; services stay platform-neutral', async () => {
  const entries = (await modules('backend/src')).filter(
    (file) => !file.startsWith('backend/src/shared/')
  );
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    outdir: 'unused',
    metafile: true,
    logLevel: 'silent',
    platform: 'neutral'
  });
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    for (const dependency of info.imports) {
      const target = dependency.path;
      if (/^backend\/src\/(history|query|actors|adapters)\//.test(file))
        assert.ok(!target.startsWith('backend/src/api/'), `${file} -> ${target}`);
      if (file.startsWith('backend/src/services/'))
        assert.match(target, /^backend\/src\/(services|shared)\//, `${file} -> ${target}`);
      assert.ok(!dependency.path.startsWith('node:'), `${file} must run in Workers`);
    }
    if (file.startsWith('backend/src/services/')) {
      const source = await readFile(path.join(root, file), 'utf8');
      assert.doesNotMatch(
        source,
        /\b(?:fetch|Response|Request)\s*\(|\b(?:document|window|localStorage|sessionStorage)\s*[.[]/,
        file
      );
    }
  }
});

test('browser service graph cannot acquire backend hosts, state owners or Node builtins', async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['frontend/web/services.js'],
    bundle: true,
    write: false,
    platform: 'browser',
    metafile: true,
    logLevel: 'silent'
  });
  for (const file of Object.keys(result.metafile.inputs))
    assert.doesNotMatch(
      file,
      /^(?:backend\/server\/|backend\/src\/(?:actors|api|history|events|query|adapters|lib|http)\/)/,
      file
    );
});
