(function (root) {
  'use strict';
  const cache = new Map(),
    queue = [];
  let active = 0,
    revision = 0;
  function trim() {
    if (cache.size <= 48) return;
    for (const [key, value] of cache) {
      if (cache.size <= 48) break;
      if (value.ready) cache.delete(key);
    }
  }
  function pump() {
    while (active < 4 && queue.length) {
      const job = queue.shift();
      active++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }
  function scheduled(run) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      pump();
    });
  }
  function image(url, needed = () => true) {
    if (cache.has(url)) {
      const entry = cache.get(url);
      cache.delete(url);
      cache.set(url, entry);
      if (!entry.ready) entry.needs.add(needed);
      return entry.task;
    }
    const entry = { needs: new Set([needed]), ready: false };
    const task = scheduled(async () => {
      if (![...entry.needs].some((check) => check())) throw Error('图片已不在当前图表中');
      const response = await fetch(url, {
        cache: 'force-cache',
        priority: 'high',
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/'))
        throw Error('图片读取失败');
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(Error('图片解码失败'));
        reader.readAsDataURL(blob);
      });
    });
    entry.task = task;
    cache.set(url, entry);
    task.then(
      () => {
        entry.ready = true;
        entry.needs.clear();
        trim();
      },
      () => {
        if (cache.get(url) === entry) cache.delete(url);
        entry.needs.clear();
      }
    );
    trim();
    return task;
  }
  async function render(svg, enabled) {
    const seq = ++revision;
    if (!svg || !enabled) return;
    root.dispatchEvent?.(new Event('owqs:assets-needed'));
    const needed = () => seq === revision && svg.isConnected;
    const nodes = [...svg.querySelectorAll('[data-map-art]')],
      urls = new Set(nodes.map((n) => QS_MEDIA.maps[n.dataset.mapArt]?.preview).filter(Boolean)),
      hits = [...urls].filter(
        (url) =>
          cache.get(url)?.ready ||
          nodes.some(
            (n) =>
              QS_MEDIA.maps[n.dataset.mapArt]?.preview === url &&
              n.getAttribute('href')?.startsWith('data:image/')
          )
      ).length;
    await Promise.allSettled(
      [...svg.querySelectorAll('[data-map-art]')].map(async (node) => {
        if (node.getAttribute('href')?.startsWith('data:image/')) return;
        const item = QS_MEDIA.maps[node.dataset.mapArt];
        if (!item?.preview) return;
        try {
          const uri = await image(item.preview, needed);
          if (needed()) node.setAttribute('href', uri);
        } catch {
          if (needed()) node.dataset.assetFailed = 'true';
        }
      })
    );
    if (needed()) {
      const label = document.getElementById('mapCacheStats');
      if (label)
        label.textContent =
          '地图素材 ' +
          urls.size +
          ' 份 · 会话缓存复用 ' +
          hits +
          ' 份（其余由浏览器图片缓存或 CDN 读取）';
    }
  }
  async function exportSvg(source) {
    root.dispatchEvent?.(new Event('owqs:assets-needed'));
    const clone = source.cloneNode(true),
      missing = [];
    clone.querySelectorAll('.match-hit').forEach((node) => node.remove());
    await Promise.all(
      [...clone.querySelectorAll('image')].map(async (node) => {
        const map = node.dataset.mapArt,
          item = map && QS_MEDIA.maps[map],
          href = node.getAttribute('href');
        const url = map ? item?.export : href;
        if (!url) {
          if (map) missing.push(item?.name || QS_DATA.maps[map]?.name || map);
          node.remove();
          return;
        }
        if (!map && url.startsWith('data:')) return;
        try {
          node.setAttribute('href', await image(url));
        } catch {
          missing.push(item?.name || '图标');
          node.remove();
        }
      })
    );
    clone.querySelectorAll('[data-map-art]').forEach((n) => {
      n.removeAttribute('data-map-art');
      n.removeAttribute('data-asset-failed');
    });
    return {
      blob: new Blob([new XMLSerializer().serializeToString(clone)], {
        type: 'image/svg+xml;charset=utf-8'
      }),
      missing: [...new Set(missing)]
    };
  }
  root.QS_ASSETS = { render, exportSvg, busy: () => active > 0 || queue.length > 0 };
})(window);
