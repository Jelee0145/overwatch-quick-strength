import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifySnapshot } from '../src/security.mjs';

// Input is delivered over SSH stdin. Never log records or configuration values.
export async function importMigration(database, input, { configPath } = {}) {
  if (input.version !== 1 || !Array.isArray(input.namespaces) || !input.config)
    throw Error('Invalid migration format');
  const config = input.config;
  for (const key of [
    'PASSWORD_PEPPER',
    'CACHE_SIGNING_KEY',
    'API_KEY_ENCRYPTION_KEY',
    'ADMIN_PASSWORD_HASH',
    'PUBLIC_ORIGIN'
  ])
    if (!config[key]) throw Error('Incomplete migration configuration');
  if (!/^https:\/\//.test(config.PUBLIC_ORIGIN)) throw Error('Migration requires HTTPS');
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const receipt = await database.store('migration').get('receipt');
  if (receipt && receipt.fingerprint !== fingerprint)
    throw Error('Destination already contains a different migration');
  const converted = [];
  let users = 0,
    batches = 0,
    matches = 0;
  const namespaces = new Set();
  for (const item of input.namespaces) {
    if (namespaces.has(item.ns) || !(item.ns === 'auth' || /^tasks:[a-f0-9]{64}$/.test(item.ns)))
      throw Error('Invalid or duplicate namespace');
    namespaces.add(item.ns);
    const records = new Map(item.records);
    if (records.size !== item.records.length) throw Error('Duplicate migration record');
    if (item.ns === 'auth') users = [...records.keys()].filter((k) => k.startsWith('user:')).length;
    const blobs = [];
    if (item.ns.startsWith('tasks:')) {
      if ([...records.keys()].some((k) => !k.startsWith('history:v1:')))
        throw Error('Only durable history may be migrated from task storage');
      for (const [key, count] of [...records])
        if (key.endsWith(':count')) {
          if (!Number.isSafeInteger(count) || count < 0 || count > 10000)
            throw Error('Invalid history chunk count');
          const root = key.slice(0, -6);
          let text = '';
          for (let i = 0; i < count; i++) {
            const part = records.get(root + ':' + i);
            if (typeof part !== 'string') throw Error('Missing history chunk');
            text += part;
            records.delete(root + ':' + i);
          }
          records.delete(key);
          const blob = JSON.parse(text);
          if (blob.batches) {
            for (const envelope of Object.values(blob.batches)) {
              await verifySnapshot(envelope, item.ns.slice(6), config);
              batches++;
            }
            matches += blob.matches?.length || 0;
          }
          blobs.push([root, blob]);
        }
      if (records.size) throw Error('Unconverted history records');
    }
    converted.push({ ns: item.ns, records: [...records], blobs });
  }
  if (!namespaces.has('auth')) throw Error('Missing authentication directory');
  if (configPath) {
    try {
      const existing = JSON.parse(await readFile(configPath, 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(config))
        throw Error('Existing destination configuration differs');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!receipt) {
    const count = await database.exclusive(
      () =>
        database.db
          .prepare('SELECT (SELECT count(*) FROM kv)+(SELECT count(*) FROM blobs) AS n')
          .get().n
    );
    if (count) throw Error('Destination database must be empty');
    await database.store('migration').transaction(async (tx) => {
      for (const item of converted) {
        const store = database.store(item.ns, true);
        for (const [key, value] of item.records) await store.put(key, value);
        for (const [key, value] of item.blobs) await store.putBlob(key, value);
        if (item.ns === 'auth') await store.setAlarm(Date.now() + 3600000);
      }
      await tx.put('receipt', {
        fingerprint,
        users,
        batches,
        matches,
        importedAt: new Date().toISOString()
      });
    });
  }
  if (configPath) {
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o750 });
    try {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o640, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return { users, batches, matches, namespaces: namespaces.size };
}
