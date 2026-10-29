'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    model = window.EventsModel;
  const dateTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });
  let snapshot = null,
    view = 'scheduled',
    busy = false,
    requestId = 0,
    retryTimer,
    queryTimer,
    pollTimer,
    bootReady = false,
    pageSuspended = false;
  const reminders = () => window.EventReminders,
    reminderState = () => reminders()?.state;
  const reserved = (match) =>
    reminderState()?.reservations.some((r) => r.id === match.reminderId && r.state !== 'completed');
  function reminderAction(action) {
    let promise;
    try {
      promise = action();
    } catch (error) {
      promise = Promise.reject(error);
    }
    Promise.resolve(promise).catch((error) => {
      if (reminderState()) reminderState().error = error.message;
      $('eventsRemindersError').textContent = error.message;
      $('eventsRemindersError').hidden = false;
    });
  }
  function reservationStatus(r, now = Date.now()) {
    if (r.deliveryStatus === 'sent') return '已提交推送';
    if (r.deliveryStatus === 'failed') return '推送失败';
    if (r.deliveryStatus === 'unavailable')
      return r.state === 'notified' ? '已提醒 · 通知未启用' : '已预约 · 通知未启用';
    if (r.state === 'notified') return '已提醒 · 推送待确认';
    const start = Date.parse(r.match?.startsAt);
    if (Number.isFinite(start) && start <= now) return '已到预定时间 · 待核实';
    if (r.state === 'unverified') return '赛程待核实';
    return r.changed ? '时间已变更' : '已预约';
  }
  function renderReminders() {
    const s = reminderState(),
      ready = s?.ready,
      list = $('eventsReservations'),
      enable = $('eventsEnableNotifications');
    list.setAttribute('aria-busy', String(!ready));
    list.replaceChildren();
    enable.disabled = !ready || !s.enabled || s.pending || s.deviceEnabled;
    enable.textContent = s?.deviceEnabled ? '本机通知已启用' : '启用本机通知';
    const statusNode = $('eventsRemindersStatus');
    statusNode.textContent =
      !ready && !s?.error ? '读取中…' : ready && !s.enabled && !s.error ? '提醒未启用' : '';
    statusNode.hidden = !statusNode.textContent;
    $('eventsRemindersError').textContent = s?.error || '';
    $('eventsRemindersError').hidden = !s?.error;
    if (!ready) return;
    const entries = s.reservations.filter((r) => r.state !== 'completed');
    if (!entries.length) {
      list.append(element('li', 'events-reservation-empty', '暂无预约'));
      return;
    }
    for (const r of entries) {
      const item = element('li', 'events-reservation'),
        copy = element('div'),
        match = r.match || {};
      const teams = (match.teams || [])
        .map((t) => (typeof t === 'string' ? t : t.name))
        .filter(Boolean)
        .join(' vs ');
      copy.append(element('strong', '', teams || '待确认比赛'));
      const starts = Date.parse(match.startsAt),
        parts = [
          Number.isFinite(starts) ? dateTime.format(new Date(starts)) : '时间待定',
          match.tournament,
          match.region
        ].filter(Boolean);
      copy.append(element('span', '', parts.join(' · ')));
      const status = reservationStatus(r);
      copy.append(element('span', 'events-reservation-status', status));
      const cancel = element('button', '', '取消预约');
      cancel.type = 'button';
      cancel.disabled = !s.enabled || s.pending;
      cancel.setAttribute('aria-label', '取消预约 ' + (teams || '待确认比赛'));
      cancel.onclick = () => reminderAction(() => reminders().cancel(r.id));
      item.append(copy, cancel);
      list.append(item);
    }
  }
  $('eventsEnableNotifications').onclick = () => reminderAction(() => reminders().enable());
  window.addEventListener('owqs:reminders', () => {
    renderReminders();
    render();
  });
  // Both tabs filter locally; v1 otherwise defaults to scheduled and a five-row page.
  const scope = () =>
    new URLSearchParams({
      series: $('eventsSeries').value,
      status: 'all',
      paginate: '0',
      ...($('eventsFrom').value && $('eventsTo').value
        ? { from: $('eventsFrom').value, to: $('eventsTo').value }
        : {})
    });
  const filters = () => ({
    view,
    series: $('eventsSeries').value,
    from: $('eventsFrom').value,
    to: $('eventsTo').value,
    tournament: $('eventsTournament').value,
    region: $('eventsRegion').value,
    team: $('eventsTeam').value
  });
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function teamLabel(team, left) {
    const label = element('span', 'event-team' + (left ? ' event-team-left' : '')),
      name = element('span', 'event-team-name', team.name),
      badge = element('span', 'event-logo-slot');
    badge.setAttribute('aria-hidden', 'true');
    try {
      const url = new URL(team.logo);
      if (
        url.protocol === 'https:' &&
        url.hostname === 'liquipedia.net' &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith('/commons/images/') &&
        /\.(png|svg|webp|jpe?g|gif)$/i.test(url.pathname)
      ) {
        const image = element('img', 'event-logo');
        image.alt = '';
        image.width = 32;
        image.height = 32;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.onerror = () => image.remove();
        image.src = url.href;
        badge.append(image);
      }
    } catch {
      /* A missing or invalid badge keeps a neutral placeholder beside the name. */
    }
    label.append(...(left ? [name, badge] : [badge, name]));
    return label;
  }
  function notice(message) {
    $('eventsNotice').textContent = message;
    $('eventsNotice').hidden = !message;
  }
  function fillOptions(id, values, label) {
    const select = $(id),
      value = select.value,
      options = [...new Set([...values, ...(value ? [value] : [])])];
    select.replaceChildren(
      new Option(label, ''),
      ...options.sort((a, b) => a.localeCompare(b, 'zh-CN')).map((v) => new Option(v, v))
    );
    select.value = value;
  }
  function render() {
    if (!snapshot) return;
    const f = filters(),
      invalid = f.from && f.to && f.from > f.to,
      matches = invalid ? [] : model.select(snapshot.matches, f),
      list = $('eventsList');
    list.replaceChildren();
    $('eventsCount').textContent = `${matches.length} 场比赛`;
    $('eventsUpdated').textContent = '更新于 ' + dateTime.format(new Date(snapshot.updatedAt));
    if (invalid) {
      list.append(element('p', 'events-empty', '开始日期不能晚于结束日期。'));
      return;
    }
    if (!matches.length) {
      const hasFilters = f.from || f.to || f.tournament || f.region || f.team.trim();
      list.append(
        element(
          'p',
          'events-empty',
          hasFilters ? '无匹配比赛' : view === 'completed' ? '暂无赛果' : '暂无赛程'
        )
      );
      return;
    }
    let currentDay = '',
      group;
    for (const match of matches) {
      const date = model.day(match.startsAt) || 'tbd';
      if (date !== currentDay) {
        currentDay = date;
        group = element('section', 'events-day');
        const heading = element(
          'h2',
          'events-day-heading',
          date === 'tbd' ? '时间待定' : dateFormat.format(new Date(match.startsAt))
        );
        group.append(heading);
        list.append(group);
      }
      const row = element('article', 'event-match'),
        meta = element('div', 'event-meta');
      meta.append(
        element('span', 'event-region', match.region),
        element('span', 'event-tournament', match.tournament)
      );
      if (match.bestOf) meta.append(element('span', 'event-format', 'BO' + match.bestOf));
      const body = element('div', 'event-match-body'),
        time = element('div', 'event-time'),
        stamp = element(
          'time',
          '',
          match.startsAt ? timeFormat.format(new Date(match.startsAt)) : '待定'
        );
      if (match.startsAt) stamp.dateTime = match.startsAt;
      const completed = match.status === 'completed',
        status = element(
          'span',
          'event-status',
          completed
            ? '已结束'
            : match.status === 'live'
              ? '进行中'
              : !match.startsAt
                ? '时间待定'
                : Date.parse(match.startsAt) < Date.now()
                  ? '赛果待公布'
                  : '未开始'
        );
      if (status.textContent === '赛果待公布') {
        status.classList.add('is-pending');
        status.replaceChildren('赛果', element('wbr'), '待公布');
      }
      time.append(stamp, status);
      const versus = element('div', 'event-versus');
      const hasScores =
        Array.isArray(match.scores) &&
        match.scores.length === 2 &&
        match.scores.every((s) => Number.isFinite(s));
      const scores = hasScores ? match.scores.join(' : ') : completed ? '—' : 'VS';
      versus.append(
        teamLabel(match.teams[0], true),
        element(
          'strong',
          'event-score' + (completed ? ' is-completed' : '') + (hasScores ? ' has-score' : ''),
          scores
        ),
        teamLabel(match.teams[1], false)
      );
      const url = new URL(match.sourceUrl);
      if (
        url.protocol === 'https:' &&
        url.hostname === 'liquipedia.net' &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith('/overwatch/')
      ) {
        const link = element('a', 'event-source-link', '赛事详情 ↗');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        body.append(time, versus, link);
      } else body.append(time, versus);
      const actions = element('div', 'event-actions');
      for (const broadcast of match.broadcasts || []) {
        const href = reminders()?.safeUrl(broadcast.url);
        if (!href) continue;
        const link = element(
          'a',
          'event-broadcast',
          broadcast.label || broadcast.platform || '观看直播'
        );
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
      }
      if (!completed && (match.reservable || reserved(match))) {
        const s = reminderState(),
          isReserved = reserved(match),
          button = element('button', 'event-reserve', isReserved ? '已预约' : '预约');
        button.type = 'button';
        button.disabled = !!isReserved || !s?.ready || !s.enabled || s.pending;
        button.title = isReserved
          ? '可在“我的预约”中取消'
          : !s?.enabled
            ? '开赛提醒服务尚未启用'
            : '预约开赛提醒';
        button.onclick = () => reminderAction(() => reminders().reserve(match.reminderId));
        actions.append(button);
      }
      row.append(meta, body);
      if (actions.childElementCount) row.append(actions);
      group.append(row);
    }
  }
  function setView(next) {
    view = next;
    document
      .querySelectorAll('[data-view]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  }
  function canPoll() {
    return bootReady && !pageSuspended && document.visibilityState === 'visible';
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!canPoll() || busy || retryTimer || queryTimer) return;
    // The server owns upstream synchronization; this only reads shared cached data.
    const seconds = Math.max(30, Math.min(60, Number(snapshot?.refreshIntervalSeconds) || 60));
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (canPoll() && !busy && !retryTimer && !queryTimer) void refresh(false);
    }, seconds * 1000);
  }
  function scheduleRetry(seconds) {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(pollTimer);
    pollTimer = null;
    if (canPoll())
      retryTimer = setTimeout(
        () => {
          retryTimer = null;
          if (canPoll() && !busy) void refresh(false);
        },
        Math.max(1, Math.min(300, Number(seconds) || 5)) * 1000
      );
  }
  async function refresh(sync = true, manual = false) {
    const id = ++requestId;
    clearTimeout(queryTimer);
    queryTimer = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(pollTimer);
    pollTimer = null;
    busy = true;
    $('eventsList').setAttribute('aria-busy', 'true');
    $('eventsRefresh').disabled = true;
    $('eventsRefresh').textContent = '更新中…';
    const params = scope();
    try {
      const next = await Cloud.api(
        (sync ? '/api/events/refresh' : '/api/events') + '?' + params,
        sync ? {} : undefined
      );
      if (id !== requestId) return;
      if (next.state === 'pending') {
        notice('查询中…');
        $('eventsCount').textContent = '正在补查…';
        if (!snapshot) $('eventsList').replaceChildren(element('p', 'events-empty', '查询中…'));
        scheduleRetry(next.retryAfter);
        return;
      }
      snapshot = next;
      fillOptions(
        'eventsTournament',
        next.matches.map((m) => m.tournament),
        '全部阶段'
      );
      fillOptions(
        'eventsRegion',
        next.matches.map((m) => m.region),
        '全部赛区'
      );
      notice(
        next.refreshError && (!next.refreshDeferred || next.updating || manual)
          ? (next.updating
              ? '更新中…'
              : next.refreshDeferred
                ? '请稍后刷新'
                : '更新失败，已保留上次数据') +
              (Number(next.retryAfter) > 0
                ? ' · ' + Math.ceil(Number(next.retryAfter)) + ' 秒后重试'
                : '')
          : next.truncated
            ? '结果不完整，请缩小日期范围'
            : next.stale
              ? '数据待更新'
              : ''
      );
      render();
      if (next.updating) scheduleRetry(next.retryAfter);
    } catch (error) {
      if (id !== requestId) return;
      notice(error.message + (snapshot ? '，已保留当前赛程。' : ''));
      if (!snapshot) {
        $('eventsCount').textContent = '暂无赛程';
        $('eventsList').replaceChildren(element('p', 'events-empty', '加载失败，请刷新重试'));
      }
    } finally {
      if (id === requestId) {
        busy = false;
        $('eventsList').setAttribute('aria-busy', 'false');
        $('eventsRefresh').disabled = false;
        $('eventsRefresh').textContent = '刷新赛程';
        schedulePoll();
      }
    }
  }
  function queryChanged() {
    ++requestId;
    busy = false;
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(pollTimer);
    pollTimer = null;
    clearTimeout(queryTimer);
    queryTimer = null;
    const from = $('eventsFrom').value,
      to = $('eventsTo').value;
    if (from && to && from > to) {
      busy = false;
      $('eventsRefresh').disabled = false;
      $('eventsRefresh').textContent = '刷新赛程';
      $('eventsList').setAttribute('aria-busy', 'false');
      render();
      return;
    }
    if (from && to && to < model.day(new Date().toISOString())) setView('completed');
    queryTimer = setTimeout(() => {
      queryTimer = null;
      refresh(false);
    }, 400);
  }
  $('eventsFilters').onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(queryTimer);
    queryTimer = null;
    refresh(false);
  };
  $('eventsFilters').addEventListener('input', render);
  $('eventsFilters').addEventListener('change', render);
  for (const id of ['eventsSeries', 'eventsFrom', 'eventsTo'])
    $(id).addEventListener('change', queryChanged);
  $('eventsSeries').addEventListener('change', () => {
    $('eventsTournament').value = '';
  });
  $('eventsClear').onclick = () => {
    $('eventsFilters').reset();
    queryChanged();
    render();
  };
  document.querySelectorAll('[data-view]').forEach(
    (button) =>
      (button.onclick = () => {
        setView(button.dataset.view);
        render();
      })
  );
  $('eventsRefresh').onclick = () => refresh(true, true);
  // Update scheduled-time labels even when the reminder API is unavailable.
  // This never creates a notice or claims that an unverified match is live.
  let statusTimer;
  const updateTimeStatus = () => {
    if (document.visibilityState === 'visible') {
      renderReminders();
      render();
    }
  };
  const startStatusTimer = () => {
    clearInterval(statusTimer);
    statusTimer = setInterval(updateTimeStatus, 15000);
    updateTimeStatus();
  };
  document.addEventListener('visibilitychange', updateTimeStatus);
  const pausePolling = () => {
    clearTimeout(pollTimer);
    pollTimer = null;
    clearTimeout(retryTimer);
    retryTimer = null;
    if (queryTimer) {
      clearTimeout(queryTimer);
      queryTimer = null;
    }
  };
  const resumePolling = () => {
    if (canPoll() && !busy && !queryTimer) void refresh(false);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumePolling();
    else pausePolling();
  });
  window.addEventListener('pagehide', () => {
    pageSuspended = true;
    clearInterval(statusTimer);
    pausePolling();
  });
  window.addEventListener('pageshow', () => {
    pageSuspended = false;
    startStatusTimer();
    resumePolling();
  });
  startStatusTimer();
  renderReminders();
  Cloud.boot()
    .then(async () => {
      bootReady = true;
      await refresh(false);
      if (
        !pageSuspended &&
        document.visibilityState === 'visible' &&
        !scope().get('from') &&
        scope().get('series') === 'owcs'
      )
        await refresh();
    })
    .catch(() => {});
})();
