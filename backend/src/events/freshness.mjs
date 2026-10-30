const MINUTE = 60000,
  HOUR = 60 * MINUTE;
export function eventRefreshInterval(matches = [], now = Date.now()) {
  let interval = 15 * MINUTE;
  for (const match of matches) {
    const start = Date.parse(match.startsAt);
    if (match.status === 'live' || match.sourceLive === true) return MINUTE;
    if (!Number.isFinite(start)) continue;
    const distance = start - now;
    if (match.status !== 'completed' && distance <= HOUR && distance >= -6 * HOUR) return MINUTE;
    if ((distance > 0 && distance <= 24 * HOUR) || (distance <= 0 && distance >= -6 * HOUR))
      interval = 5 * MINUTE;
  }
  return interval;
}
export function nextEventRefresh(matches, updatedAt, now = Date.now()) {
  let next = updatedAt + eventRefreshInterval(matches, now);
  // Wake when a game enters a faster-refresh window, even without any visitors.
  for (const match of matches) {
    const start = Date.parse(match.startsAt);
    if (match.status === 'completed' || !Number.isFinite(start)) continue;
    for (const lead of [24 * HOUR, HOUR])
      if (start - lead > now) next = Math.min(next, start - lead);
  }
  return next;
}
