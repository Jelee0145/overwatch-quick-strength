import { SqliteDatabase } from './storage.mjs';
import { importMigration } from './migration.mjs';
process.umask(0o077);
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 256 * 1024 * 1024) throw Error('Migration too large');
  chunks.push(chunk);
}
const body = Buffer.concat(chunks).toString('utf8');
const database = new SqliteDatabase(process.env.OWQS_DATABASE || '/var/lib/owqs/state.sqlite3');
try {
  const summary = await importMigration(database, JSON.parse(body), {
    configPath: process.env.OWQS_CONFIG || '/etc/owqs/config.json'
  });
  console.log(JSON.stringify({ imported: true, ...summary }));
} catch (error) {
  const safe = new Set([
    'Invalid migration format',
    'Incomplete migration configuration',
    'Migration requires HTTPS',
    'Destination already contains a different migration',
    'Invalid or duplicate namespace',
    'Duplicate migration record',
    'Only durable history may be migrated from task storage',
    'Invalid history chunk count',
    'Missing history chunk',
    'Unconverted history records',
    'Missing authentication directory',
    'Existing destination configuration differs',
    'Destination database must be empty'
  ]);
  console.error(
    'OWQS_MIGRATION_ERROR ' +
      JSON.stringify({
        type: error.name,
        reason: safe.has(error.message)
          ? error.message
          : 'History signature or input validation failed'
      })
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
