import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, MAX_RATE_PER_SECOND, priorityOf } from '../../src/services/scheduler.mjs';

// A driven clock keeps queue assertions independent of machine load. Like a real timer, the
// sleep yields first, so pending start callbacks observe the clock before it advances.
function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => void (value += ms),
    sleep: async (ms) => {
      await new Promise((resolve) => setImmediate(resolve));
      value += Math.max(1, ms);
    }
  };
}
// Grants resolve promises, so a queued request is only running after a macrotask turn.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('start rate is clamped to the operator ceiling and cannot bank a burst', () => {
  assert.equal(createScheduler({ ratePerSecond: 500 }).stats().ratePerSecond, MAX_RATE_PER_SECOND);
  assert.equal(createScheduler({ ratePerSecond: 3 }).stats().ratePerSecond, 3);
  assert.equal(createScheduler({ ratePerSecond: 0 }).stats().ratePerSecond, MAX_RATE_PER_SECOND);
  assert.equal(
    createScheduler({ ratePerSecond: Number.NaN }).stats().ratePerSecond,
    MAX_RATE_PER_SECOND
  );
  assert.equal(
    createScheduler({ ratePerSecond: Number.POSITIVE_INFINITY }).stats().ratePerSecond,
    Infinity
  );
  assert.equal(createScheduler({ burst: 1 }).stats().burst, 1);
  assert.equal(createScheduler({ concurrency: 4 }).stats().concurrency, 4);
});

test('a burst of requests cannot exceed the burst depth, and starts stay rate spaced', async () => {
  const time = clock();
  const scheduler = createScheduler({
    ratePerSecond: 8,
    burst: 2,
    concurrency: 8,
    now: time.now,
    sleep: time.sleep
  });
  const starts = [];
  const calls = Array.from({ length: 6 }, (_, i) =>
    scheduler.run(async () => {
      starts.push(time.now());
      return i;
    })
  );
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4, 5]);
  // The bucket depth is the only allowance for simultaneous starts.
  assert.equal(starts[0], starts[1]);
  for (let i = 2; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 124);
  assert.ok(starts.at(-1) - starts[0] >= 124 * (starts.length - 2));
});

test('production defaults keep any one-second window at or below eight starts', async () => {
  const time = clock();
  const scheduler = createScheduler({ now: time.now, sleep: time.sleep });
  assert.equal(scheduler.stats().burst, 1);
  const starts = [];
  await Promise.all(
    Array.from({ length: 24 }, () => scheduler.run(async () => starts.push(time.now())))
  );
  for (let i = 0; i < starts.length; i++) {
    const inWindow = starts.filter((t) => t >= starts[i] && t < starts[i] + 1000).length;
    assert.ok(inWindow <= 8, inWindow + ' starts within one second at ' + starts[i]);
  }
});

test('concurrency is a separate ceiling from the start rate', async () => {
  let active = 0,
    peak = 0;
  const scheduler = createScheduler({ ratePerSecond: 200, burst: 8, concurrency: 2 });
  async function work() {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
  }
  await Promise.all(Array.from({ length: 6 }, () => scheduler.run(work)));
  assert.equal(peak, 2);
});

test('higher priority is served first and equal priorities stay first-in-first-out', async () => {
  const time = clock();
  const scheduler = createScheduler({
    ratePerSecond: 1000,
    burst: 1,
    concurrency: 1,
    maxAgeMs: 1e9,
    now: time.now,
    sleep: time.sleep
  });
  let release;
  const held = scheduler.run(() => new Promise((resolve) => (release = resolve)));
  await tick();
  const order = [];
  const queued = [
    scheduler.run(async () => order.push('low'), { priority: 'low' }),
    scheduler.run(async () => order.push('normal-a')),
    scheduler.run(async () => order.push('normal-b')),
    scheduler.run(async () => order.push('high'), { priority: 'high' })
  ];
  assert.equal(scheduler.stats().waiting, 4);
  release();
  await held;
  await Promise.all(queued);
  assert.deepEqual(order, ['high', 'normal-a', 'normal-b', 'low']);
  assert.equal(scheduler.stats().waiting, 0);
  assert.equal(scheduler.stats().active, 0);
});

test('ageing promotes a waiting low-priority request instead of starving it', async () => {
  const time = clock();
  const scheduler = createScheduler({
    ratePerSecond: 1000,
    burst: 1,
    concurrency: 1,
    maxAgeMs: 500,
    now: time.now,
    sleep: time.sleep
  });
  let release;
  const held = scheduler.run(() => new Promise((resolve) => (release = resolve)));
  await tick();
  const order = [];
  const old = scheduler.run(async () => order.push('old-low'), { priority: 'low' });
  // One class per maxAgeMs: a low request needs two periods to reach the top class.
  time.advance(1100);
  const queued = [
    old,
    ...Array.from({ length: 4 }, (_, i) =>
      scheduler.run(async () => order.push('high-' + i), { priority: 'high' })
    )
  ];
  release();
  await held;
  await Promise.all(queued);
  assert.equal(order[0], 'old-low');
});

test('an aborted waiter leaves the queue without starting and without leaking a slot', async () => {
  const time = clock();
  const scheduler = createScheduler({
    ratePerSecond: 1,
    burst: 1,
    concurrency: 1,
    now: time.now,
    sleep: time.sleep
  });
  await scheduler.run(async () => {});
  const controller = new AbortController();
  let started = false;
  const pending = scheduler.run(async () => void (started = true), {
    priority: 'low',
    signal: controller.signal
  });
  assert.equal(scheduler.stats().waiting, 1);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(started, false);
  assert.equal(scheduler.stats().waiting, 0);
  assert.equal(scheduler.stats().active, 0);
  await assert.rejects(
    scheduler.run(async () => {}, { signal: AbortSignal.abort() }),
    (error) => error.name === 'AbortError'
  );
});

test('a cooldown holds every start and recovery does not resume with a burst', async () => {
  const time = clock();
  const scheduler = createScheduler({
    ratePerSecond: 8,
    burst: 2,
    concurrency: 4,
    now: time.now,
    sleep: time.sleep
  });
  scheduler.coolDown(30000);
  assert.ok(scheduler.stats().holdMs >= 30000);
  assert.equal(scheduler.stats().tokens, 0);
  const starts = [];
  const pending = Array.from({ length: 3 }, () =>
    scheduler.run(async () => starts.push(time.now()))
  );
  assert.equal(starts.length, 0);
  await Promise.all(pending);
  assert.equal(starts.length, 3);
  // The first start waits out the cooldown; afterwards no more than the burst depth may share a
  // start instant, and the rest keep the 125ms cadence.
  assert.ok(starts[0] >= 30000);
  assert.equal(starts[0], starts[1]);
  assert.ok(starts[2] - starts[0] >= 124);
});

test('priority names resolve to ordered classes with a safe default', () => {
  assert.ok(priorityOf('high') < priorityOf('normal'));
  assert.ok(priorityOf('normal') < priorityOf('low'));
  assert.equal(priorityOf('urgent'), priorityOf('normal'));
  assert.equal(priorityOf(undefined), priorityOf('normal'));
});
