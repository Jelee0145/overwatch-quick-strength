import { Fault, digest, getBlob } from '../security.mjs';

export const inventoryId = (domain, value) =>
  digest('owqs:data-inventory:v1:' + domain + ':' + value);
const hex = /^[a-f0-9]{64}$/;
export async function inventoryUsers(storage, cursor) {
  if (cursor !== undefined && (typeof cursor !== 'string' || !hex.test(cursor)))
    throw new Fault('盘点游标无效', 400);
  const users = [],
    statusTotals = {};
  let total = 0,
    startAfter,
    found = cursor === undefined,
    more = false;
  let metadataRevision = await inventoryId('directory', '');
  for (;;) {
    const page = await storage.list({
      prefix: 'user:',
      limit: 20,
      ...(startAfter ? { startAfter } : {})
    });
    for (const [key, user] of page) {
      if (
        typeof user.id !== 'string' ||
        !['approved', 'pending', 'rejected', 'revoked'].includes(user.status)
      )
        throw new Error('Invalid user metadata');
      const anonymousId = await inventoryId('user', user.id);
      metadataRevision = await inventoryId(
        'directory',
        metadataRevision + ':' + anonymousId + ':' + user.status
      );
      total++;
      statusTotals[user.status] = (statusTotals[user.status] || 0) + 1;
      if (found) {
        if (users.length < 20) users.push({ id: user.id, anonymousId, status: user.status });
        else more = true;
      } else if (anonymousId === cursor) found = true;
      startAfter = key;
    }
    if (page.size < 20) break;
  }
  if (!found) throw new Fault('盘点游标无效', 400);
  return {
    users,
    total,
    statusTotals,
    metadataRevision,
    nextCursor: more ? users.at(-1).anonymousId : null
  };
}

// Catalog metadata only: never read account/batch blobs, migrate, or verify signatures.
export async function historyInventory(storage, user) {
  const root = 'history:v1:' + (await digest(String(user)));
  const catalog = await getBlob(storage, root + ':catalog');
  if (catalog === null) return { accounts: [], accountCount: 0, batchCount: 0, matchCount: 0 };
  if (!Array.isArray(catalog.accounts)) throw new Error('Invalid catalog');
  const accounts = [],
    seen = new Set();
  for (const a of catalog.accounts) {
    if (
      typeof a.key !== 'string' ||
      !a.key.startsWith(root + ':account:') ||
      typeof a.scope !== 'string' ||
      !Number.isSafeInteger(a.count) ||
      a.count < 0 ||
      !Array.isArray(a.batchIds) ||
      a.batchIds.some((id) => typeof id !== 'string' || !hex.test(id)) ||
      new Set(a.batchIds).size !== a.batchIds.length ||
      !hex.test(a.revision)
    )
      throw new Error('Invalid catalog metadata');
    const anonymousId = await inventoryId('game-account', a.key);
    if (seen.has(anonymousId)) throw new Error('Duplicate catalog account');
    seen.add(anonymousId);
    accounts.push({
      anonymousId,
      scope: await inventoryId('scope', a.scope),
      count: a.count,
      batchIds: [...a.batchIds].sort(),
      revision: a.revision
    });
  }
  if (JSON.stringify(catalog) !== JSON.stringify(await getBlob(storage, root + ':catalog')))
    throw new Error('Catalog changed during inventory');
  accounts.sort((a, b) => a.anonymousId.localeCompare(b.anonymousId));
  return {
    accounts,
    accountCount: accounts.length,
    batchCount: accounts.reduce((n, a) => n + a.batchIds.length, 0),
    matchCount: accounts.reduce((n, a) => n + a.count, 0)
  };
}
