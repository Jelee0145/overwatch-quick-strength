'use strict';
// Reuse the established IndexedDB schema and per-user cache keys, including changelog reads.
window.Cloud = (() => {
  let session, db, bootPromise;
  const login = () => location.replace('/login?next=' + encodeURIComponent(location.pathname));
  const transport = OWQS_HTTP.create({ csrf: () => session?.csrf || '', unauthorized: login });
  const api = (path, body) =>
    transport(path.replace(/^\/api\/(auth|events)(?=[/?]|$)/, '/api/v1/$1'), body);
  async function verify() {
    const value = await api('/api/auth/session');
    if (value.user.status !== 'approved') {
      login();
      throw Error('账号等待授权');
    }
    return value;
  }
  async function initialize() {
    session = await verify();
    try {
      db = await CloudCache.initialize(session);
    } catch {
      db = OWQS_HTTP.memoryDatabase();
    }
    document.getElementById('cloudIdentity').textContent = session.user.email;
    document.getElementById('cloudLogout').onclick = async () => {
      try {
        await api('/api/auth/logout', {});
        location.replace('/login');
      } catch (e) {
        showError(e);
      }
    };
    document.body.classList.remove('cloud-pending');
    return session;
  }
  function showError(error) {
    const notice = document.getElementById('sessionError');
    notice.hidden = false;
    notice.textContent = error.message;
  }
  const boot = () =>
    bootPromise ||
    (bootPromise = initialize().catch((error) => {
      bootPromise = null;
      showError(error);
      throw error;
    }));
  async function storage(key, value) {
    await boot();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('cache', value === undefined ? 'readonly' : 'readwrite'),
        request =
          value === undefined
            ? tx.objectStore('cache').get(session.user.id + '|' + key)
            : tx.objectStore('cache').put(value, session.user.id + '|' + key);
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(Error('本地记录保存失败'));
    });
  }
  window.addEventListener('focus', () => {
    if (session) verify().catch(showError);
  });
  return { boot, storage, verify, api };
})();
Cloud.boot().catch(() => {});
