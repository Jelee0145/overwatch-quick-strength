'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const DETAIL_PATH = /^Overwatch_Champions_Series\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+){0,4}$/;
  const LOGO = /^\/api\/v1\/events\/logos\/[a-f0-9]{64}$/;
  const MEDIA = /^\/media\/(?:maps|icons)\/[a-f0-9]{20}\.webp$/;
  const SOURCE = /^https:\/\/liquipedia\.net\/overwatch\/[A-Za-z0-9_\-/]+$/;
  const dateTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const target = new URLSearchParams(location.search).get('t') || '';
  let detail = null,
    shown = '',
    tab = 'schedule',
    timer,
    busy = false,
    bootReady = false;

  // Liquipedia writes labels in English; translate the common ones and keep the rest as-is.
  const WORDS = [
    [/\bRegular Season\b/gi, '常规赛'],
    [/\bRegional Playoffs\b/gi, '区域季后赛'],
    [/\bPlayoffs?\b/gi, '季后赛'],
    [/\bSwiss (?:Stage|System|Standings)\b/gi, '瑞士轮'],
    [/\bSwiss\b/gi, '瑞士轮'],
    [/\bGroup Stage\b/gi, '小组赛'],
    [/\bGroup ([A-Z])\b/g, '$1 组'],
    [/\bMain Event\b/gi, '正赛'],
    [/\bKnockout Stage\b/gi, '淘汰赛'],
    [/\bPlay-?Ins?\b/gi, '附加赛'],
    [/\bUpper Bracket\b/gi, '胜者组'],
    [/\bLower Bracket\b/gi, '败者组'],
    [/\bGrand Finals?\b/gi, '总决赛'],
    [/\bQuarter-?finals?\b/gi, '四分之一决赛'],
    [/\bSemi-?finals?\b/gi, '半决赛'],
    [/\bFinals?\b/gi, '决赛'],
    [/\bThird Place Match\b/gi, '季军赛'],
    [/\bWeek (\d+)\b/gi, '第 $1 周'],
    [/\bDay (\d+)\b/gi, '第 $1 天'],
    [/\bRound (\d+)\b/gi, '第 $1 轮'],
    [/\bStage (\d+)\b/gi, '第 $1 阶段'],
    [/\bSingle[- ]Elimination\b/gi, '单败淘汰'],
    [/\bDouble[- ]Elimination\b/gi, '双败淘汰'],
    [/\bRound[- ]Robin\b/gi, '循环赛'],
    [/\bBracket\b/gi, '对阵'],
    [/\bOnline\b/gi, '线上'],
    [/\bOffline\b/gi, '线下'],
    [/\bHybrid\b/gi, '线上+线下'],
    [/\bInvited\b/gi, '受邀'],
    [/\bQualified\b/gi, '晋级'],
    [/\bTBA\b/g, '待定'],
    [/\bTBD\b/g, '待定']
  ];
  const zh = (value) => WORDS.reduce((s, [re, to]) => s.replace(re, to), String(value || ''));
  const COLUMNS = {
    Matches: '比赛',
    Match: '比赛',
    Maps: '地图',
    Map: '地图',
    Games: '小局',
    Points: '积分',
    Pts: '积分',
    'Map Diff': '净胜图',
    'Map Diff.': '净胜图',
    Diff: '净胜',
    'W-L': '胜-负',
    Buchholz: '布赫霍尔茨分'
  };
  const ROLES = {
    dps: '输出',
    damage: '输出',
    tank: '重装',
    support: '支援',
    flex: '自由人',
    coach: '教练',
    'head coach': '主教练',
    'assistant coach': '助理教练',
    analyst: '分析师',
    manager: '经理',
    substitute: '替补'
  };
  const GROUPS = { main: '阵容', staff: '教练组', former: '前成员', substitutes: '替补' };
  const STATUS = { up: '晋级', stayup: '晋级', down: '淘汰', stay: '' };

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = value;
    return node;
  }
  function picture(src, className, alt = '', size = 32) {
    if (typeof src !== 'string' || !(LOGO.test(src) || MEDIA.test(src))) return null;
    const image = element('img', className);
    image.alt = alt;
    image.width = size;
    image.height = size;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = src;
    image.onerror = () => image.remove();
    return image;
  }
  function badge(team) {
    const slot = element('span', 'event-logo-slot');
    slot.setAttribute('aria-hidden', 'true');
    const image = picture(team?.logo, 'event-logo');
    if (image) slot.append(image);
    return slot;
  }
  function teamLabel(team, left) {
    const label = element('span', 'event-team' + (left ? ' event-team-left' : '')),
      name = element('span', 'event-team-name', team?.name || '待定');
    label.append(...(left ? [name, badge(team)] : [badge(team), name]));
    return label;
  }
  const when = (value) => (value ? dateTime.format(new Date(value)) : '时间待定');
  const short = (team) => team?.shortName || team?.name || '待定';
  function notice(message) {
    $('eventNotice').textContent = message || '';
    $('eventNotice').hidden = !message;
  }
  function empty(panel, message) {
    panel.replaceChildren(element('p', 'events-empty', message));
  }

  function renderInfo(info, matches) {
    const box = $('eventInfo');
    box.replaceChildren();
    const add = (label, value) => {
      if (!value || (Array.isArray(value) && !value.length)) return;
      const item = element('div');
      item.append(
        element('dt', '', label),
        element('dd', '', Array.isArray(value) ? value.map(zh).join('、') : zh(value))
      );
      box.append(item);
    };
    const dates = [info?.startDate, info?.endDate].filter(Boolean);
    add('组织方', info?.organizers);
    add('类型', info?.type);
    add('地点', info?.location);
    add('赛制', info?.format);
    add('奖金', info?.prizePool);
    add('日期', dates.length ? [...new Set(dates)].join(' ~ ') : '');
    add('队伍', info?.teams);
    box.hidden = !box.childElementCount;
    $('eventTitle').textContent = zh(info?.title) || '赛事详情';
    document.title = $('eventTitle').textContent + ' · 赛事详情 · 狸狸天眼查';
    const done = matches.filter((m) => m.finished).length;
    $('eventSubtitle').textContent = matches.length
      ? `${matches.length} 场比赛 · 已完成 ${done} 场`
      : '';
  }

  function renderSchedule(panel) {
    panel.replaceChildren();
    if (!detail.matches.length) return empty(panel, '暂无赛程');
    let stage = null,
      group;
    for (const match of detail.matches) {
      if (match.stage !== stage || !group) {
        stage = match.stage;
        group = element('section', 'events-day');
        group.append(element('h2', 'events-day-heading', zh(stage) || '赛程'));
        panel.append(group);
      }
      const row = element('button', 'event-match event-match-open');
      row.type = 'button';
      row.onclick = () => open(match.id);
      const meta = element('span', 'event-meta');
      meta.append(element('span', 'event-tournament', when(match.startsAt)));
      if (match.bestOf) meta.append(element('span', 'event-format', 'BO' + match.bestOf));
      const versus = element('span', 'event-versus'),
        has = match.scores?.every((s) => Number.isFinite(s));
      versus.append(
        teamLabel(match.teams[0], true),
        element(
          'strong',
          'event-score' + (has ? ' has-score is-completed' : ''),
          has ? match.scores.join(' : ') : 'VS'
        ),
        teamLabel(match.teams[1], false)
      );
      const body = element('span', 'event-match-body event-detail-body');
      body.append(versus);
      if (match.games?.some((g) => g.played))
        body.append(
          element('span', 'event-maps-hint', match.games.filter((g) => g.played).length + ' 张地图')
        );
      row.append(meta, body);
      row.setAttribute(
        'aria-label',
        `${short(match.teams[0])} 对 ${short(match.teams[1])}，${when(match.startsAt)}，查看每局详情`
      );
      group.append(row);
    }
  }

  function renderStandings(panel) {
    panel.replaceChildren();
    if (!detail.standings.length) return empty(panel, '暂无积分榜');
    for (const table of detail.standings) {
      const section = element('section', 'event-standing');
      section.append(element('h2', 'events-day-heading', zh(table.title) || '积分榜'));
      const wrap = element('div', 'event-table-wrap'),
        grid = element('table', 'event-table'),
        head = element('tr');
      head.append(element('th', '', '#'), element('th', 'event-table-team', '队伍'));
      for (const column of table.columns)
        head.append(element('th', '', COLUMNS[column] || zh(column)));
      if (table.rounds) head.append(element('th', '', '战绩'));
      const thead = element('thead'),
        tbody = element('tbody');
      thead.append(head);
      for (const row of table.rows) {
        const tr = element('tr', row.status ? 'is-' + row.status.replace(/[^a-z]/g, '') : '');
        const place = element('td', 'event-place', row.place ?? '');
        if (STATUS[row.status]) place.title = STATUS[row.status];
        const team = element('td', 'event-table-team');
        team.append(teamLabel(row.team, false));
        tr.append(place, team, ...row.stats.map((s) => element('td', '', s)));
        if (table.rounds) {
          const history = element('td', 'event-history');
          for (const entry of row.history) {
            const chip = element(
              'span',
              'event-chip' + (entry ? ' is-' + entry.result.replace(/[^a-z]/g, '') : ''),
              entry ? entry.score || '·' : '·'
            );
            if (entry?.opponent) chip.title = '对 ' + entry.opponent;
            history.append(chip);
          }
          tr.append(history);
        }
        tbody.append(tr);
      }
      grid.append(thead, tbody);
      wrap.append(grid);
      section.append(wrap);
      panel.append(section);
    }
  }

  function renderTeams(panel) {
    panel.replaceChildren();
    if (!detail.participants.length) return empty(panel, '暂无参赛队伍');
    const list = element('div', 'event-teams');
    for (const entry of detail.participants) {
      const card = element('article', 'event-team-card'),
        head = element('div', 'event-team-card-head');
      head.append(teamLabel(entry.team, false));
      const note = [zh(entry.qualifier), zh(entry.qualifierPlacement)].filter(Boolean).join(' · ');
      if (note) head.append(element('span', 'event-team-note', note));
      card.append(head);
      for (const group of entry.groups) {
        if (entry.groups.length > 1)
          card.append(
            element('h3', 'event-team-group', GROUPS[group.label.toLowerCase()] || zh(group.label))
          );
        const members = element('ul', 'event-members');
        for (const member of group.members) {
          const item = element('li');
          item.append(element('strong', '', member.id));
          const role = ROLES[String(member.role).toLowerCase()] || member.role;
          if (role) item.append(element('span', '', role));
          if (member.country) item.title = member.country;
          members.append(item);
        }
        card.append(members);
      }
      list.append(card);
    }
    panel.append(list);
  }

  function renderSource() {
    const footer = $('eventSource'),
      pages = (detail?.source?.pages || []).filter((url) => SOURCE.test(url));
    footer.replaceChildren();
    if (!pages.length && SOURCE.test('https://liquipedia.net/overwatch/' + target))
      pages.push('https://liquipedia.net/overwatch/' + target);
    footer.append(element('span', '', '数据来自'));
    pages.forEach((url, i) => {
      const link = element('a', '', i ? 'Liquipedia 子页面 ' + i : 'Liquipedia 原页面');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      footer.append(link);
    });
    const license = element('a', '', 'CC BY-SA 3.0');
    license.href = 'https://creativecommons.org/licenses/by-sa/3.0/';
    license.target = '_blank';
    license.rel = 'noopener noreferrer';
    footer.append(
      license,
      element('span', '', '已翻译整理'),
      element('span', '', '选图方按赛制推算')
    );
    if (detail?.updatedAt) footer.append(element('span', '', '更新于 ' + when(detail.updatedAt)));
  }

  function setTab(next) {
    tab = next;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('aria-pressed', String(active));
    }
    $('eventSchedule').hidden = tab !== 'schedule';
    $('eventStandings').hidden = tab !== 'standings';
    $('eventTeams').hidden = tab !== 'teams';
  }

  function render() {
    const key = JSON.stringify(detail);
    if (key === shown) return;
    shown = key;
    renderInfo(detail.info, detail.matches);
    $('eventTabs').hidden = false;
    renderSchedule($('eventSchedule'));
    renderStandings($('eventStandings'));
    renderTeams($('eventTeams'));
    renderSource();
    $('eventSchedule').setAttribute('aria-busy', 'false');
    route();
  }

  // ---- Match drawer (#m=<id>) ----
  function findMatch(id) {
    const list = detail?.matches || [],
      exact = list.find((m) => m.id === id);
    if (exact) return exact;
    // Links from the schedule list rebuild the id from the ticker; fall back to time + teams.
    const [, startsAt, ...teams] = String(id).split('|'),
      names = teams.map((t) => t.toLowerCase());
    const same = (m) => m.teams.every((t) => names.includes(String(t.name).toLowerCase()));
    return (
      list.find((m) => m.startsAt === startsAt && same(m)) ||
      list.find(
        (m) => same(m) && Math.abs(Date.parse(m.startsAt) - Date.parse(startsAt)) < 6 * 3600000
      ) ||
      null
    );
  }
  function bans(game, match) {
    const box = element('div', 'event-bans');
    game.bans.forEach((hero, side) => {
      const item = element('span', 'event-ban');
      item.append(element('span', 'event-ban-team', short(match.teams[side]) + ' 禁用'));
      if (!hero) item.append(element('span', 'event-ban-none', '—'));
      else {
        const icon = picture(hero.icon, 'event-hero', '', 28);
        if (icon) item.append(icon);
        item.append(element('span', 'event-ban-name', hero.name));
      }
      box.append(item);
    });
    return box;
  }
  function paintDrawer(match) {
    const body = $('eventDrawerBody');
    body.replaceChildren();
    $('eventDrawerTitle').textContent = `${short(match.teams[0])} vs ${short(match.teams[1])}`;
    const summary = element('div', 'event-drawer-summary'),
      has = match.scores?.every((s) => Number.isFinite(s));
    summary.append(
      element(
        'p',
        'event-drawer-meta',
        [zh(match.stage), when(match.startsAt), match.bestOf ? 'BO' + match.bestOf : '']
          .filter(Boolean)
          .join(' · ')
      )
    );
    const versus = element('div', 'event-versus');
    versus.append(
      teamLabel(match.teams[0], true),
      element(
        'strong',
        'event-score' + (has ? ' has-score is-completed' : ''),
        has ? match.scores.join(' : ') : 'VS'
      ),
      teamLabel(match.teams[1], false)
    );
    summary.append(versus);
    body.append(summary);
    const games = (match.games || []).filter((g) => g.played || g.map?.name);
    if (!games.length) body.append(element('p', 'events-empty', '比赛开始后显示每局地图与比分'));
    const list = element('ol', 'event-games');
    games.forEach((game, i) => {
      const item = element('li', 'event-game' + (game.played ? '' : ' is-unplayed')),
        art = element('span', 'event-map-art'),
        image = picture(game.map?.image, 'event-map-image', '', 96);
      if (image) {
        image.width = 96;
        image.height = 54;
        art.append(image);
      }
      const info = element('div', 'event-game-info'),
        title = element('div', 'event-game-title');
      title.append(
        element('span', 'event-game-index', '第 ' + (i + 1) + ' 图'),
        element('strong', '', game.map?.name || '待定')
      );
      if (game.map?.mode) title.append(element('span', 'event-game-mode', game.map.mode));
      info.append(title);
      const score = element('div', 'event-game-score');
      [0, 1].forEach((side) => {
        const part = element(
          'span',
          'event-game-side' + (game.winner === side ? ' is-winner' : ''),
          `${short(match.teams[side])} ${game.scores?.[side] || (game.played ? '0' : '-')}`
        );
        score.append(part);
      });
      if (game.winner !== null && game.winner !== undefined)
        score.append(element('span', 'event-game-winner', short(match.teams[game.winner]) + ' 胜'));
      info.append(score);
      if (game.picker === 0 || game.picker === 1)
        info.append(
          element(
            'p',
            'event-game-picker',
            '选图：' + short(match.teams[game.picker]) + '（按赛制推算）'
          )
        );
      if (game.bans?.some(Boolean)) info.append(bans(game, match));
      item.append(art, info);
      list.append(item);
    });
    if (games.length) body.append(list);
    if (match.mvp?.length) body.append(element('p', 'event-mvp', 'MVP：' + match.mvp.join('、')));
  }
  function route() {
    const drawer = $('eventDrawer'),
      hash = location.hash.startsWith('#m=') ? location.hash.slice(3) : '';
    let id = '';
    try {
      id = decodeURIComponent(hash);
    } catch {
      /* Malformed fragment. */
    }
    const match = id && detail ? findMatch(id) : null;
    if (!match) {
      if (drawer.open) drawer.close();
      return;
    }
    paintDrawer(match);
    setTab('schedule');
    if (!drawer.open) {
      if (typeof drawer.showModal === 'function') drawer.showModal();
      else drawer.setAttribute('open', '');
    }
  }
  function open(id) {
    const next = '#m=' + encodeURIComponent(id);
    if (location.hash === next) route();
    else location.hash = next;
  }
  function closeDrawer() {
    if (location.hash.startsWith('#m='))
      history.replaceState(null, '', location.pathname + location.search);
    route();
  }

  // ---- Loading ----
  function later(seconds) {
    clearTimeout(timer);
    timer = null;
    if (document.visibilityState !== 'visible') return;
    timer = setTimeout(
      () => {
        timer = null;
        void load();
      },
      Math.max(5, Math.min(300, Number(seconds) || 30)) * 1000
    );
  }
  async function load() {
    if (busy || !bootReady) return;
    if (!DETAIL_PATH.test(target)) {
      notice('赛事页面无效');
      empty($('eventSchedule'), '请从赛事中心打开赛事详情');
      $('eventSchedule').setAttribute('aria-busy', 'false');
      renderSource();
      return;
    }
    busy = true;
    try {
      const value = await Cloud.api('/api/events/detail?' + new URLSearchParams({ t: target }));
      if (value.state === 'pending') {
        const seconds = Math.max(5, Math.min(300, Number(value.retryAfter) || 30));
        notice('正在整理赛事数据，约 ' + seconds + ' 秒后自动刷新');
        if (!detail) empty($('eventSchedule'), '正在整理…');
        later(seconds);
        return;
      }
      detail = value;
      notice(value.partial ? '部分页面仍在整理，稍后自动补全' : '');
      render();
      later(value.partial ? 60 : 180);
    } catch (error) {
      notice(error.message + (detail ? '，已保留当前内容。' : ''));
      if (!detail) empty($('eventSchedule'), '加载失败，请稍后刷新');
      $('eventSchedule').setAttribute('aria-busy', 'false');
      renderSource();
      later(60);
    } finally {
      busy = false;
    }
  }

  for (const button of document.querySelectorAll('[data-tab]'))
    button.onclick = () => setTab(button.dataset.tab);
  $('eventDrawerClose').onclick = closeDrawer;
  $('eventDrawer').addEventListener('close', () => {
    if (location.hash.startsWith('#m='))
      history.replaceState(null, '', location.pathname + location.search);
  });
  $('eventDrawer').addEventListener('click', (event) => {
    if (event.target === $('eventDrawer')) closeDrawer();
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !timer) void load();
    else if (document.visibilityState !== 'visible') {
      clearTimeout(timer);
      timer = null;
    }
  });
  renderSource();
  Cloud.boot()
    .then(() => {
      bootReady = true;
      return load();
    })
    .catch(() => {});
})();
