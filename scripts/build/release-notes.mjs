import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export function collectNotes(commits, initial) {
  const updates = commits
    .filter(
      (c) => /^(feat|feature|fix)(\([^)]*\))?!?:/i.test(c.subject) || /^Changelog:/im.test(c.body)
    )
    .map((c) => ({
      id: c.id,
      date: c.date,
      title: /^fix/i.test(c.subject) ? '问题修复' : '功能更新',
      items: [...c.body.matchAll(/^Changelog:\s*(.+)$/gm)].map((m) => m[1].trim())
    }));
  for (const update of updates)
    if (!update.items.length)
      update.items = [
        commits
          .find((c) => c.id === update.id)
          .subject.replace(/^(feat|feature|fix)(\([^)]*\))?!?:\s*/i, '')
      ];
  const entries = [...updates, ...initial];
  return {
    version: createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 20),
    entries
  };
}
export function gitNotes(base, initial) {
  // The baseline is the first release containing the curated historical entries.
  // Explicit fetch supports shallow Cloudflare build checkouts without pulling secrets.
  try {
    execFileSync('git', ['cat-file', '-e', base + '^{commit}'], { stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', 'origin', '--unshallow'], { stdio: 'ignore' });
  }
  const output = execFileSync(
    'git',
    ['log', base + '..HEAD', '--format=%H%x1f%cs%x1f%s%x1f%b%x1e'],
    { encoding: 'utf8' }
  );
  const commits = output
    .split('\x1e')
    .filter((v) => v.trim())
    .map((line) => {
      const [id, date, subject, body] = line.trim().split('\x1f');
      return { id, date, subject, body: body || '' };
    });
  return collectNotes(commits, initial);
}
