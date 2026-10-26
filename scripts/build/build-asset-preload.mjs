import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function buildAssetPreload({ base, media, staticFile }) {
  const pages = [
    'index.html',
    'tools/strength.html',
    'tools/draw.html',
    'tools/events.html',
    'login.html'
  ];
  const contents = await Promise.all(
    pages.map((file) => readFile(path.join(base, 'public', file), 'utf8'))
  );
  const urls = new Set(
    contents.flatMap((html) =>
      [...html.matchAll(/(?:src|href)="(\/static\/[^"?]+)"/g)].map((m) => m[1])
    )
  );
  const heroes = JSON.parse(await readFile(path.join(base, 'web/draw/heroes.json'), 'utf8'));
  for (const url of [
    media.avatar,
    ...Object.values(media.ranks),
    ...heroes.heroes.map((h) => '/media/heroes/' + h.id + '.' + h.sha256.slice(0, 16) + '.png'),
    ...Object.values(media.maps).map((m) => m.preview)
  ])
    if (url) urls.add(url);
  const assets = [];
  for (const url of urls) {
    if (
      !/^\/(?:static\/[a-z0-9-]+\.[a-f0-9]{16}\.(?:js|css|svg)|media\/(?:maps|icons)\/[a-f0-9]{20}\.webp|media\/heroes\/[a-z0-9-]+\.[a-f0-9]{16}\.png)$/.test(
        url
      )
    )
      throw Error('Invalid preload asset: ' + url);
    assets.push({ url, bytes: (await stat(path.join(base, 'public', url.slice(1)))).size });
  }
  const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16),
    plan = '/static/asset-plan.' + version + '.json';
  await writeFile(path.join(base, 'public', plan.slice(1)), JSON.stringify({ version, assets }));
  const script = await staticFile(
    (await readFile(path.join(base, 'web/asset-preload.js'), 'utf8')).replace(
      '__ASSET_PLAN_URL__',
      plan
    ),
    'js',
    'asset-preload'
  );
  for (let i = 0; i < pages.length; i++)
    await writeFile(
      path.join(base, 'public', pages[i]),
      contents[i].replace('</head>', `<script defer src="${script}"></script></head>`)
    );
}
