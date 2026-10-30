import { mkdir, readFile, writeFile, copyFile, rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
// Renderer assets are read by the unprivileged service user.
process.umask(0o022);

export const sharedSources = [
  'core.js',
  'benchmarks.js',
  'rating-rules.js',
  'resource-rating.js',
  'performance.js'
];
export function rendererMediaPaths(media) {
  const urls = new Set(
    [
      media.avatar,
      ...Object.values(media.ranks),
      ...Object.values(media.maps).flatMap((m) => [m.preview, m.export])
    ].filter(Boolean)
  );
  for (const url of urls)
    if (!/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/.test(url))
      throw Error('Unexpected renderer media path');
  return [...urls].sort();
}
export async function buildBackend({ base = path.resolve(import.meta.dirname, '..') } = {}) {
  base = path.resolve(base);
  const source = path.join(base, 'source'),
    out = path.join(base, 'backend/src');
  await mkdir(path.join(out, 'shared'), { recursive: true });
  let revision = 'local';
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: base,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {}
  await writeFile(
    path.join(out, 'release.mjs'),
    'export const release=' +
      JSON.stringify({ revision, builtAt: new Date().toISOString(), version: 'cloud-1.1.0' }) +
      ';'
  );
  const notices = await Promise.all(
    ['parse5', 'entities'].map((name) =>
      readFile(path.join(base, 'node_modules', name, 'LICENSE'), 'utf8')
    )
  );
  await build({
    stdin: { contents: "export {parseFragment} from 'parse5';", resolveDir: base },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    banner: { js: '/*! Bundled parser notices\n' + notices.join('\n\n') + '\n*/' },
    outfile: path.join(out, 'shared/events-html.mjs')
  });
  for (const file of sharedSources) {
    const code = await readFile(path.join(source, file), 'utf8');
    await writeFile(
      path.join(out, 'shared', file),
      code.replace(
        /if\s*\(typeof module\s*!==?\s*['"]undefined['"]\)\s*module\.exports\s*=[^;]+;/g,
        ''
      )
    );
  }
  const heroes = JSON.parse(await readFile(path.join(source, 'data/heroes.json'), 'utf8')),
    maps = JSON.parse(await readFile(path.join(source, 'data/maps.json'), 'utf8'));
  await writeFile(
    path.join(out, 'shared/data.mjs'),
    'export const heroes=' +
      JSON.stringify(
        Object.fromEntries(heroes.map((h) => [String(h.heroGuid), { ...h, role: h.roleType }]))
      ) +
      ';\nexport const maps=' +
      JSON.stringify(Object.fromEntries(maps.map((m) => [String(m.guid), m]))) +
      ';'
  );
  const ai = await readFile(path.join(source, 'ai_review.py'), 'utf8'),
    prompt = ai.match(/PROMPT = '''([\s\S]*?)'''/)?.[1];
  if (!prompt) throw Error('Missing review prompt');
  const knowledge = await readFile(path.join(source, 'AI锐评-游戏常识.md'), 'utf8');
  await writeFile(
    path.join(out, 'prompt.mjs'),
    'export const prompt=' +
      JSON.stringify(prompt + '\n\n' + knowledge) +
      ';export const version="1.6-cloud.1";'
  );
  const media = JSON.parse(await readFile(path.join(source, 'media/manifest.json'), 'utf8'));
  await writeFile(
    path.join(out, 'shared/media.mjs'),
    'export default ' + JSON.stringify(media) + ';'
  );
  await copyFile(path.join(source, 'chart.js'), path.join(out, 'shared/chart.mjs'));
  const dist = path.join(base, 'dist'),
    assets = path.join(dist, 'backend-assets');
  await mkdir(dist, { recursive: true });
  if ((await lstat(dist)).isSymbolicLink() || (await realpath(dist)) !== dist)
    throw Error('Invalid backend output parent');
  try {
    if ((await lstat(assets)).isSymbolicLink()) throw Error('Invalid backend assets directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (path.dirname(assets) !== dist || path.basename(assets) !== 'backend-assets')
    throw Error('Invalid backend assets output');
  // Only this dedicated generated tree is replaced; other dist artifacts belong to the user.
  await rm(assets, { recursive: true, force: true });
  for (const url of rendererMediaPaths(media)) {
    const target = path.join(assets, url.slice(1));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, url.slice(1)), target);
  }
  return { revision, assets };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildBackend();
  console.log('Backend build complete: shared modules and isolated renderer assets.');
}
