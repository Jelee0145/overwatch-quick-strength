import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
export const pluginDirectory = path.join(root, 'plugins/astrbot_plugin_owqs');
const sources = [
  'main.py',
  'owqs.py',
  'metadata.yaml',
  '_conf_schema.json',
  'requirements.txt',
  'README.md',
  '.dockerignore',
  'docker/Dockerfile',
  'docker/compose.yaml'
];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let n = 0xffffffff;
  for (const b of data) n = crcTable[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}

// Standard ZIP/deflate, with fixed timestamps and no filesystem metadata/secrets.
export function zipFiles(files) {
  const chunks = [],
    central = [];
  let offset = 0,
    size = 0;
  for (const [name, raw] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[\w./-]+$/.test(name) || name.split('/').some((p) => p === '..') || name.startsWith('/'))
      throw Error('Invalid archive path');
    const filename = Buffer.from('astrbot_plugin_owqs/' + name),
      data = Buffer.from(raw),
      packed = deflateRawSync(data),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    chunks.push(header, filename, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 8, 6, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    size += entry.length + filename.length;
    offset += header.length + filename.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

export async function buildPlugin({
  destination = pluginDirectory,
  archivePath = path.join(root, 'dist/astrbot_plugin_owqs-1.0.0.zip')
} = {}) {
  const files = new Map(
    await Promise.all(
      sources.map(async (name) => [name, await readFile(path.join(pluginDirectory, name))])
    )
  );
  const compiled = await build({
    entryPoints: [path.join(pluginDirectory, 'core/runner.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    legalComments: 'none'
  });
  files.set('runtime.mjs', compiled.outputFiles[0].contents);
  const manifest = JSON.parse(
    await readFile(path.join(root, 'source/media/manifest.json'), 'utf8')
  );
  const packaged = {
    version: manifest.version,
    avatar: manifest.avatar,
    ranks: manifest.ranks,
    maps: Object.fromEntries(
      Object.entries(manifest.maps).map(([id, m]) => [
        id,
        { name: m.name, export: m.export || null }
      ])
    )
  };
  files.set('assets/manifest.json', Buffer.from(JSON.stringify(packaged)));
  const urls = new Set(
    [
      packaged.avatar,
      ...Object.values(packaged.ranks),
      ...Object.values(packaged.maps).map((m) => m.export)
    ].filter(Boolean)
  );
  for (const url of urls) {
    if (!/^\/media\/(maps|icons)\/[a-f0-9]{20}\.webp$/.test(url))
      throw Error('Unexpected media path in manifest');
    files.set('assets' + url, await readFile(path.join(root, 'source', url.slice(1))));
  }
  for (const [name, data] of files) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    if (path.resolve(target) !== path.resolve(pluginDirectory, name)) await writeFile(target, data);
    else if (name === 'runtime.mjs' || name.startsWith('assets/')) await writeFile(target, data);
  }
  const archive = zipFiles(files);
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await writeFile(archivePath + '.sha256', sha256 + '  ' + path.basename(archivePath) + '\n');
  return { archivePath, sha256, files: files.size, bytes: archive.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(JSON.stringify(await buildPlugin()));
