import { Fault } from '../security.mjs';

export async function authCall(env, path, body = {}, rest = {}) {
  const r = await env.AUTH.get(env.AUTH.idFromName('directory')).fetch('https://internal/', {
    method: 'POST',
    body: JSON.stringify({ path, body, ...rest })
  });
  const data = await r.json();
  if (!r.ok) throw new Fault(data.error, r.status);
  return data;
}
