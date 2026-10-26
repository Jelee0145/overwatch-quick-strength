import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'test/plugin/plugin.test.mjs'], {
  stdio: 'inherit'
});
if (result.error) {
  console.error('Plugin test runner unavailable.');
  process.exit(1);
}
process.exit(result.status ?? 1);
