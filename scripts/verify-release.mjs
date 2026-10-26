import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Test the immutable target without replacing the running checkout's public assets.
export function verifyRevision({ root, revision, env = process.env, run = execFileSync }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid release revision');
  root = path.resolve(root);
  const temporary = mkdtempSync(path.join(tmpdir(), 'owqs-verify-')),
    checkout = path.join(temporary, 'checkout');
  if (path.dirname(checkout) !== temporary || path.dirname(temporary) !== path.resolve(tmpdir()))
    throw Error('Unexpected verification directory');
  let attached = false;
  try {
    run('git', ['worktree', 'add', '--detach', checkout, revision], {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    attached = true;
    const options = { cwd: checkout, env, stdio: 'inherit' };
    run('npm', ['ci', '--no-audit', '--no-fund'], options);
    run('npm', ['run', 'build'], options);
    run('npm', ['test'], options);
  } finally {
    try {
      if (attached)
        run('git', ['worktree', 'remove', '--force', checkout], {
          cwd: root,
          env,
          stdio: 'inherit'
        });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
