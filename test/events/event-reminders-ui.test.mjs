import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A non-default port exercises the same-origin rule, which must be checked before the external HTTPS rule.
const ORIGIN = 'https://site.test:8443';
const FRONTEND = fs.readFileSync(new URL('../../web/event-reminders.js', import.meta.url), 'utf8');
const WORKER = fs.readFileSync(new URL('../../web/event-reminders-sw.js', import.meta.url), 'utf8');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

// Both tabs receive the same lock manager, matching the browser's origin-wide Web Locks.
function createLocks() {
  const tails = new Map();
  return {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const run = previous.then(() => callback());
      tails.set(name, run.then(() => {}, () => {}));
      return run;
    }
  };
}

function createClock() {
  let now = 1_000_000;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, {callback, at: now + Number(delay), every: null});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, {callback, at: now + Number(delay), every: Number(delay) || 1});
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advance(amount) {
      const target = now + amount;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) {
            nextId = id;
            next = timer;
          }
        }
        if (!next) break;
        timers.delete(nextId);
        now = next.at;
        next.callback();
        if (next.every !== null) timers.set(nextId, {callback: next.callback, at: now + next.every, every: next.every});
      }
      now = target;
    }
  };
}

function createElement(tagName) {
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    className: '',
    type: '',
    href: '',
    target: '',
    rel: '',
    onclick: null,
    _text: '',
    setAttribute(name, value) {
      this.attributes[String(name)] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    append(...children) {
      for (const child of children) {
        child.parentNode = this;
        this.children.push(child);
      }
    },
    remove() {
      if (this.parentNode) {
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
      }
      this.parentNode = null;
    }
  };
  Object.defineProperty(element, 'textContent', {
    get() {
      return this._text + this.children.map(child => child.textContent).join('');
    },
    set(value) {
      this._text = String(value);
    }
  });
  return element;
}

function createDocument(visibility) {
  const listeners = {};
  const body = createElement('body');
  return {
    body,
    visibilityState: visibility,
    createElement,
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    },
    dispatch(type) {
      for (const listener of listeners[type] || []) listener({type});
    }
  };
}

let tabSequence = 0;

function createPage(options = {}) {
  const origin = options.origin || ORIGIN;
  const clock = options.clock || createClock();
  const storage = options.storage || createStorage();
  const locks = options.locks === false ? undefined : options.locks || createLocks();
  const document = createDocument(options.visibility || 'visible');
  const apiCalls = [];
  const page = {storage, locks, clock, document, apiCalls, notices: options.notices || []};
  const windowListeners = {};

  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  function Notification() {}
  Notification.permission = options.permission || 'granted';
  Notification.requestPermission = () => (options.requestPermission
    ? options.requestPermission()
    : Promise.resolve(Notification.permission));

  const registration = {
    active: {},
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => ({toJSON: () => ({endpoint: 'https://push.test/subscription'})})
    }
  };

  const cloud = {
    boot: async () => {
      if (options.bootError) throw options.bootError;
      return {user: {id: options.userId || 'user-1'}};
    },
    api: async (path, body) => {
      apiCalls.push({path, body});
      if (path === '/api/events/reminders') {
        return {
          enabled: options.enabled !== false,
          publicKey: '',
          reservations: [],
          notices: page.notices
        };
      }
      return {};
    }
  };

  class MockPushManager {}

  const window = {
    isSecureContext: true,
    Cloud: cloud,
    Notification,
    PushManager: MockPushManager,
    confirm: options.confirm || (() => true),
    addEventListener(type, listener) {
      (windowListeners[type] ||= []).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners[event.type] || []) listener(event);
      return true;
    }
  };

  const navigator = {
    locks,
    serviceWorker: {
      register: async () => registration,
      addEventListener() {}
    }
  };

  const sandbox = {
    window,
    document,
    navigator,
    location: {origin},
    localStorage: storage,
    Notification,
    CustomEvent: MockCustomEvent,
    crypto: {randomUUID: () => 'tab-' + (++tabSequence)},
    URL,
    atob,
    Date: class extends Date {
      static now() {
        return clock.now();
      }
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval
  };
  vm.createContext(sandbox);
  vm.runInContext(FRONTEND, sandbox, {filename: 'web/event-reminders.js'});
  page.reminders = sandbox.window.EventReminders;
  page.dispatchWindow = (type, properties = {}) => window.dispatchEvent({type, ...properties});
  return page;
}

function textsOf(node) {
  const texts = [];
  (function walk(current) {
    if (current._text) texts.push(current._text);
    for (const child of current.children) walk(child);
  })(node);
  return texts;
}

async function settle(turns = 20) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function createServiceWorker() {
  const listeners = {};
  const shown = [];
  const opened = [];
  const focused = [];
  const pages = [];
  const self = {
    // The worker's own host has no port, while reminder URLs may use the app's 8443 origin.
    location: {origin: 'https://site.test'},
    registration: {
      showNotification(title, options) {
        shown.push({title, options});
      }
    },
    clients: {
      matchAll: async () => pages,
      openWindow: async url => {
        opened.push(url);
        return {};
      }
    },
    skipWaiting: async () => {},
    claim: async () => {},
    addEventListener(type, listener) {
      (listeners[type] ||= []).push(listener);
    }
  };
  const sandbox = {self, URL};
  vm.createContext(sandbox);
  vm.runInContext(WORKER, sandbox, {filename: 'web/event-reminders-sw.js'});

  async function dispatch(type, event) {
    const waits = [];
    const fullEvent = {...event, waitUntil: promise => waits.push(promise)};
    for (const listener of listeners[type] || []) listener(fullEvent);
    await Promise.all(waits);
  }

  function addPage(url) {
    const page = {
      url,
      messages: [],
      postMessage(message) {
        this.messages.push(message);
      },
      focus: async () => focused.push(url)
    };
    pages.push(page);
    return page;
  }

  return {dispatch, shown, opened, focused, pages, addPage};
}

test('the toast contains only the start label and close button, then dismisses after three seconds', async () => {
  const page = createPage({notices: [{id: 'notice-1', url: 'https://twitch.tv/example'}]});
  await page.reminders.getReady();

  assert.equal(page.document.body.children.length, 1);
  const toast = page.document.body.children[0];
  assert.equal(toast.tagName, 'ASIDE');
  assert.equal(toast.className, 'event-reminder-toast');
  assert.equal(toast.getAttribute('role'), 'status');
  assert.equal(toast.getAttribute('aria-label'), '即将开赛');
  assert.deepEqual(textsOf(toast), ['即将开赛', '×']);
  assert.deepEqual(toast.children.map(child => child.tagName), ['A', 'BUTTON', 'DIV']);
  assert.equal(toast.children[0].href, 'https://twitch.tv/example');
  assert.equal(toast.children[0].target, '_blank');
  assert.equal(toast.children[0].rel, 'noopener noreferrer');
  assert.equal(toast.children[1].getAttribute('aria-label'), '关闭开赛提醒');
  assert.equal(toast.children[2].className, 'event-reminder-toast-countdown');
  assert.equal(toast.children[2].getAttribute('aria-hidden'), 'true');
  assert.equal(toast.children[2].textContent, '');
  assert.equal(toast.children[2].children.length, 0);

  page.clock.advance(2999);
  assert.equal(page.document.body.children.length, 1);
  page.clock.advance(1);
  assert.equal(page.document.body.children.length, 0);

  // An unsafe URL is not turned into a link, and the close button dismisses immediately.
  page.notices = [{id: 'notice-2', url: 'javascript:alert(1)'}];
  await page.reminders.refresh();
  assert.equal(page.document.body.children.length, 1);
  const second = page.document.body.children[0];
  assert.equal(second.children[0].tagName, 'STRONG');
  assert.deepEqual(textsOf(second), ['即将开赛', '×']);
  second.children[1].onclick();
  assert.equal(page.document.body.children.length, 0);

  // Same-origin pages on the non-default port stay links; external URLs with a port, or
  // same-origin pages outside /tools/events, are rejected.
  const safeUrl = page.reminders.safeUrl;
  assert.equal(safeUrl('https://site.test:8443/tools/events?match=1'), 'https://site.test:8443/tools/events?match=1');
  assert.equal(safeUrl('https://site.test:8443/tools/events/'), 'https://site.test:8443/tools/events/');
  assert.equal(safeUrl('https://site.test:8443/tools/events.html'), 'https://site.test:8443/tools/events.html');
  assert.equal(safeUrl('https://site.test:8443/tools/other'), null);
  assert.equal(safeUrl('https://twitch.tv:8443/channel'), null);
  assert.equal(safeUrl('https://evil.test/tools/events'), null);
  assert.equal(safeUrl('https://user:secret@twitch.tv/channel'), null);
  assert.equal(safeUrl('https://user@twitch.tv/channel'), null);
  assert.equal(safeUrl('https://twitch.tv/channel'), 'https://twitch.tv/channel');

  // A localhost dev origin also accepts its own events pages before the external rules apply.
  const localhost = createPage({origin: 'https://localhost:8443'});
  await localhost.reminders.getReady();
  assert.equal(localhost.reminders.safeUrl('https://localhost:8443/tools/events'), 'https://localhost:8443/tools/events');
  assert.equal(localhost.reminders.safeUrl('/tools/events'), 'https://localhost:8443/tools/events');
  assert.equal(localhost.reminders.safeUrl('https://localhost:8443/tools/events.html'), 'https://localhost:8443/tools/events.html');
  assert.equal(localhost.reminders.safeUrl('https://localhost:8443/tools/events/other'), null);
});

test('two tabs sharing storage and locks show a matching notice only once', async () => {
  const storage = createStorage();
  const locks = createLocks();
  const notices = [{id: 'shared-notice', url: 'https://twitch.tv/shared'}];
  const first = createPage({storage, locks, notices});
  const second = createPage({storage, locks, notices});

  await Promise.all([first.reminders.getReady(), second.reminders.getReady()]);

  const toasts = first.document.body.children.length + second.document.body.children.length;
  assert.equal(toasts, 1);
  const seen = JSON.parse(storage.getItem('owqs:reminders:user-1:seen'));
  assert.deepEqual(Object.keys(seen), ['shared-notice']);
});

test('a hidden page does not claim a notice until it becomes visible', async () => {
  const page = createPage({visibility: 'hidden', notices: [{id: 'hidden-notice', url: 'https://twitch.tv/hidden'}]});
  await page.reminders.getReady();

  assert.equal(page.document.body.children.length, 0);
  assert.equal(page.storage.getItem('owqs:reminders:user-1:seen'), null);

  page.document.visibilityState = 'visible';
  page.document.dispatch('visibilitychange');
  await settle();

  assert.equal(page.document.body.children.length, 1);
  const seen = JSON.parse(page.storage.getItem('owqs:reminders:user-1:seen'));
  assert.deepEqual(Object.keys(seen), ['hidden-notice']);
});

test('unavailable local storage falls back to per-tab memory, with and without Web Locks', async () => {
  for (const locks of [createLocks(), false]) {
    const storage = {
      getItem() { throw Error('Storage blocked'); },
      setItem() { throw Error('Storage blocked'); },
      removeItem() { throw Error('Storage blocked'); }
    };
    const page = createPage({storage, locks, notices: [{id: 'memory-only', url: '/tools/events'}]});
    await page.reminders.getReady();
    assert.equal(page.document.body.children.length, 1);
    page.clock.advance(3000);
    await page.reminders.refresh();
    assert.equal(page.document.body.children.length, 0, 'the same notice does not replay in this tab');
  }
});

test('quota errors writing the seen set do not suppress a notice', async () => {
  const storage = createStorage();
  storage.setItem = () => { throw Error('Quota exceeded'); };
  const page = createPage({storage, notices: [{id: 'quota-notice', url: '/tools/events'}]});
  await page.reminders.getReady();
  assert.equal(page.document.body.children.length, 1);
  page.clock.advance(3000);
  await page.reminders.refresh();
  assert.equal(page.document.body.children.length, 0);
});

test('pagehide suspends polling and pageshow resumes with a fresh backend read', async () => {
  const page = createPage();
  await page.reminders.getReady();
  const before = page.apiCalls.length;
  page.dispatchWindow('pagehide', {persisted: true});
  page.notices = [{id: 'returned-notice', url: '/tools/events'}];
  page.clock.advance(60000);
  await settle();
  assert.equal(page.apiCalls.length, before);
  assert.equal(page.document.body.children.length, 0);
  page.dispatchWindow('pageshow', {persisted: true});
  await settle();
  assert.ok(page.apiCalls.length > before);
  assert.equal(page.document.body.children.length, 1);
  page.clock.advance(15000);
  await settle();
  assert.equal(page.document.body.children.length, 0, 'returning does not replay a seen notice');
});

test('retained notices are summarized once instead of replaying a backlog of toasts', async () => {
  const page = createPage({notices: [
    {id: 'old-1', createdAt: 100000, url: 'https://twitch.tv/one'},
    {id: 'old-2', createdAt: 200000, url: 'https://twitch.tv/two'}
  ]});
  await page.reminders.getReady();
  const toast = page.document.body.children[0];
  assert.deepEqual(textsOf(toast), ['2 条开赛提醒', '×']);
  assert.equal(toast.children[0].href, ORIGIN + '/tools/events');
  assert.deepEqual(Object.keys(JSON.parse(page.storage.getItem('owqs:reminders:user-1:seen'))).sort(), ['old-1', 'old-2']);
  page.clock.advance(3000);
  await page.reminders.refresh();
  assert.equal(page.document.body.children.length, 0);
});

test('a delayed retained notice is labeled as a catch-up reminder', async () => {
  const page = createPage({notices: [{id: 'late', createdAt: 100000, url: '/tools/events'}]});
  await page.reminders.getReady();
  assert.deepEqual(textsOf(page.document.body.children[0]), ['开赛提醒（补提醒）', '×']);
});

test('reservation status distinguishes generated notices from push acceptance and unverified due times', () => {
  const events = fs.readFileSync(new URL('../../web/events.js', import.meta.url), 'utf8');
  const statusFunction = events.match(/ function reservationStatus\(r,now=Date\.now\(\)\)\{[\s\S]*?\n \}/)?.[0];
  assert.ok(statusFunction);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(statusFunction + ';globalThis.statusFor=reservationStatus;', sandbox);
  const pending = {state: 'notified', deliveryStatus: 'pending'};
  assert.match(sandbox.statusFor(pending, 1000), /已提醒.*推送待确认/);
  assert.match(sandbox.statusFor({...pending, deliveryStatus: 'sent'}, 1000), /已提交推送/);
  assert.match(sandbox.statusFor({...pending, deliveryStatus: 'failed'}, 1000), /推送失败/);
  assert.match(sandbox.statusFor({...pending, deliveryStatus: 'unavailable'}, 1000), /已提醒.*通知未启用/);
  const withoutDevice = sandbox.statusFor({state: 'active', deliveryStatus: 'unavailable', match: {startsAt: new Date(2000).toISOString()}}, 1000);
  assert.equal(withoutDevice, '已预约 · 通知未启用');
  assert.doesNotMatch(withoutDevice, /已生成/);
  assert.doesNotMatch(sandbox.statusFor({state: 'unverified', deliveryStatus: 'unavailable'}, 1000), /已生成/);
  assert.match(sandbox.statusFor({state: 'active', match: {startsAt: new Date(500).toISOString()}}, 1000), /已到预定时间.*待核实/);
  assert.equal(sandbox.statusFor({state: 'active', match: {startsAt: new Date(2000).toISOString()}}, 1000), '已预约');
});

test('the service worker uses a fixed title without a body and falls back on unsafe click URLs', async () => {
  const worker = createServiceWorker();
  const page = worker.addPage(ORIGIN + '/tools/events');

  await worker.dispatch('push', {data: {json: () => ({url: 'javascript:alert(1)', id: 'notice-9'})}});
  assert.equal(worker.shown.length, 1);
  const push = worker.shown[0];
  assert.equal(push.title, '即将开赛');
  assert.equal('body' in push.options, false);
  // The payload is unsafe, so the notification points at the worker origin's events page.
  assert.deepEqual(Object.keys(push.options.data), ['url']);
  assert.equal(push.options.data.url, 'https://site.test/tools/events');
  assert.equal(push.options.tag, 'owqs-reminder-notice-9');
  assert.deepEqual(page.messages.map(message => message.type), ['owqs:reminders:poll']);

  await worker.dispatch('push', {data: {json: () => { throw new Error('malformed'); }}});
  assert.equal(worker.shown.length, 2);
  assert.equal(worker.shown[1].title, '即将开赛');
  assert.equal('body' in worker.shown[1].options, false);
  assert.equal(worker.shown[1].options.tag, undefined);
  assert.equal(worker.shown[1].options.data.url, 'https://site.test/tools/events');

  // External URLs are only allowed on the default HTTPS port; the worker's own origin has no port.
  await worker.dispatch('push', {data: {json: () => ({url: ORIGIN + '/tools/events', id: 'notice-10'})}});
  assert.equal(worker.shown[2].options.data.url, 'https://site.test/tools/events');
  assert.equal(worker.shown[2].options.tag, 'owqs-reminder-notice-10');
  // An external HTTPS URL with a port is rejected. A relative path with the same path resolves on the worker origin.
  await worker.dispatch('push', {data: {json: () => ({url: 'https://twitch.tv:8443/channel', id: 'notice-11'})}});
  assert.equal(worker.shown[3].options.data.url, 'https://site.test/tools/events');
  await worker.dispatch('push', {data: {json: () => ({url: '/tools/events', id: 'notice-12'})}});
  assert.equal(worker.shown[4].options.data.url, 'https://site.test/tools/events');

  worker.pages.length = 0;
  let closed = false;
  const click = async data => {
    closed = false;
    await worker.dispatch('notificationclick', {
      notification: {
        data,
        close() {
          closed = true;
        }
      }
    });
    return closed;
  };
  assert.equal(await click({url: 'https://evil.test/phish'}), true);
  assert.equal(await click({url: 'https://site.test/tools/events'}), true);
  assert.equal(await click({url: 'https://twitch.tv:8443/safe'}), true);
  assert.deepEqual(worker.opened, [
    'https://site.test/tools/events',
    'https://site.test/tools/events',
    'https://site.test/tools/events'
  ]);

  assert.equal(await click({url: 'https://twitch.tv/safe'}), true);
  assert.deepEqual(worker.opened.at(-1), 'https://twitch.tv/safe');

  // An already-open page is focused instead of opening another window.
  worker.addPage('https://twitch.tv/safe');
  assert.equal(await click({url: 'https://twitch.tv/safe'}), true);
  assert.deepEqual(worker.focused, ['https://twitch.tv/safe']);
  assert.equal(worker.opened.length, 4);
});

test('denied notification permission rejects reserve without POSTing it', async () => {
  const denied = createPage({permission: 'denied', notices: []});
  await denied.reminders.getReady();
  await assert.rejects(denied.reminders.reserve('match-1'), /系统通知已被阻止/);
  assert.deepEqual(denied.apiCalls.map(call => call.path), ['/api/events/reminders']);

  let confirms = 0;
  const promptDenied = createPage({
    permission: 'default',
    confirm: () => {
      confirms += 1;
      return true;
    },
    requestPermission: async () => 'denied',
    notices: []
  });
  await promptDenied.reminders.getReady();
  await assert.rejects(promptDenied.reminders.reserve('match-1'), /未获得通知权限/);
  assert.equal(confirms, 1);
  assert.deepEqual(promptDenied.apiCalls.map(call => call.path), ['/api/events/reminders']);
});
