import { Fault } from '../security.mjs';
import { parseDetailPage } from './detail-parser.mjs';
import { heroTerm, mapTerm } from './glossary.mjs';
import { nextEventRefresh } from './freshness.mjs';
import { detailParseApi, detailPath, detailRevisionApi, detailRoot } from './source.mjs';

// Event detail pages (standings, map-by-map results, hero bans, rosters) built from
// Liquipedia tournament pages. Liquipedia's API terms cap action=parse at one request per
// 30 seconds, shared with the schedule sync, so detail work is deliberately thrifty:
// - visitors only ever read stored copies; their first visit queues a background parse;
// - a cheap action=query (one request for up to 50 pages) checks revision ids, and only
//   pages whose revision changed are parsed again;
// - at most one detail parse every two minutes, and never ahead of schedule/backfill work.
const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
const PARSE_GAP = 2 * MINUTE,
  ACTIVE_CHECK = 10 * MINUTE,
  IDLE_CHECK = 6 * HOUR,
  ACTIVE_REPARSE = 6 * HOUR,
  VIEW_WRITE = 10 * MINUTE,
  KEEP = 14 * DAY,
  MAX_ROOTS = 24,
  MAX_SUBPAGES = 4,
  MAX_PAGE_BYTES = 120 * 1024,
  MAX_PARSE_BYTES = 4 * 1024 * 1024,
  MAX_QUERY_BYTES = 256 * 1024,
  // A detail parse holds the shared 30-second parse gate. It may start only when the next
  // schedule refresh is at least that far away (less a few seconds of alarm jitter), so a
  // one-minute live cadence still leaves the slot between two refreshes for detail pages
  // while scores are delayed by at most the slack.
  PARSE_GATE = 30 * 1000,
  SCHEDULE_SLACK = 3 * 1000,
  SCHEDULE_ROOM = PARSE_GATE - SCHEDULE_SLACK,
  // After this many failed parses of a stage page, visitors are told instead of waiting.
  STALLED_AFTER = 3,
  // Reminder checks around a match start ("urgent") come back about every two minutes per
  // source. A detail parse holds the parse gate for 30 seconds, so after an urgent check went
  // out it may start only early in that interval; after one was queued behind the gate it
  // waits until an urgent check gets through. With no urgent check for three minutes, the
  // reminder window is over and details run normally.
  URGENT_FREE = 85 * 1000,
  URGENT_IDLE = 3 * MINUTE,
  MAX_STANDING_ROOTS = 8,
  STANDING_ROWS = 16;
const PAGE_URL = 'https://liquipedia.net/overwatch/';
const pageKey = (path) => 'detailPage:' + path;
const REGIONS = ['中国', '韩国', '日本', '太平洋', '亚洲', '北美', 'EMEA', '国际赛'];
const regionOrder = (region) =>
  REGIONS.includes(region) ? REGIONS.indexOf(region) : REGIONS.length;
const retryDelay = (failures) => Math.min(6 * HOUR, 10 * MINUTE * 2 ** (failures - 1));

function activeRoots(matches = [], now) {
  const roots = new Set();
  for (const match of matches) {
    const start = Date.parse(match.startsAt),
      root = match.series === 'owcs' && detailRoot(match.sourceUrl);
    if (!root) continue;
    if (
      match.status === 'live' ||
      (Number.isFinite(start) && start > now - DAY && start < now + 2 * DAY)
    )
      roots.add(root);
  }
  return roots;
}
function subpagesOf(root, links = []) {
  const found = [];
  for (const link of links) {
    const title = String(link?.['*'] || link?.title || '').replace(/ /g, '_');
    if ((link?.ns ?? 0) !== 0 || !title.startsWith(root + '/') || /Qualifier/i.test(title))
      continue;
    try {
      if (!found.includes(detailPath(title))) found.push(title);
    } catch {
      /* Outside the allowlist; ignore. */
    }
  }
  return found.slice(0, MAX_SUBPAGES);
}
const richer = (a, b) =>
  b.games.filter((g) => g.played).length > a.games.filter((g) => g.played).length ? b : a;

export class EventDetails {
  constructor(center) {
    this.center = center;
    this.wanted = false;
    // Earliest time the next detail parse may run; schedule() wakes no earlier than this.
    this.after = 0;
  }
  get storage() {
    return this.center.storage;
  }
  async index() {
    const saved = await this.storage.get('detailIndex');
    return { roots: {}, pages: {}, after: 0, ...(saved || {}) };
  }
  async view(value) {
    const path = detailPath(value),
      root = detailRoot(PAGE_URL + path) || path,
      now = this.center.now(),
      index = await this.index(),
      entry = index.roots[root];
    if (!entry || now - (entry.viewedAt || 0) >= VIEW_WRITE) {
      index.roots[root] = {
        addedAt: entry?.addedAt || now,
        checkedAt: entry?.checkedAt || 0,
        viewedAt: now
      };
      this.prune(index, now, new Set());
      await this.save(index);
    }
    const first = await this.storage.get(pageKey(root));
    if (!first) {
      const meta = index.pages[root];
      // A page in failure backoff waits for its retry time instead of waking the alarm.
      this.wanted ||= !meta?.failures || now >= meta.failedAt + retryDelay(meta.failures);
      this.after = Math.max(this.after, index.after || 0);
      const waiting = Object.keys(index.roots).filter(
        (r) => index.roots[r].viewedAt && !index.pages[r]?.fetchedAt
      ).length;
      return {
        state: 'pending',
        root,
        // Repeated failures are reported rather than shown as an endless "preparing".
        ...((meta?.failures || 0) >= STALLED_AFTER && { stalled: true }),
        retryAfter: Math.min(
          300,
          Math.max(10, Math.ceil((Math.max(index.after, now) - now) / 1000) + 60 * waiting)
        )
      };
    }
    const subs = (first.subpages || []).slice(0, MAX_SUBPAGES),
      rest = await Promise.all(subs.map((path) => this.storage.get(pageKey(path)))),
      pages = [first, ...rest.filter(Boolean)];
    if (rest.some((page) => !page)) this.wanted = true;
    return this.localize(
      this.assemble(
        root,
        pages,
        subs,
        index,
        now,
        rest.some((p) => !p)
      )
    );
  }
  // Region standings for the events home page: the OWCS stages in the current schedule.
  // Reading them counts as a visit, so those stage pages are parsed like any opened page.
  async standings() {
    const now = this.center.now(),
      snapshot = await this.storage.get('snapshot'),
      stages = new Map();
    for (const match of snapshot?.matches || []) {
      const root = (match.series || 'owcs') === 'owcs' && detailRoot(match.sourceUrl),
        start = Date.parse(match.startsAt);
      if (!root) continue;
      const distance =
        match.status === 'live' ? 0 : Number.isFinite(start) ? Math.abs(start - now) : Infinity;
      const known = stages.get(root);
      if (!known || distance < known.distance)
        stages.set(root, {
          root,
          region: String(match.region || ''),
          tournament: String(match.tournament || ''),
          distance
        });
    }
    const picked = [...stages.values()]
      .filter((stage) => stage.distance < 7 * DAY)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_STANDING_ROOTS)
      .sort(
        (a, b) => regionOrder(a.region) - regionOrder(b.region) || a.root.localeCompare(b.root)
      );
    const regions = [];
    for (const stage of picked) {
      let value;
      try {
        value = await this.view(stage.root);
      } catch {
        continue;
      }
      const base = { root: stage.root, region: stage.region, tournament: stage.tournament };
      if (value.state !== 'ready') {
        regions.push({ ...base, state: 'pending', ...(value.stalled && { stalled: true }) });
        continue;
      }
      regions.push({
        ...base,
        state: 'ready',
        title: value.info?.title || '',
        updatedAt: value.updatedAt,
        partial: value.partial,
        standings: value.standings
          .slice(0, 3)
          .map((table) => ({ ...table, rows: table.rows.slice(0, STANDING_ROWS) })),
        source: value.source.url
      });
    }
    return {
      regions,
      source: {
        name: 'Liquipedia',
        license: 'CC BY-SA 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/'
      }
    };
  }
  assemble(root, pages, subs, index, now, partial) {
    const byId = new Map(),
      standings = new Map();
    for (const page of pages) {
      for (const match of page.data.matches || [])
        byId.set(match.id, byId.has(match.id) ? richer(byId.get(match.id), match) : match);
      for (const table of page.data.standings || []) {
        const key = table.kind + '|' + table.title;
        if (!standings.has(key)) standings.set(key, table);
      }
    }
    const matches = [...byId.values()].sort(
      (a, b) =>
        (Date.parse(a.startsAt) || Infinity) - (Date.parse(b.startsAt) || Infinity) ||
        a.id.localeCompare(b.id)
    );
    const stages = [...new Set(matches.map((m) => m.stage).filter(Boolean))];
    return {
      state: 'ready',
      root,
      info: pages[0].data.info,
      stages,
      matches,
      standings: [...standings.values()],
      participants: pages.find((p) => p.data.participants?.length)?.data.participants || [],
      partial,
      updatedAt: new Date(Math.max(...pages.map((p) => p.fetchedAt))).toISOString(),
      checkedAt: index.roots[root]?.checkedAt
        ? new Date(index.roots[root].checkedAt).toISOString()
        : null,
      source: {
        name: 'Liquipedia',
        url: PAGE_URL + root,
        pages: [root, ...subs].map((path) => PAGE_URL + path),
        license: 'CC BY-SA 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
        note: '赛事数据来自 Liquipedia，依 CC BY-SA 3.0 由本站翻译整理；选图方按“上一图败方选图”推算。'
      }
    };
  }
  async localize(value) {
    const local = await this.center.logos.resolver(),
      team = (t) => (t ? { ...t, logo: local(t.logo) } : t),
      // Stored pages keep the English names, so newly added hero/map translations apply
      // to pages parsed before them without waiting for a reparse.
      game = (g) => ({
        ...g,
        map: g.map?.en ? mapTerm(g.map.en, g.map.mode) : g.map,
        bans: (g.bans || []).map((b) => (b?.en ? heroTerm(b.en) : b))
      });
    return {
      ...value,
      matches: value.matches.map((m) => ({
        ...m,
        teams: m.teams.map(team),
        games: (m.games || []).map(game)
      })),
      standings: value.standings.map((s) => ({
        ...s,
        rows: s.rows.map((r) => ({ ...r, team: team(r.team) }))
      })),
      participants: value.participants.map((p) => ({ ...p, team: team(p.team) }))
    };
  }
  prune(index, now, active) {
    for (const [root, entry] of Object.entries(index.roots))
      if (!active.has(root) && now - Math.max(entry.viewedAt || 0, entry.addedAt || 0) > KEEP)
        delete index.roots[root];
    const kept = Object.entries(index.roots)
      .sort(
        ([a, x], [b, y]) =>
          Number(active.has(b)) - Number(active.has(a)) ||
          Math.max(y.viewedAt || 0, y.addedAt || 0) - Math.max(x.viewedAt || 0, x.addedAt || 0)
      )
      .slice(0, MAX_ROOTS);
    index.roots = Object.fromEntries(kept);
    const live = new Set(Object.keys(index.roots));
    for (const root of Object.keys(index.roots))
      for (const sub of index.pages[root]?.subpages || []) live.add(sub);
    for (const path of Object.keys(index.pages)) if (!live.has(path)) delete index.pages[path];
  }
  // One unit of background work per alarm: a revision check or a single page parse.
  // Detail work is demand-driven (only roots a visitor opened) and yields to the schedule:
  // it never sends a request in an alarm that already reached Liquipedia, and parses only
  // when its 30-second gate leaves the next schedule refresh (nearly) on time.
  async work({ sent = false } = {}) {
    const center = this.center,
      now = center.now(),
      index = await this.index(),
      waiting = () =>
        Object.entries(index.roots).some(
          ([root, entry]) => entry.viewedAt && !index.pages[root]?.fetchedAt
        );
    this.wanted = false;
    const snapshot = await this.storage.get('snapshot'),
      upcoming = snapshot ? nextEventRefresh(snapshot.matches, snapshot.updatedAt, now) : now,
      gate = (await this.storage.get('refreshAfter')) || 0;
    this.after = Math.max(index.after || 0, gate);
    const urgent = await this.storage.get('urgentTrack'),
      sinceUrgent = urgent ? now - urgent.at : Infinity,
      yieldUrgent =
        sinceUrgent >= 0 &&
        sinceUrgent < URGENT_IDLE &&
        (urgent.queued || sinceUrgent > URGENT_FREE);
    if (sent || now < this.after || yieldUrgent || (await center.queries.hasPending())) {
      this.wanted = waiting() || !!this.nextParse(index, activeRoots(snapshot?.matches, now), now);
      return;
    }
    const active = activeRoots(snapshot?.matches, now);
    this.prune(index, now, active);
    const due = upcoming - now >= SCHEDULE_ROOM ? this.nextParse(index, active, now) : null;
    if (due) {
      await this.parse(index, due, now);
      this.after = index.after;
      this.wanted = !!this.nextParse(index, active, center.now());
    } else {
      await this.checkRevisions(index, active, now);
      this.after = Math.max(this.after, index.after || 0);
      // Blocked only by an imminent schedule refresh: try again in the next free slot.
      this.wanted = !!this.nextParse(index, active, now);
    }
    await this.save(index);
  }
  // Visitors can register a page while a parse is in flight; keep their newer entries.
  async save(index) {
    const latest = await this.storage.get('detailIndex');
    for (const [root, entry] of Object.entries(latest?.roots || {})) {
      const mine = index.roots[root];
      if (!mine) {
        if (Object.keys(index.roots).length < MAX_ROOTS) index.roots[root] = entry;
      } else if ((entry.viewedAt || 0) > (mine.viewedAt || 0)) mine.viewedAt = entry.viewedAt;
    }
    await this.storage.put('detailIndex', index);
  }
  nextParse(index, active, now) {
    const candidates = [];
    for (const [root, entry] of Object.entries(index.roots)) {
      if (!entry.viewedAt) continue;
      for (const path of [root, ...(index.pages[root]?.subpages || [])]) {
        const meta = index.pages[path];
        if (meta?.failures && now < meta.failedAt + retryDelay(meta.failures)) continue;
        const missing = !meta?.fetchedAt,
          changed = meta?.latest && meta.latest !== meta.revid,
          stale = active.has(root) && now - (meta?.fetchedAt || 0) > ACTIVE_REPARSE;
        if (missing || changed || stale)
          candidates.push({
            path,
            root,
            // Missing stage pages first (they unlock the page), then subpages, then refreshes.
            rank: (missing ? 0 : 4) + (path === root ? 0 : 2) + (active.has(root) ? 0 : 1)
          });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    return candidates[0] || null;
  }
  async parse(index, { path, root }, now) {
    const meta = (index.pages[path] ||= {});
    let data;
    try {
      data = await this.center.source(detailParseApi(path), null, {
        priority: 'detail',
        maxBytes: MAX_PARSE_BYTES,
        read: (value) => value
      });
    } catch (error) {
      // A cooldown means nothing was sent; any other failure did use a request slot.
      if (error.retryAfter) index.after = Math.max(index.after, now + error.retryAfter * 1000);
      else {
        index.after = Math.max(index.after, now + PARSE_GAP);
        meta.failures = Math.min(20, (meta.failures || 0) + 1);
        meta.failedAt = now;
      }
      return;
    }
    index.after = Math.max(index.after, now + PARSE_GAP);
    try {
      const parsed = parseDetailPage(data?.parse?.text?.['*'], path),
        subpages = path === root ? subpagesOf(root, data.parse.links) : undefined,
        record = {
          revid: data.parse.revid || null,
          fetchedAt: this.center.now(),
          data: parsed,
          subpages
        };
      if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_PAGE_BYTES)
        throw Error('Detail page too large');
      await this.storage.put(pageKey(path), record);
      Object.assign(meta, {
        revid: record.revid,
        fetchedAt: record.fetchedAt,
        failures: 0,
        failedAt: 0
      });
      if (!meta.latest) meta.latest = record.revid;
      if (subpages) meta.subpages = subpages;
    } catch {
      meta.failures = Math.min(20, (meta.failures || 0) + 1);
      meta.failedAt = this.center.now();
      console.warn(JSON.stringify({ event: 'event_detail_parse_failed', at: meta.failedAt }));
    }
  }
  async checkRevisions(index, active, now) {
    const roots = Object.entries(index.roots).filter(
      ([root, entry]) =>
        entry.viewedAt &&
        now - (entry.checkedAt || 0) >= (active.has(root) ? ACTIVE_CHECK : IDLE_CHECK)
    );
    const paths = [];
    for (const [root] of roots)
      for (const path of [root, ...(index.pages[root]?.subpages || [])])
        if (index.pages[path]?.fetchedAt && paths.length < 50) paths.push(path);
    if (!paths.length) return;
    if (now < ((await this.storage.get('upstreamRetryAt')) || 0)) return;
    try {
      const data = await this.query(detailRevisionApi(paths));
      for (const page of data?.query?.pages || []) {
        const path = String(page.title || '').replace(/ /g, '_');
        if (index.pages[path] && Number.isFinite(page.lastrevid))
          index.pages[path].latest = page.lastrevid;
      }
      for (const [root] of roots) index.roots[root].checkedAt = now;
      index.after = Math.max(index.after, now + 30000);
    } catch {
      index.after = now + 10 * MINUTE;
    }
  }
  async query(url) {
    const env = this.center.env,
      identity = env.EVENTS_CONTACT || env.PUBLIC_ORIGIN;
    if (!identity || /[\r\n]/.test(identity)) throw Error('Missing event API contact');
    await this.center.lpSlot();
    const response = await (env.EVENTS_FETCH || fetch)(url, {
      headers: {
        'User-Agent': 'OWQS-EventCenter/1.0 (' + identity + ')',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      if (/^\d+$/.test(retry || ''))
        await this.storage.put('upstreamRetryAt', this.center.now() + Number(retry) * 1000);
      throw Error('Upstream unavailable');
    }
    if (!response.headers.get('Content-Type')?.includes('application/json'))
      throw Error('Unexpected response');
    const body = await response.text();
    if (body.length > MAX_QUERY_BYTES) throw Error('Response too large');
    return JSON.parse(body);
  }
}

export function detailError(error) {
  return error instanceof Fault ? error : new Fault('赛事详情暂不可用，请稍后重试', 503);
}
