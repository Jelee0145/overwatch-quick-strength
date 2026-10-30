// Route every upstream request through the one schedule shared by all users on this host.
import {
  createScheduler,
  DEFAULT_PACING,
  MAX_RATE_PER_SECOND
} from '../src/services/scheduler.mjs';
export {
  createScheduler,
  DEFAULT_PACING,
  MAX_RATE_PER_SECOND
} from '../src/services/scheduler.mjs';

/**
 * Wrap a fetcher so each call reserves a start slot from `scheduler`.
 * The fetch is untouched (URL, init, redirect and timeout behaviour stay the adapter's), and
 * the slot is released when the request settles so concurrency reflects real in-flight work.
 * @param {Function} fetcher
 * @param {object} [options]
 * @param {object} [options.scheduler] Shared scheduler; defaults to a new one.
 * @param {string} [options.priority] Default priority class for calls that carry none.
 */
export function pacedFetch(fetcher = fetch, { scheduler, priority = 'normal' } = {}) {
  const shared = scheduler || createScheduler();
  // The priority class is a third argument, not a RequestInit field: the platform fetch must keep
  // receiving exactly the options the adapter built.
  return (url, init, requested) =>
    shared.run(() => fetcher(url, init), {
      priority: requested || priority,
      signal: init?.signal
    });
}
