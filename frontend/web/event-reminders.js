'use strict';
(() => {
  if (window.EventReminders || !window.Cloud) return;
  const cloud = window.Cloud,
    state = {
      ready: false,
      enabled: false,
      publicKey: '',
      reservations: [],
      notices: [],
      deviceEnabled: false,
      error: '',
      pending: false
    };
  let userId = '',
    timer,
    refreshing,
    registration,
    toast,
    toastTimer,
    stopped = false,
    syncingDevice = false;
  const tabId = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const emit = () => window.dispatchEvent(new CustomEvent('owqs:reminders', { detail: state }));
  const supported = () =>
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;
  function safeUrl(value) {
    try {
      const u = new URL(value, location.origin);
      if (u.username || u['pass' + 'word']) return null;
      if (u.origin === location.origin && /^\/tools\/events(?:\/|\.html)?$/.test(u.pathname))
        return u.href;
      if (u.protocol !== 'https:' || u.port) return null;
      const hosts = ['twitch.tv', 'bilibili.com', 'b23.tv', 'sooplive.com', 'sooplive.co.kr'];
      return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h)) ? u.href : null;
    } catch {
      return null;
    }
  }
  const key = (name) => 'owqs:reminders:' + encodeURIComponent(userId) + ':' + name;
  const memorySeen = Object.create(null);
  function readSeen() {
    try {
      const saved = JSON.parse(localStorage.getItem(key('seen')) || '{}');
      return { ...(saved && typeof saved === 'object' ? saved : {}), ...memorySeen };
    } catch {
      return { ...memorySeen };
    }
  }
  function showNotice(item) {
    const url = safeUrl(item.url),
      node = document.createElement('aside');
    node.className = 'event-reminder-toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-label', '即将开赛');
    const title = document.createElement(url ? 'a' : 'strong');
    title.textContent =
      item.count > 1
        ? `${item.count} 条开赛提醒`
        : Number.isFinite(item.createdAt) && Date.now() - item.createdAt > 5 * 60000
          ? '开赛提醒（补提醒）'
          : '即将开赛';
    title.className = 'event-reminder-toast-title';
    if (url) {
      title.href = url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭开赛提醒');
    const footer = document.createElement('div');
    footer.className = 'event-reminder-toast-countdown';
    footer.setAttribute('aria-hidden', 'true');
    node.append(title, close, footer);
    toast = node;
    let seconds = 3;
    const dismiss = () => {
      clearInterval(toastTimer);
      node.remove();
      if (toast === node) toast = null;
    };
    close.onclick = dismiss;
    document.body.append(node);
    toastTimer = setInterval(() => {
      seconds--;
      if (seconds <= 0) dismiss();
    }, 1000);
  }
  async function claim(item, batch = [item]) {
    if (stopped || toast || document.visibilityState !== 'visible' || !userId || !item?.id) return;
    const take = () => {
      if (stopped || toast || document.visibilityState !== 'visible') return;
      const seen = readSeen(),
        id = String(item.id);
      if (Object.prototype.hasOwnProperty.call(seen, id)) return;
      const now = Date.now(),
        entries = Object.entries(seen)
          .filter(([, t]) => Number(t) > now - 30 * 86400000)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 999);
      const next = Object.fromEntries(entries),
        unseen = batch.filter(
          (n) => n?.id && !Object.prototype.hasOwnProperty.call(seen, String(n.id))
        );
      for (const notice of unseen) {
        const noticeId = String(notice.id);
        Object.defineProperty(next, noticeId, { value: now, enumerable: true });
        memorySeen[noticeId] = now;
      }
      // Private browsing/storage limits must not silently discard in-page reminders.
      // Without shared storage, deduplication is necessarily limited to this tab.
      try {
        localStorage.setItem(key('seen'), JSON.stringify(next));
      } catch {
        /* Use memorySeen. */
      }
      showNotice({
        ...item,
        count: unseen.length,
        url: unseen.length > 1 ? '/tools/events' : item.url
      });
    };
    if (navigator.locks?.request) {
      await navigator.locks.request(key('notice-lock'), take);
      return;
    }
    // Older browsers use a short storage lease, followed by ownership verification.
    const leaseKey = key('lease');
    let lease;
    try {
      lease = JSON.parse(localStorage.getItem(leaseKey) || 'null');
      if (lease?.until > Date.now()) return;
      localStorage.setItem(leaseKey, JSON.stringify({ owner: tabId, until: Date.now() + 2000 }));
    } catch {
      take();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 80));
    try {
      if (JSON.parse(localStorage.getItem(leaseKey) || 'null')?.owner !== tabId) return;
      take();
      if (JSON.parse(localStorage.getItem(leaseKey) || 'null')?.owner === tabId)
        localStorage.removeItem(leaseKey);
    } catch {
      take();
    }
  }
  async function deliver() {
    if (!state.enabled || toast || stopped || document.visibilityState !== 'visible') return;
    const seen = readSeen(),
      unseen = state.notices
        .filter((item) => item?.id && !Object.prototype.hasOwnProperty.call(seen, String(item.id)))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (unseen.length) await claim(unseen[0], unseen);
  }
  function schedule() {
    clearTimeout(timer);
    if (!stopped)
      timer = setTimeout(
        () => {
          void refresh().catch(() => {});
        },
        document.visibilityState === 'visible' ? 15000 : 60000
      );
  }
  async function getRegistration() {
    if (!supported()) throw Error('此浏览器暂不支持系统推送，请使用支持推送的 HTTPS 浏览器。');
    // The worker only handles reminders; keep its scope separate from application workers.
    registration =
      registration ||
      (await navigator.serviceWorker.register('/event-reminders-sw.js', {
        scope: '/event-reminders/',
        updateViaCache: 'none'
      }));
    if (!registration.active)
      await new Promise((resolve, reject) => {
        const worker = registration.installing || registration.waiting;
        if (!worker) {
          reject(Error('通知服务未就绪，请重试。'));
          return;
        }
        const timeout = setTimeout(() => reject(Error('通知服务启动超时，请重试。')), 15000);
        const changed = () => {
          if (worker.state === 'activated') {
            clearTimeout(timeout);
            worker.removeEventListener('statechange', changed);
            resolve();
          } else if (worker.state === 'redundant') {
            clearTimeout(timeout);
            worker.removeEventListener('statechange', changed);
            reject(Error('通知服务启动失败，请重试。'));
          }
        };
        worker.addEventListener('statechange', changed);
        changed();
      });
    return registration;
  }
  async function existingSubscription() {
    if (!supported()) return null;
    const r = await getRegistration();
    return r.pushManager.getSubscription();
  }
  async function syncDevice() {
    if (syncingDevice || !state.enabled || !supported() || Notification.permission !== 'granted')
      return;
    syncingDevice = true;
    try {
      const subscription = await existingSubscription();
      if (subscription) {
        await cloud.api('/api/events/reminders/subscribe', { subscription: subscription.toJSON() });
        state.deviceEnabled = true;
      }
    } catch (error) {
      state.deviceEnabled = false;
      state.error = error.message;
    } finally {
      syncingDevice = false;
      emit();
    }
  }
  function refresh() {
    if (!state.ready) return ready.then(() => refresh());
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const value = await cloud.api('/api/events/reminders');
        if (stopped) return state;
        state.enabled = value.enabled === true;
        state.publicKey = typeof value.publicKey === 'string' ? value.publicKey : '';
        state.reservations = Array.isArray(value.reservations) ? value.reservations : [];
        state.notices = Array.isArray(value.notices) ? value.notices : [];
        state.error = '';
        state.deviceEnabled = false;
        if (state.enabled && supported() && Notification.permission === 'granted') {
          try {
            state.deviceEnabled = !!(await existingSubscription());
          } catch (error) {
            state.error = error.message;
          }
        }
        emit();
        await deliver();
        return state;
      } catch (error) {
        state.error = error.message;
        emit();
        throw error;
      } finally {
        refreshing = null;
        schedule();
      }
    })();
    return refreshing;
  }
  function permissionFromClick() {
    if (!state.ready) throw Error('正在读取提醒设置，请稍后重试。');
    if (!state.enabled) throw Error('开赛提醒服务尚未启用。');
    if (!supported()) throw Error('此浏览器暂不支持系统推送，请使用支持推送的 HTTPS 浏览器。');
    if (Notification.permission === 'denied')
      throw Error('系统通知已被阻止，请在浏览器网站设置中允许通知后重试。');
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (!window.confirm('开赛提醒会发送到此账号所有已启用通知的设备。是否允许此浏览器接收通知？'))
      throw Error('已取消启用通知，尚未预约。');
    // Call synchronously inside the original click, before any await or network request.
    return Notification.requestPermission();
  }
  function applicationKey(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) =>
      c.charCodeAt(0)
    );
  }
  async function enableWith(permission) {
    if ((await permission) !== 'granted') throw Error('未获得通知权限，请允许通知后重试。');
    if (!state.publicKey) throw Error('开赛提醒服务尚未配置完成。');
    const r = await getRegistration();
    let subscription = await r.pushManager.getSubscription();
    if (!subscription)
      subscription = await r.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey(state.publicKey)
      });
    await cloud.api('/api/events/reminders/subscribe', { subscription: subscription.toJSON() });
    state.deviceEnabled = true;
    emit();
  }
  async function mutate(action) {
    if (state.pending) throw Error('正在保存提醒设置，请稍候。');
    state.pending = true;
    state.error = '';
    emit();
    try {
      const value = await action();
      await refresh();
      return value;
    } catch (error) {
      state.error = error.message;
      emit();
      throw error;
    } finally {
      state.pending = false;
      emit();
    }
  }
  function enable() {
    if (state.pending) return Promise.reject(Error('正在保存提醒设置，请稍候。'));
    let permission;
    try {
      permission = permissionFromClick();
    } catch (error) {
      return Promise.reject(error);
    }
    return mutate(() => enableWith(permission));
  }
  function reserve(matchId) {
    if (state.pending) return Promise.reject(Error('正在保存提醒设置，请稍候。'));
    let permission;
    try {
      permission = permissionFromClick();
    } catch (error) {
      return Promise.reject(error);
    }
    return mutate(async () => {
      await enableWith(permission);
      return cloud.api('/api/events/reminders/reserve', { matchId });
    });
  }
  function cancel(id) {
    return mutate(async () => {
      if (!state.enabled) throw Error('开赛提醒服务尚未启用。');
      return cloud.api('/api/events/reminders/cancel', { id });
    });
  }
  function disable() {
    return mutate(async () => {
      const subscription = await existingSubscription();
      if (subscription) {
        await cloud.api('/api/events/reminders/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      state.deviceEnabled = false;
    });
  }
  window.EventReminders = {
    enable,
    reserve,
    cancel,
    disable,
    refresh,
    state,
    getReady: () => ready,
    safeUrl
  };
  // Both Cloud clients cache bootPromise. Reuse that initialization and its authenticated user id.
  const ready = cloud
    .boot()
    .then(async (session) => {
      if (!session?.user?.id) throw Error('无法读取当前账号。');
      userId = String(session.user.id);
      state.ready = true;
      await refresh();
      await syncDevice();
      return state;
    })
    .catch((error) => {
      state.error = error.message;
      emit();
      throw error;
    });
  void ready.catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refresh().catch(() => {});
      void deliver();
    } else schedule();
  });
  window.addEventListener('storage', (event) => {
    if (userId && event.key === key('seen')) void deliver();
  });
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'owqs:reminders:poll') void refresh().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(toastTimer);
    toast?.remove();
    toast = null;
  });
  window.addEventListener('pageshow', () => {
    stopped = false;
    void refresh().catch(() => {});
  });
})();
