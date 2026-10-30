(function (root) {
  'use strict';
  if (root.OWQS_ASSET_PRELOAD) return;
  const PLAN = '__ASSET_PLAN_URL__',
    KEY = 'owqs:asset-progress:v1',
    BUDGET = 8 * 1024 * 1024,
    QUIET = 3000;
  let plan = null,
    cursor = 0,
    used = 0,
    failures = 0,
    timer = null,
    controller = null,
    lastActivity = Date.now(),
    loaded = false;
  const state = (root.OWQS_ASSET_PRELOAD = { completed: 0, bytes: 0 });
  const allowed =
    /^\/(?:static\/[a-z0-9-]+\.[a-f0-9]{16}\.(?:js|css|svg)|media\/(?:maps|icons)\/[a-f0-9]{20}\.webp|media\/heroes\/[a-z0-9-]+\.[a-f0-9]{16}\.png)$/;
  function blocked() {
    const n = navigator.connection;
    return (
      document.hidden ||
      navigator.onLine === false ||
      n?.saveData ||
      /^(slow-)?2g$/.test(n?.effectiveType) ||
      root.QS_ASSETS?.busy() ||
      !!document.querySelector('#cancel:not([hidden]), #drawButton:disabled, .drawing')
    );
  }
  function schedule(delay = QUIET) {
    clearTimeout(timer);
    if (loaded && used < BUDGET && failures < 3)
      timer = setTimeout(() => {
        if (root.requestIdleCallback) root.requestIdleCallback(run, { timeout: 2000 });
        else run();
      }, delay);
  }
  function interrupt() {
    lastActivity = Date.now();
    controller?.abort();
    schedule();
  }
  function save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ version: plan.version, cursor, time: Date.now() })
      );
    } catch {}
  }
  async function run() {
    if (controller) return;
    if (blocked() || Date.now() - lastActivity < QUIET) {
      schedule();
      return;
    }
    if (plan && cursor >= plan.assets.length) return;
    controller = new AbortController();
    const current = controller,
      timeout = setTimeout(() => current.abort(), 15000);
    try {
      if (!plan) {
        const response = await fetch(PLAN, {
          cache: 'force-cache',
          credentials: 'omit',
          priority: 'low',
          signal: current.signal
        });
        if (!response.ok) throw Error('plan');
        const text = await response.text();
        if (text.length > 65536) throw Error('plan size');
        const value = JSON.parse(text);
        if (
          !/^[a-f0-9]{16}$/.test(value.version) ||
          !Array.isArray(value.assets) ||
          value.assets.length > 512 ||
          value.assets.some(
            (a) =>
              !allowed.test(a.url) ||
              !Number.isSafeInteger(a.bytes) ||
              a.bytes <= 0 ||
              a.bytes > 1024 * 1024
          )
        )
          throw Error('plan assets');
        plan = value;
        try {
          const saved = JSON.parse(localStorage.getItem(KEY));
          if (
            saved?.version === plan.version &&
            Date.now() - saved.time < 86400000 &&
            Number.isInteger(saved.cursor) &&
            saved.cursor >= 0 &&
            saved.cursor <= plan.assets.length
          )
            cursor = saved.cursor;
        } catch {}
      } else {
        const asset = plan.assets[cursor],
          already = root.performance
            ?.getEntriesByType('resource')
            .some((entry) => entry.name === new URL(asset.url, location.origin).href);
        if (!already && asset.bytes > BUDGET - used) {
          used = BUDGET;
          return;
        }
        if (!already) {
          const response = await fetch(asset.url, {
            cache: 'force-cache',
            credentials: 'omit',
            priority: 'low',
            signal: current.signal
          });
          if (!response.ok) throw Error('asset');
          await response.arrayBuffer();
          used += asset.bytes;
          state.bytes = used;
        }
        cursor++;
        state.completed++;
        save();
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        if (plan) {
          cursor++;
          save();
        } else failures++;
      }
    } finally {
      clearTimeout(timeout);
      if (controller === current) controller = null;
      schedule(failures ? 30000 : 750);
    }
  }
  for (const event of ['pointerdown', 'keydown', 'input', 'scroll', 'submit', 'owqs:assets-needed'])
    root.addEventListener(event, interrupt, { passive: true, capture: true });
  document.addEventListener('visibilitychange', interrupt);
  root.addEventListener('online', interrupt);
  navigator.connection?.addEventListener?.('change', interrupt);
  function start() {
    loaded = true;
    lastActivity = Date.now();
    schedule();
  }
  if (document.readyState === 'complete') start();
  else root.addEventListener('load', start, { once: true });
})(window);
