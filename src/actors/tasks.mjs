import { CloudHistory } from '../history/cloud-history.mjs';
import { historyInventory } from '../operations/data-inventory.mjs';
import { warmHistoryAnalysis } from '../history/response.mjs';
import { normalizeQueryOptions, legacyQueryOptions, queryRequestId } from '../query/options.mjs';
import { selectApiMatch } from '../services/match-view.mjs';
import {
  mintQueryIndex,
  verifyQueryIndex,
  cleanManifest,
  cacheEntries,
  mintCacheRecords,
  verifyCacheRecord,
  nameKey
} from '../query/cache-records.mjs';
import {
  Fault,
  json,
  token,
  digest,
  canonical,
  mac,
  equal,
  signSnapshot,
  verifySnapshot,
  putBlob,
  getBlob,
  deleteBlob
} from '../security.mjs';
import {
  createQuery,
  runQuery,
  queryProgress,
  accountScope,
  accountRecords,
  queryCheckpoint,
  restoreQuery,
  upgradeQuery,
  ingestCache
} from '../query/query.mjs';
import { prepareReview, callReview } from '../adapters/review.mjs';
import { QUERY_SUSPENDED_MESSAGE, resolveQuerySuspended } from '../query/suspension.mjs';
import { authCall } from './auth-client.mjs';
export { authCall } from './auth-client.mjs';
import {
  isActiveJob as active,
  refundsFailure,
  refundsCacheOnly,
  retriesAutomatically
} from './task-policy.mjs';
// A rate limit needs fewer starts; a failure needs fewer concurrent requests. Retained only for
// the job that hit them, so one refused task cannot slow every other task down.
export function adaptPacing(data, { rateLimitFailures = 0, reduced = false } = {}) {
  data.concurrency = rateLimitFailures || reduced ? 1 : 3;
  // 500ms after the first refusal, up to 2s; a manual resume alone adds no delay.
  data.minIntervalMs = rateLimitFailures ? Math.min(2000, 500 * rateLimitFailures) : 0;
  return data;
}
// While the switch is on, creation answers with a suspended job record instead of throwing:
// clients already understand `state`, so the page shows one notice and no quota is reserved.
export { QUERY_SUSPENDED_MESSAGE, querySuspended } from '../query/suspension.mjs';
export const RATE_LIMIT_BACKOFF_MS = 30000,
  FAILURE_BACKOFF_MS = 5000,
  MAX_BACKOFF_MS = 120000;
export class UserTasks {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.chain = Promise.resolve();
    this.creating = new Set();
    this.history = new CloudHistory(this.storage, env);
  }
  async fetch(request) {
    const i = await request.json();
    const work = this.chain.then(() => this.handle(i));
    this.chain = work.catch(() => {});
    try {
      return json(await work);
    } catch (e) {
      return json({ error: e instanceof Fault ? e.message : '任务服务暂不可用' }, e.status || 500);
    }
  }
  async schedule() {
    await this.storage.setAlarm(Date.now() + 1);
  }
  async readAccounts() {
    const value = await getBlob(this.storage, 'accounts');
    const scope = await (this.scopePromise ||= accountScope(this.env));
    return value?.scope === scope && value.until > Date.now() ? value.items : [];
  }
  async saveAccounts(s) {
    const items = accountRecords(s),
      signature = canonical(items);
    if (items.length && signature !== this.accountSignature) {
      await putBlob(this.storage, 'accounts', {
        scope: await (this.scopePromise ||= accountScope(this.env)),
        until: Math.max(...items.map((a) => Date.parse(a.queriedAt))) + 1800000,
        items
      });
      this.accountSignature = signature;
    }
  }
  async priorFromHistory(user, tag) {
    try {
      const latest = await this.history.latest(user, nameKey(tag));
      return latest
        ? {
            matches: latest.matches,
            recentHistory: latest.recentHistory || [],
            queryCache: latest.queryCache,
            matchIndex: latest.queryIndexMatches || []
          }
        : null;
    } catch {
      return null;
    }
  }
  async job(id) {
    const j = await this.storage.get('job:' + id);
    if (!j || j.until < Date.now()) throw new Fault('任务不存在或已过期', 404);
    return j;
  }
  async refund(job, reason) {
    if (job.quotaRefunded) {
      job.quota = 'released';
      return true;
    }
    job.refundPending = reason;
    await this.storage.put('job:' + job.id, job);
    try {
      await authCall(this.env, '/quota', {
        user: job.user,
        kind: job.kind,
        job: job.id,
        refund: true
      });
      job.quotaRefunded = true;
      job.quota = 'released';
      job.billingReason = reason;
      delete job.refundPending;
      await this.storage.put('job:' + job.id, job);
      return true;
    } catch {
      await this.storage.setAlarm(Date.now() + 5000).catch(() => {});
      return false;
    }
  }
  async compensate(job, reason) {
    // Old webpage queries kept their reservation on failure. Old API jobs charged cache hits.
    if (job.refundPending) return this.refund(job, job.refundPending);
    if (job.state !== 'done' && refundsFailure(job)) return this.refund(job, reason || job.state);
    return true;
  }
  async persistCreation(job, data, { legacy = false } = {}) {
    job.quota = 'reserved';
    job.billingReason = 'pending';
    job.state = 'creating';
    this.creating.add(job.id);
    try {
      await this.schedule();
      await this.storage.put('job:' + job.id, job);
      if (job.dedupeStorageKey) await this.storage.put(job.dedupeStorageKey, job.id);
      if (job.kind === 'query') await putBlob(this.storage, 'prior:' + job.id, data.prior);
      await putBlob(
        this.storage,
        'data:' + job.id,
        job.kind === 'query' ? queryCheckpoint(data) : data
      );
      await this.schedule();
      await authCall(this.env, '/quota', { user: job.user, kind: job.kind, job: job.id });
      job.state = 'running';
      await this.storage.put('job:' + job.id, job);
      if (legacy) await this.storage.put('active:' + job.kind, job.id);
      await this.schedule();
      return { id: job.id, state: job.state };
    } catch (e) {
      job.state = 'failed';
      job.message = '任务建立失败';
      job.finishedAt = Date.now();
      await this.refund(job, 'creation-failed');
      await this.storage.put('job:' + job.id, job);
      await this.schedule().catch(() => {});
      throw e;
    } finally {
      this.creating.delete(job.id);
    }
  }
  async queryCapacity(user) {
    const now = Date.now(),
      jobs = [...(await this.storage.list({ prefix: 'job:' }))].map(([, j]) => j);
    if (
      jobs.filter(
        (j) =>
          j.user === user &&
          j.kind === 'query' &&
          j.until > now &&
          (active(j) || j.state === 'creating')
      ).length >= 5
    )
      throw new Fault('当前账号的未完成查询已达 5 个，请稍后再试', 429);
  }
  async createJob(metadata, data, { legacy = false } = {}) {
    const now = metadata.createdAt ?? Date.now();
    const job = { id: token(), createdAt: now, until: now + 3600000, ...metadata };
    return this.persistCreation(job, data, { legacy });
  }
  /** A stable record so every client renders the suspension instead of an error toast. */
  suspendedJob(user, version, api = false) {
    return {
      id: token(),
      kind: 'query',
      state: 'suspended',
      suspended: true,
      message: QUERY_SUSPENDED_MESSAGE,
      progress: null,
      createdAt: Date.now(),
      finishedAt: Date.now(),
      policyVersion: 2,
      api: !!api,
      battletag: null,
      quota: 'none',
      billingReason: 'suspended'
    };
  }
  async createUnified(user, version, b, api) {
    if (await resolveQuerySuspended(this.env)) return this.suspendedJob(user, version, api);
    const options = normalizeQueryOptions(b),
      requestId = queryRequestId(b),
      scope = { server: this.env.DASHEN_SERVER, dts: this.env.DASHEN_DTS };
    const fingerprint = await digest(canonical({ options, scope })),
      dedupeStorageKey = requestId
        ? 'dedupe:query:v2:' + (await digest(canonical({ user, requestId })))
        : null;
    if (dedupeStorageKey) {
      const id = await this.storage.get(dedupeStorageKey),
        old = id && (await this.storage.get('job:' + id));
      if (old && old.until > Date.now()) {
        if (old.fingerprint !== fingerprint) throw new Fault('相同请求标识的查询参数不同', 409);
        return { id: old.id, state: old.state };
      }
    }
    await this.queryCapacity(user);
    const now = Date.now();
    const data = createQuery(
      options.battletag,
      options.limit,
      options.syncHistory
        ? (await this.priorFromHistory(user, options.battletag)) || { matches: [] }
        : { matches: [] },
      options.syncHistory ? await this.readAccounts() : [],
      { supplementOtherMatches: options.supplementOtherMatches, pool: options.pool }
    );
    return this.createJob(
      {
        user,
        version,
        kind: 'query',
        api,
        policyVersion: 2,
        apiOptions: options,
        scope,
        fingerprint,
        dedupeStorageKey,
        message: '查询已建立',
        createdAt: now
      },
      data
    );
  }
  async handle(i) {
    const { user, version, path, body: b = {} } = i;
    if (path === '/admin-history-inventory') {
      await authCall(this.env, '/authorize-inventory', {}, { adminToken: i.adminToken });
      return historyInventory(this.storage, user);
    }
    await authCall(this.env, '/check-user', { user, version });
    const request = { user, version, path, body: b };
    const routes = new Map([
      ['/history', this.#handleHistory],
      ['/api-profile', this.#handleApiProfile],
      ['/api-match', this.#handleApiMatch],
      ['/api-match-review', this.#handleApiMatch],
      ['/api-query', this.#handleUnifiedQuery],
      ['/unified-query', this.#handleUnifiedQuery],
      ['/query', this.#handleQuery],
      ['/ai-review', this.#createLegacyJob],
      ['/active', this.#handleActive]
    ]);
    const handler = routes.get(path);
    if (handler) return handler.call(this, request);

    // Preserve job lookup and ownership checks even for unknown paths.
    const job = await this.job(b.id);
    if (job.user !== user) throw new Fault('任务不存在', 404);
    const jobRoutes = new Map([
      ['/cache', this.#handleCache],
      ['/status', this.#handleStatus],
      ['/cancel', this.#handleCancel],
      ['/resume', this.#handleResume]
    ]);
    const jobHandler = jobRoutes.get(path);
    if (jobHandler) return jobHandler.call(this, request, job);
    throw new Fault('接口不存在', 404);
  }
  async #handleHistory({ user, body: b }) {
    return this.history.handle(user, b);
  }
  async #handleApiProfile({ user }) {
    const catalog = await this.history.handle(user, { action: 'list' }),
      last = await this.storage.get('last-api-query');
    const records = [
      ...catalog.accounts.map((a) => ({ tag: a.tag, updatedAt: a.updatedAt })),
      ...(last ? [last] : [])
    ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { valid: true, lastBattletag: records[0]?.tag || null };
  }
  async #handleApiMatch({ user, version, path, body: b }) {
    const query = await this.job(b.id);
    if (query.user !== user || query.kind !== 'query') throw new Fault('查询记录不存在', 404);
    if (query.state !== 'done') throw new Fault('请等待查询完成', 409);
    const envelope = await getBlob(this.storage, 'result:' + query.id),
      snapshot = await verifySnapshot(envelope, user, this.env);
    const selected = selectApiMatch(snapshot, b.index, query.apiOptions || {}),
      detail = selected.detail;
    if (path === '/api-match') return { match: detail };
    const prepared = await prepareReview(snapshot, selected.match.mid),
      cached = await getBlob(this.storage, 'api-review:' + prepared.fingerprint);
    const cachedReview =
      cached && Date.now() - Date.parse(cached.content?.review?.generatedAt) < 30 * 86400000
        ? cached
        : undefined;
    const info = Object.fromEntries(
      ['index', 'count', 'mid', 'battletag', 'mapName', 't', 'ret', 'duration'].map((k) => [
        k,
        detail[k]
      ])
    );
    const value = await this.handle({
      user,
      version,
      path: '/ai-review',
      body: {
        battletag: snapshot.battletag,
        matchId: selected.match.mid,
        envelope,
        cachedReview,
        requestId: b.requestId,
        apiReview: true,
        reviewMatch: info
      }
    });
    return value.cached
      ? { cached: true, review: value.review, match: info }
      : { id: value.id, state: value.state, status: '/api/v1/reviews/' + value.id, match: info };
  }
  async #handleUnifiedQuery({ user, version, path, body: b }) {
    return this.createUnified(user, version, b, path === '/api-query');
  }
  async #handleQuery(request) {
    if (request.body.policyVersion === 2) return this.#handleUnifiedQuery(request);
    return this.#createLegacyJob(request);
  }
  async #createLegacyJob({ user, version, path, body: b }) {
    // AI review reuses saved results and keeps working; only new upstream queries stop.
    if (path === '/query' && (await resolveQuerySuspended(this.env)))
      return this.suspendedJob(user, version);
    const kind = path === '/query' ? 'query' : 'ai',
      options = kind === 'query' ? legacyQueryOptions(b) : null,
      prior = b.envelope ? await verifySnapshot(b.envelope, user, this.env, b.battletag) : null;
    let analysis;
    if (kind === 'ai') {
      if (!prior) throw new Fault('本地缺少可信对局，请先查询');
      analysis = await prepareReview(prior, b.matchId);
      if (
        !b.force &&
        b.cachedReview?.content?.user === user &&
        b.cachedReview.content.fingerprint === analysis.fingerprint &&
        equal(
          b.cachedReview.signature,
          await mac(b.cachedReview.content, this.env.CACHE_SIGNING_KEY)
        )
      )
        return {
          cached: true,
          review: { ...b.cachedReview.content.review, cached: true },
          reviewEnvelope: b.cachedReview
        };
    }
    const fingerprint = await digest(
      canonical(
        kind === 'query'
          ? { ...options, scope: { server: this.env.DASHEN_SERVER, dts: this.env.DASHEN_DTS } }
          : { fingerprint: analysis.fingerprint }
      )
    );
    const previous = await this.storage.get('active:' + kind);
    if (previous) {
      const old = await this.storage.get('job:' + previous);
      if (old && active(old)) {
        if (old.fingerprint === fingerprint) return { id: old.id, state: old.state };
        throw new Fault('当前' + (kind === 'query' ? '查询' : 'AI') + '任务尚未完成', 409);
      }
    }
    if (kind === 'ai' && (typeof b.requestId !== 'string' || b.requestId.length > 100))
      throw new Fault('缺少请求标识');
    // A completed idempotency key is reused until the short-term result expires.
    const dedupeKey = await digest(canonical({ fingerprint, requestId: b.requestId || token() }));
    const done = await this.storage.get('dedupe:' + kind + ':' + dedupeKey);
    if (done) {
      const old = await this.storage.get('job:' + done);
      if (old && old.until > Date.now()) return { id: old.id, state: old.state };
    }
    if (kind === 'query') await this.queryCapacity(user);
    let indexPrior;
    if (kind === 'query' && b.queryIndex) {
      const index = await verifyQueryIndex(b.queryIndex, user, b.battletag, this.env);
      if (prior) prior.matchIndex = index;
      else indexPrior = { matches: [], matchIndex: index };
    }
    const data =
      kind === 'query'
        ? createQuery(
            options.battletag,
            options.limit,
            prior || indexPrior || { matches: [] },
            await this.readAccounts(),
            {
              supplementOtherMatches: options.supplementOtherMatches,
              pool: options.pool,
              cacheManifest: cleanManifest(b.cacheManifest)
            }
          )
        : analysis;
    const job = {
      user,
      version,
      kind,
      fingerprint,
      dedupeKey,
      message: kind === 'query' ? '查询已建立' : '正在准备 AI锐评…'
    };
    if (kind === 'ai') job.reviewKey = String(b.reviewKey || '').slice(0, 150);
    if (kind === 'ai' && b.apiReview) {
      job.apiReview = true;
      job.reviewMatch = b.reviewMatch;
    }
    job.dedupeStorageKey = 'dedupe:' + kind + ':' + dedupeKey;
    return this.createJob(job, data, { legacy: true });
  }
  async #handleActive({ user }) {
    const tasks = [...(await this.storage.list({ prefix: 'job:' }))]
      .map(([, j]) => j)
      .filter((j) => j.user === user && active(j) && j.until > Date.now())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((j) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        message: j.message,
        api: !!j.api,
        policyVersion: j.policyVersion || 1,
        battletag: j.apiOptions?.battletag || null,
        quota: j.quota || (j.quotaRefunded ? 'released' : 'reserved')
      }));
    return { tasks };
  }
  async #handleCache({ user, body: b }, job) {
    if (typeof b.batch !== 'string' || !/^[a-f0-9]{64}$/.test(b.batch))
      throw new Fault('缓存批次无效');
    if (job.kind !== 'query' || job.cancel || !active(job))
      throw new Fault('任务不能接收缓存', 409);
    let data = restoreQuery(
      await getBlob(this.storage, 'data:' + job.id),
      (await getBlob(this.storage, 'prior:' + job.id)) || { matches: [] }
    );
    if (!data.cacheRequest || data.cacheRequest.id !== b.batch) {
      if (job.lastCacheBatch === b.batch) return { ok: true, replayed: true };
      throw new Fault('缓存批次已更新', 409);
    }
    if (
      !Array.isArray(b.records) ||
      b.records.length > 80 ||
      (b.legacyEnvelopes && !Array.isArray(b.legacyEnvelopes)) ||
      b.legacyEnvelopes?.length > 5
    )
      throw new Fault('缓存批次格式错误');
    const entries = [];
    for (const r of b.records) {
      try {
        entries.push(await verifyCacheRecord(r, user, this.env));
      } catch {}
    }
    for (const r of b.legacyEnvelopes || []) {
      try {
        entries.push(...cacheEntries(await verifySnapshot(r, user, this.env)));
      } catch {}
    }
    const completed = b.complete !== false,
      previousBatch = data.cacheRequest.id;
    ingestCache(data, entries, completed);
    await putBlob(this.storage, 'data:' + job.id, queryCheckpoint(data));
    if (completed) {
      job.state = 'running';
      job.cacheRequest = null;
      job.lastCacheBatch = previousBatch;
      job.message = '缓存已核验，继续查询…';
      job.resumeAfter = 0;
    } else job.cacheRequest = data.cacheRequest;
    await this.storage.put('job:' + job.id, job);
    await this.schedule();
    return { ok: true };
  }
  async #handleStatus({ body: b }, job) {
    const r = {
      id: job.id,
      kind: job.kind,
      state: job.state,
      message: job.message,
      progress: job.progress || null,
      cacheRequest: job.cacheRequest || null,
      reviewKey: job.reviewKey || null,
      createdAt: job.createdAt || null,
      finishedAt: job.finishedAt || null,
      apiOptions: job.apiOptions || null,
      policyVersion: job.policyVersion || 1,
      quota:
        job.quota ||
        (job.quotaRefunded ? 'released' : job.state === 'done' ? 'charged' : 'reserved'),
      billingReason: job.billingReason || null
    };
    if (job.apiReview) r.reviewMatch = job.reviewMatch;
    if (job.state === 'done') {
      if (job.kind === 'query') {
        r.archiveWarning = job.archiveWarning || null;
        r.envelope = await getBlob(this.storage, 'result:' + job.id);
        r.queryIndex = await getBlob(this.storage, 'query-index:' + job.id);
        r.cacheRecords = (await getBlob(this.storage, 'cache-result:' + job.id)) || [];
        if (!b.compact) r.result = r.envelope.content.data;
      } else {
        r.reviewEnvelope = await getBlob(this.storage, 'result:' + job.id);
        r.review = r.reviewEnvelope.content.review;
      }
    }
    return r;
  }
  async #handleCancel(request, job) {
    if (job.kind === 'ai') throw new Fault('已发出的 AI 请求不能取消计费');
    if (!active(job)) return { ok: true };
    job.cancel = true;
    if (['paused', 'awaiting-cache'].includes(job.state)) {
      job.state = 'cancelled';
      job.message = '查询已停止';
      job.until = Date.now() + 3600000;
      job.finishedAt = Date.now();
      await this.compensate(job, 'cancelled');
      if ((await this.storage.get('active:query')) === job.id)
        await this.storage.delete('active:query');
    }
    await this.storage.put('job:' + job.id, job);
    await this.schedule();
    return { ok: true };
  }
  async #handleResume(request, job) {
    if (job.kind !== 'query' || job.state !== 'paused') throw new Fault('当前任务不能继续');
    if (job.resumeAfter > Date.now()) throw new Fault('请稍后继续当前任务', 429);
    job.state = 'running';
    job.reducedConcurrency = true;
    job.message = '正在继续查询…';
    await this.storage.put('job:' + job.id, job);
    await this.schedule();
    return { ok: true };
  }
  /** Exponential per error code, capped, so a long outage cannot spin the alarm either. */
  backoff(status, { rateLimits = 0, repeats = 0 } = {}) {
    if (status === 429)
      return Math.min(MAX_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * 2 ** (Math.max(1, rateLimits) - 1));
    if ([502, 504].includes(status))
      return Math.min(MAX_BACKOFF_MS, FAILURE_BACKOFF_MS * 2 ** (Math.max(1, repeats) - 1));
    return 0;
  }
  async alarm() {
    if (this.env.API_ORIGIN) return;
    if (this.executing) return;
    this.executing = true;
    try {
      await this.runAlarm();
    } finally {
      this.executing = false;
    }
  }
  async runAlarm() {
    const jobs = [...(await this.storage.list({ prefix: 'job:' }))].map(([, j]) => j);
    const now = Date.now();
    for (const j of jobs) {
      if (j.state === 'creating' && !this.creating.has(j.id)) {
        j.state = 'failed';
        j.message = '任务建立中断，请重新查询';
        j.finishedAt = now;
        await this.refund(j, 'creation-interrupted');
        await this.storage.put('job:' + j.id, j);
      }
      if (j.refundPending) await this.refund(j, j.refundPending);
      if (['failed', 'cancelled'].includes(j.state) && !j.quotaRefunded)
        await this.compensate(j, j.state);
      if (j.until < now) {
        if (!(await this.compensate(j, 'expired'))) continue;
        await this.storage.delete('job:' + j.id);
        for (const prefix of ['data:', 'prior:', 'result:', 'cache-result:', 'query-index:'])
          await deleteBlob(this.storage, prefix + j.id);
        if ((await this.storage.get('active:' + j.kind)) === j.id)
          await this.storage.delete('active:' + j.kind);
        const key = j.dedupeStorageKey || 'dedupe:' + j.kind + ':' + (j.dedupeKey || j.fingerprint);
        if ((await this.storage.get(key)) === j.id) await this.storage.delete(key);
      }
    }
    for (const j of jobs)
      if (j.until > now && j.state === 'awaiting-cache' && j.cacheRequest?.until <= now) {
        j.state = 'paused';
        j.message = '等待浏览器缓存，请刷新页面继续';
        j.resumeAfter = 0;
        await this.storage.put('job:' + j.id, j);
      }
    for (const j of jobs)
      if (
        retriesAutomatically(j) &&
        j.state === 'paused' &&
        !j.cancel &&
        (j.resumeAfter || 0) <= now &&
        j.until > now
      ) {
        const latest = await this.storage.get('job:' + j.id);
        if (!latest || latest.state !== 'paused' || latest.cancel) continue;
        Object.assign(j, latest, { state: 'running', message: '正在重试查询…' });
        await this.storage.put('job:' + j.id, j);
      }
    const accounts = await getBlob(this.storage, 'accounts');
    if (accounts && accounts.until < now) await deleteBlob(this.storage, 'accounts');
    const last = await this.storage.get('lastKind');
    const job = jobs
      .filter((j) => j.state === 'running' && j.until > now)
      .sort((a, b) => (a.kind === last) - (b.kind === last))[0];
    if (job) {
      try {
        await authCall(this.env, '/check-user', { user: job.user, version: job.version });
        if (
          job.policyVersion === 2 &&
          canonical(job.scope) !==
            canonical({ server: this.env.DASHEN_SERVER, dts: this.env.DASHEN_DTS })
        )
          throw new Fault('查询赛季已变更，请重新查询', 409);
        if (job.cancel) {
          job.state = 'cancelled';
          job.message = '查询已停止';
        } else {
          let data = await getBlob(this.storage, 'data:' + job.id);
          if (!data) throw new Fault('任务数据已过期', 410);
          if (job.kind === 'query') {
            if (data.version !== 2) {
              data = upgradeQuery(data);
              await putBlob(this.storage, 'prior:' + job.id, data.prior);
            } else
              data = restoreQuery(
                data,
                (await getBlob(this.storage, 'prior:' + job.id)) || { matches: [] }
              );
            // Recovery is decided per upstream error, not once per job: a rate limit and a
            // timeout call for different remedies.
            adaptPacing(data, {
              rateLimitFailures: job.rateLimitFailures,
              reduced: job.reducedConcurrency
            });
            let persisted = -1;
            const checkpoint = async (s) => {
              if (s.checkpointRevision === persisted) return;
              const revision = s.checkpointRevision;
              await putBlob(this.storage, 'data:' + job.id, queryCheckpoint(s));
              if (job.apiOptions?.syncHistory !== false) await this.saveAccounts(s);
              const latest = await this.storage.get('job:' + job.id);
              if (!latest) return;
              job.progress = queryProgress(s);
              await this.storage.put('job:' + job.id, {
                ...latest,
                progress: job.progress,
                message:
                  (s.phase === 'done'
                    ? '正在完成查询…'
                    : job.progress.phaseLabel +
                      ' ' +
                      job.progress.completed +
                      '/' +
                      job.progress.total) +
                  ' · 请求 ' +
                  job.progress.requests +
                  ' · 缓存 ' +
                  job.progress.cacheHits
              });
              persisted = revision;
            };
            job.message = await runQuery(data, this.env, {
              checkpoint,
              shouldStop: async () => !!(await this.storage.get('job:' + job.id))?.cancel
            });
            // Reaching this point means the upstream accepted the query at the current pacing.
            job.rateLimitFailures = 0;
            job.failures = 0;
            if (data.cacheRequest) {
              job.state = 'awaiting-cache';
              job.cacheRequest = data.cacheRequest;
              job.message = '正在复用浏览器缓存…';
            }
            if (data.phase === 'done') {
              await putBlob(
                this.storage,
                'query-index:' + job.id,
                await mintQueryIndex(job.user, data.result, this.env)
              );
              await putBlob(
                this.storage,
                'cache-result:' + job.id,
                await mintCacheRecords(job.user, data.result, this.env)
              );
              const envelope = await signSnapshot(job.user, data.result, this.env);
              await putBlob(this.storage, 'result:' + job.id, envelope);
              try {
                if (job.apiOptions?.syncHistory !== false) {
                  await this.history.handle(job.user, { action: 'push', envelopes: [envelope] });
                  if (job.api)
                    await this.storage.put('last-api-query', {
                      tag: data.result.battletag,
                      updatedAt: data.result.queriedAt
                    });
                }
                job.archiveWarning = null;
              } catch (e) {
                job.archiveWarning =
                  e instanceof Fault
                    ? e.message
                    : '云端历史归档暂不可用，已保留查询结果，可稍后补传';
              }
              job.state = 'done';
              job.quota = 'charged';
              job.billingReason = 'upstream-fetch';
              if (
                refundsCacheOnly(job) &&
                !data.result.syncStatus?.fetchedMatches &&
                !data.result.syncStatus?.rankFetches &&
                !data.result.historyStatus?.requests
              )
                await this.refund(job, 'cache-only');
            }
          } else {
            // Alarms may be delivered again after interruption: never resend a dispatched AI request.
            if (job.dispatched)
              throw new Fault('上次 AI 请求中断，未自动重发；请手动重新锐评', 504);
            job.dispatched = true;
            await this.storage.put('job:' + job.id, job);
            const review = await callReview(this.env, data.payload, data.fingerprint);
            const content = { user: job.user, fingerprint: data.fingerprint, review },
              envelope = { content, signature: await mac(content, this.env.CACHE_SIGNING_KEY) };
            await putBlob(this.storage, 'result:' + job.id, envelope);
            if (job.apiReview) {
              const previous = (await this.storage.get('api-review-index')) || [],
                index = [...previous.filter((e) => e !== data.fingerprint), data.fingerprint];
              await putBlob(this.storage, 'api-review:' + data.fingerprint, envelope);
              for (const old of index.slice(0, -50))
                await deleteBlob(this.storage, 'api-review:' + old);
              await this.storage.put('api-review-index', index.slice(-50));
            }
            job.state = 'done';
            job.quota = 'charged';
            job.billingReason = 'ai-response';
            job.message = '锐评已生成';
          }
        }
      } catch (e) {
        job.state =
          [429, 502, 504].includes(e.status) && job.kind === 'query' ? 'paused' : 'failed';
        job.message = e instanceof Fault ? e.message : '任务服务暂不可用';
        // Back off longer after repeated failures; a single rate limit keeps the established pause.
        const rateLimits =
            e.status === 429 ? (job.rateLimitFailures = (job.rateLimitFailures || 0) + 1) : 0,
          repeats = (job.failures = e.status === 429 ? 0 : (job.failures || 0) + 1);
        if (job.kind === 'query')
          job.resumeAfter = Date.now() + this.backoff(e.status, { rateLimits, repeats });
      }
      const latest = await this.storage.get('job:' + job.id);
      if (latest?.cancel && job.kind === 'query' && job.state !== 'done') {
        job.state = 'cancelled';
        job.message = '查询已停止';
      }
      if (!active(job)) {
        if (job.state !== 'done') await this.compensate(job, job.state);
        job.until = Date.now() + 3600000;
        job.finishedAt = job.finishedAt || Date.now();
        if ((await this.storage.get('active:' + job.kind)) === job.id)
          await this.storage.delete('active:' + job.kind);
        if (job.state === 'done' || job.kind === 'ai') {
          await deleteBlob(this.storage, 'data:' + job.id);
          await deleteBlob(this.storage, 'prior:' + job.id);
        }
      }
      await this.storage.put('job:' + job.id, job);
      await this.storage.put('lastKind', job.kind);
      if (
        job.kind === 'query' &&
        job.state === 'done' &&
        !job.archiveWarning &&
        job.apiOptions?.syncHistory !== false
      ) {
        const envelope = await getBlob(this.storage, 'result:' + job.id);
        if (envelope)
          await warmHistoryAnalysis(
            job.user,
            this.env,
            this.history,
            envelope.content.data.battletag,
            job.apiOptions || {}
          ).catch(() => {});
      }
    }
    const rest = [...(await this.storage.list({ prefix: 'job:' }))].map(([, j]) => j),
      currentAccounts = await getBlob(this.storage, 'accounts');
    if (rest.length || currentAccounts)
      await this.storage.setAlarm(
        rest.some((j) => j.state === 'running')
          ? Date.now() + 1
          : Math.min(
              ...rest.map((j) =>
                j.state === 'awaiting-cache'
                  ? Math.min(j.until, j.cacheRequest.until)
                  : j.refundPending
                    ? now + 5000
                    : j.state === 'paused' && retriesAutomatically(j)
                      ? Math.min(j.until, (j.resumeAfter || now) + 1)
                      : j.until
              ),
              currentAccounts?.until || Infinity
            ) + 1
      );
  }
}
