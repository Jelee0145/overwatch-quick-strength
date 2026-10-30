import { createHash, randomUUID } from 'node:crypto';
import { Fault } from '../src/security.mjs';
import { broadcastsFor } from '../src/events/broadcasts.mjs';
import { validateSubscription } from './web-push.mjs';

const MINUTE = 60000,
  DAY = 86400000;
const retainNotices = (notices, now) =>
  notices.filter((n) => Number.isFinite(n.createdAt) && now - n.createdAt < DAY).slice(-100);
function pushFailure(error, now) {
  const status = Number(error?.statusCode),
    code =
      Number.isInteger(status) && status >= 400 && status <= 599
        ? 'http'
        : error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'timeout'
          : 'network';
  return { code, at: now, ...(code === 'http' ? { statusCode: status } : {}) };
}
function deliveryView(r, account, enabled, now) {
  const deliveryCount = Object.values(r.deliveries || {}).filter(Boolean).length;
  const eligible = Object.values(account.subscriptions).some(
    (d) => !r.notifiedAt || d.enabledAt <= r.notifiedAt
  );
  const expired = r.notifiedAt && (r.finished || now - Date.parse(r.notifiedStartsAt) > 5 * MINUTE);
  return {
    deliveryStatus: deliveryCount
      ? 'sent'
      : r.deliveryFailure || expired
        ? 'failed'
        : !enabled || !eligible || (r.finished && !r.notifiedAt)
          ? 'unavailable'
          : 'pending',
    deliveryCount,
    deliveryFailure: r.deliveryFailure || null
  };
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
// Time is mutable. Repeated pairings within a stage are deliberately ineligible.
export function matchIdentity(match) {
  if (
    match.series !== 'owcs' ||
    match.teams?.length !== 2 ||
    match.teams.some((t) => !t.name || /^(?:tbd|tba|待定|unknown)$/i.test(t.name))
  )
    return null;
  return hash(
    JSON.stringify([match.sourceUrl, ...match.teams.map((t) => t.name.toLowerCase().trim()).sort()])
  );
}
export class EventReminders {
  constructor(storage, env, { send, publicKey = '', now = () => Date.now() } = {}) {
    this.storage = storage;
    this.env = env;
    this.send = send;
    this.publicKey = publicKey;
    this.now = now;
    this.chain = Promise.resolve();
  }
  exclusive(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => {});
    return p;
  }
  async state() {
    const state = (await this.storage.get('state')) || { catalog: {}, users: {}, checked: {} };
    state.tracking ||= {};
    return state;
  }
  cleanTracking(state, now) {
    for (const [user, account] of Object.entries(state.tracking)) {
      for (const [id, expires] of Object.entries(account.leases))
        if (expires <= now) delete account.leases[id];
      if (!Object.keys(account.leases).length && now - account.lastSync > DAY)
        delete state.tracking[user];
    }
  }
  trackingIds(state, now) {
    return Object.values(state.tracking).flatMap((account) =>
      Object.entries(account.leases)
        .filter(([, expires]) => expires > now)
        .map(([id]) => id)
    );
  }
  syncTracking(user, input) {
    return this.exclusive(async () => {
      const ids = input?.matchIds;
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      )
        throw new Fault('比赛标识格式错误，单批最多 50 场', 400);
      const state = await this.state(),
        now = this.now();
      this.cleanTracking(state, now);
      const account = (state.tracking[user] ||= { leases: {}, lastSync: 0 });
      const limit = (message, seconds = 60) => {
        const error = new Fault(message, 429);
        error.retryAfter = seconds;
        throw error;
      };
      if (!account.windowStart || now - account.windowStart >= MINUTE) {
        account.windowStart = now;
        account.windowCount = 0;
      }
      if (account.windowCount >= 60)
        limit(
          '比赛追踪请求过于频繁',
          Math.max(1, Math.ceil((account.windowStart + MINUTE - now) / 1000))
        );
      const known = [...new Set(ids)].filter((id) => state.catalog[id]);
      const combined = new Set([...Object.keys(account.leases), ...known]);
      if (combined.size > 100) limit('比赛追踪数量已达上限');
      if (
        new Set([...combined].map((id) => state.catalog[id]?.match.sourceUrl).filter(Boolean))
          .size > 20
      )
        limit('比赛追踪来源数量已达上限');
      const allLeases = this.trackingIds(state, now);
      const activeReservations = Object.values(state.users).flatMap((account) =>
        Object.values(account.reservations)
          .filter((r) => !r.finished)
          .map((r) => r.id)
      );
      const globalSources = new Set(
        [...allLeases, ...activeReservations, ...known]
          .map((id) => state.catalog[id]?.match.sourceUrl)
          .filter(Boolean)
      );
      if (globalSources.size > 5 && known.some((id) => !account.leases[id]))
        limit('比赛追踪来源容量已达上限');
      if (
        new Set([...allLeases, ...known]).size > 2000 ||
        allLeases.length + known.filter((id) => !account.leases[id]).length > 10000
      )
        limit('比赛追踪容量已达上限');
      account.lastSync = now;
      account.windowCount++;
      for (const id of known) account.leases[id] = now + 2 * 60 * MINUTE;
      const matches = ids.map((id) => {
        const entry = state.catalog[id],
          obs = entry?.tracking;
        const start = Date.parse(obs?.observedStartsAt);
        let trackingState = !entry
          ? 'missing'
          : entry.ambiguous || obs?.result === 'ambiguous'
            ? 'ambiguous'
            : obs?.result === 'missing'
              ? 'missing'
              : !obs || obs.result !== 'verified' || now - obs.verifiedAt > 3 * MINUTE
                ? 'unverified'
                : entry.match.status === 'completed'
                  ? 'completed'
                  : Number.isFinite(start) && now - start > 10 * MINUTE
                    ? 'expired'
                    : 'watching';
        return {
          id,
          match: entry
            ? { ...entry.match, broadcasts: broadcastsFor(entry.match), reminderId: id }
            : null,
          trackingState,
          scheduleRevision: obs?.scheduleRevision || 0,
          stableSince: obs?.stableSince ?? null,
          verifiedAt: obs?.verifiedAt ?? null,
          leaseExpiresAt: account.leases[id] ?? null,
          canNotify:
            trackingState === 'watching' &&
            (entry.match.startsAt || null) === obs.observedStartsAt &&
            Number.isFinite(start) &&
            now >= start &&
            now - start <= 10 * MINUTE &&
            obs.stableSince + 10 * MINUTE <= now &&
            now - obs.verifiedAt <= 3 * MINUTE
        };
      });
      await this.save(state);
      return { serverTime: now, retryAfter: 60, matches };
    });
  }
  recover() {
    return this.exclusive(async () => {
      const state = await this.state(),
        now = this.now();
      for (const account of Object.values(state.users))
        account.notices = retainNotices(account.notices, now);
      this.cleanTracking(state, now);
      await this.save(state);
      // Recover missing alarms without making network requests or replaying old notices.
      if (
        Object.values(state.users).some((u) =>
          Object.values(u.reservations).some((r) => !r.finished)
        ) ||
        this.trackingIds(state, now).length
      )
        await this.storage.setAlarm(now);
    });
  }
  async save(state) {
    await this.storage.put('state', state);
    await this.schedule(state);
  }
  async schedule(state) {
    const now = this.now(),
      active = Object.values(state.users)
        .flatMap((u) => Object.values(u.reservations))
        .filter((r) => !r.finished);
    const tracked = this.trackingIds(state, now);
    if (!active.length && !tracked.length) {
      await this.storage.deleteAlarm();
      return;
    }
    const times = [...active.map((r) => r.id), ...tracked]
      .map((id) => Date.parse(state.catalog[id]?.match.startsAt))
      .filter((t) => Number.isFinite(t) && t > now);
    const existing = await this.storage.getAlarm(),
      hasRetry = active.some((r) => {
        const start = Date.parse(state.catalog[r.id]?.match.startsAt);
        return start <= now && now - start <= 5 * MINUTE;
      });
    const sources = new Set(
      [...active.map((r) => r.id), ...tracked]
        .map((id) => state.catalog[id]?.match.sourceUrl)
        .filter(Boolean)
    );
    const nextSource = [...sources].map((source) =>
      Math.max(
        now + 30000,
        (state.lastSourceAttempt || 0) + 30000,
        (state.checked[source] || 0) + 2 * MINUTE,
        state.sourceRetry?.[source] || 0
      )
    );
    await this.storage.setAlarm(
      Math.min(
        now + (hasRetry ? 30000 : 2 * MINUTE),
        ...nextSource,
        ...times,
        ...(existing > now ? [existing] : [])
      )
    );
  }
  ingest(state, matches, checkedAt) {
    const groups = new Map();
    for (const match of matches) {
      const id = matchIdentity(match);
      if (id) groups.set(id, [...(groups.get(id) || []), match]);
    }
    for (const [id, group] of groups) {
      const old = state.catalog[id],
        unique = new Map(group.map((m) => [m.id, m]));
      if (old?.checkedAt > checkedAt) {
        if (unique.size > 1) old.ambiguous = true;
        continue;
      }
      if (unique.size !== 1) {
        state.catalog[id] = {
          ...(old || { match: group[0], checkedAt: 0 }),
          lastSeenAt: this.now(),
          ambiguous: true
        };
        continue;
      }
      const match = group[0];
      if (old?.ambiguous && checkedAt === 0) continue;
      const same = old?.match.id === match.id && old?.match.status === match.status;
      state.catalog[id] = {
        match,
        tracking: old?.tracking,
        lastSeenAt: this.now(),
        checkedAt: checkedAt || (same ? old?.checkedAt || 0 : 0),
        ambiguous: false
      };
    }
  }
  decorate(matches) {
    return this.exclusive(async () => {
      const state = await this.state();
      this.ingest(state, matches, 0);
      // A list read is not a fresh source observation; background tracking confirms schedules.
      await this.save(state);
      return matches.map((match) => {
        const id = matchIdentity(match),
          entry = state.catalog[id];
        return {
          ...match,
          broadcasts: broadcastsFor(match),
          reminderId: id,
          reservable:
            !!id &&
            !entry?.ambiguous &&
            match.status !== 'completed' &&
            (!match.startsAt || Date.parse(match.startsAt) > this.now())
        };
      });
    });
  }
  handle(user, action, body = {}) {
    return this.exclusive(async () => {
      const state = await this.state(),
        account = (state.users[user] ||= { subscriptions: {}, reservations: {}, notices: [] });
      if (action === 'subscribe') {
        if (!this.send) throw new Fault('比赛通知尚未配置，请联系管理员', 503);
        let subscription;
        try {
          subscription = validateSubscription(body.subscription);
        } catch {
          throw new Fault('通知设备格式错误', 400);
        }
        const key = hash(subscription.endpoint);
        if (!account.subscriptions[key] && Object.keys(account.subscriptions).length >= 10)
          throw new Fault('最多启用 10 台通知设备');
        // A browser endpoint belongs to its current signed-in account only.
        for (const [id, other] of Object.entries(state.users))
          if (id !== user) delete other.subscriptions[key];
        account.subscriptions[key] = {
          value: subscription,
          enabledAt: account.subscriptions[key]?.enabledAt || this.now()
        };
      } else if (action === 'unsubscribe') {
        if (typeof body.endpoint !== 'string') throw new Fault('通知设备格式错误');
        delete account.subscriptions[hash(body.endpoint)];
      } else if (action === 'reserve') {
        const found = Object.entries(state.catalog).find(
            ([key, v]) => key === body.matchId || v.match.id === body.matchId
          ),
          [id, entry] = found || [];
        if (
          !entry ||
          entry.ambiguous ||
          entry.match.status === 'completed' ||
          (entry.match.startsAt && Date.parse(entry.match.startsAt) <= this.now())
        )
          throw new Fault('这场比赛暂不支持预约，请刷新赛程');
        if (!account.reservations[id] && Object.keys(account.reservations).length >= 100)
          throw new Fault('最多保留 100 场预约，请先清理旧预约');
        account.reservations[id] ||= {
          id,
          originalStartsAt: entry.match.startsAt,
          createdAt: this.now(),
          deliveries: {}
        };
      } else if (action === 'cancel') {
        delete account.reservations[body.id];
        account.notices = account.notices.filter((n) => n.matchId !== body.id);
      } else if (action !== 'list') throw new Fault('接口不存在', 404);
      account.notices = retainNotices(account.notices, this.now());
      await this.save(state);
      return {
        enabled: !!this.send,
        publicKey: this.publicKey,
        deviceCount: Object.keys(account.subscriptions).length,
        deliveryReady: !!this.send && Object.keys(account.subscriptions).length > 0,
        reservations: Object.values(account.reservations).map((r) => {
          const entry = state.catalog[r.id];
          return {
            id: r.id,
            ...deliveryView(r, account, !!this.send, this.now()),
            match: entry?.match,
            changed: r.originalStartsAt !== entry?.match.startsAt,
            state: r.finished
              ? 'completed'
              : r.notifiedAt
                ? 'notified'
                : !entry?.checkedAt || entry.ambiguous
                  ? 'unverified'
                  : 'active'
          };
        }),
        notices: account.notices
      };
    });
  }
  alarm() {
    return this.exclusive(async () => {
      const state = await this.state(),
        now = this.now(),
        ids = new Set([
          ...this.trackingIds(state, now),
          ...Object.values(state.users).flatMap((u) =>
            Object.values(u.reservations)
              .filter((r) => !r.finished)
              .map((r) => r.id)
          )
        ]);
      this.cleanTracking(state, now);
      const sources = [
        ...new Set([...ids].map((id) => state.catalog[id]?.match.sourceUrl).filter(Boolean))
      ];
      // Share source requests across every account and device, obeying EventCenter's gate.
      const source = sources
        .filter(
          (s) =>
            (!state.sourceRetry?.[s] || now >= state.sourceRetry[s]) &&
            (now - (state.checked[s] || 0) >= 2 * MINUTE ||
              [...ids].some((id) => {
                const e = state.catalog[id],
                  start = Date.parse(e?.match.startsAt);
                return e?.match.sourceUrl === s && start <= now && e.checkedAt < start;
              }))
        )
        .sort((a, b) => (state.attempted?.[a] || 0) - (state.attempted?.[b] || 0))[0];
      if (source) {
        state.attempted ||= {};
        state.attempted[source] = now;
        state.lastSourceAttempt = now;
        state.sourceRetry ||= {};
        try {
          const response = await this.env.EVENTS.get().fetch(
            'https://events.internal/track?source=' + encodeURIComponent(source),
            { method: 'POST' }
          );
          if (response.ok) {
            const data = await response.json();
            for (const id of ids)
              if (state.catalog[id]?.match.sourceUrl === source) state.catalog[id].checkedAt = 0;
            this.ingest(state, data.matches, now);
            for (const id of ids) {
              const entry = state.catalog[id];
              if (entry?.match.sourceUrl !== source) continue;
              const matches = data.matches.filter((m) => matchIdentity(m) === id);
              const unique = new Map(matches.map((m) => [m.id, m]));
              const obs = entry.tracking || {
                scheduleRevision: 0,
                stableSince: null,
                verifiedAt: null
              };
              if (unique.size !== 1) {
                obs.result = unique.size ? 'ambiguous' : 'missing';
                obs.stableSince = null;
              } else {
                const startsAt = matches[0].startsAt || null;
                if (!obs.scheduleRevision || obs.observedStartsAt !== startsAt) {
                  obs.scheduleRevision++;
                  obs.stableSince = now;
                } else if (
                  obs.stableSince === null ||
                  !obs.verifiedAt ||
                  now - obs.verifiedAt > 5 * MINUTE
                ) {
                  obs.stableSince = now;
                }
                obs.observedStartsAt = startsAt;
                obs.verifiedAt = now;
                obs.result = 'verified';
              }
              entry.tracking = obs;
            }
            state.checked[source] = now;
            delete state.sourceRetry[source];
          } else if (response.status === 429) {
            const seconds = Number(response.headers.get('Retry-After'));
            state.sourceRetry[source] =
              now +
              Math.min(
                5 * MINUTE,
                Math.max(1000, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30000)
              );
          } else {
            state.sourceRetry[source] = now + 5 * MINUTE;
            for (const id of ids) {
              const entry = state.catalog[id];
              if (entry?.match.sourceUrl === source && entry.tracking)
                entry.tracking.result = 'failed';
            }
          }
        } catch {
          state.sourceRetry[source] = now + 5 * MINUTE;
          for (const id of ids) {
            const entry = state.catalog[id];
            if (entry?.match.sourceUrl === source && entry.tracking)
              entry.tracking.result = 'failed';
          }
          /* Preserve reservations and retry after the shared source backoff. */
        }
      }
      for (const account of Object.values(state.users)) {
        account.notices = retainNotices(account.notices, now);
        for (const r of Object.values(account.reservations)) {
          const entry = state.catalog[r.id];
          if (!entry || r.finished) continue;
          if (entry.match.status === 'completed') {
            r.finished = true;
            r.finishedAt = now;
            continue;
          }
          const start = Date.parse(entry.match.startsAt);
          if (
            (Number.isFinite(start) && now - start > DAY) ||
            (!Number.isFinite(start) && now - r.createdAt > 14 * DAY)
          ) {
            r.finished = true;
            r.finishedAt = now;
            continue;
          }
          if (r.notifiedAt && r.notifiedStartsAt !== entry.match.startsAt && start > now) {
            r.notifiedAt = null;
            r.noticeId = null;
            r.deliveries = {};
            delete r.deliveryFailure;
            account.notices = account.notices.filter((n) => n.matchId !== r.id);
          }
          if (
            entry.ambiguous ||
            !entry.checkedAt ||
            now - entry.checkedAt > 3 * MINUTE ||
            !Number.isFinite(start) ||
            start > now ||
            entry.checkedAt < start
          )
            continue;
          // Never replay old reminders after a long outage.
          if (now - start > 5 * MINUTE) {
            r.finished = true;
            r.finishedAt = now;
            continue;
          }
          if (!r.notifiedAt) {
            r.notifiedAt = now;
            r.notifiedStartsAt = entry.match.startsAt;
            r.noticeId = randomUUID();
            account.notices.push({
              id: r.noticeId,
              matchId: r.id,
              url: broadcastsFor(entry.match)[0]?.url || '/tools/events',
              createdAt: now
            });
            account.notices = retainNotices(account.notices, now);
          }
          const payload = {
            id: r.noticeId,
            title: '即将开赛',
            url: broadcastsFor(entry.match)[0]?.url || '/tools/events',
            tag: 'owqs-match-' + r.id
          };
          // Persist the notice before outbound work; successful endpoints survive restarts.
          await this.storage.put('state', state);
          for (const [key, device] of Object.entries(account.subscriptions)) {
            if (this.now() - start > 5 * MINUTE) break;
            if (r.deliveries[key] || device.enabledAt > r.notifiedAt || !this.send) continue;
            try {
              const result = await this.send(device.value, payload);
              if (result?.expired) {
                delete account.subscriptions[key];
                r.deliveryFailure = { code: 'expired', at: this.now() };
                console.warn(
                  JSON.stringify({ event: 'event_reminder_push_failed', ...r.deliveryFailure })
                );
              } else {
                r.deliveries[key] = true;
                delete r.deliveryFailure;
              }
            } catch (error) {
              r.deliveryFailure = pushFailure(error, this.now());
              console.warn(
                JSON.stringify({ event: 'event_reminder_push_failed', ...r.deliveryFailure })
              );
            }
            // Persist only an allowlisted failure category, never provider text or device URLs.
            await this.storage.put('state', state);
          }
        }
      }
      for (const account of Object.values(state.users))
        for (const [id, r] of Object.entries(account.reservations))
          if (r.finishedAt && now - r.finishedAt > 7 * DAY) delete account.reservations[id];
      // Bound catalog retention without dropping any account's reservations.
      const retained = new Set([
        ...Object.values(state.users).flatMap((u) => Object.keys(u.reservations)),
        ...this.trackingIds(state, now)
      ]);
      for (const [id, v] of Object.entries(state.catalog))
        if (
          !retained.has(id) &&
          (Date.parse(v.match.startsAt) < now - 7 * DAY ||
            (!Number.isFinite(Date.parse(v.match.startsAt)) &&
              now - (v.lastSeenAt || now) > 14 * DAY))
        )
          delete state.catalog[id];
      await this.save(state);
    });
  }
}
