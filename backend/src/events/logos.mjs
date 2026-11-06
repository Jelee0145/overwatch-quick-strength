import { liquipediaLogo } from './parser.mjs';

// Team badges are copied once from Liquipedia and served from this site, so visitors never
// depend on reaching liquipedia.net and the page CSP needs no third-party image origin.
export const LOGO_ROUTE = '/api/v1/events/logos/';
const MAX_BYTES = 64 * 1024,
  PER_RUN = 6,
  RECHECK = 30 * 86400000,
  MAX_BACKOFF = 86400000;
const TYPES = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) =>
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45
};
const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function logoSources(matches = []) {
  const urls = new Set();
  for (const match of matches)
    for (const team of match.teams || []) if (liquipediaLogo(team.logo)) urls.add(team.logo);
  return urls;
}

export class EventLogos {
  constructor(center) {
    this.center = center;
    this.misses = new Set();
  }
  get storage() {
    return this.center.storage;
  }
  fetcher() {
    // Standalone passes its fetch explicitly; Workers have no EVENTS_FETCH override.
    const env = this.center.env;
    return (
      env.EVENTS_LOGO_FETCH || (!env.EVENTS_FETCH && typeof fetch === 'function' ? fetch : null)
    );
  }
  // Replace upstream badge URLs with local copies; unknown badges become null placeholders.
  async localize(value) {
    if (!value || !Array.isArray(value.matches)) return value;
    const local = await this.resolver();
    const matches = value.matches.map((match) =>
      Array.isArray(match.teams)
        ? {
            ...match,
            teams: match.teams.map((team) => (team?.logo ? { ...team, logo: local(team.logo) } : team))
          }
        : match
    );
    return { ...value, matches };
  }
  // Maps an upstream badge URL to its local copy (or null), queueing unknown badges.
  async resolver() {
    const known = await this.storage.list({ prefix: 'logoSource:' });
    return (url) => {
      if (!url) return null;
      const saved = known.get('logoSource:' + url);
      if (saved?.hash) return LOGO_ROUTE + saved.hash;
      if (liquipediaLogo(url)) this.misses.add(url);
      return null;
    };
  }
  pending() {
    return this.misses.size > 0;
  }
  async read(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    return (await this.storage.get('logo:' + hash)) || null;
  }
  // Download badges that are new, due for a monthly recheck, or past their failure backoff.
  async sync(matches = []) {
    const fetcher = this.fetcher();
    if (!fetcher) return;
    const now = this.center.now();
    if (now < ((await this.storage.get('logoAfter')) || 0)) return;
    const urls = new Set([...logoSources(matches), ...this.misses]),
      known = await this.storage.list({ prefix: 'logoSource:' });
    const due = [...urls].filter((url) => {
      const saved = known.get('logoSource:' + url);
      if (!saved) return true;
      if (saved.hash) return now - saved.checkedAt >= RECHECK;
      return now >= saved.failedAt + Math.min(MAX_BACKOFF, 600000 * 2 ** (saved.failures - 1));
    });
    let done = 0;
    for (const url of due.slice(0, PER_RUN)) {
      if ((await this.download(fetcher, url)) === 'limited') break;
      done++;
    }
    // Only badges still waiting for a download slot keep the next sync early.
    const limited = this.center.now() < ((await this.storage.get('logoAfter')) || 0);
    this.misses = limited ? new Set() : new Set(due.slice(done));
  }
  async download(fetcher, url) {
    const key = 'logoSource:' + url,
      previous = await this.storage.get(key),
      identity = this.center.env.EVENTS_CONTACT || this.center.env.PUBLIC_ORIGIN || '';
    try {
      // Badges share the site-wide two-second Liquipedia request spacing.
      await this.center.lpSlot();
      const response = await fetcher(url, {
        headers: {
          ...(identity && !/[\r\n]/.test(identity)
            ? { 'User-Agent': 'OWQS-EventCenter/1.0 (' + identity + ')' }
            : {}),
          Accept: 'image/png,image/webp,image/jpeg,image/gif'
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
      });
      if (response.status === 429 || response.status === 503) {
        const retry = Number(response.headers.get('Retry-After'));
        await this.storage.put(
          'logoAfter',
          this.center.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 600000)
        );
        return 'limited';
      }
      const type = (response.headers.get('Content-Type') || '').split(';')[0].trim();
      if (!response.ok || !TYPES[type]) throw Error('Unexpected logo response');
      if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw Error('Logo too large');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES || !TYPES[type](bytes)) throw Error('Invalid logo');
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
      if (!(await this.storage.get('logo:' + hash)))
        await this.storage.put('logo:' + hash, { type, data: base64(bytes) });
      await this.storage.put(key, { hash, checkedAt: this.center.now() });
      return 'ok';
    } catch {
      // A failed recheck keeps serving the copy already stored.
      if (previous?.hash)
        await this.storage.put(key, { ...previous, checkedAt: this.center.now() });
      else
        await this.storage.put(key, {
          failedAt: this.center.now(),
          failures: Math.min(20, (previous?.failures || 0) + 1)
        });
      return 'failed';
    }
  }
}

export function logoResponse(saved) {
  const binary = atob(saved.data),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': saved.type,
      // Content-addressed: the URL changes whenever the image does.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
