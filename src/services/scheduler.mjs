/**
 * One upstream request schedule shared by every user, task and process on this host.
 *
 * Two independent ceilings are enforced here and must not be conflated:
 * - a token bucket limits request *starts* (rate per second, with a small burst),
 * - a concurrency cap limits how many requests may be in flight at once.
 *
 * A production scan measured about 82-90ms detail round trips, so 8 req/s needs roughly one
 * request in flight: the start rate is the binding constraint, and the concurrency cap only
 * protects against slow endpoints. Neither may be raised without a new scan.
 *
 * Requests are ordered by user-visible value, then by arrival. A waiting class is promoted by
 * ageing after `maxAgeMs`, so a low-priority request cannot starve behind steady high work.
 *
 * The scheduler owns no transport: callers pass an async start function that performs the
 * network call, and stay responsible for retries, cancellation and checkpoints.
 */

// Highest start rate chosen by the operator; scanning showed 9 req/s and above can be refused.
export const MAX_RATE_PER_SECOND = 8;
export const DEFAULT_PACING = Object.freeze({
  ratePerSecond: MAX_RATE_PER_SECOND,
  // One start at a time: a burst of two plus the 125ms cadence would put nine starts into the
  // first second, which is exactly the rate the upstream refused during scanning.
  burst: 1,
  concurrency: 6,
  maxAgeMs: 2500
});
const PRIORITIES = Object.freeze(['high', 'normal', 'low']);
export const priorityOf = (value) =>
  PRIORITIES.includes(value) ? PRIORITIES.indexOf(value) : PRIORITIES.indexOf('normal');

/**
 * @param {object} [options]
 * @param {number} [options.ratePerSecond] Start rate ceiling; finite values are clamped to
 *   MAX_RATE_PER_SECOND, while `Infinity` means "no start pacing" for tests and offline tools.
 * @param {number} [options.burst] Token bucket depth, so idle time cannot bank a spike. Values
 *   above 1 allow simultaneous starts and can exceed the per-second ceiling in the first second.
 * @param {number} [options.concurrency] In-flight ceiling, independent of the start rate.
 * @param {number} [options.maxAgeMs] Age after which a waiting class is promoted.
 * @param {Function} [options.now] Milliseconds clock.
 * @param {Function} [options.sleep] Async delay used by the wake-up loop.
 */
export function createScheduler({
  ratePerSecond = DEFAULT_PACING.ratePerSecond,
  burst = DEFAULT_PACING.burst,
  concurrency = DEFAULT_PACING.concurrency,
  maxAgeMs = DEFAULT_PACING.maxAgeMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const requested = Number(ratePerSecond),
    unlimited = requested === Infinity,
    rate = unlimited
      ? 0
      : Math.min(
          MAX_RATE_PER_SECOND,
          Number.isFinite(requested) && requested > 0 ? requested : MAX_RATE_PER_SECOND
        ),
    intervalMs = unlimited ? 0 : 1000 / rate,
    depth = Math.max(1, Math.floor(Number.isFinite(burst) ? burst : DEFAULT_PACING.burst)),
    limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 0;
  let tokens = depth,
    refilledAt = now(),
    active = 0,
    // No start may happen before this timestamp; only a cooldown moves it.
    until = 0,
    sequence = 0,
    pumping = false;
  const waiting = [];

  function refill() {
    if (!intervalMs) {
      tokens = depth;
      refilledAt = now();
      return;
    }
    const t = now();
    if (t > refilledAt) {
      tokens = Math.min(depth, tokens + (t - refilledAt) / intervalMs);
      refilledAt = t;
    }
  }
  const settle = (w) => {
    if (w.settled) return false;
    w.settled = true;
    const index = waiting.indexOf(w);
    if (index >= 0) waiting.splice(index, 1);
    return true;
  };
  /**
   * Serve in priority class order. Ageing removes one class per `maxAgeMs` waited, all the way
   * to the top class, so continuous high-priority traffic cannot starve a low-priority request;
   * equal classes keep first-in-first-out order through the arrival sequence.
   */
  function next() {
    let best = null,
      bestClass = 0;
    for (const w of waiting) {
      const aged = Math.floor((now() - w.queuedAt) / maxAgeMs),
        promoted = Math.max(0, priorityOf(w.priority) - aged);
      if (!best || promoted < bestClass) {
        best = w;
        bestClass = promoted;
      }
    }
    return best;
  }
  /** Earliest moment a token is available again (a cooldown can push it further out). */
  function startsAt() {
    const t = now(),
      refilled = intervalMs ? refilledAt + Math.max(0, 1 - tokens) * intervalMs : t;
    return Math.max(t, until, refilled);
  }
  // A token bucket: `burst` starts may go out at once after idle, then starts are spaced by rate.
  // Returns how many starts were granted, so the wake-up loop can detect a stalled pass.
  function drain() {
    let granted = 0;
    for (;;) {
      if (!waiting.length || (limit && active >= limit)) return granted;
      if (now() < until) return granted;
      refill();
      if (tokens < 1) return granted;
      const w = next();
      if (!w) return granted;
      tokens -= 1;
      w.start();
      granted++;
    }
  }
  /**
   * Grant starts without depending on traffic: the loop wakes at the next possible start time.
   * Completions and new arrivals also pump, so the queue never depends on a single trigger.
   */
  function pump() {
    if (pumping) return;
    pumping = true;
    void (async () => {
      let stalled = 0;
      try {
        for (;;) {
          const granted = drain();
          if (!waiting.length || (limit && active >= limit)) return;
          const delay = startsAt() - now();
          if (delay > 0) {
            stalled = 0;
            await sleep(delay);
            continue;
          }
          // Nothing to wait for yet nothing granted: stop instead of spinning, and let the next
          // completion or arrival pump again.
          if (!granted && ++stalled > 1) return;
        }
      } finally {
        pumping = false;
      }
    })().catch(() => {});
  }
  /**
   * Reserve one start slot, wait for it, then run `start`.
   * @param {Function} start Performs the request; its result is returned to the caller.
   * @param {{priority?:string, signal?:AbortSignal}} [options]
   */
  async function run(start, { priority = 'normal', signal } = {}) {
    signal?.throwIfAborted();
    let resolve;
    const ready = new Promise((done) => (resolve = done)),
      w = { priority, sequence: ++sequence, queuedAt: now(), settled: false, granted: false };
    w.start = () => {
      settle(w);
      w.granted = true;
      active++;
      resolve();
    };
    waiting.push(w);
    const cancel = () => {
      if (settle(w)) resolve();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    pump();
    try {
      await ready;
    } finally {
      signal?.removeEventListener('abort', cancel);
      settle(w);
    }
    try {
      signal?.throwIfAborted();
      // A waiter cancelled without a grant must never issue a request.
      if (!w.granted) throw new Error('scheduler grant lost');
      return await start();
    } finally {
      if (w.granted) active--;
      pump();
    }
  }
  /** Pause every start for `ms` (for example while the upstream refuses requests). */
  function coolDown(ms) {
    const wait = Number(ms);
    if (!Number.isFinite(wait) || wait <= 0) return;
    until = Math.max(until, now() + wait);
    // A cooldown also empties the bucket, so recovery cannot resume with a banked burst.
    tokens = 0;
    refilledAt = now();
    pump();
  }
  const stats = () => ({
    ratePerSecond: rate || Infinity,
    burst: depth,
    concurrency: limit,
    active,
    waiting: waiting.length,
    tokens: Math.round(tokens * 100) / 100,
    holdMs: Math.max(0, until - now())
  });
  return Object.freeze({ run, coolDown, stats });
}
