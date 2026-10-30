import { writeFile } from 'node:fs/promises';
import { passwordHash } from '../backend/src/security.mjs';
const pepper = 'local-test-pepper-only';
const hash = await passwordHash('local-admin-123', pepper);
await writeFile(
  new URL('../.dev.vars', import.meta.url),
  `PASSWORD_PEPPER="${pepper}"\nCACHE_SIGNING_KEY="local-test-signing-only"\nAPI_KEY_ENCRYPTION_KEY="local-test-api-key-encryption-only"\nADMIN_PASSWORD_HASH='${JSON.stringify(hash)}'\n`
);
console.log('Local test secrets written (.dev.vars is never uploaded).');
