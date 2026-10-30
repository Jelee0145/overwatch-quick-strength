import { ServiceError as Fault } from '../services/errors.mjs';
import { mac, equal } from './crypto.mjs';
export async function signSnapshot(user, data, env) {
  const content = {
    version: 1,
    user,
    scope: { battletag: data.battletag, server: env.DASHEN_SERVER, dts: env.DASHEN_DTS },
    data
  };
  return { content, signature: await mac(content, env.CACHE_SIGNING_KEY) };
}
export async function verifySnapshot(value, user, env, tag) {
  if (
    !value?.content ||
    value.content.user !== user ||
    value.content.version !== 1 ||
    !equal(value.signature, await mac(value.content, env.CACHE_SIGNING_KEY))
  )
    throw new Fault('记录校验失败，请重新查询此账号。');
  const c = value.content;
  if (
    c.scope.server !== env.DASHEN_SERVER ||
    c.scope.dts !== env.DASHEN_DTS ||
    (tag && c.scope.battletag !== tag) ||
    c.data.battletag !== c.scope.battletag
  )
    throw new Fault('缓存账号或赛季不匹配');
  return c.data;
}
