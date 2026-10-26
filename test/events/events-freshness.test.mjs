import test from 'node:test';
import assert from 'node:assert/strict';
import { eventRefreshInterval, nextEventRefresh } from '../../src/events/freshness.mjs';
import { EventCenter } from '../../src/events/center.mjs';
import { page, card, response } from '../events-fixture.mjs';
const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  now = Date.parse('2026-10-24T08:00:00Z');
const match = (offset, status = 'scheduled') => ({
  startsAt: new Date(now + offset).toISOString(),
  status
});
import { MemoryStorage as Storage } from '../helpers/storage.mjs';
test('event freshness follows live, imminent, warm and idle windows without mistaking unknown dates as live', () => {
  assert.equal(eventRefreshInterval([], now), 15 * MINUTE);
  assert.equal(eventRefreshInterval([{ startsAt: null, status: 'scheduled' }], now), 15 * MINUTE);
  assert.equal(eventRefreshInterval([match(48 * HOUR)], now), 15 * MINUTE);
  assert.equal(eventRefreshInterval([match(2 * HOUR)], now), 5 * MINUTE);
  assert.equal(eventRefreshInterval([match(24 * HOUR)], now), 5 * MINUTE);
  assert.equal(eventRefreshInterval([match(HOUR)], now), MINUTE);
  assert.equal(eventRefreshInterval([match(-4 * HOUR)], now), MINUTE);
  assert.equal(eventRefreshInterval([match(-6 * HOUR - 1)], now), 15 * MINUTE);
  assert.equal(eventRefreshInterval([match(-2 * HOUR, 'completed')], now), 5 * MINUTE);
  assert.equal(eventRefreshInterval([{ startsAt: null, status: 'live' }], now), MINUTE);
  assert.equal(eventRefreshInterval([{ ...match(-8 * HOUR), sourceLive: true }], now), MINUTE);
});
test('alarm wakes at freshness transitions rather than waiting for a longer idle interval', () => {
  const start = now + HOUR + 2 * MINUTE,
    items = [{ startsAt: new Date(start).toISOString(), status: 'scheduled' }];
  assert.equal(nextEventRefresh(items, now, now), now + 2 * MINUTE);
  assert.equal(nextEventRefresh([match(24 * HOUR + 3 * MINUTE)], now, now), now + 3 * MINUTE);
});

test('date-query cache keeps ongoing games fresh across midnight and stable historical dates longer', () => {
  const center = new EventCenter({ storage: new Storage() }, {});
  center.now = () => now;
  const query = { from: '2026-10-23', to: '2026-10-23' },
    updatedAt = now - MINUTE;
  assert.equal(
    center.queries.refreshAt({
      query,
      cache: { updatedAt, refreshIntervalMs: MINUTE, nextRefreshAt: updatedAt + MINUTE }
    }),
    now
  );
  assert.equal(
    center.queries.refreshAt({
      query,
      cache: { updatedAt, refreshIntervalMs: 15 * MINUTE, nextRefreshAt: updatedAt + 15 * MINUTE }
    }),
    updatedAt + 24 * HOUR
  );
  assert.equal(
    center.queries.refreshAt({
      query: {},
      cache: { updatedAt, refreshIntervalMs: MINUTE, nextRefreshAt: updatedAt + MINUTE }
    }),
    now
  );
});
test('background alarm refreshes imminent scores each minute, exposes freshness, and GET remains cache-only', async () => {
  let clock = now,
    calls = 0;
  const storage = new Storage(),
    html = () =>
      page([card({ timestamp: Math.floor((now + 30 * MINUTE) / 1000), scores: [calls, 0] })], []);
  const center = new EventCenter(
    { storage },
    {
      EVENTS_CONTACT: 'https://test.example',
      EVENTS_FETCH: async () => {
        calls++;
        return response(html());
      }
    }
  );
  center.now = () => clock;
  await center.alarm();
  assert.equal(calls, 1);
  assert.equal(await storage.getAlarm(), now + MINUTE);
  let view = await (await center.fetch(new Request('https://events.internal/'))).json();
  assert.equal(view.refreshIntervalSeconds, 60);
  assert.equal(Date.parse(view.nextRefreshAt), now + MINUTE);
  clock += MINUTE - 1;
  await center.alarm();
  assert.equal(calls, 1);
  clock++;
  await center.alarm();
  assert.equal(calls, 2);
  assert.equal(await storage.getAlarm(), clock + MINUTE);
  view = await (await center.fetch(new Request('https://events.internal/'))).json();
  assert.equal(view.matches[0].scores[0], 2);
  for (let i = 0; i < 4; i++) await center.fetch(new Request('https://events.internal/'));
  assert.equal(calls, 2);
});
test('manual refresh reports the shared gate and never silently presents old data as a new fetch', async () => {
  let clock = now,
    calls = 0;
  const storage = new Storage();
  const center = new EventCenter(
    { storage },
    {
      EVENTS_CONTACT: 'https://test.example',
      EVENTS_FETCH: async () => {
        calls++;
        return response(page());
      }
    }
  );
  center.now = () => clock;
  await center.refresh();
  clock += 1000;
  const value = await center.refresh(true);
  assert.equal(calls, 1);
  assert.equal(value.refreshDeferred, true);
  assert.equal(value.retryAfter, 29);
  assert.match(value.refreshError, /未重新抓取/);
  clock += 29000;
  await center.refresh(true);
  assert.equal(calls, 2);
});
test('a failed faster sync still respects the source five-minute backoff and preserves cached scores', async () => {
  let clock = now,
    fail = false,
    calls = 0;
  const storage = new Storage();
  const center = new EventCenter(
    { storage },
    {
      EVENTS_CONTACT: 'https://test.example',
      EVENTS_FETCH: async () => {
        calls++;
        return fail
          ? new Response('upstream unavailable', { status: 503 })
          : response(page([card({ timestamp: Math.floor((now + MINUTE) / 1000) })], []));
      }
    }
  );
  center.now = () => clock;
  await center.refresh();
  clock += MINUTE;
  fail = true;
  await center.alarm();
  assert.equal(calls, 2);
  assert.equal(await storage.getAlarm(), clock + 5 * MINUTE);
  const value = await center.refresh(true);
  assert.ok(value.matches.length);
  assert.match(value.refreshError, /上次成功/);
  assert.equal(calls, 2);
});
