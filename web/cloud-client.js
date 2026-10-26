'use strict';
window.Cloud = (() => {
  let session = null,
    db = null,
    csrf = '',
    lastTag = '',
    bootPromise = null,
    persistent = true;
  const transport = OWQS_HTTP.create({
    csrf: () => csrf,
    unauthorized: () => {
      if (session) location.assign('/login');
    }
  });
  function api(path, body) {
    path = path
      .replace(/^\/api\/job\//, '/api/v1/jobs/')
      .replace(/^\/api\/(auth|admin|events)(?=[/?]|$)/, '/api/v1/$1')
      .replace(/^\/api\/history$/, '/api/v1/history')
      .replace(/^\/api\/query$/, '/api/v1/query');
    return transport(path, body);
  }
  async function jobs() {
    await boot();
    try {
      const value = await api('/api/v1/jobs');
      return value.tasks || [];
    } catch (error) {
      if (error.status && error.status < 500) throw error;
      return [];
    }
  }
  const initialize = async () => {
    session = await api('/api/auth/session');
    csrf = session.csrf;
    if (session.user.status !== 'approved') {
      location.assign('/login');
      throw Error('等待授权');
    }
    document.body.classList.remove('cloud-pending');
    document.getElementById('cloudIdentity').textContent = session.user.email;
    document.getElementById('cloudLogout').onclick = async () => {
      try {
        await api('/api/auth/logout', {});
        location.assign('/login');
      } catch (e) {
        alert(e.message);
      }
    };
    try {
      db = await CloudCache.initialize(session);
    } catch {
      persistent = false;
      db = OWQS_HTTP.memoryDatabase();
      const notice = document.getElementById('status');
      if (notice) notice.textContent = '本机存储不可用，本次历史仅在当前页面保留';
    }
    await CloudHistory.initialize(db, session);
    return session;
  };
  const boot = () =>
    bootPromise ||
    (bootPromise = initialize().catch((e) => {
      bootPromise = null;
      throw e;
    }));
  async function storage(key, value) {
    await boot();
    key = session.user.id + '|' + key;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cache', value === undefined ? 'readonly' : 'readwrite'),
        r =
          value === undefined
            ? tx.objectStore('cache').get(key)
            : tx.objectStore('cache').put(value, key);
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(Error('本地缓存读取或保存失败'));
    });
  }
  const scope = () => session.scope.server + '|' + session.scope.dts;
  const snapshot = async (tag) => {
    await boot();
    return storage('snapshot|' + scope() + '|' + tag);
  };
  async function save(envelope, records = [], queryIndex = null) {
    if (!envelope?.content?.data) throw Error('查询结果缺少可信签名');
    await CloudHistory.save(envelope);
    lastTag = envelope.content.data.battletag;
    await storage('snapshot|' + scope() + '|' + lastTag, envelope);
    await storage('latest', lastTag);
    window.OWQS_SERVER_ANALYSIS?.invalidate(lastTag);
    if (persistent) await CloudCache.save(envelope, records, queryIndex);
    void CloudHistory.sync();
  }
  async function latest() {
    await boot();
    await CloudHistory.sync();
    const tasks = await jobs(),
      active = tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.state)),
      remote = {
        activeJob: active.find((t) => t.kind === 'query')?.id,
        activeAI: active.find((t) => ['ai', 'ai-review', 'review'].includes(t.kind))?.id
      },
      savedTag = await storage('latest'),
      accounts = await CloudHistory.list(),
      tag = accounts.some((a) => a.tag === savedTag) ? savedTag : accounts[0]?.tag;
    const value = tag ? await snapshot(tag) : null;
    if (persistent) await CloudCache.render(value?.content?.data?.syncStatus);
    return { ...remote, historyTag: tag, result: value?.content?.data || null };
  }
  async function startQuery(tag, limit, supplementOtherMatches = false, pool = '') {
    await boot();
    return api('/api/query', {
      battletag: tag,
      limit,
      supplementOtherMatches,
      pool,
      requestId: crypto.randomUUID()
    });
  }
  const key = async (value) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
      ),
      (n) => n.toString(16).padStart(2, '0')
    ).join('');
  return { api, boot, snapshot, save, latest, startQuery, storage, key, jobs };
})();
