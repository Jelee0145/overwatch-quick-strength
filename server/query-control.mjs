import { upstream } from '../src/adapters/dashen.mjs';
import { Fault } from '../src/security.mjs';

const DAY = 86400000;
// Beijing 08:00 is UTC 00:00, independent of the host's timezone.
export function queryCheckSchedule(now) {
  const day = Math.floor((now + 8 * 3600000) / DAY);
  return { day, due: day * DAY };
}

export class QueryControl {
  constructor(storage, env, { now = Date.now, call = upstream } = {}) {
    this.storage = storage;
    this.env = env;
    this.now = now;
    this.call = call;
    this.chain = Promise.resolve();
    this.state = { manual: 'auto', autoSuspended: false, lastDay: null, verdict: 'unchecked' };
  }
  get suspended() {
    return this.state.manual === 'paused' || this.state.autoSuspended;
  }
  get forced() {
    return ['true', '1'].includes(String(this.env.QUERY_SUSPENDED ?? '').toLowerCase());
  }
  get scope() {
    return JSON.stringify([
      String(this.env.QUERY_PROBE_TAG || '')
        .trim()
        .toLowerCase(),
      this.env.DASHEN_SERVER,
      this.env.DASHEN_DTS
    ]);
  }
  snapshot() {
    return {
      supported: true,
      suspended: this.forced || this.suspended,
      forced: this.forced,
      manual: this.state.manual,
      autoSuspended: this.state.autoSuspended,
      verified: this.state.verifiedScope === this.scope,
      lastCheckedAt: this.state.lastCheckedAt || null,
      verdict: this.state.verdict,
      nextCheckAt: this.nextCheckAt
    };
  }
  async recover() {
    this.state = (await this.storage.get('state')) || this.state;
    const { day, due } = queryCheckSchedule(this.now());
    this.nextCheckAt = this.now() < due ? due : this.state.lastDay === day ? due + DAY : this.now();
    await this.storage.setAlarm(this.nextCheckAt);
  }
  change(update) {
    const work = this.chain.then(async () => {
      const next = { ...this.state, ...update(this.state) };
      await this.storage.put('state', next);
      this.state = next;
    });
    this.chain = work.catch(() => {});
    return work;
  }
  async setManual(mode) {
    if (!['auto', 'paused'].includes(mode)) throw new Fault('查询控制模式无效');
    await this.change(() => ({ manual: mode }));
    return this.snapshot();
  }
  async probe() {
    const tag = String(this.env.QUERY_PROBE_TAG || '').trim();
    if (!/^.+#\d+$/.test(tag) || tag.length > 100) return 'probe-not-configured';
    if (!this.env.DASHEN_TOKEN || !this.env.DASHEN_ROLE_ID) return 'credential-missing';
    try {
      const value = await this.call(
        this.env,
        '/searchBnetAccount',
        null,
        {
          name: tag,
          token: this.env.DASHEN_TOKEN,
          roleId: this.env.DASHEN_ROLE_ID,
          dts: this.env.DASHEN_DTS,
          server: this.env.DASHEN_SERVER
        },
        { priority: 'low' }
      );
      if (
        value == null ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && Object.keys(value).length === 0)
      )
        return 'empty';
      if (typeof value?.name !== 'string') return 'invalid-format';
      if (value.name.toLowerCase() !== tag.toLowerCase()) return 'different-player';
      if (typeof value.customerToken !== 'string' || !value.customerToken.trim())
        return 'invalid-format';
      return 'healthy';
    } catch (error) {
      // Only bounded classifications are retained; exception messages can contain provider data.
      return (
        {
          429: 'rate-limited',
          503: 'credential-error',
          504: 'network-error',
          502: 'upstream-error'
        }[error?.status] || 'invalid-format'
      );
    }
  }
  async alarm() {
    const now = this.now(),
      { day, due } = queryCheckSchedule(now);
    if (now < due || this.state.lastDay === day) {
      this.nextCheckAt = now < due ? due : due + DAY;
      await this.storage.setAlarm(this.nextCheckAt);
      return;
    }
    // Claim the day durably before I/O; a restart never sends another probe for this day.
    await this.change(() => ({ lastDay: day, lastCheckedAt: now, verdict: 'checking' }));
    const scope = this.scope,
      verdict = await this.probe();
    await this.change((state) => ({
      verdict: verdict === 'empty' && state.verifiedScope !== scope ? 'empty-unverified' : verdict,
      ...(verdict === 'healthy' ? { autoSuspended: false, verifiedScope: scope } : {}),
      ...(verdict === 'empty' && state.verifiedScope === scope ? { autoSuspended: true } : {})
    }));
    const schedule = queryCheckSchedule(this.now());
    this.nextCheckAt =
      this.now() < schedule.due
        ? schedule.due
        : this.state.lastDay === schedule.day
          ? schedule.due + DAY
          : this.now();
    await this.storage.setAlarm(this.nextCheckAt);
  }
}
