import { readFile, mkdir, copyFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resetStage, artifactManifest, archiveStage } from './package-server.mjs';
const root = path.resolve(import.meta.dirname, '..');
const rootFiles = new Set([
  'index.html',
  'login.html',
  'admin.html',
  'release-notes.json',
  'manifest.json',
  'app-icon.svg',
  'install.js',
  'event-reminders-sw.js',
  '_headers'
]);
export async function stageWeb({ base = root } = {}) {
  const stage = await resetStage(base, 'web-stage'),
    source = path.join(base, 'public');
  if ((await lstat(source)).isSymbolicLink()) throw Error('Invalid public directory');
  async function copy(dir, relative = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith('.') ||
        (entry.name.startsWith('_') && name !== '_headers')
      )
        throw Error('Unexpected web package input');
      if (!relative && !rootFiles.has(name) && !['static', 'media', 'tools'].includes(name))
        throw Error('Unexpected web package root: ' + name);
      const from = path.join(dir, entry.name),
        to = path.join(stage, 'public', name);
      if (entry.isDirectory()) {
        if (!['static', 'media', 'tools'].includes(name.split('/')[0]))
          throw Error('Unexpected web directory');
        await copy(from, name);
      } else if (
        (entry.isFile() && /\.(html|js|css|json|svg|webp|png|ico)$/.test(name)) ||
        (entry.isFile() && name === '_headers')
      ) {
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
      } else throw Error('Unexpected web package file: ' + name);
    }
  }
  await copy(source);
  for (const name of [
    'index.html',
    'login.html',
    'admin.html',
    'tools/strength.html',
    'event-reminders-sw.js'
  ])
    await readFile(path.join(stage, 'public', name));
  const manifest = await artifactManifest(stage, 'web');
  return { stage, manifest };
}
export async function packageWeb({ base = root } = {}) {
  const { stage } = await stageWeb({ base });
  return archiveStage(base, stage, 'owqs-web.tar.gz');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await packageWeb();
  console.log('Web package ready: dist/owqs-web.tar.gz (' + result.bytes + ' bytes)');
}
