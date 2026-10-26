import policy from '../../access-policy.json' with { type: 'json' };
import {
  Fault,
  token,
  digest,
  email,
  passwordHash,
  passwordOK,
  json,
  mac,
  day,
  encryptSecret,
  decryptSecret
} from '../security.mjs';
const LIMIT_WINDOW = 15 * 60 * 1000;
const ROUTES = new Map([
  ['/register', 'register'],
  ['/login', 'login'],
  ['/admin/login', 'adminLogin'],
  ['/reset/request', 'resetRequest'],
  ['/reset/confirm', 'resetConfirm'],
  ['/session', 'sessionInfo'],
  ['/logout', 'logout'],
  ['/admin/logout', 'logout'],
  ['/authorize', 'authorizeSelf'],
  ['/check-user', 'checkUser'],
  ['/quota', 'quota'],
  ['/api-key', 'apiKey'],
  ['/api-key-auth', 'apiKeyAuth']
]);
export class AuthDirectory {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.chain = Promise.resolve();
  }
  async fetch(request) {
    const input = await request.json();
    const work = this.chain.then(() => this.handle(input));
    this.chain = work.catch(() => {});
    try {
      return json(await work);
    } catch (e) {
      return json({ error: e instanceof Fault ? e.message : '登录服务暂不可用' }, e.status || 500);
    }
  }
  async init() {
    if (!(await this.storage.get('policy')))
      await this.storage.put('policy', {
        ...policy,
        approvedEmails: policy.approvedEmails.map((e) => email(e))
      });
    if (!(await this.storage.getAlarm())) await this.storage.setAlarm(Date.now() + 3600000);
  }
  async rate(key, max = 5) {
    key = 'rate:' + (await digest(key));
    const now = Date.now(),
      r = await this.storage.get(key);
    const next =
      r && r.until > now ? { ...r, count: r.count + 1 } : { count: 1, until: now + LIMIT_WINDOW };
    await this.storage.put(key, next);
    if (next.count > max) throw new Fault('操作频繁，请 15 分钟后再试', 429);
  }
  async session(raw, admin = false) {
    if (!raw) throw new Fault('请先登录', 401);
    const s = await this.storage.get('session:' + (await digest(raw)));
    if (!s || s.until < Date.now() || s.admin !== admin)
      throw new Fault('登录已过期，请重新登录', 401);
    if (!admin) {
      const u = await this.storage.get('user:' + s.user);
      if (!u || u.version !== s.version || (s.apiKeyDigest && s.apiKeyDigest !== u.apiKey?.digest))
        throw new Fault('登录已失效，请重新登录', 401);
      return { ...s, account: u };
    }
    return s;
  }
  async authorize(input, admin = false, approved = true) {
    const raw = admin ? input.adminToken : input.userToken,
      s = await this.session(raw, admin);
    if (
      input.mutation &&
      input.csrf !== (await mac({ csrf: raw, admin }, this.env.PASSWORD_PEPPER))
    )
      throw new Fault('请求校验失败，请刷新页面', 403);
    if (!admin && approved && s.account.status !== 'approved')
      throw new Fault('账号尚未授权或授权已撤销', 403);
    return s;
  }
  async issue(user, admin = false, apiKeyDigest = null) {
    const raw = token(),
      p = await this.storage.get('policy'),
      seconds = admin ? p.adminSessionHours * 3600 : p.sessionDays * 86400;
    const s = {
      admin,
      ...(apiKeyDigest ? { apiKeyDigest } : {}),
      user: user?.id || null,
      version: user?.version || 0,
      until: Date.now() + seconds * 1000
    };
    await this.storage.put('session:' + (await digest(raw)), s);
    return { token: raw, seconds, csrf: await mac({ csrf: raw, admin }, this.env.PASSWORD_PEPPER) };
  }
  view(u) {
    return {
      id: u.id,
      email: u.email,
      status: u.status,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      queryDaily: u.queryDaily,
      aiDaily: u.aiDaily,
      resetRequestedAt: u.resetRequestedAt || null,
      apiKey: u.apiKey
        ? { exists: true, createdAt: u.apiKey.createdAt, updatedAt: u.apiKey.updatedAt }
        : { exists: false }
    };
  }
  async audit(action, user) {
    const key = 'audit:' + Date.now() + ':' + token().slice(0, 8);
    await this.storage.put(key, { action, user, at: new Date().toISOString() });
  }
  async apiKeyAccount(raw) {
    if (typeof raw !== 'string' || raw.length > 100) throw new Fault('API 密钥无效', 401);
    const key = await digest(raw),
      userId = await this.storage.get('apikey:' + key);
    const u = userId ? await this.storage.get('user:' + userId) : null;
    if (!u || u.apiKey?.digest !== key) throw new Fault('API 密钥无效', 401);
    if (u.status !== 'approved') throw new Fault('账号尚未授权或授权已撤销', 403);
    return u;
  }
  async handle(i) {
    await this.init();
    const b = i.body || {},
      p = await this.storage.get('policy');
    const handler = ROUTES.get(i.path);
    if (handler) return this[handler](i, b, p);
    if (i.path.startsWith('/admin/')) return this.admin(i, b);
    throw new Fault('接口不存在', 404);
  }
  async register(i, b, p) {
    await this.rate('register:' + i.ip, 10);
    const address = email(b.email),
      id = await digest(address),
      key = 'user:' + id;
    if (await this.storage.get(key)) throw new Fault('无法重复申请，请登录或申请重置密码');
    const password = await passwordHash(b.password, this.env.PASSWORD_PEPPER),
      now = new Date().toISOString();
    const u = {
      id,
      email: address,
      password,
      status: p.approvedEmails.includes(address) ? 'approved' : 'pending',
      version: 1,
      createdAt: now,
      updatedAt: now,
      queryDaily: p.queryDaily,
      aiDaily: p.aiDaily
    };
    await this.storage.put(key, u);
    return { ...(await this.issue(u)), user: this.view(u) };
  }
  async login(i, b) {
    await this.rate('login-ip:' + i.ip, 20);
    if (Object.hasOwn(b, 'apiKey')) {
      const u = await this.apiKeyAccount(b.apiKey);
      await this.rate('login-user:' + u.id, 8);
      return { ...(await this.issue(u, false, u.apiKey.digest)), user: this.view(u) };
    }
    const id = await digest(email(b.email));
    await this.rate('login-user:' + id, 8);
    const u = await this.storage.get('user:' + id);
    // Spend the same KDF work for a non-existent account.
    const record = u?.password || {
      salt: '00000000000000000000000000000000',
      hash: '0'.repeat(64)
    };
    if (!(await passwordOK(b.password, record, this.env.PASSWORD_PEPPER)) || !u)
      throw new Fault('邮箱或密码错误', 401);
    return { ...(await this.issue(u)), user: this.view(u) };
  }
  async adminLogin(i, b) {
    await this.rate('admin-login:' + i.ip);
    let record;
    try {
      record = JSON.parse(this.env.ADMIN_PASSWORD_HASH || '');
    } catch {
      throw new Fault('管理员密码尚未配置', 503);
    }
    if (!(await passwordOK(b.password, record, this.env.PASSWORD_PEPPER)))
      throw new Fault('管理员密码错误', 401);
    return this.issue(null, true);
  }
  async resetRequest(i, b) {
    await this.rate('reset-ip:' + i.ip, 5);
    const id = await digest(email(b.email));
    await this.rate('reset-email:' + id, 2);
    const u = await this.storage.get('user:' + id);
    if (u) {
      u.resetRequestedAt = new Date().toISOString();
      await this.storage.put('user:' + id, u);
    }
    return { message: '申请已提交，请联系管理员核验后获取重置链接' };
  }
  async resetConfirm(i, b) {
    await this.rate('reset-confirm:' + i.ip, 10);
    if (typeof b.code !== 'string' || !/^[a-f0-9]{64}$/.test(b.code))
      throw new Fault('重置链接无效或已过期');
    const key = 'reset:' + (await digest(b.code)),
      r = await this.storage.get(key);
    if (!r || r.until < Date.now()) throw new Fault('重置链接无效或已过期');
    const u = await this.storage.get('user:' + r.user);
    if (!u || u.version !== r.version) throw new Fault('重置链接已失效');
    u.password = await passwordHash(b.password, this.env.PASSWORD_PEPPER);
    u.version++;
    u.resetRequestedAt = null;
    u.updatedAt = new Date().toISOString();
    await this.storage.put('user:' + u.id, u);
    await this.storage.delete(key);
    await this.audit('password-reset', u.id);
    return { message: '密码已更新，请重新登录' };
  }
  async sessionInfo(i) {
    const s = await this.authorize(i, false, false);
    const usage = (await this.storage.get('usage:' + s.user)) || { day: day(), query: 0, ai: 0 };
    return {
      user: this.view(s.account),
      csrf: await mac({ csrf: i.userToken, admin: false }, this.env.PASSWORD_PEPPER),
      usage: usage.day === day() ? usage : { day: day(), query: 0, ai: 0 }
    };
  }
  async logout(i) {
    const admin = i.path.includes('/admin/');
    await this.authorize(i, admin, false);
    await this.storage.delete('session:' + (await digest(admin ? i.adminToken : i.userToken)));
    return { ok: true };
  }
  async authorizeSelf(i) {
    const s = await this.authorize(i);
    return { user: this.view(s.account), version: s.version };
  }
  async checkUser(i, b) {
    const u = await this.storage.get('user:' + b.user);
    if (!u || u.status !== 'approved' || u.version !== b.version)
      throw new Fault('授权或会话已失效', 403);
    return { user: this.view(u) };
  }
  async quota(i, b) {
    return this.storage.transaction(async (storage) => {
      const u = await storage.get('user:' + b.user);
      if (!u || (!b.refund && u.status !== 'approved')) throw new Fault('账号未授权', 403);
      const key = 'usage:' + u.id,
        old = await storage.get(key),
        r = old?.day === day() ? old : { day: day(), query: 0, ai: 0 };
      const kind = b.kind;
      if (!['query', 'ai'].includes(kind) || !b.job) throw new Fault('额度类型错误');
      const reservation = 'quota:' + b.job,
        existing = await storage.get(reservation);
      if (existing && (existing.user !== u.id || (existing.kind && existing.kind !== kind)))
        throw new Fault('额度记录不匹配', 409);
      if (b.refund) {
        if (existing && !existing.refunded) {
          if (existing.day === r.day) {
            r[kind] = Math.max(0, r[kind] - 1);
            await storage.put(key, r);
          }
          await storage.put(reservation, { ...existing, refunded: true });
        }
        return { usage: r };
      }
      if (existing) return { usage: r };
      if (r[kind] >= u[kind + 'Daily'])
        throw new Fault('今日' + (kind === 'ai' ? 'AI锐评' : '查询') + '额度已用完', 429);
      r[kind]++;
      await storage.put(key, r);
      await storage.put(reservation, {
        day: r.day,
        user: u.id,
        kind,
        until: Date.now() + 2 * 86400000
      });
      return { usage: r };
    });
  }
  async apiKey(i, b) {
    const s = await this.authorize(i),
      u = await this.storage.get('user:' + s.user);
    if (!u || u.status !== 'approved') throw new Fault('账号尚未授权', 403);
    if (b.action === 'reveal') {
      await this.rate('api-key-reveal:' + u.id, 30);
      if (!u.apiKey) throw new Fault('尚未创建 API 密钥', 404);
      return {
        key: await decryptSecret(u.apiKey, this.env.API_KEY_ENCRYPTION_KEY),
        createdAt: u.apiKey.createdAt
      };
    }
    if (b.action !== 'regenerate') throw new Fault('密钥操作无效');
    const now = new Date().toISOString(),
      key = 'owqs_' + token(),
      record = await encryptSecret(key, this.env.API_KEY_ENCRYPTION_KEY);
    if (u.apiKey?.digest) await this.storage.delete('apikey:' + u.apiKey.digest);
    u.apiKey = { ...record, digest: await digest(key), createdAt: now, updatedAt: now };
    u.updatedAt = now;
    await this.storage.put('apikey:' + u.apiKey.digest, u.id);
    await this.storage.put('user:' + u.id, u);
    await this.audit('api-key-regenerate', u.id);
    return { key, createdAt: now };
  }
  async apiKeyAuth(i, b) {
    const u = await this.apiKeyAccount(b.key);
    return {
      user: this.view(u),
      version: u.version,
      tier: u.tier === 'free' ? 'free' : 'standard'
    };
  }
  async admin(i, b) {
    await this.authorize(i, true);
    if (i.path === '/admin/session')
      return { csrf: await mac({ csrf: i.adminToken, admin: true }, this.env.PASSWORD_PEPPER) };
    if (i.path === '/admin/users')
      return {
        users: [...(await this.storage.list({ prefix: 'user:' }))].map(([, u]) => this.view(u))
      };
    const u = await this.storage.get('user:' + String(b.id));
    if (!u) throw new Fault('玩家不存在', 404);
    if (i.path === '/admin/access' || i.path === '/admin/quota') {
      if (i.path === '/admin/access') {
        if (!['approved', 'rejected', 'revoked'].includes(b.status))
          throw new Fault('授权状态错误');
        u.status = b.status;
        if (b.status !== 'approved') u.version++;
      }
      for (const k of ['queryDaily', 'aiDaily'])
        if (b[k] !== undefined) {
          if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > 1000)
            throw new Fault('额度应为 0—1000 的整数');
          u[k] = b[k];
        }
      u.updatedAt = new Date().toISOString();
      await this.storage.put('user:' + u.id, u);
      await this.audit(i.path === '/admin/quota' ? 'quota-update' : 'access:' + b.status, u.id);
      return { user: this.view(u) };
    }
    if (i.path === '/admin/reset') {
      if (b.action === 'close') {
        u.resetRequestedAt = null;
        await this.storage.put('user:' + u.id, u);
        await this.audit('reset-close', u.id);
        return { ok: true };
      }
      if (b.action !== 'issue') throw new Fault('重置操作错误');
      const code = token();
      u.version++;
      u.resetRequestedAt = null;
      await this.storage.put('user:' + u.id, u);
      await this.storage.put('reset:' + (await digest(code)), {
        user: u.id,
        version: u.version,
        until: Date.now() + 30 * 60000
      });
      await this.audit('reset-issue', u.id);
      return { code, expiresAt: new Date(Date.now() + 30 * 60000).toISOString() };
    }
    throw new Fault('接口不存在', 404);
  }
  async alarm() {
    const now = Date.now();
    for (const prefix of ['session:', 'reset:', 'rate:', 'audit:', 'quota:']) {
      const values = await this.storage.list({ prefix });
      for (const [key, v] of values)
        if (v.until ? v.until < now : new Date(v.at).getTime() < now - 30 * 86400000)
          await this.storage.delete(key);
    }
    await this.storage.setAlarm(now + 3600000);
  }
}
