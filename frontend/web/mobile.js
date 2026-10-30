'use strict';
(() => {
  const shell = window.OWQS_MOBILE,
    app = window.OWQS_APP;
  if (!shell || !app) return;
  const { media, icon, esc, openContent } = shell,
    $ = (id) => document.getElementById(id),
    results = document.querySelector('.results');
  const chart = $('chart'),
    summary = $('mobileSummary'),
    zoom = $('mobileChartDialog'),
    zoomBody = $('mobileChartBody');
  let view = null,
    currentTab = 'chart',
    selectedHero = null,
    lastMatch = null,
    zoomScale = 1,
    pan = { x: 0, y: 0 },
    pointers = new Map(),
    gesture = null,
    openedZoom = 0,
    ownedFullscreen = false,
    lockedOrientation = false;
  const tabs = document.createElement('div');
  tabs.className = 'mobile-analysis-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '分析内容');
  tabs.innerHTML = [
    ['chart', '图表'],
    ['data', '数据'],
    ['review', '锐评']
  ]
    .map(
      ([key, label]) =>
        `<button type="button" role="tab" id="mobileTab-${key}" aria-controls="mobilePage-${key}" aria-selected="${key === 'chart'}" data-tab="${key}" tabindex="${key === 'chart' ? 0 : -1}">${label}</button>`
    )
    .join('');
  const pages = {};
  for (const name of ['chart', 'data', 'review']) {
    const page = document.createElement('section');
    page.id = 'mobilePage-' + name;
    page.className = 'mobile-analysis-page';
    page.dataset.page = name;
    page.setAttribute('aria-labelledby', 'mobileTab-' + name);
    pages[name] = page;
  }
  results.prepend(tabs, pages.chart, pages.data, pages.review);
  [
    '.result-toolbar',
    '#mobileSummary',
    '.canvas-wrap',
    '.timeline-navigation',
    '#timelineScroll'
  ].forEach((selector) => {
    const node = results.querySelector(selector);
    if (node) pages.chart.append(node);
  });
  pages.chart.append(
    Object.assign(document.createElement('div'), {
      className: 'mobile-evidence-actions',
      innerHTML:
        '<button type="button" data-evidence="personal">预测依据</button><button type="button" data-evidence="estimate">本场依据</button>'
    })
  );
  for (const [page, id] of [
    [pages.data, 'mobileDataSelect'],
    [pages.review, 'mobileReviewSelect']
  ]) {
    const bar = document.createElement('div');
    bar.className = 'mobile-match-bar';
    bar.innerHTML = `<button type="button" data-step="-1" aria-label="上一场">${icon('chevron')}</button><select id="${id}" aria-label="选择场次"></select><button type="button" data-step="1" aria-label="下一场">${icon('chevron')}</button>`;
    page.append(bar);
    bar.querySelector('select').onchange = (e) => selectMatch(Number(e.target.value));
    bar
      .querySelectorAll('[data-step]')
      .forEach(
        (button) =>
          (button.onclick = () => selectMatch((view?.index || 0) + Number(button.dataset.step)))
      );
  }
  const list = document.createElement('div');
  list.id = 'mobilePlayers';
  list.className = 'mobile-player-list';
  list.setAttribute('aria-label', '本场玩家数据');
  pages.data.append(list);
  list.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    const player = event.target.closest('.mobile-player-row')?.querySelector('[data-player]');
    if (player) openHero(Number(player.dataset.player), 'data');
  });
  const dataNote = document.createElement('p');
  dataNote.className = 'mobile-data-note';
  dataNote.textContent = '点击英雄查看详细数据';
  pages.data.append(dataNote);
  const review = $('aiReviewPanel'),
    reviewMarker = document.createComment('desktop-review-position');
  review.before(reviewMarker);
  pages.review.append(review);
  const reviewEmpty = document.createElement('p');
  reviewEmpty.className = 'mobile-review-empty';
  reviewEmpty.textContent = '选择一场对局后查看锐评';
  pages.review.append(reviewEmpty);
  const placeReview = () => {
    if (media.matches) pages.review.insertBefore(review, reviewEmpty);
    else reviewMarker.after(review);
  };
  placeReview();
  const progress = document.createElement('div');
  progress.className = 'mobile-query-progress';
  progress.setAttribute('role', 'status');
  progress.hidden = true;
  results.insertBefore(progress, pages.chart);
  const syncProgress = () => {
    const running = !!app.activeJob;
    progress.hidden = !running;
    progress.textContent = running ? $('status').textContent : '';
  };
  new MutationObserver(syncProgress).observe($('status'), {
    childList: true,
    characterData: true,
    subtree: true
  });
  syncProgress();
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'mobile-chart-more';
  more.textContent = '更多';
  more.onclick = () => openContent('导出图表', [results.querySelector('.actions')]);
  results.querySelector('.chart-tools').append(more);
  document.querySelectorAll('[data-evidence]').forEach(
    (button) =>
      (button.onclick = () => {
        if (button.dataset.evidence === 'personal') {
          const node = $('personalDetail');
          openContent('个人段位预测依据', [node]);
          node.open = true;
        } else
          openContent('本场对局信息', [
            $('matchMeta'),
            $('estimateDetail'),
            document.querySelector('.game-data-note')
          ]);
      })
  );
  function setTab(name, focus = false) {
    currentTab = name;
    tabs.querySelectorAll('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    });
    for (const [key, page] of Object.entries(pages)) {
      page.classList.toggle('mobile-page-active', key === name);
      if (media.matches) {
        page.setAttribute('role', 'tabpanel');
        page.inert = key !== name;
      } else {
        page.removeAttribute('role');
        page.inert = false;
      }
    }
  }
  tabs
    .querySelectorAll('[data-tab]')
    .forEach((button) => (button.onclick = () => setTab(button.dataset.tab)));
  tabs.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const names = ['chart', 'data', 'review'],
      index = names.indexOf(currentTab);
    setTab(
      names[
        e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3
      ],
      true
    );
  };
  setTab('chart');
  function selectMatch(index) {
    if (!view?.model.matches.length) return;
    index = Math.max(0, Math.min(index, view.model.matches.length - 1));
    app.timeline.selected = view.model.matches[index].mid;
    $('matchSelect').value = String(index);
    app.showPlayers(index);
  }
  const value = (n) =>
    n === null || n === undefined
      ? '—'
      : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const grade = (p) =>
    p.performance?.grade
      ? `${esc(p.performance.grade)} <span>${p.performance.score.toFixed(1)}</span>`
      : '待评';
  function render(detail) {
    view = detail;
    const m = detail.model.matches[detail.index],
      identity = m ? detail.raw.battletag + '|' + m.mid : null;
    if (lastMatch !== identity) {
      if (heroDialog.open) heroDialog.close();
      selectedHero = null;
      list.scrollTop = 0;
    }
    lastMatch = identity;
    const s = detail.model.summary,
      personal = detail.model.personalPrediction?.selected;
    summary.innerHTML = detail.model.matches.length
      ? [
          ['强度预估', value(s.mean), s.unanchored ? '缺少段位依据' : QS.rank(s.mean)],
          [
            '个人段位预测',
            personal?.mean !== null && personal?.mean !== undefined ? personal.rank : '样本不足',
            personal ? QS.roles[personal.role] : ''
          ],
          ['预估可信度', `${s.confidencePercent ?? 0}%`, '对局证据评分']
        ]
          .map(
            ([label, note, extra]) =>
              `<div><span>${esc(label)}</span><strong>${esc(note)}</strong><small>${esc(extra)}</small></div>`
          )
          .join('')
      : '';
    for (const id of ['mobileDataSelect', 'mobileReviewSelect']) {
      const select = $(id);
      select.innerHTML = detail.model.matches.length
        ? detail.model.matches
            .map(
              (match, index) =>
                `<option value="${index}">第 ${(detail.model.windowOffset || 0) + index + 1} 场 · ${esc(QS_DATA.maps[match.mapGuid]?.name || match.mapName || '未知地图')}</option>`
            )
            .join('')
        : '<option>尚无对局</option>';
      select.value = String(detail.index);
      const bar = select.parentElement;
      bar.querySelector('[data-step="-1"]').disabled = !m || detail.index <= 0;
      bar.querySelector('[data-step="1"]').disabled =
        !m || detail.index >= detail.model.matches.length - 1;
    }
    list.innerHTML = m
      ? `<div class="mobile-player-columns"><span>玩家 / 英雄</span><span>击杀 / 助攻 / 死亡</span><span>评分</span></div>` +
        ['T', 'E']
          .map((side) => {
            const players = m.players
              .map((p, index) => ({ p, index }))
              .filter(({ p }) => p.side === side);
            return (
              `<div class="mobile-team-heading ${side === 'E' ? 'enemy' : ''}">${side === 'T' ? '我方' : '对方'}（${players.length}）</div>` +
              players
                .map(({ p, index }) => {
                  const hero = QS_DATA.heroes[p.hero],
                    src = window.QS_HERO_ICONS?.[p.hero];
                  return `<div class="mobile-player-row${p.name === detail.raw.battletag ? ' mobile-player-self' : ''}"><button class="mobile-player-open" type="button" data-player="${index}" aria-label="查看 ${esc(p.name)} ${esc(hero?.name || '未知英雄')} 的详细数据">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="mobile-avatar-fallback" aria-hidden="true">?</span>'}<span><strong>${esc(p.name)}</strong><small>${esc(hero?.name || '未知英雄')}</small></span></button><span class="mobile-kad">${value(p.stats.kill)} / ${value(p.stats.assist)} / ${value(p.stats.death)}</span><button type="button" class="mobile-player-grade grade-${esc(p.performance?.grade || 'none')}" data-rating="${index}" aria-label="查看 ${esc(p.name)} 的评分依据">${grade(p)}</button></div>`;
                })
                .join('')
            );
          })
          .join('')
      : '<div class="mobile-list-empty">输入战网昵称，查询后查看玩家数据<button type="button" class="primary" id="mobileEmptyQuery">开始查询</button></div>';
    list
      .querySelectorAll('[data-player]')
      .forEach(
        (button) => (button.onclick = () => openHero(Number(button.dataset.player), 'data'))
      );
    list
      .querySelectorAll('[data-rating]')
      .forEach(
        (button) => (button.onclick = () => openHero(Number(button.dataset.rating), 'rating'))
      );
    list.querySelectorAll('img').forEach(
      (img) =>
        (img.onerror = () => {
          img.hidden = true;
        })
    );
    $('mobileEmptyQuery')?.addEventListener('click', () => shell.run('query'));
    reviewEmpty.hidden = !!m;
    dataNote.hidden = !m;
    dataNote.textContent =
      m && !m.hasGameData ? '本场缺少部分游戏数据，点击英雄查看已有数据' : '点击英雄查看详细数据';
    $('mobileChartOpen').disabled = !chart.querySelector('svg');
    document.querySelectorAll('[data-evidence]').forEach((button) => (button.disabled = !m));
    syncProgress();
    if (selectedHero !== null && heroDialog.open) paintHero();
  }
  window.addEventListener('owqs:analysis-updated', (event) => render(event.detail));
  const heroDialog = document.createElement('dialog');
  heroDialog.id = 'mobileHeroDialog';
  heroDialog.className = 'mobile-hero-dialog';
  heroDialog.setAttribute('aria-labelledby', 'mobileHeroTitle');
  heroDialog.innerHTML = `<div class="mobile-modal-head"><div><h2 id="mobileHeroTitle"></h2><p id="mobileHeroScore"></p></div><button type="button" aria-label="关闭英雄详情">${icon('close')}</button></div><div class="mobile-hero-tabs" role="tablist" aria-label="英雄详情内容"><button id="mobileHeroDataTab" role="tab" aria-controls="mobileHeroData" aria-selected="true" type="button" data-hero-tab="data">数据</button><button id="mobileHeroRatingTab" role="tab" aria-controls="mobileHeroRating" aria-selected="false" type="button" data-hero-tab="rating">评分依据</button></div><div class="mobile-hero-content"><div id="mobileHeroData" role="tabpanel" aria-labelledby="mobileHeroDataTab"></div><div id="mobileHeroRating" role="tabpanel" aria-labelledby="mobileHeroRatingTab" hidden></div></div>`;
  document.body.append(heroDialog);
  shell.track(heroDialog);
  heroDialog.querySelector('.mobile-modal-head button').onclick = () => heroDialog.close();
  heroDialog.addEventListener('close', () => {
    selectedHero = null;
  });
  let heroTab = 'data';
  function setHeroTab(name) {
    heroTab = name;
    heroDialog.querySelectorAll('[data-hero-tab]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.heroTab === name));
      button.tabIndex = button.dataset.heroTab === name ? 0 : -1;
    });
    $('mobileHeroData').hidden = name !== 'data';
    $('mobileHeroRating').hidden = name !== 'rating';
    heroDialog.querySelector('.mobile-hero-content').scrollTop = 0;
  }
  heroDialog
    .querySelectorAll('[data-hero-tab]')
    .forEach((button) => (button.onclick = () => setHeroTab(button.dataset.heroTab)));
  heroDialog.querySelector('.mobile-hero-tabs').onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    setHeroTab(
      e.key === 'Home'
        ? 'data'
        : e.key === 'End'
          ? 'rating'
          : heroTab === 'data'
            ? 'rating'
            : 'data'
    );
    heroDialog.querySelector('[aria-selected="true"]').focus();
  };
  function paintHero() {
    const p = view?.model.matches[view.index]?.players[selectedHero];
    if (!p) return;
    const r = p.performance;
    $('mobileHeroTitle').textContent =
      p.name + ' · ' + (QS_DATA.heroes[p.hero]?.name || '未知英雄');
    $('mobileHeroScore').textContent = r?.grade
      ? `${r.grade} · ${r.score.toFixed(1)} 分`
      : '待评 · ' + (r?.reason || '缺少数据');
    const fields = [
      ['击杀', p.stats.kill],
      ['助攻', p.stats.assist],
      ['死亡', p.stats.death],
      ['最后一击', p.stats.finalHit],
      ['伤害', p.stats.heroDamage],
      ['治疗', p.stats.cure],
      ['抵挡', p.stats.resistDamage],
      ['受治疗', p.stats.healingTaken],
      ['承伤', p.stats.damageTaken]
    ];
    $('mobileHeroData').innerHTML =
      `<div class="mobile-hero-metrics">${fields.map(([label, n]) => `<div><span>${label}</span><strong>${value(n)}</strong></div>`).join('')}</div><dl class="mobile-hero-reference"><dt>参考段位</dt><dd>${p.score === null ? '—' : esc(QS.rank(p.score))}</dd><dt>强度</dt><dd>${value(p.score)}</dd></dl><p class="hint">— 表示未返回，0 表示实际为零。受治疗未拆分来源；承伤与抵挡不同。</p>`;
    // Reuse the existing rating renderer; never recompute a score in the mobile view.
    const target = $('performancePanel');
    if (r?.grade) {
      app.showPerformance(p, true);
      $('mobileHeroRating').replaceChildren(...target.childNodes);
      target.hidden = true;
      const close = $('mobileHeroRating').querySelector('#closePerformance');
      if (close) close.remove();
    } else $('mobileHeroRating').innerHTML = `<p>${esc(r?.reason || '缺少评分依据')}</p>`;
  }
  async function openHero(index, tab) {
    const current = view,
      p = current?.model.matches[current.index]?.players[index];
    if (!p) return;
    try {
      await app.ensurePlayerDetail(p);
    } catch (error) {
      $('status').textContent = error.message;
      return;
    }
    if (current !== view) return;
    selectedHero = index;
    paintHero();
    setHeroTab(tab);
    heroDialog.showModal();
  }
  const stage = document.createElement('div');
  stage.className = 'mobile-zoom-stage';
  while (zoom.firstChild) stage.append(zoom.firstChild);
  zoom.append(stage);
  zoom.querySelector('.hint')?.remove();
  zoom.querySelector('.mobile-chart-heading').prepend($('mobileChartClose'));
  $('mobileChartClose').innerHTML = icon('close');
  $('mobileChartClose').setAttribute('aria-label', '退出放大查看');
  const zoomTools = document.createElement('div');
  zoomTools.className = 'mobile-zoom-tools';
  zoomTools.innerHTML =
    '<button type="button" aria-label="缩小图表" data-zoom="out">−</button><button type="button" data-zoom="reset">适应屏幕</button><button type="button" aria-label="放大图表" data-zoom="in">＋</button>';
  stage.append(zoomTools);
  function placeZoom() {
    const portrait = innerHeight > innerWidth;
    zoom.classList.toggle('mobile-zoom-rotated', portrait);
    stage.style.width = (portrait ? innerHeight : innerWidth) + 'px';
    stage.style.height = (portrait ? innerWidth : innerHeight) + 'px';
    applyZoom();
  }
  function applyZoom() {
    const svg = zoomBody.querySelector('svg');
    if (!svg) return;
    const width = Number(svg.getAttribute('width')) || 1440,
      height = Number(svg.getAttribute('height')) || 1100;
    const scale =
      Math.min(zoomBody.clientWidth / width, zoomBody.clientHeight / height) * zoomScale;
    const maxX = Math.max(0, (width * scale - zoomBody.clientWidth) / 2),
      maxY = Math.max(0, (height * scale - zoomBody.clientHeight) / 2);
    pan.x = Math.max(-maxX, Math.min(maxX, pan.x));
    pan.y = Math.max(-maxY, Math.min(maxY, pan.y));
    svg.style.width = width + 'px';
    svg.style.height = height + 'px';
    svg.style.transform = `translate(calc(-50% + ${pan.x}px),calc(-50% + ${pan.y}px)) scale(${scale})`;
  }
  zoomTools.querySelectorAll('[data-zoom]').forEach(
    (button) =>
      (button.onclick = () => {
        zoomScale =
          button.dataset.zoom === 'reset'
            ? 1
            : Math.max(1, Math.min(5, zoomScale * (button.dataset.zoom === 'in' ? 1.4 : 1 / 1.4)));
        if (zoomScale === 1) pan = { x: 0, y: 0 };
        applyZoom();
      })
  );
  $('mobileChartOpen').onclick = async () => {
    if (!media.matches || !chart.querySelector('svg')) return;
    app.settleTimeline();
    const clone = chart.querySelector('svg').cloneNode(true);
    clone.querySelectorAll('[id]').forEach((n) => (n.id = 'mobile-' + n.id));
    clone.querySelectorAll('*').forEach((n) => {
      for (const attribute of [...n.attributes])
        if (attribute.value.includes('url(#'))
          n.setAttribute(
            attribute.name,
            attribute.value.replace(/url\(#([^)]+)\)/g, 'url(#mobile-$1)')
          );
    });
    zoomBody.replaceChildren(clone);
    zoomScale = 1;
    pan = { x: 0, y: 0 };
    pointers.clear();
    gesture = null;
    zoom.showModal();
    const session = ++openedZoom;
    document.body.classList.add('mobile-chart-fullscreen');
    placeZoom();
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        ownedFullscreen = document.fullscreenElement === document.documentElement;
        if (!zoom.open || session !== openedZoom) {
          if (!zoom.open && ownedFullscreen) {
            await document.exitFullscreen();
            ownedFullscreen = false;
          }
          return;
        }
      }
      if (screen.orientation?.lock) {
        await screen.orientation.lock('landscape');
        lockedOrientation = true;
        if (!zoom.open || session !== openedZoom) {
          if (!zoom.open) {
            screen.orientation.unlock();
            lockedOrientation = false;
          }
          return;
        }
      }
    } catch {
      /* The page-local landscape view also works without native fullscreen or orientation lock. */
    }
    if (zoom.open) placeZoom();
  };
  $('mobileChartClose').onclick = () => zoom.close();
  zoom.addEventListener('close', () => {
    openedZoom++;
    document.body.classList.remove('mobile-chart-fullscreen');
    pointers.clear();
    gesture = null;
    if (lockedOrientation) {
      screen.orientation?.unlock?.();
      lockedOrientation = false;
    }
    if (ownedFullscreen && document.fullscreenElement === document.documentElement)
      document.exitFullscreen().catch(() => {});
    ownedFullscreen = false;
  });
  document.addEventListener('fullscreenchange', () => {
    if (ownedFullscreen && document.fullscreenElement !== document.documentElement && zoom.open)
      zoom.close();
    else if (zoom.open) placeZoom();
  });
  window.addEventListener('resize', () => {
    if (zoom.open) placeZoom();
  });
  const point = (e) =>
    zoom.classList.contains('mobile-zoom-rotated')
      ? { x: e.clientY, y: -e.clientX }
      : { x: e.clientX, y: e.clientY };
  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  let dragged = false;
  zoomBody.addEventListener('pointerdown', (e) => {
    dragged = false;
    pointers.set(e.pointerId, point(e));
    zoomBody.setPointerCapture(e.pointerId);
    gesture = {
      point: point(e),
      pan: { ...pan },
      scale: zoomScale,
      distance: pointers.size === 2 ? distance() : 0,
      match: e.target.closest('[data-match]')?.dataset.match
    };
  });
  zoomBody.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const next = point(e);
    pointers.set(e.pointerId, next);
    if (pointers.size === 2 && gesture.distance) {
      zoomScale = Math.max(1, Math.min(5, (gesture.scale * distance()) / gesture.distance));
      dragged = true;
    } else {
      const dx = next.x - gesture.point.x,
        dy = next.y - gesture.point.y;
      if (Math.hypot(dx, dy) > 5) dragged = true;
      pan = { x: gesture.pan.x + dx, y: gesture.pan.y + dy };
    }
    applyZoom();
  });
  zoomBody.addEventListener('pointerup', (e) => {
    const match = gesture?.match;
    if (!dragged && pointers.size === 1 && match !== undefined) {
      selectMatch(Number(match));
      setTab('data');
      zoom.close();
    }
    pointers.delete(e.pointerId);
    const remaining = [...pointers.values()][0];
    gesture = remaining
      ? { point: remaining, pan: { ...pan }, scale: zoomScale, distance: 0 }
      : null;
  });
  zoomBody.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    gesture = null;
  });
  zoomBody.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomScale = Math.max(1, Math.min(5, zoomScale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      applyZoom();
    },
    { passive: false }
  );
  zoomBody.addEventListener('keydown', (e) => {
    if (!['Enter', ' '].includes(e.key)) return;
    const hit = e.target.closest('[data-match]');
    if (hit) {
      e.preventDefault();
      selectMatch(Number(hit.dataset.match));
      setTab('data');
      zoom.close();
    }
  });
  media.addEventListener('change', () => {
    placeReview();
    setTab(currentTab);
    if (!media.matches) {
      heroDialog.close();
      zoom.close();
    } else if (view) render(view);
  });
  const last = window.OWQS_LAST_ANALYSIS;
  if (last) render(last);
})();
