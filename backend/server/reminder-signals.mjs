// Combines Liquipedia's schedule, the previous match on the same source page and, for China,
// NetEase's official match state into a two-stage reminder decision. Liquipedia volunteers
// often edit times after a delayed day has already started (2026-11-06: 16:00 -> 19:00 was
// written at 16:37), so a stable listed time alone cannot prove that a match is starting.
const MINUTE = 60000,
  HOUR = 60 * MINUTE;
const PREVIOUS_SPAN = 12 * HOUR,
  LINKED_GAP = 3 * HOUR,
  PRE_LEAD = 10 * MINUTE,
  STABLE_FOR = 10 * MINUTE,
  START_GRACE = 30 * MINUTE,
  SIGNAL_WINDOW = 6 * HOUR,
  OFFICIAL_SPAN = 12 * HOUR;
const STOP_WORDS = new Set(['team', 'the', 'gaming', 'esports', 'club']);
const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]/g, '');
const unknown = (name) => !norm(name) || /^(?:tbd|tba|待定|unknown)$/i.test(String(name).trim());

/** Name keys tolerate source spellings: "OU Gaming"/"Over Ultra Gaming", "SV"/"SV.CRUSH". */
export function teamKeys(team) {
  const name = typeof team === 'string' ? team : team?.name;
  if (unknown(name)) return new Set();
  const words = String(name)
    .split(/[^A-Za-z0-9一-鿿]+/)
    .filter(Boolean);
  const keys = new Set([norm(name)]);
  if (typeof team === 'object' && !unknown(team?.shortName)) keys.add(norm(team.shortName));
  if (words.length > 1) {
    keys.add(words.map((w) => w[0].toLowerCase()).join(''));
    if (words[0].length >= 2 && !STOP_WORDS.has(words[0].toLowerCase())) keys.add(norm(words[0]));
  }
  keys.delete('');
  return keys;
}
const sameTeam = (a, b) => {
  const left = teamKeys(a),
    right = teamKeys(b);
  return [...left].some((key) => right.has(key));
};
export function pairingKey(match) {
  return (match?.teams || [])
    .map((t) => norm(t?.name))
    .sort()
    .join('|');
}

/** The official China entry for a Liquipedia match, or null when not uniquely paired. */
export function officialFor(official, match) {
  if (!Array.isArray(official) || (match?.teams || []).length !== 2) return null;
  if (match.region !== '中国' && !/\/China(?:\/|#|$)/.test(match.sourceUrl || '')) return null;
  const start = Date.parse(match.startsAt);
  if (!Number.isFinite(start)) return null;
  const [a, b] = match.teams;
  const found = official
    .filter(
      (o) =>
        Math.abs(o.time - start) <= OFFICIAL_SPAN &&
        ((sameTeam(a, o.teams[0]) && sameTeam(b, o.teams[1])) ||
          (sameTeam(a, o.teams[1]) && sameTeam(b, o.teams[0])))
    )
    .sort((x, y) => Math.abs(x.time - start) - Math.abs(y.time - start));
  if (!found.length) return null;
  if (found.length > 1 && Math.abs(found[0].time - start) === Math.abs(found[1].time - start))
    return null;
  return found[0];
}

function decided(match) {
  const best = Number(match?.bestOf),
    scores = (match?.scores || []).filter(Number.isFinite);
  return (
    Number.isInteger(best) && best > 0 && scores.length === 2 && Math.max(...scores) > best / 2
  );
}
/** Completion with the time it was first observed; at 0 means it was already finished when first seen. */
export function completion(match, official) {
  const own = official ? officialFor(official, match) : null;
  const done = match?.status === 'completed' || decided(match) || own?.status === 'completed';
  if (!done) return null;
  const times = [match.completedSeenAt, own?.completedSeenAt].filter(Number.isFinite);
  return { at: times.length ? Math.min(...times) : 0 };
}

/** The latest earlier match on the same source page within the same match day. */
export function previousMatch(sourceMatches, match) {
  const start = Date.parse(match?.startsAt),
    key = pairingKey(match);
  if (!Number.isFinite(start) || !Array.isArray(sourceMatches)) return null;
  return (
    sourceMatches
      .filter((m) => {
        const t = Date.parse(m.startsAt);
        return (
          Number.isFinite(t) && t < start && start - t <= PREVIOUS_SPAN && pairingKey(m) !== key
        );
      })
      .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0] || null
  );
}

/**
 * Decide what a reminder client may send now ('pre' advance notice, 'start' reminder, 'none').
 * - Previous match on the same page starts at most three hours earlier ("linked"):
 *   while it runs nothing is sent; once it finishes the advance notice is sent; the start
 *   reminder follows at the listed time when the time has been unchanged for ten minutes.
 * - First match of the day, or after a longer break: advance notice ten minutes before the
 *   listed time, start reminder at the listed time once it has been unchanged for ten minutes.
 * - China: NetEase's official "in progress" state confirms the start at once.
 * - The match's own score is only a late fallback when no other signal fired.
 */
export function reminderPhase({
  match,
  observedStartsAt,
  stableSince,
  verified,
  sourceMatches,
  official,
  now
}) {
  const start = Date.parse(observedStartsAt);
  const none = (reason, previous = null) => ({ phase: 'none', reason, previous });
  if (!verified || match?.startsAt !== observedStartsAt || !Number.isFinite(start))
    return none('unverified');
  if (completion(match, official)) return none('completed');
  const candidate = previousMatch(sourceMatches, match),
    previous = candidate && start - Date.parse(candidate.startsAt) <= LINKED_GAP ? candidate : null,
    previousDone = previous ? completion(previous, official) : null;
  const previousView = previous && {
    teams: (previous.teams || []).map((t) => String(t?.name || '待定').slice(0, 60)),
    startsAt: previous.startsAt || null,
    completed: !!previousDone
  };
  const result = (phase, reason) => ({ phase, reason, previous: previousView });
  if (officialFor(official, match)?.status === 'live') return result('start', 'official-live');
  if (now - start > SIGNAL_WINDOW) return none('expired', previousView);
  const stable = Number.isFinite(stableSince) && stableSince + STABLE_FOR <= now;
  const scored =
    match.status === 'live' ||
    (match.scores || []).some((score) => Number.isFinite(score) && score > 0);
  const onTime = (ready) =>
    now >= start &&
    stable &&
    now - Math.max(start, stableSince + STABLE_FOR, ready || 0) <= START_GRACE;
  if (previous) {
    if (!previousDone)
      return scored ? result('start', 'match-started') : none('previous-pending', previousView);
    if (onTime(previousDone.at)) return result('start', 'scheduled-time');
    if (now < start || !stable) return result('pre', 'previous-completed');
  } else {
    if (onTime(0)) return result('start', 'scheduled-time');
    if (now >= start - PRE_LEAD && now < start) return result('pre', 'scheduled-soon');
    if (now >= start && !stable && !scored) return result('pre', 'scheduled-soon');
  }
  if (scored) return result('start', 'match-started');
  return now >= start ? none('expired', previousView) : none('scheduled', previousView);
}
