import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const base = path.resolve(import.meta.dirname, '../..');

test('release verifies the service can load the tree before restarting', async () => {
  const source = await readFile(path.join(base, 'scripts/deploy-local.mjs'), 'utf8'),
    compact = source.replace(/\s+/g, '');
  // Source directories are traversed by the unprivileged service, so their modes matter
  // as much as the file modes; a 0700 directory fails exactly like a 0600 module.
  assert.match(source, /src server -type d -exec chmod 755/);
  assert.match(source, /src server -type f -exec chmod 644/);
  // The probe must run as the service user and must precede the restart, otherwise a
  // permission fault becomes an outage instead of a refused release.
  const probe = compact.indexOf("'-u','owqs'");
  const restart = compact.indexOf("'restart','owqs'");
  assert.ok(probe > 0, 'deploy must probe as the service user');
  assert.ok(restart > probe, 'the probe must run before the restart');
  assert.match(source, /src\/worker\.mjs/);
});
