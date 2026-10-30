import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { digest, getBlob, putBlob, deleteBlob } from '../backend/src/security.mjs';

// Run with the service stopped, before checking out code predating batch storage.
// The transaction verifies every batch hash before replacing any account or catalog.
export async function restoreLegacyHistory(storage, keys, { apply = false } = {}) {
  return storage.transaction(async (tx) => {
    let count = 0;
    for (const key of keys) {
      const account = await getBlob(tx, key);
      if (account?.version !== 2 || !account.batchMeta) continue;
      const batches = {};
      for (const id of Object.keys(account.batchMeta)) {
        const envelope = await getBlob(tx, key + ':batch:' + id);
        if (!envelope || (await digest(JSON.stringify(envelope))) !== id)
          throw Error('History batch integrity check failed');
        batches[id] = envelope;
      }
      const legacy = { tag: account.tag, matches: account.matches, batches };
      count++;
      if (!apply) continue;
      await putBlob(tx, key, legacy);
      const catalogKey = key.slice(0, key.indexOf(':account:')) + ':catalog',
        catalog = await getBlob(tx, catalogKey),
        summary = catalog?.accounts.find((a) => a.key === key);
      if (summary) {
        summary.bytes = new TextEncoder().encode(JSON.stringify(legacy)).length;
        await putBlob(tx, catalogKey, catalog);
      }
      for (const id of Object.keys(batches)) await deleteBlob(tx, key + ':batch:' + id);
    }
    return count;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = process.argv.indexOf('--database'),
    filename = arg >= 0 ? process.argv[arg + 1] : null;
  if (!filename || !existsSync(filename))
    throw Error('Pass --database <existing SQLite file>; stop owqs.service first');
  const target = realpathSync(filename),
    apply = process.argv.includes('--apply');
  const { SqliteDatabase } = await import('../backend/server/storage.mjs'),
    database = new SqliteDatabase(target);
  try {
    const rows = database.db
        .prepare(
          "SELECT ns,key FROM blobs WHERE key LIKE 'history:v1:%:account:%' AND key NOT LIKE '%:batch:%'"
        )
        .all(),
      groups = new Map();
    for (const { ns, key } of rows) {
      if (!groups.has(ns)) groups.set(ns, []);
      groups.get(ns).push(key);
    }
    let count = 0;
    for (const [ns, keys] of groups)
      count += await restoreLegacyHistory(database.store(ns), keys, { apply });
    console.log(
      `${apply ? 'Restored' : 'Verified'} ${count} accounts; ${apply ? 'legacy format ready' : 'dry-run, no archive values changed'}.`
    );
  } finally {
    await database.close();
  }
}
