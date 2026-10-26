'use strict';
(() => {
  const analysis = !!document.getElementById('chart'),
    draw = !!document.getElementById('drawStage'),
    events = document.body.classList.contains('events-page');
  if (!analysis && !document.body.classList.contains('toolkit')) return;
  const media = matchMedia('(max-width:760px), (max-height:500px) and (pointer:coarse)'),
    esc = (value) =>
      String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
      );
  const icons = {
    menu: 'M4 6h16M4 12h16M4 18h16',
    home: 'm3 10 9-7 9 7v11h-6v-7H9v7H3Z',
    analysis: 'M5 20V10M12 20V4M19 20V7',
    draw: 'm4 7 8-4 8 4v11l-8 4-8-4Zm0 0 8 4 8-4M12 11v11',
    close: 'm6 6 12 12M18 6 6 18',
    query: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
    chevron: 'm9 5 7 7-7 7'
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${icons[name] || icons.chevron}"/></svg>`;
  icons.events =
    'M8 3h8v6a4 4 0 0 1-8 0Zm0 2H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 13v6M8 21h8';
  document.body.classList.add(
    'mobile-app',
    analysis ? 'mobile-analysis' : draw ? 'mobile-draw' : events ? 'mobile-events' : 'mobile-home'
  );
  const header = document.querySelector('body>header'),
    menu = document.createElement('button');
  menu.className = 'mobile-menu-button';
  menu.type = 'button';
  menu.setAttribute('aria-label', '打开菜单');
  menu.setAttribute('aria-haspopup', 'dialog');
  menu.innerHTML = icon('menu');
  header.prepend(menu);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'mobile-header-action';
  action.textContent = analysis ? '查询' : draw ? '抽取记录' : '';
  action.hidden = !analysis && !draw;
  header.append(action);
  const nav = document.createElement('nav');
  nav.className = 'mobile-bottom-nav';
  nav.setAttribute('aria-label', '主要导航');
  nav.innerHTML = [
    ['home', '首页', '/'],
    ['analysis', '分析', '/tools/strength'],
    ['draw', '抽取', '/tools/draw'],
    ['events', '赛事', '/tools/events']
  ]
    .map(
      ([id, title, url]) =>
        `<a href="${url}"${id === (analysis ? 'analysis' : draw ? 'draw' : events ? 'events' : 'home') ? ' aria-current="page"' : ''}>${icon(id)}<span>${title}</span></a>`
    )
    .join('');
  document.body.append(nav);
  const drawer = document.createElement('dialog');
  drawer.id = 'mobileMenu';
  drawer.className = 'mobile-drawer';
  drawer.setAttribute('aria-labelledby', 'mobileMenuTitle');
  drawer.innerHTML = `<div class="mobile-modal-head"><h2 id="mobileMenuTitle">菜单</h2><button type="button" aria-label="关闭菜单">${icon('close')}</button></div><div class="mobile-drawer-account"></div><div class="mobile-drawer-links">${[
    ['query', '查询设置'],
    ['history', '历史记录'],
    ['api', 'API 管理'],
    ['changelog', '更新日志'],
    ['help', '评分说明'],
    ['logout', '退出账号']
  ]
    .map(
      ([id, label]) =>
        `<button type="button" data-menu="${id}"><span>${label}</span>${icon('chevron')}</button>`
    )
    .join('')}</div>`;
  document.body.append(drawer);
  const panel = document.createElement('dialog');
  panel.id = 'mobileContentDialog';
  panel.className = 'mobile-content-dialog';
  panel.innerHTML = `<div class="mobile-modal-head"><h2 id="mobileContentTitle"></h2><button type="button" aria-label="关闭面板">${icon('close')}</button></div><div class="mobile-content-body"></div>`;
  panel.setAttribute('aria-labelledby', 'mobileContentTitle');
  document.body.append(panel);
  let active = null,
    returnFocus = null,
    replacing = false,
    moved = [],
    serial = 0;
  const skipped = new WeakSet(),
    registered = new WeakSet();
  const restore = () => {
    for (const { node, marker } of moved) {
      marker.replaceWith(node);
    }
    moved = [];
  };
  function track(dialog) {
    if (registered.has(dialog)) return;
    registered.add(dialog);
    const original = dialog.showModal.bind(dialog);
    dialog.showModal = () => {
      if (dialog.open) return;
      if (!media.matches) {
        original();
        return;
      }
      returnFocus = document.activeElement;
      if (active?.open) {
        skipped.add(active);
        active.close();
        restore();
        replacing = true;
      }
      original();
      active = dialog;
      const state = { ...(history.state || {}), owqsModal: ++serial };
      if (replacing) {
        history.replaceState(state, '');
        replacing = false;
      } else history.pushState(state, '');
      dialog.dataset.mobileHistory = String(serial);
      document.body.classList.add('mobile-modal-open');
    };
    dialog.addEventListener('close', () => {
      if (skipped.has(dialog)) {
        skipped.delete(dialog);
        return;
      }
      if (active !== dialog) return;
      active = null;
      restore();
      document.body.classList.remove('mobile-modal-open');
      if (history.state?.owqsModal === Number(dialog.dataset.mobileHistory)) history.back();
      requestAnimationFrame(() => {
        if (!active && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
    });
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (
        e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom
      )
        dialog.close();
    });
  }
  document.querySelectorAll('dialog').forEach(track);
  menu.setAttribute('aria-controls', 'mobileMenu');
  menu.setAttribute('aria-expanded', 'false');
  drawer.addEventListener('close', () => menu.setAttribute('aria-expanded', 'false'));
  window.addEventListener('popstate', () => {
    if (active && history.state?.owqsModal !== Number(active.dataset.mobileHistory)) {
      const previous = active;
      active = null;
      skipped.add(previous);
      previous.close();
      restore();
      document.body.classList.remove('mobile-modal-open');
      returnFocus?.focus?.({ preventScroll: true });
    }
  });
  function openContent(title, nodes) {
    if (!media.matches) return;
    panel.querySelector('h2').textContent = title;
    panel.showModal();
    const container = panel.querySelector('.mobile-content-body');
    container.replaceChildren();
    for (const node of nodes.filter(Boolean)) {
      const marker = document.createComment('mobile-panel');
      node.replaceWith(marker);
      moved.push({ node, marker });
      container.append(node);
    }
    container.scrollTop = 0;
  }
  function run(name) {
    if (['query', 'history', 'help'].includes(name)) {
      if (!analysis) {
        location.href = '/tools/strength?panel=' + name;
        return;
      }
      if (name === 'query') {
        openContent('查询与图表设置', [document.querySelector('.workspace>aside')]);
        return;
      }
      if (name === 'help') {
        openContent('评分说明', [
          ...document.querySelectorAll('.results>.method:not(#personalDetail)')
        ]);
        return;
      }
    }
    const id = {
      history: 'historyOpen',
      api: 'apiKeyOpen',
      changelog: 'changelogOpen',
      logout: 'cloudLogout'
    }[name];
    const button = id && document.getElementById(id);
    if (button) {
      if (name === 'logout' && drawer.open) drawer.close();
      button.click();
    }
  }
  drawer.querySelector('.mobile-modal-head button').onclick = () => drawer.close();
  panel.querySelector('.mobile-modal-head button').onclick = () => panel.close();
  drawer
    .querySelectorAll('[data-menu]')
    .forEach((button) => (button.onclick = () => run(button.dataset.menu)));
  menu.onclick = () => {
    drawer.querySelector('.mobile-drawer-account').textContent =
      document.getElementById('cloudIdentity')?.textContent || '当前账号';
    drawer.showModal();
    menu.setAttribute('aria-expanded', 'true');
  };
  action.onclick = () =>
    analysis ? run('query') : document.getElementById('historyOpen')?.click();
  media.addEventListener('change', () => {
    if (!media.matches && active) {
      active.close();
      restore();
    }
  });
  const fitKeyboard = () => {
    const field = document.activeElement,
      editing = field?.matches('input,textarea,select'),
      height = window.visualViewport?.height;
    if (media.matches && editing && height && height < innerHeight - 80)
      document.body.style.setProperty('--mobile-viewport', height + 'px');
    else document.body.style.removeProperty('--mobile-viewport');
  };
  window.visualViewport?.addEventListener('resize', fitKeyboard);
  document.addEventListener('focusin', fitKeyboard);
  document.addEventListener('focusout', () => requestAnimationFrame(fitKeyboard));
  window.OWQS_MOBILE = { media, icon, esc, track, openContent, run };
  const requested = new URL(location.href).searchParams.get('panel');
  if (media.matches && ['query', 'history', 'help'].includes(requested)) {
    const url = new URL(location.href);
    url.searchParams.delete('panel');
    history.replaceState(history.state, '', url);
    run(requested);
  }
})();
