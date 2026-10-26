import path from 'node:path';
import { buildBackend } from './build-backend.mjs';
import { buildWeb } from './build-web.mjs';

const base = path.resolve(import.meta.dirname, '..');
const capture = process.argv.includes('--bot-capture');
if (!process.argv.includes('--web-only')) await buildBackend({ base });
await buildWeb({ base, capture });
console.log(
  'Cloud build complete: hashed scripts, lazy CDN media, idle browser prewarming; original local tool preserved.'
);
