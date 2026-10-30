import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../../frontend/web/app/query.js', import.meta.url), 'utf8');
function page() {
  const elements = new Map(),
    listeners = {},
    windowListeners = {},
    intervals = [];
  let queries = true,
    fail = false,
    requests = 0;
  const context = vm.createContext({
    activeJob: null,
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, title: '' });
      return elements.get(id);
    },
    Cloud: {
      api: async () => {
        requests++;
        if (fail) throw Error('offline');
        return { capabilities: { queries } };
      }
    },
    document: {
      hidden: false,
      addEventListener: (event, handler) => {
        listeners[event] = handler;
      }
    },
    window: {
      addEventListener: (event, handler) => {
        windowListeners[event] = handler;
      }
    },
    setInterval: (handler, ms) => {
      intervals.push({ handler, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    clearTimeout: () => {}
  });
  vm.runInContext(code, context);
  return {
    context,
    elements,
    listeners,
    windowListeners,
    intervals,
    queries(value) {
      queries = value;
    },
    fail(value) {
      fail = value;
    },
    requests: () => requests,
    run: (script) => vm.runInContext(script, context)
  };
}

test('already-open page mirrors pause and resume, preserving busy state and active jobs', async () => {
  const p = page();
  p.queries(false);
  await p.run('refreshQueryAvailability()');
  assert.equal(p.elements.get('query').disabled, true);
  assert.equal(p.elements.get('querySuspended').hidden, false);
  p.run('busy(true)');
  p.queries(true);
  await p.run('refreshQueryAvailability()');
  assert.equal(p.elements.get('query').disabled, true, 'starting request remains busy');
  assert.equal(p.elements.get('querySuspended').hidden, true);
  p.run("activeJob = 'running'; busy(false); setSuspended(true); setSuspended(false)");
  assert.equal(p.elements.get('query').disabled, true, 'running job stays disabled');
  p.run('activeJob = null; busy(false)');
  assert.equal(p.elements.get('query').disabled, false);
});

test('availability refresh waits 60 seconds, resumes on focus, and keeps state when offline', async () => {
  const p = page();
  p.run('startQueryAvailabilityRefresh(); startQueryAvailabilityRefresh()');
  assert.equal(p.intervals.length, 1);
  assert.equal(p.intervals[0].ms, 60000);
  p.queries(false);
  await p.intervals[0].handler();
  assert.equal(p.elements.get('query').disabled, true);
  p.fail(true);
  p.queries(true);
  await p.intervals[0].handler();
  assert.equal(p.elements.get('query').disabled, true);
  p.context.document.hidden = true;
  const before = p.requests();
  await p.intervals[0].handler();
  assert.equal(p.requests(), before);
  p.context.document.hidden = false;
  p.fail(false);
  p.windowListeners.focus();
  await p.run('Promise.resolve()');
  assert.equal(p.elements.get('query').disabled, false);
  p.windowListeners.pagehide();
  p.windowListeners.pageshow({ persisted: true });
  assert.equal(p.intervals.length, 2);
});
