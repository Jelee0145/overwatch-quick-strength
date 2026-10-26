'use strict';
const fallback = () => self.location.origin + '/tools/events';
function safeReminderUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.username || url['pass' + 'word']) return fallback();
    if (url.origin === self.location.origin && /^\/tools\/events(?:\/|\.html)?$/.test(url.pathname))
      return url.href;
    if (url.protocol !== 'https:' || url.port) return fallback();
    return ['twitch.tv', 'bilibili.com', 'b23.tv', 'sooplive.com', 'sooplive.co.kr'].some(
      (host) => url.hostname === host || url.hostname.endsWith('.' + host)
    )
      ? url.href
      : fallback();
  } catch {
    return fallback();
  }
}
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
async function wakePages() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const page of pages) page.postMessage({ type: 'owqs:reminders:poll' });
}
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    /* Malformed payload still gets a generic reminder. */
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification('即将开赛', {
        data: { url: safeReminderUrl(payload.url) },
        ...(payload.id ? { tag: 'owqs-reminder-' + String(payload.id) } : {})
      }),
      wakePages()
    ])
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeReminderUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      await wakePages();
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = pages.find((page) => page.url === url);
      if (existing) await existing.focus();
      else await self.clients.openWindow(url);
    })()
  );
});
