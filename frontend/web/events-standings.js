'use strict';
// Region standings beside the events list. The server only returns stored copies; regions
// still being prepared show a short note and the panel re-reads them later.
(() => {
  const $ = (id) => document.getElementById(id),
    labels = window.EventLabels;
  const LOGO = /^\/api\/v1\/events\/logos\/[a-f0-9]{64}$/;
  const KEY = 'owqs:events-standings-region';
  let value = null,
    selected = '',
    timer,
    busy = false;
  try {
    selected = localStorage.getItem(KEY) || '';
  } catch {
    /* Storage may be unavailable. */
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function team(entry) {
    const cell = element('span', 'events-standings-team'),
      slot = element('span', 'event-logo-slot');
    slot.setAttribute('aria-hidden', 'true');
    if (typeof entry?.logo === 'string' && LOGO.test(entry.logo)) {
      const image = element('img', 'event-logo');
      image.alt = '';
      image.width = 24;
      image.height = 24;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.onerror = () => image.remove();
      image.src = entry.logo;
      slot.append(image);
    }
    const name = element(
      'span',
      'events-standings-name',
      entry?.shortName || entry?.name || '待定'
    );
    if (entry?.name) name.title = entry.name;
    cell.append(slot, name);
    return cell;
  }
  const detailLink = (root, hash = '') =>
    '/tools/event.html?' + new URLSearchParams({ t: root }) + hash;
  function table(data) {
    const wrap = element('div', 'events-standings-table'),
      grid = element('table'),
      head = element('tr'),
      columns = data.columns.slice(0, 2);
    if (data.title) wrap.append(element('h3', '', labels.zh(data.title)));
    head.append(element('th', '', '#'), element('th', 'is-team', '队伍'));
    for (const column of columns)
      head.append(element('th', '', labels.COLUMNS[column] || labels.zh(column)));
    const thead = element('thead'),
      tbody = element('tbody');
    thead.append(head);
    for (const row of data.rows) {
      const tr = element('tr', row.status ? 'is-' + row.status.replace(/[^a-z]/g, '') : ''),
        place = element('td', 'is-place', row.place ?? '');
      if (labels.STATUS[row.status]) place.title = labels.STATUS[row.status];
      const name = element('td', 'is-team');
      name.append(team(row.team));
      tr.append(place, name, ...columns.map((_, i) => element('td', '', row.stats[i] ?? '')));
      tbody.append(tr);
    }
    grid.append(thead, tbody);
    wrap.append(grid);
    return wrap;
  }
  function render() {
    const tabs = $('eventsStandingsRegions'),
      body = $('eventsStandingsBody'),
      regions = value?.regions || [];
    body.setAttribute('aria-busy', 'false');
    tabs.replaceChildren();
    body.replaceChildren();
    if (!regions.length) {
      tabs.hidden = true;
      body.append(element('p', 'events-standings-empty', '近期暂无 OWCS 赛区积分'));
      return;
    }
    if (!regions.some((r) => r.root === selected)) {
      const filter = $('eventsRegion')?.value;
      selected = (
        regions.find((r) => r.region === filter) ||
        regions.find((r) => r.state === 'ready' && r.standings.length) ||
        regions[0]
      ).root;
    }
    tabs.hidden = regions.length < 2;
    for (const region of regions) {
      const button = element('button', '', region.region || labels.zh(region.title) || '赛区');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(region.root === selected));
      button.onclick = () => select(region.root);
      tabs.append(button);
    }
    const region = regions.find((r) => r.root === selected),
      heading = element(
        'a',
        'events-standings-stage',
        region.tournament || labels.zh(region.title)
      );
    heading.href = detailLink(region.root);
    body.append(heading);
    if (region.state !== 'ready') {
      body.append(
        element(
          'p',
          'events-standings-empty',
          region.stalled ? '暂时无法整理，稍后自动重试' : '正在整理积分，稍后自动显示'
        )
      );
      return;
    }
    if (!region.standings.length) {
      body.append(element('p', 'events-standings-empty', '本阶段暂无积分榜'));
    } else for (const data of region.standings) body.append(table(data));
    const more = element('a', 'events-standings-more', '完整积分榜与对阵');
    more.href = detailLink(region.root, '#standings');
    body.append(more);
  }
  function select(root) {
    selected = root;
    try {
      localStorage.setItem(KEY, root);
    } catch {
      /* Storage may be unavailable. */
    }
    render();
  }
  function later(seconds) {
    clearTimeout(timer);
    timer = null;
    if (document.visibilityState !== 'visible') return;
    timer = setTimeout(() => {
      timer = null;
      void load();
    }, seconds * 1000);
  }
  async function load() {
    if (busy) return;
    busy = true;
    try {
      value = await Cloud.api('/api/events/standings');
      render();
      // Regions still being prepared are re-read sooner; ready tables change slowly.
      later(value.regions?.some((r) => r.state !== 'ready' || r.partial) ? 60 : 300);
    } catch {
      if (!value) {
        $('eventsStandingsBody').setAttribute('aria-busy', 'false');
        $('eventsStandingsBody').replaceChildren(
          element('p', 'events-standings-empty', '积分暂不可用')
        );
      }
      later(120);
    } finally {
      busy = false;
    }
  }
  $('eventsRegion')?.addEventListener('change', () => {
    const match = value?.regions?.find((r) => r.region === $('eventsRegion').value);
    if (match) select(match.root);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !timer) void load();
    else if (document.visibilityState !== 'visible') {
      clearTimeout(timer);
      timer = null;
    }
  });
  Cloud.boot()
    .then(load)
    .catch(() => {});
})();
