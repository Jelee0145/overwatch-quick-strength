import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rendererMediaPaths } from './build-backend.mjs';

const root = path.resolve(import.meta.dirname, '..');
export async function resetStage(base, name) {
  base = path.resolve(base);
  const dist = path.join(base, 'dist'),
    stage = path.join(dist, name);
  if (!['server-stage', 'web-stage'].includes(name) || path.dirname(stage) !== dist)
    throw Error('Invalid stage directory');
  await mkdir(dist, { recursive: true });
  if ((await lstat(dist)).isSymbolicLink() || (await realpath(dist)) !== dist)
    throw Error('Invalid stage parent');
  try {
    if ((await lstat(stage)).isSymbolicLink()) throw Error('Invalid stage directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  return stage;
}
export async function copyTree(source, destination, accept) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isDirectory()) throw Error('Invalid package source tree');
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_'))
      throw Error('Hidden files are not allowed in packages');
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symlinks are not allowed in packages');
    if (entry.isDirectory()) await copyTree(from, to, accept);
    else if (entry.isFile() && accept(entry.name)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    } else throw Error('Unexpected package input: ' + entry.name);
  }
}
export async function artifactManifest(stage, kind) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const bytes = await readFile(file);
        files.push({
          path: path.relative(stage, file).split(path.sep).join('/'),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        });
      }
    }
  }
  await walk(stage);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schemaVersion: 1, kind, builtAt: new Date().toISOString(), files };
  await writeFile(
    path.join(stage, 'artifact-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  return manifest;
}
export async function archiveStage(base, stage, filename) {
  const dist = path.resolve(base, 'dist');
  if (path.dirname(stage) !== dist || !/^owqs-(server|web)\.tar\.gz$/.test(filename))
    throw Error('Invalid archive output');
  execFileSync('tar', ['-czf', filename, '-C', path.basename(stage), '.'], {
    cwd: dist,
    stdio: 'pipe'
  });
  const archive = path.join(dist, filename),
    bytes = await readFile(archive),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(archive + '.sha256', sha256 + '  ' + filename + '\n');
  return { archive, bytes: bytes.length, sha256 };
}
export async function stageBackend({ base = root } = {}) {
  const stage = await resetStage(base, 'server-stage');
  // Only executable source trees and the renderer manifest allowlist enter the backend archive.
  for (const name of ['server', 'src'])
    await copyTree(path.join(base, name), path.join(stage, name), (file) =>
      /\.(mjs|js|json)$/.test(file)
    );
  await copyFile(path.join(base, 'access-policy.json'), path.join(stage, 'access-policy.json'));
  const media = JSON.parse(await readFile(path.join(base, 'source/media/manifest.json'), 'utf8'));
  for (const url of rendererMediaPaths(media)) {
    const source = path.join(base, 'dist/backend-assets', url.slice(1));
    if ((await lstat(source)).isSymbolicLink()) throw Error('Invalid renderer media');
    const target = path.join(stage, 'backend-assets', url.slice(1));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({
      name: 'owqs-backend',
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      scripts: { start: 'node server/main.mjs' }
    })
  );
  const manifest = await artifactManifest(stage, 'backend');
  return { stage, manifest };
}
export async function packageBackend({ base = root } = {}) {
  const { stage } = await stageBackend({ base });
  // Resolve imports from the isolated package, where neither source/ nor public/ exists.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await import(' + JSON.stringify(pathToFileURL(path.join(stage, 'src/worker.mjs')).href) + ')'
    ],
    { cwd: stage, stdio: 'pipe' }
  );
  return archiveStage(base, stage, 'owqs-server.tar.gz');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await packageBackend();
  console.log('Backend package ready: dist/owqs-server.tar.gz (' + result.bytes + ' bytes)');
}
