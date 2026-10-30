import { Fault, json, cookie } from '../security.mjs';
import { authCall } from '../actors/tasks.mjs';
import { readBody as body, sessionInput, checkCookieWrite } from './context.mjs';
import { listEvents, handleReminder } from '../events/application.mjs';
export async function legacyApi(request, env, url, path) {
  if (path === '/api/admin/data-inventory') {
    if (request.method !== 'GET') throw new Fault('请求方法错误', 405);
    const input = sessionInput(request);
    await authCall(env, '/authorize-inventory', {}, input);
    const params = [...url.searchParams.keys()];
    if (params.some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1)
      throw new Fault('盘点参数无效', 400);
    try {
      const page = await authCall(
        env,
        '/admin/data-inventory',
        {
          ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {})
        },
        input
      );
      const users = [];
      for (const user of page.users) {
        const task = env.TASKS.get(env.TASKS.idFromName(user.id));
        const response = await task.fetch('https://internal/', {
          method: 'POST',
          body: JSON.stringify({
            path: '/admin-history-inventory',
            user: user.id,
            adminToken: input.adminToken
          })
        });
        if (!response.ok) throw new Error('Inventory unavailable');
        const history = await response.json();
        users.push({ anonymousId: user.anonymousId, status: user.status, history });
      }
      return json(
        {
          version: 1,
          coverage: 'catalog-metadata-only',
          scopes: 'all',
          snapshot: false,
          generatedAt: new Date().toISOString(),
          cursor: url.searchParams.get('cursor'),
          nextCursor: page.nextCursor,
          total: page.total,
          statusTotals: page.statusTotals,
          metadataRevision: page.metadataRevision,
          users,
          pageTotals: {
            users: users.length,
            gameAccounts: users.reduce((n, u) => n + u.history.accountCount, 0),
            batches: users.reduce((n, u) => n + u.history.batchCount, 0),
            matches: users.reduce((n, u) => n + u.history.matchCount, 0)
          }
        },
        200,
        { 'Cache-Control': 'no-store' }
      );
    } catch (error) {
      if (error instanceof Fault && error.status === 400) throw error;
      throw new Fault('盘点服务暂不可用', 503);
    }
  }
  const mutation = request.method === 'POST';
  checkCookieWrite(request);
  const i = { ...sessionInput(request), body: mutation ? await body(request) : {} };
  const publicRoutes = {
    '/api/auth/register': '/register',
    '/api/auth/login': '/login',
    '/api/auth/reset/request': '/reset/request',
    '/api/auth/reset/confirm': '/reset/confirm',
    '/api/admin/login': '/admin/login'
  };
  const authRoutes = {
    '/api/auth/session': '/session',
    '/api/auth/logout': '/logout',
    '/api/auth/api-key': '/api-key',
    '/api/admin/session': '/admin/session',
    '/api/admin/logout': '/admin/logout',
    '/api/admin/users': '/admin/users',
    '/api/admin/query-control': '/admin/query-control',
    '/api/admin/access': '/admin/access',
    '/api/admin/quota': '/admin/quota',
    '/api/admin/reset': '/admin/reset'
  };
  if (publicRoutes[path] || authRoutes[path]) {
    const internal = publicRoutes[path] || authRoutes[path];
    if (
      internal !== '/admin/query-control' &&
      (['/session', '/admin/session', '/admin/users'].includes(internal) ? mutation : !mutation)
    )
      throw new Fault('请求方法错误', 405);
    const value = await authCall(env, internal, i.body, i),
      headers = {};
    if (value.token) {
      headers['Set-Cookie'] = cookie(value.token, path.startsWith('/api/admin/'), value.seconds);
      delete value.token;
      delete value.seconds;
    }
    if (path.endsWith('/logout'))
      headers['Set-Cookie'] = cookie('', path.startsWith('/api/admin/'), 0);
    if (path === '/api/auth/session')
      value.scope = { server: env.DASHEN_SERVER, dts: env.DASHEN_DTS };
    return json(value, 200, headers);
  }
  const auth = await authCall(env, '/authorize', {}, i);
  if (path === '/api/events/reminders' || path.startsWith('/api/events/reminders/')) {
    const action =
      path === '/api/events/reminders' ? 'list' : path.slice('/api/events/reminders/'.length);
    if (action === 'list' ? mutation : !mutation) throw new Fault('请求方法错误', 405);
    return json(await handleReminder(env, auth.user.id, action, i.body));
  }
  if (path === '/api/events' || path === '/api/events/refresh') {
    if (path.endsWith('/refresh') ? !mutation : mutation) throw new Fault('请求方法错误', 405);
    const params = new URLSearchParams(url.searchParams);
    if (!params.has('status')) params.set('status', 'all');
    const { response, value } = await listEvents(env, auth.user.id, params, {
      refresh: mutation,
      paginate: false
    });
    return response || json(value, 200, { 'Cache-Control': 'private, no-store' });
  }
  const task = env.TASKS.get(env.TASKS.idFromName(auth.user.id));
  let internal,
    b = i.body;
  if (path === '/api/query' && mutation) internal = '/query';
  else if (path === '/api/ai-review' && mutation) internal = '/ai-review';
  else if (path === '/api/history' && mutation) internal = '/history';
  else if (path === '/api/latest' && !mutation) {
    const r = await task.fetch('https://internal/', {
      method: 'POST',
      body: JSON.stringify({ path: '/active', user: auth.user.id, version: auth.version })
    });
    const v = await r.json();
    if (!r.ok) throw new Fault(v.error, r.status);
    return json({
      activeJob: v.tasks.find((t) => t.kind === 'query')?.id || null,
      activeAI: v.tasks.find((t) => t.kind === 'ai')?.id || null,
      result: null
    });
  } else if (/^\/api\/job\/[a-f0-9]{64}(\/(cancel|resume|cache))?$/.test(path)) {
    const parts = path.split('/');
    internal = parts[4] ? '/' + parts[4] : '/status';
    if (internal === '/status' ? mutation : !mutation) throw new Fault('请求方法错误', 405);
    b = { ...i.body, id: parts[3], compact: url.searchParams.get('compact') === '1' };
  } else throw new Fault('接口不存在', 404);
  const r = await task.fetch('https://internal/', {
    method: 'POST',
    body: JSON.stringify({ path: internal, body: b, user: auth.user.id, version: auth.version })
  });
  return r;
}
