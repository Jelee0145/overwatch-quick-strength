'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    heroes = HERO_DRAW_DATA.heroes,
    modes = { wheel: '轮盘', card: '抽卡', slot: '老虎机' },
    reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let mode = 'wheel',
    role = 'all',
    busy = false,
    ready = false,
    records = [],
    lastHero = null;
  const pool = () => HeroDrawEngine.pool(heroes, role),
    pick = () => HeroDrawEngine.pick(pool());
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  function portrait(hero) {
    const img = document.createElement('img');
    img.src = hero.portrait;
    img.alt = hero.name;
    img.draggable = false;
    img.decoding = 'async';
    return img;
  }
  function cell(hero, className) {
    const item = document.createElement('div');
    item.className = className;
    item.dataset.hero = hero.id;
    item.append(portrait(hero));
    return item;
  }
  function setCard(hero) {
    $('cardPortrait').src = hero.portrait;
    $('cardPortrait').alt = hero.name;
    $('cardName').textContent = hero.name;
    $('cardRole').textContent = hero.role;
  }
  let wheelItems = [],
    wheelStep = 1;
  function prepareWheel() {
    wheelItems = [...$('wheelTrack').children].map((item) => ({
      item,
      image: item.querySelector('img'),
      center: item.offsetLeft + item.offsetWidth / 2
    }));
    wheelStep = wheelItems.length > 1 ? wheelItems[1].center - wheelItems[0].center : 1;
  }
  function depthWheel(shift) {
    for (const { item, image, center } of wheelItems) {
      const distance = Math.abs(center + shift) / Math.max(1, wheelStep),
        scale = Math.max(0.56, 1.16 - Math.min(4, distance) * 0.15);
      image.style.transform = `translateY(${Math.min(distance, 3) * 5}px) scale(${scale})`;
      item.style.opacity = String(Math.max(0.26, 1 - distance * 0.18));
      item.style.zIndex = String(100 - Math.min(90, Math.round(distance * 10)));
    }
  }
  function centerWheel(index) {
    const item = $('wheelTrack').children[index];
    return -item.offsetLeft - item.offsetWidth / 2;
  }
  function idle() {
    const candidates = pool(),
      hero = lastHero && candidates.some((h) => h.id === lastHero.id) ? lastHero : candidates[0];
    $('poolCount').textContent = `${candidates.length} 位英雄`;
    $('stagePool').textContent = role === 'all' ? '全英雄池' : role + '英雄';
    $('wheelTrack').replaceChildren(
      ...HeroDrawEngine.sequence(candidates, 9, 4, hero).map((hero) => cell(hero, 'wheel-cell'))
    );
    prepareWheel();
    $('wheelTrack').style.transform = `translateX(${centerWheel(4)}px)`;
    depthWheel(centerWheel(4));
    $('heroCard').classList.toggle('revealed', !!lastHero);
    setCard(hero);
    $('slotTrack').replaceChildren(cell(hero, 'slot-cell'));
    $('slotTrack').style.transform = 'translateY(0)';
  }
  function lock(value) {
    busy = value;
    $('drawStage').classList.toggle('drawing', value);
    for (const button of document.querySelectorAll(
      'button[data-mode],[data-role],#drawButton,#clearDrawHistory'
    ))
      button.disabled = value || !ready;
    $('drawButton').firstElementChild.textContent = value ? '正在抽取…' : '再抽一次';
  }
  async function animate(node, from, to, duration) {
    const animation = node.animate([{ transform: from }, { transform: to }], {
      duration: reduced.matches ? 140 : duration,
      easing: 'cubic-bezier(.10,.78,.16,1)',
      fill: 'forwards'
    });
    let frame;
    const update = () => {
      depthWheel(new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
      frame = requestAnimationFrame(update);
    };
    if (node.id === 'wheelTrack') update();
    try {
      await animation.finished;
      node.style.transform = to;
    } finally {
      if (frame) cancelAnimationFrame(frame);
      animation.cancel();
      if (node.id === 'wheelTrack')
        depthWheel(new DOMMatrixReadOnly(getComputedStyle(node).transform).m41);
    }
  }
  async function runWheel(hero) {
    const track = $('wheelTrack'),
      sequence = HeroDrawEngine.sequence(pool(), 36, 32, hero).map((hero) =>
        cell(hero, 'wheel-cell')
      );
    track.replaceChildren(...sequence);
    prepareWheel();
    await animate(
      track,
      `translateX(${centerWheel(3)}px)`,
      `translateX(${centerWheel(32)}px)`,
      2600
    );
    prepareWheel();
    track.style.transform = `translateX(${centerWheel(32)}px)`;
    depthWheel(centerWheel(32));
    sequence[32].classList.add('picked');
  }
  async function runCard(hero) {
    const card = $('heroCard');
    card.classList.remove('revealed');
    card.classList.add('card-dealing');
    await wait(reduced.matches ? 100 : 500);
    setCard(hero);
    card.classList.remove('card-dealing');
    card.classList.add('revealed');
    await wait(reduced.matches ? 120 : 650);
  }
  async function runSlot(hero) {
    const sides = [...document.querySelectorAll('.slot-emblem')];
    await Promise.all(
      [...sides.slice(0, 1), $('slotTrack'), ...sides.slice(1)].map(async (target, column) => {
        const track = column === 1 ? target : document.createElement('div'),
          stop = 24 + column * 2,
          sequence = Array.from({ length: stop + 3 }, () => cell(pick(), 'slot-cell'));
        if (column === 1) sequence[stop] = cell(hero, 'slot-cell');
        else {
          const emblem = document.createElement('div');
          emblem.className = 'slot-cell';
          emblem.append(target.querySelector('.ow-mark').cloneNode(true));
          sequence[stop] = emblem;
          target.replaceChildren(track);
        }
        track.replaceChildren(...sequence);
        const height = sequence[0].getBoundingClientRect().height;
        await animate(
          track,
          'translateY(0)',
          `translateY(${-stop * height}px)`,
          2100 + column * 200
        );
        track.style.transform = `translateY(${-stop * sequence[stop].getBoundingClientRect().height}px)`;
        sequence[stop].classList.add('picked');
        if (column !== 1) target.replaceChildren(sequence[stop].firstElementChild);
      })
    );
  }
  function history() {
    $('historyCount').textContent = records.length;
    $('historyEmpty').hidden = records.length > 0;
    $('clearDrawHistory').disabled = busy || !records.length;
    $('drawHistoryList').replaceChildren(
      ...records.map((record) => {
        const hero = heroes.find((h) => h.id === record.hero),
          item = document.createElement('li'),
          content = document.createElement('div'),
          name = document.createElement('strong'),
          detail = document.createElement('small');
        name.textContent = hero.name;
        detail.textContent = `${hero.role} · ${modes[record.mode] || '抽取'} · ${new Date(record.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
        content.append(name, detail);
        item.append(portrait(hero), content);
        return item;
      })
    );
  }
  async function draw() {
    if (busy || !ready) return;
    lock(true);
    $('drawStage').classList.remove('has-result');
    $('resultHint').textContent = '';
    $('resultName').textContent = '';
    $('resultRole').textContent = '';
    let hero;
    try {
      await Cloud.verify();
      hero = pick();
      const preload = new Image();
      preload.src = hero.portrait;
      await preload.decode().catch(() => {});
      await { wheel: runWheel, card: runCard, slot: runSlot }[mode](hero);
      lastHero = hero;
      $('drawStage').classList.add('has-result');
      $('resultHint').textContent = '';
      $('resultName').textContent = hero.name;
      $('resultRole').textContent = hero.role;
      records = [{ hero: hero.id, mode, at: new Date().toISOString() }, ...records].slice(0, 50);
      try {
        await Cloud.storage('hero-draw-history', records);
      } catch {
        $('resultHint').textContent = '已抽中，记录保存失败';
      }
      history();
    } catch (error) {
      $('resultHint').textContent = error.message;
      if (hero) idle();
    } finally {
      lock(false);
      history();
    }
  }
  function switchMode(next) {
    if (busy || !ready) return;
    lastHero = null;
    $('resultHint').textContent = '';
    $('resultName').textContent = '';
    $('resultRole').textContent = '';
    $('drawStage').classList.remove('has-result');
    $('drawButton').firstElementChild.textContent = '开始抽取';
    mode = next;
    $('drawStage').dataset.mode = mode;
    for (const button of document.querySelectorAll('button[data-mode]'))
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    for (const name of Object.keys(modes)) $(name + 'View').hidden = name !== mode;
    idle();
    Cloud.storage('hero-draw-mode', mode).catch(() => {});
  }
  for (const button of document.querySelectorAll('button[data-mode]'))
    button.onclick = () => switchMode(button.dataset.mode);
  for (const button of document.querySelectorAll('[data-role]'))
    button.onclick = () => {
      if (busy || !ready) return;
      role = button.dataset.role;
      lastHero = null;
      for (const item of document.querySelectorAll('[data-role]'))
        item.setAttribute('aria-pressed', String(item.dataset.role === role));
      $('resultHint').textContent = '';
      $('resultName').textContent = '';
      $('resultRole').textContent = '';
      $('drawStage').classList.remove('has-result');
      idle();
    };
  $('drawButton').onclick = draw;
  $('historyOpen').onclick = () => {
    history();
    $('drawHistory').showModal();
  };
  $('historyClose').onclick = () => $('drawHistory').close();
  const drawCard = $('heroCard');
  drawCard.setAttribute('role', 'button');
  drawCard.tabIndex = 0;
  drawCard.setAttribute('aria-label', '抽个英雄');
  drawCard.onclick = () => {
    if (mode === 'card') draw();
  };
  drawCard.onkeydown = (event) => {
    if (mode === 'card' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      draw();
    }
  };
  $('clearDrawHistory').onclick = async () => {
    if (busy || !ready || !records.length) return;
    if (!confirm('清空当前账号在此浏览器的抽取记录？')) return;
    try {
      await Cloud.storage('hero-draw-history', []);
      records = [];
      history();
    } catch (error) {
      $('resultHint').textContent = error.message;
    }
  };
  const resize = new ResizeObserver(() => {
    if (!busy && ready) idle();
  });
  resize.observe($('drawStage'));
  Cloud.boot()
    .then(async () => {
      const saved = await Cloud.storage('hero-draw-history');
      records = Array.isArray(saved)
        ? saved
            .filter(
              (r) =>
                r &&
                heroes.some((h) => h.id === r.hero) &&
                modes[r.mode] &&
                !Number.isNaN(Date.parse(r.at))
            )
            .slice(0, 50)
        : [];
      const savedMode = await Cloud.storage('hero-draw-mode');
      ready = true;
      switchMode(modes[savedMode] ? savedMode : 'wheel');
      lock(false);
      $('drawButton').firstElementChild.textContent = '开始抽取';
      history();
    })
    .catch((error) => {
      $('resultHint').textContent = error.message;
    });
})();
