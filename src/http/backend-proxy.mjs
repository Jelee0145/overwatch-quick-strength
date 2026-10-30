import { Fault } from '../security.mjs';
import { checkCookieWrite } from '../api/context.mjs';

function backendOrigin(env) {
  let target;
  try {
    target = new URL(env.API_ORIGIN);
  } catch {
    throw new Fault('后端地址配置无效', 503);
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash
  )
    throw new Fault('后端地址配置无效', 503);
  return target.origin;
}

export async function proxyBackend(request, env) {
  const incoming = new URL(request.url);
  let path;
  try {
    path = decodeURIComponent(incoming.pathname);
  } catch {
    throw new Fault('接口不存在', 404);
  }
  if (
    !path.startsWith('/api/') ||
    /^\/api\/(?:v1\/)?internal(?:\/|$)/.test(path) ||
    path.includes('\\')
  )
    throw new Fault('接口不存在', 404);
  checkCookieWrite(request);
  const origin = backendOrigin(env);
  if (origin === incoming.origin) throw new Fault('后端地址配置无效', 503);
  const target = new URL(origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (
      [
        'host',
        'forwarded',
        'x-real-ip',
        'cf-connecting-ip',
        'true-client-ip',
        'connection',
        'content-length'
      ].includes(key) ||
      key.startsWith('x-forwarded-') ||
      key.startsWith('cf-access-')
    )
      headers.delete(key);
  }
  if (request.method === 'POST') headers.set('Origin', origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await (env.BACKEND_FETCH || fetch)(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
      ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {})
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Fault('后端返回了意外跳转', 502);
    const response = new Response(upstream.body, upstream);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault('后端暂不可用', 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function authorizeBackendPage(request, env) {
  const url = new URL(request.url);
  url.pathname = '/api/v1/auth/session';
  url.search = '';
  const headers = new Headers();
  if (request.headers.has('Cookie')) headers.set('Cookie', request.headers.get('Cookie'));
  const response = await proxyBackend(new Request(url, { headers }), env);
  if (response.status === 401 || response.status === 403) throw new Fault('请先登录', 401);
  if (!response.ok) throw new Fault('后端暂不可用', response.status >= 500 ? response.status : 502);
  let session;
  try {
    session = await response.json();
  } catch {
    throw new Fault('后端响应无效', 502);
  }
  if (session.user?.status !== 'approved') throw new Fault('账号尚未授权', 403);
}
