import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transform, build } from 'esbuild';
import { sharedSources } from './build-backend.mjs';
import { gitNotes } from './build/release-notes.mjs';
import { buildToolkit } from './build-toolkit.mjs';
import { buildAssetPreload } from './build/build-asset-preload.mjs';
import { buildApiCapture } from './build-api-capture.mjs';
import { rewriteCopy, cleanDecorativeEnglish } from './build/ui-copy.mjs';

// Build the browser product. App modules are concatenated in dependency order; the
// server-facing chart and algorithm stay single-source in source/.
export async function buildWeb({ base, capture = false } = {}) {
  process.umask(0o022);
  base = path.resolve(base);
  const source = path.join(base, 'source'),
    webBase = path.join(base, 'frontend/web/base'),
    pages = path.join(base, 'frontend/web/pages');
  const outputDirectory = path.resolve(base, 'public');
  if (path.dirname(outputDirectory) !== base) throw Error('Unexpected build output directory');
  for (const name of [
    'art.js',
    'data.js',
    'chart.js',
    'style.css',
    'app.js',
    'cloud.css',
    'cloud-client.js',
    'cloud-review.js',
    'login.js',
    'admin.js',
    ...sharedSources
  ]) {
    const target = path.resolve(outputDirectory, name);
    if (path.dirname(target) !== outputDirectory) throw Error('Unexpected legacy output');
    await rm(target, { force: true });
  }
  for (const name of ['assets', 'static', 'media', 'tools']) {
    const target = path.resolve(outputDirectory, name);
    if (path.dirname(target) !== outputDirectory) throw Error('Unexpected generated directory');
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(path.join(base, 'public/static'), { recursive: true });

  const noteConfig = JSON.parse(
    await readFile(path.join(base, 'frontend/web/release-notes.json'), 'utf8')
  );
  const releaseNotes = gitNotes(noteConfig.baseline, noteConfig.entries);
  await writeFile(path.join(base, 'public/release-notes.json'), JSON.stringify(releaseNotes));

  const media = JSON.parse(await readFile(path.join(source, 'media/manifest.json'), 'utf8'));
  for (const dir of ['maps', 'icons'])
    await cp(path.join(source, 'media', dir), path.join(base, 'public/media', dir), {
      recursive: true
    });

  const logo = (await readFile(path.join(base, 'frontend/web/fox.svg'), 'utf8')).trim();
  if (!logo) throw Error('Missing website logo');
  const favicon = logo
    .replace(' class="mark"', '')
    .replace('width="42" height="42"', 'width="48" height="48"')
    .replace(' aria-hidden="true"', '');
  const faviconURL =
    '/static/logo.' + createHash('sha256').update(favicon).digest('hex').slice(0, 16) + '.svg';
  await writeFile(path.join(base, 'public', faviconURL.slice(1)), favicon);

  const installHead =
    '<link rel="manifest" href="/manifest.json"><script defer src="/install.js"></script>';
  const brandPage = (page) =>
    page
      .replace(
        /<title>([^<]+)<\/title>/,
        (_, title) =>
          '<title>' +
          (/^(守望工具箱|快速强度图)/.test(title)
            ? (/英雄抽取/.test(title)
                ? '随机英雄 · '
                : '快速强度图' === title || title.includes('Quick Strength')
                  ? '对局分析 · '
                  : '') + '狸狸天眼查'
            : title.replace(/快速强度图|守望工具箱/g, '狸狸天眼查')) +
          '</title>'
      )
      .replace(/<link\b[^>]*rel="(?:shortcut )?icon"[^>]*>/g, '')
      .replace(
        '</head>',
        `<link rel="icon" type="image/svg+xml" sizes="any" href="${faviconURL}"></head>`
      );
  const withInstall = (page) => page.replace('</head>', installHead + '</head>');

  const httpClient = await readFile(path.join(base, 'frontend/web/http-client.js'), 'utf8');
  await writeFile(
    path.join(base, 'public/app-icon.svg'),
    await readFile(path.join(base, 'frontend/web/app-icon.svg'))
  );
  await writeFile(
    path.join(base, 'public/install.js'),
    (
      await transform(await readFile(path.join(base, 'frontend/web/install.js'), 'utf8'), {
        loader: 'js',
        minify: true,
        target: 'es2022'
      })
    ).code
  );
  await writeFile(
    path.join(base, 'public/event-reminders-sw.js'),
    await readFile(path.join(base, 'frontend/web/event-reminders-sw.js'))
  );
  await writeFile(
    path.join(base, 'public/manifest.json'),
    JSON.stringify({
      id: '/',
      name: '狸狸天眼查',
      short_name: '天眼查',
      description: '守望先锋对局分析、英雄抽取与赛事中心',
      lang: 'zh-CN',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#f58220',
      icons: [
        { src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
      ]
    })
  );

  const app = (
    await Promise.all([
      readFile(path.join(webBase, 'app.js'), 'utf8'),
      ...['timeline.js', 'export.js', 'query.js', 'boot.js'].map((name) =>
        readFile(path.join(base, 'frontend/web/app', name), 'utf8')
      )
    ])
  ).join('\n');
  const chart = await readFile(path.join(source, 'chart.js'), 'utf8');

  const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  async function staticFile(code, extension, name) {
    const out = (
      await transform(code, {
        loader: extension === 'css' ? 'css' : 'js',
        minify: true,
        target: 'es2022',
        ...(extension === 'css' ? {} : { format: 'iife' })
      })
    ).code;
    const url = '/static/' + name + '.' + hash(out) + '.' + extension;
    await writeFile(path.join(base, 'public', url.slice(1)), out);
    return url;
  }

  const reminderEngine = await staticFile(
    await readFile(path.join(base, 'frontend/web/event-reminders.js'), 'utf8'),
    'js',
    'event-reminders'
  );
  const extras = await staticFile(
    rewriteCopy(
      [
        await readFile(path.join(base, 'frontend/web/api-key.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/cloud-review.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/changelog.js'), 'utf8')
      ].join('\n')
    ),
    'js',
    'app-extras'
  );
  const mobile = await staticFile(
    rewriteCopy(
      [
        await readFile(path.join(base, 'frontend/web/mobile-shell.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/mobile.js'), 'utf8')
      ].join('\n')
    ),
    'js',
    'app-mobile'
  );
  const lazyLoader = await staticFile(
    (await readFile(path.join(base, 'frontend/web/lazy-loader.js'), 'utf8')).replace(
      '__OWQS_LAZY__',
      JSON.stringify({ extras, mobile, reminders: reminderEngine })
    ),
    'js',
    'lazy-loader'
  );
  const css = await staticFile(
    (await readFile(path.join(webBase, 'style.css'), 'utf8')) +
      '\n' +
      (await readFile(path.join(base, 'frontend/web/cloud.css'), 'utf8')) +
      '\n' +
      (await readFile(path.join(base, 'frontend/web/mobile-shell.css'), 'utf8')) +
      '\n' +
      (await readFile(path.join(base, 'frontend/web/mobile.css'), 'utf8')) +
      '\n' +
      (await readFile(path.join(base, 'frontend/web/event-reminders.css'), 'utf8')),
    'css',
    'app'
  );

  const browserData = await readFile(path.join(webBase, 'data.js'), 'utf8');
  const runtime = await Promise.all(
    sharedSources.map((name) => readFile(path.join(source, name), 'utf8'))
  );
  const services = await build({
    entryPoints: [path.join(base, 'frontend/web/services.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false
  });
  runtime.push(services.outputFiles[0].text);
  const smallArt =
    'window.QS_MEDIA=' +
    JSON.stringify(media) +
    ';window.QS_ART={};window.QS_AVATAR=QS_MEDIA.avatar;window.QS_RANK_ART=QS_MEDIA.ranks;';
  const main = await staticFile(
    rewriteCopy(
      [
        httpClient,
        browserData,
        ...runtime,
        smallArt,
        chart,
        await readFile(path.join(base, 'frontend/web/media-loader.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/history-model.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/cloud-history.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/cloud-cache.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/cloud-client.js'), 'utf8'),
        await readFile(path.join(base, 'frontend/web/server-analysis.js'), 'utf8'),
        app
      ].join('\n')
    ),
    'js',
    'app'
  );

  let html = await readFile(path.join(pages, 'strength.html'), 'utf8');
  const changelog = rewriteCopy(
    await readFile(path.join(base, 'frontend/web/changelog.html'), 'utf8')
  );
  const apiKey = rewriteCopy(await readFile(path.join(base, 'frontend/web/api-key.html'), 'utf8'));
  const headAssets = `<link rel="icon" type="image/svg+xml" sizes="any" href="${faviconURL}"><link rel="manifest" href="/manifest.json"><link rel="preload" as="script" href="${mobile}" media="(max-width:760px), (max-height:500px) and (pointer:coarse)"><link rel="stylesheet" href="${css}"><script defer src="${main}"></script><script defer src="${lazyLoader}"></script><script defer src="/install.js"></script>`;
  html = html
    .replaceAll('{{SITE_MARK}}', logo)
    .replace('{{CHANGELOG}}', changelog + '\n')
    .replace('{{API_KEY}}', apiKey)
    .replace('{{HEAD_ASSETS}}', headAssets);
  await mkdir(path.join(base, 'public/tools'), { recursive: true });
  await writeFile(path.join(base, 'public/tools/strength.html'), html);

  if (capture) await buildApiCapture({ base, html, app: rewriteCopy(app), css });
  await buildToolkit({
    base,
    brandPage: (page) => withInstall(brandPage(page)),
    logo,
    staticFile,
    releaseNotes,
    rewriteCopy,
    cleanDecorativeEnglish
  });
  for (const page of ['login', 'admin']) {
    let content = withInstall(
      brandPage(await readFile(path.join(base, 'frontend/web', page + '.html'), 'utf8'))
    );
    const js = await staticFile(
      rewriteCopy(
        httpClient + '\n' + (await readFile(path.join(base, 'frontend/web', page + '.js'), 'utf8'))
      ),
      'js',
      page
    );
    content = content
      .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '')
      .replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, '')
      .replace(
        '</head>',
        `<link rel="stylesheet" href="${css}"><script defer src="${js}"></script><script defer src="/install.js"></script></head>`
      );
    await writeFile(
      path.join(base, 'public', page + '.html'),
      rewriteCopy(cleanDecorativeEnglish(content))
    );
  }
  await writeFile(
    path.join(base, 'public/_headers'),
    `/release-notes.json\n  Cache-Control: no-store\n/event-reminders-sw.js\n  Cache-Control: no-store\n/static/*\n  Cache-Control: public, max-age=31536000, immutable\n/media/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`
  );
  await buildAssetPreload({ base, media, staticFile });
}
