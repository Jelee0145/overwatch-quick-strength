import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { account } from './cf-api.mjs';
const base = path.resolve(import.meta.dirname, '..'),
  auth = (
    await readFile(path.join(base, '.private/config/.wrangler/config/default.toml'), 'utf8')
  ).match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
const r = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/quick-strength-friends`,
  { headers: { Authorization: 'Bearer ' + auth }, redirect: 'error' }
);
const text = await r.text();
console.log(
  JSON.stringify({
    status: r.status,
    manualRedirectCount: (text.match(/redirect:\s*["']manual["']/g) || []).length,
    unsupportedRedirectCount: (text.match(/redirect:\s*["']error["']/g) || []).length,
    adminQuotaSeparated: text.includes('/admin/quota')
  })
);
