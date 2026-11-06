// Combines Liquipedia's schedule, the previous match on the same source page and, for China,
// NetEase's official match state into a two-stage reminder decision. Liquipedia volunteers
// often edit times after a delayed day has already started (2026-11-06: 16:00 -> 19:00 was
// written at 16:37), so a stable listed time alone cannot prove that a match is starting.
const MINUTE = 60000,
  HOUR = 60 * MINUTE;
const PREVIOUS_SPAN = 12 * HOUR,
  LINKED_GAP = 3 * HOUR,
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
 * Decide whether the single reminder for a match may be sent now ('pre') or not ('none').
 * Liquipedia often corrects times only after a delayed or early match has started, so there
 * is no separate "match started" message.
 * - Previous match on the same page starts at most three hours earlier ("linked"): nothing
 *   while it runs; the reminder goes out as soon as it finishes ('previous-completed').
 * - First match of the day, or after a longer break: at the listed time ('scheduled-time'),
 *   at most 30 minutes late.
 * - Fallbacks when the expected signal never arrives: NetEase "in progress" for China
 *   ('official-live') or the match's own score ('match-started').
 */
export function reminderPhase({ match, observedStartsAt, verified, sourceMatches, official, now }) {
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
  const result = (reason) => ({ phase: 'pre', reason, previous: previousView });
  if (now - start > SIGNAL_WINDOW) return none('expired', previousView);
  if (previousDone) return result('previous-completed');
  if (!previous && now >= start && now - start <= START_GRACE) return result('scheduled-time');
  if (officialFor(official, match)?.status === 'live') return result('official-live');
  if (match.status === 'live' || (match.scores || []).some((x) => Number.isFinite(x) && x > 0))
    return result('match-started');
  if (previous) return none('previous-pending', previousView);
  return now >= start ? none('expired') : none('scheduled');
}
