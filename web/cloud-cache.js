(function (root) {
  'use strict';
  let db,
    session,
    scope,
    manifestRows = [],
    lastReport = null;
  const caps = { match: 500, profile: 2000, history: 500 },
    tag = (v) =>
      String(v || '')
        .normalize('NFC')
        .trim(),
    id = (type, key) => scope + '|' + type + '|' + key;
  const store = (name, key, value) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(name, value === undefined ? 'readonly' : 'readwrite'),
        r =
          value === undefined
            ? tx.objectStore(name).get(key)
            : tx.objectStore(name).put(value, key);
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(Error('缓存读写失败'));
    });
  const all = (name) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(name),
        r = tx.objectStore(name).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(Error('缓存读取失败'));
    });
  async function prune() {
    const rows = (await all('cacheIndex')).filter((r) => r.scope === scope);
    const remove = [];
    for (const [type, max] of Object.entries(caps))
      remove.push(
        ...rows
          .filter((r) => r.type === type)
          .sort((a, b) => b.usedAt - a.usedAt)
          .slice(max)
      );
    if (remove.length)
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['cacheIndex', 'cacheRecords'], 'readwrite');
        for (const r of remove) {
          tx.objectStore('cacheIndex').delete(r.id);
          tx.objectStore('cacheRecords').delete(r.id);
        }
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
    const retained = new Set(
      rows.filter((r) => r.type === 'match' && !remove.includes(r)).map((r) => r.key)
    );
    if (retained.size)
      await new Promise((resolve, reject) => {
        const tx = db.transaction('cache', 'readwrite'),
          r = tx.objectStore('cache').openCursor(),
          prefix =
            session.user.id + '|snapshot|' + session.scope.server + '|' + session.scope.dts + '|';
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return;
          if (
            String(c.key).startsWith(prefix) &&
            c.value?.content?.data &&
            [
              ...(c.value.content.data.matches || []),
              ...(c.value.content.data.recentHistory || []).flatMap((h) => h.matches || []),
              ...(c.value.content.data.queryCache?.battles || []).map((r) => r.game)
            ].some((m) => !retained.has(m.mid))
          )
            c.delete();
          c.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
  }
  async function initialize(value) {
    session = value;
    scope = session.user.id + '|' + session.scope.server + '|' + session.scope.dts;
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('qs-cloud-v1', 3);
      r.onupgradeneeded = () => {
        for (const name of ['cache', 'cacheRecords', 'cacheIndex', 'queryIndex', 'historyAccounts'])
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = reject;
      r.onblocked = () => reject(Error('历史存储升级等待其他页面关闭，请关闭旧标签页后刷新'));
    });
    db.onversionchange = () => db.close();
    const input = document.getElementById('supplementOtherMatches');
    if (input) {
      const key = 'qs-supplement:' + session.user.id;
      let immediate = null;
      try {
        immediate = localStorage.getItem(key);
      } catch {}
      input.checked =
        immediate === null
          ? !!(await store('cache', session.user.id + '|supplementOtherMatches'))
          : immediate === 'true';
      input.onchange = () => {
        try {
          localStorage.setItem(key, String(input.checked));
        } catch {}
        store('cache', session.user.id + '|supplementOtherMatches', input.checked).catch(() => {});
      };
    }
    return db;
  }
  function legacyEntries(data, legacyKey) {
    const a = [],
      put = (type, key, updatedAt, names = []) =>
        a.push({ id: id(type, key), scope, type, key, updatedAt, names, legacyKey, usedAt: 0 });
    const player = (p) => {
      if (!p.res?.error && p.res?.rankQueriedAt)
        put('profile', p.playerKey || 'n:' + tag(p.name), p.res.rankQueriedAt, [tag(p.name)]);
    };
    const game = (m) => {
      put('match', m.mid, m.dataQueriedAt || data.queriedAt);
      for (const p of m.players || []) player(p);
    };
    for (const m of data.matches || []) game(m);
    for (const p of data.queryCache?.profiles || []) player(p);
    for (const h of data.recentHistory || []) {
      if (!h.error) put('history', tag(h.name), h.queriedAt);
      for (const m of h.matches || []) game(m);
    }
    for (const r of data.queryCache?.battles || []) game(r.game);
    return a;
  }
  async function manifest() {
    const rows = (await all('cacheIndex')).filter((r) => r.scope === scope),
      index = new Map(rows.map((r) => [r.type + '|' + r.key, r]));
    // Old signed snapshots stay intact until the server verifies and upgrades them.
    const prefix =
      session.user.id + '|snapshot|' + session.scope.server + '|' + session.scope.dts + '|';
    await new Promise((resolve, reject) => {
      const r = db.transaction('cache').objectStore('cache').openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) {
          resolve();
          return;
        }
        if (String(c.key).startsWith(prefix) && c.value?.content?.data?.schemaVersion !== 3) {
          for (const m of legacyEntries(c.value?.content?.data || {}, c.key)) {
            const k = m.type + '|' + m.key,
              old = index.get(k);
            if (!old || Date.parse(m.updatedAt) > Date.parse(old.updatedAt)) index.set(k, m);
          }
        }
        c.continue();
      };
      r.onerror = reject;
    });
    manifestRows = [];
    for (const [type, max] of Object.entries(caps))
      manifestRows.push(
        ...[...index.values()]
          .filter((r) => r.type === type)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, max)
      );
    return manifestRows.map(({ type, key, updatedAt, names }) => ({ type, key, updatedAt, names }));
  }
  async function fulfill(job) {
    const request = job.cacheRequest;
    if (!request) return;
    const records = [],
      legacy = new Map();
    for (const key of request.keys) {
      const row =
        manifestRows.find((r) => r.type === key.type && r.key === key.key) ||
        (await store('cacheIndex', id(key.type, key.key)));
      if (!row) continue;
      const record = await store('cacheRecords', row.id);
      if (record) records.push(record);
      else if (row.legacyKey && !legacy.has(row.legacyKey))
        legacy.set(row.legacyKey, await store('cache', row.legacyKey));
      row.usedAt = Date.now();
      if (!row.legacyKey) await store('cacheIndex', row.id, row);
    }
    const batches = [];
    let batch = { records: [], legacyEnvelopes: [] };
    const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
    for (const [field, values] of [
      ['records', records],
      ['legacyEnvelopes', [...legacy.values()].filter(Boolean)]
    ])
      for (const value of values) {
        if (bytes(value) > 2700000) continue;
        const candidate = {
          records: [...batch.records],
          legacyEnvelopes: [...batch.legacyEnvelopes]
        };
        candidate[field].push(value);
        if (
          bytes(candidate) > 2800000 ||
          candidate.records.length > 80 ||
          candidate.legacyEnvelopes.length > 5
        ) {
          batches.push(batch);
          batch = { records: [], legacyEnvelopes: [] };
        }
        batch[field].push(value);
      }
    batches.push(batch);
    for (let i = 0; i < batches.length; i++)
      await Cloud.api('/api/job/' + job.id + '/cache', {
        batch: request.id,
        ...batches[i],
        complete: i === batches.length - 1
      });
  }
  async function save(envelope, records = [], ticket = null) {
    const data = envelope.content.data;
    lastReport = data.syncStatus;
    const query = {
      ticket,
      scope,
      tag: data.battletag,
      updatedAt: data.queriedAt,
      matches: (ticket?.content?.matches || data.matches)
        .slice(0, 50)
        .map((m) => ({ mid: m.mid, t: m.t, mapGuid: m.mapGuid }))
    };
    await store('queryIndex', scope + '|' + data.battletag, query);
    for (const record of records) {
      const c = record?.content;
      if (
        c?.user !== session.user.id ||
        c.server !== session.scope.server ||
        c.dts !== session.scope.dts
      )
        continue;
      const key = id(c.type, c.key),
        old = await store('cacheIndex', key);
      if (old && Date.parse(old.updatedAt) > Date.parse(c.updatedAt)) continue;
      await store('cacheRecords', key, record);
      await store('cacheIndex', key, {
        id: key,
        scope,
        type: c.type,
        key: c.key,
        updatedAt: c.updatedAt,
        names: c.names || [],
        usedAt: Date.now()
      });
    }
    await prune();
    await render();
  }
  async function render(report = lastReport) {
    if (report) lastReport = report;
    const el = document.getElementById('queryStats');
    if (el && lastReport) {
      const r = lastReport;
      el.textContent =
        (r.mode === 'fast' ? '快查询' : '慢查询') +
        ' · ' +
        r.playerSlots +
        ' 个玩家位 / ' +
        r.uniquePlayers +
        ' 位唯一玩家；详情新增 ' +
        r.fetchedMatches +
        ' / 复用 ' +
        r.reusedMatches +
        '；段位新查 ' +
        (r.rankRequests ?? r.rankFetches) +
        ' / 复用 ' +
        r.rankReuses +
        '；近期请求 ' +
        r.historyRequests +
        ' / 复用 ' +
        r.historyCacheHits;
    }
    const panel = document.getElementById('cacheRecordsBody');
    if (!panel) return;
    const rows = (await all('cacheIndex'))
        .filter((r) => r.scope === scope)
        .sort((a, b) => b.usedAt - a.usedAt),
      queries = (await all('queryIndex')).filter((r) => r.scope === scope);
    panel.replaceChildren();
    const summary = document.createElement('p');
    summary.textContent =
      '已查账号 ' +
      queries.length +
      ' · 对局 ' +
      rows.filter((r) => r.type === 'match').length +
      ' · 玩家快照 ' +
      rows.filter((r) => r.type === 'profile').length +
      ' · 近期参考 ' +
      rows.filter((r) => r.type === 'history').length;
    panel.append(summary);
    for (const q of queries.slice(0, 10)) {
      const line = document.createElement('p');
      line.textContent =
        q.tag +
        ' · 保留 ' +
        q.matches.length +
        ' 场 · ' +
        new Date(q.updatedAt).toLocaleString('zh-CN');
      panel.append(line);
    }
    for (const r of rows.slice(0, 60)) {
      const line = document.createElement('p'),
        age = Date.now() - Date.parse(r.updatedAt),
        ttl =
          r.type === 'profile'
            ? 21600000
            : r.type === 'history'
              ? (await store('cacheRecords', r.id))?.content?.value?.refs?.length
                ? 21600000
                : 900000
              : Infinity;
      line.textContent =
        { match: '对局', profile: '玩家', history: '近期参考' }[r.type] +
        ' · ' +
        (r.names?.[0] || r.key) +
        ' · ' +
        new Date(r.updatedAt).toLocaleString('zh-CN') +
        ' · ' +
        (age >= 0 && age < ttl ? '有效' : '过期') +
        (lastReport?.cacheHitKeys?.includes(r.type + '|' + r.key) ? ' · 本次命中' : '');
      panel.append(line);
    }
  }
  root.CloudCache = {
    initialize,
    manifest,
    fulfill,
    save,
    render,
    queryIndex: async (name) => (await store('queryIndex', scope + '|' + name))?.ticket || null
  };
})(window);
