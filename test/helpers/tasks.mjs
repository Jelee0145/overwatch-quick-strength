import { UserTasks } from '../../src/actors/tasks.mjs';
import { AuthDirectory } from '../../src/actors/auth.mjs';
import { getBlob, putBlob } from '../../src/security.mjs';
import { service } from '../query-fixture.mjs';
import { MemoryStorage } from './storage.mjs';
export async function setup() {
  const storage = new MemoryStorage(),
    ledger = new MemoryStorage(),
    env = {
      CACHE_SIGNING_KEY: 'test-signing-key',
      DASHEN_SERVER: '1',
      DASHEN_DTS: '2026',
      DASHEN_TOKEN: 'fixture-token',
      DASHEN_ROLE_ID: 'fixture-role'
    };
  await ledger.put('user:u', {
    id: 'u',
    status: 'approved',
    version: 1,
    queryDaily: 100,
    aiDaily: 100
  });
  const auth = new AuthDirectory({ storage: ledger }, env),
    fault = { refund: false };
  env.AUTH = {
    idFromName: (n) => n,
    get: () => ({
      fetch: (url, init) =>
        fault.refund && JSON.parse(init.body).body.refund
          ? Response.json({ error: 'fixture unavailable' }, { status: 503 })
          : auth.fetch(new Request(url, init))
    })
  };
  return { storage, ledger, env, fault, task: new UserTasks({ storage }, env) };
}
export async function request(task, path, body = {}) {
  const r = await task.fetch(
    new Request('https://internal/', {
      method: 'POST',
      body: JSON.stringify({ user: 'u', version: 1, path, body })
    })
  );
  return { status: r.status, ...(await r.json()) };
}
export const start = (task, body = {}) =>
  request(task, '/api-query', { battletag: 'Main#100', limit: 5, ...body });
export async function speed(ctx, id) {
  const data = await getBlob(ctx.storage, 'data:' + id);
  data.minIntervalMs = 0;
  await putBlob(ctx.storage, 'data:' + id, data);
}
export async function finish(task, id) {
  for (let n = 0; n < 20; n++) {
    await task.alarm();
    const j = await task.storage.get('job:' + id);
    if (!['running', 'paused', 'awaiting-cache'].includes(j?.state)) return j;
  }
  throw Error('Fixture query did not finish');
}
export async function fixture(run, options = {}) {
  const original = globalThis.fetch,
    mock = service(options);
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    return Response.json({
      code: 0,
      data: await mock.call(
        {},
        u.pathname.replace('/v1/a19ld5tool', ''),
        Object.fromEntries(u.searchParams),
        init?.body ? JSON.parse(init.body) : undefined
      )
    });
  };
  try {
    await run(mock);
  } finally {
    globalThis.fetch = original;
  }
}
