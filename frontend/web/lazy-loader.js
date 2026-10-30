'use strict';
// Extras, the phone layout and reminders are not needed for the first query; one loader fetches each on its own trigger.
(() => {
  const config = __OWQS_LAZY__;
  const targets = {
    extras: { url: config.extras, marker: 'appExtras' },
    mobile: { url: config.mobile, marker: 'appMobile' },
    reminders: { url: config.reminders, marker: 'eventReminders' }
  };
  const started = new Set();
  function load(name) {
    const target = targets[name];
    if (!target || !target.url || started.has(name)) return;
    started.add(name);
    const script = document.createElement('script');
    script.src = target.url;
    script.async = true;
    script.dataset[target.marker] = '';
    document.head.append(script);
  }
  function afterIdle(callback) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 1000 });
    else setTimeout(callback, 50);
  }
  // Extras join the startup wave, deferred only by this script's own defer.
  load('extras');
  // The phone layout is only fetched when its media query already matches, so desktop never downloads it.
  if (targets.mobile.url) {
    const media = matchMedia('(max-width:760px), (max-height:500px) and (pointer:coarse)');
    const startMobile = () => {
      if (media.matches) load('mobile');
    };
    startMobile();
    media.addEventListener?.('change', startMobile);
  }
  // Reminders wait for the page to be interactive; the events page includes the engine directly.
  if (targets.reminders.url) {
    const startReminders = () => {
      if (!window.EventReminders) load('reminders');
    };
    if (document.readyState === 'complete') afterIdle(startReminders);
    else window.addEventListener('load', () => afterIdle(startReminders), { once: true });
  }
})();
