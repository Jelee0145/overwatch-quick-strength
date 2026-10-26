import { Fault, mac, equal, canonical } from '../security.mjs';
export { nameKey } from '../services/data.mjs';
import { nameKey } from '../services/data.mjs';
export const profileKey = (p) => p.playerKey || 'n:' + nameKey(p.name);
export async function playerIdentity(env, ct) {
  return ct && env.CACHE_SIGNING_KEY
    ? mac(
        { domain: 'qs-player-v1', server: env.DASHEN_SERVER, dts: env.DASHEN_DTS, ct },
        env.CACHE_SIGNING_KEY
      )
    : undefined;
}
function identityGroups(players) {
  const parent = new Map(),
    root = (k) => {
      if (!parent.has(k)) parent.set(k, k);
      if (parent.get(k) !== k) parent.set(k, root(parent.get(k)));
      return parent.get(k);
    };
  const keys = (p) =>
    [/^.+#\d+$/.test(nameKey(p.name)) ? 'n:' + nameKey(p.name) : null, p.playerKey].filter(Boolean);
  for (const p of players) {
    const a = keys(p);
    for (const k of a) root(k);
    if (a.length === 2) parent.set(root(a[1]), root(a[0]));
  }
  const groups = new Map();
  for (const p of players) {
    const a = keys(p);
    if (!a.length) continue;
    const key = root(a[0]);
    if (!groups.has(key)) groups.set(key, { names: new Set(), ids: new Set() });
    const g = groups.get(key);
    g.names.add(nameKey(p.name));
    if (p.playerKey) g.ids.add(p.playerKey);
  }
  return [...groups.values()];
}
export function cacheEntries(data) {
  const players = [
      ...(data.matches || []),
      ...(data.recentHistory || []).flatMap((h) => h.matches || []),
      ...(data.queryCache?.battles || []).map((r) => r.game)
    ]
      .flatMap((m) => m.players || [])
      .concat(data.queryCache?.profiles || []),
    byName = new Map(),
    byId = new Map();
  for (const g of identityGroups(players)) {
    for (const name of g.names) byName.set(name, g);
    for (const key of g.ids) byId.set(key, g);
  }
  const records = new Map(),
    put = (type, key, value, updatedAt, names = []) => {
      if (!key) return;
      const id = type + '|' + key,
        old = records.get(id),
        aliases = [...new Set([...(old?.names || []), ...names])].slice(0, 5);
      if (!old || Date.parse(updatedAt) > Date.parse(old.updatedAt))
        records.set(id, { type, key, value, updatedAt, names: aliases });
      else old.names = aliases;
    };
  const profile = (p) => {
    const g = byName.get(nameKey(p.name)) || byId.get(p.playerKey),
      ids = [...(g?.ids || [])],
      names = [...(g?.names || [nameKey(p.name)])],
      key = ids[0] || profileKey(p);
    if (p.res && !p.res.error && Array.isArray(p.res.rows) && p.res.rankQueriedAt)
      put(
        'profile',
        key,
        { name: nameKey(p.name), playerKey: ids[0], playerKeys: ids, res: p.res },
        p.res.rankQueriedAt,
        names
      );
  };
  const game = (owner, m) => {
    put('match', m.mid, { owner: nameKey(owner), game: m }, m.dataQueriedAt || data.queriedAt);
    for (const p of m.players || []) profile(p);
  };
  for (const m of data.matches || []) game(data.battletag, m);
  for (const r of data.queryCache?.battles || []) game(r.owner, r.game);
  for (const p of data.queryCache?.profiles || []) profile(p);
  for (const h of data.recentHistory || []) {
    if (!h.error) {
      const { matches, ...metadata } = h;
      put(
        'history',
        nameKey(h.name),
        {
          ...metadata,
          refs: (matches || []).map(({ mid, t, ret, mapGuid, gameMode }) => ({
            mid,
            t,
            ret,
            mapGuid,
            ...(gameMode === undefined ? {} : { gameMode })
          }))
        },
        h.queriedAt
      );
    }
    for (const m of h.matches || []) game(h.name, m);
  }
  return [...records.values()];
}
export async function mintCacheRecords(user, data, env) {
  return Promise.all(
    cacheEntries(data).map(async (entry) => {
      const content = {
        domain: 'qs-cache-v1',
        user,
        server: env.DASHEN_SERVER,
        dts: env.DASHEN_DTS,
        ...entry
      };
      return { content, signature: await mac(content, env.CACHE_SIGNING_KEY) };
    })
  );
}
export async function verifyCacheRecord(record, user, env) {
  const c = record?.content;
  if (
    c?.domain !== 'qs-cache-v1' ||
    c.user !== user ||
    c.server !== env.DASHEN_SERVER ||
    c.dts !== env.DASHEN_DTS ||
    !['match', 'profile', 'history'].includes(c.type) ||
    typeof c.key !== 'string' ||
    !equal(record.signature, await mac(c, env.CACHE_SIGNING_KEY))
  )
    throw new Fault('缓存记录校验失败');
  return c;
}
export async function mintQueryIndex(user, data, env) {
  const content = {
    domain: 'qs-query-index-v1',
    user,
    server: env.DASHEN_SERVER,
    dts: env.DASHEN_DTS,
    tag: data.battletag,
    updatedAt: data.queriedAt,
    matches: (data.queryIndexMatches || data.matches)
      .slice(0, 50)
      .map(({ mid, t, ret, mapGuid, gameMode }) => ({
        mid,
        t,
        ret,
        mapGuid,
        ...(gameMode === undefined ? {} : { gameMode })
      }))
  };
  return { content, signature: await mac(content, env.CACHE_SIGNING_KEY) };
}
export async function verifyQueryIndex(record, user, tag, env) {
  const c = record?.content;
  if (
    c?.domain !== 'qs-query-index-v1' ||
    c.user !== user ||
    c.server !== env.DASHEN_SERVER ||
    c.dts !== env.DASHEN_DTS ||
    c.tag !== nameKey(tag) ||
    !Array.isArray(c.matches) ||
    c.matches.length > 50 ||
    !equal(record.signature, await mac(c, env.CACHE_SIGNING_KEY))
  )
    throw new Fault('账号缓存索引校验失败');
  return c.matches;
}
export function cleanManifest(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 3000) throw new Fault('缓存清单过大或格式错误');
  const index = new Map();
  for (const m of value) {
    if (
      !['match', 'profile', 'history'].includes(m?.type) ||
      typeof m.key !== 'string' ||
      m.key.length > 150 ||
      m.key === '__proto__'
    )
      continue;
    index.set(m.type + '|' + m.key, {
      type: m.type,
      key: m.key,
      updatedAt: String(m.updatedAt || '').slice(0, 80),
      names: Array.isArray(m.names) ? m.names.slice(0, 5).map(nameKey) : []
    });
  }
  return [...index.values()];
}
