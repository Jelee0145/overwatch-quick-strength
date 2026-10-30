import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const hex = /^[a-f0-9]{64}$/;
const validId = (value) => typeof value === 'string' && hex.test(value);
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
function validateReport(input) {
  const pages = Array.isArray(input) ? input : [input];
  if (!pages.length) throw new Error('Empty report');
  const users = new Map();
  let expectedCursor = null,
    total,
    statuses,
    metadataRevision,
    completed = false;
  for (const page of pages) {
    if (
      completed ||
      page?.version !== 1 ||
      page.coverage !== 'catalog-metadata-only' ||
      page.scopes !== 'all' ||
      page.snapshot !== false ||
      !validId(page.metadataRevision) ||
      !natural(page.total) ||
      !Array.isArray(page.users) ||
      page.users.length > 20 ||
      (page.cursor !== null && !validId(page.cursor)) ||
      page.cursor !== expectedCursor ||
      (page.nextCursor !== null && !validId(page.nextCursor))
    )
      throw new Error('Invalid report or page sequence');
    if (
      !page.statusTotals ||
      Object.entries(page.statusTotals).some(
        ([key, value]) =>
          !['approved', 'pending', 'rejected', 'revoked'].includes(key) || !natural(value)
      ) ||
      Object.values(page.statusTotals).reduce((n, v) => n + v, 0) !== page.total
    )
      throw new Error('Invalid status totals');
    const currentStatuses = JSON.stringify(Object.entries(page.statusTotals).sort());
    if (
      total !== undefined &&
      (total !== page.total ||
        statuses !== currentStatuses ||
        metadataRevision !== page.metadataRevision)
    )
      throw new Error('Directory changed between pages');
    total = page.total;
    statuses = currentStatuses;
    metadataRevision = page.metadataRevision;
    for (const u of page.users) {
      if (
        !validId(u.anonymousId) ||
        users.has(u.anonymousId) ||
        !['approved', 'pending', 'rejected', 'revoked'].includes(u.status) ||
        !Array.isArray(u.history?.accounts)
      )
        throw new Error('Invalid or duplicate user');
      const accounts = new Map();
      for (const a of u.history.accounts) {
        if (
          !validId(a.anonymousId) ||
          accounts.has(a.anonymousId) ||
          !validId(a.scope) ||
          !natural(a.count) ||
          !validId(a.revision) ||
          !Array.isArray(a.batchIds) ||
          a.batchIds.some((id) => !validId(id)) ||
          new Set(a.batchIds).size !== a.batchIds.length
        )
          throw new Error('Invalid or duplicate game account/batch');
        accounts.set(a.anonymousId, { ...a, batchIds: [...a.batchIds].sort() });
      }
      if (
        u.history.accountCount !== accounts.size ||
        u.history.batchCount !==
          [...accounts.values()].reduce((n, a) => n + a.batchIds.length, 0) ||
        u.history.matchCount !== [...accounts.values()].reduce((n, a) => n + a.count, 0)
      )
        throw new Error('Invalid history totals');
      users.set(u.anonymousId, { status: u.status, accounts });
    }
    const sums = page.users.reduce(
      (s, u) => ({
        users: s.users + 1,
        gameAccounts: s.gameAccounts + u.history.accountCount,
        batches: s.batches + u.history.batchCount,
        matches: s.matches + u.history.matchCount
      }),
      { users: 0, gameAccounts: 0, batches: 0, matches: 0 }
    );
    if (!page.pageTotals || Object.keys(sums).some((k) => sums[k] !== page.pageTotals[k]))
      throw new Error('Invalid page totals');
    if (
      page.nextCursor !== null &&
      (page.users.length !== 20 || page.nextCursor !== page.users.at(-1).anonymousId)
    )
      throw new Error('Invalid next cursor');
    expectedCursor = page.nextCursor;
    completed = expectedCursor === null;
  }
  if (!completed || users.size !== total) throw new Error('Incomplete report; collect every page');
  const actual = {};
  for (const u of users.values()) actual[u.status] = (actual[u.status] || 0) + 1;
  if (statuses !== JSON.stringify(Object.entries(actual).sort()))
    throw new Error('Status totals changed');
  return users;
}
export function compareInventories(leftInput, rightInput) {
  const left = validateReport(leftInput),
    right = validateReport(rightInput);
  const missing = (a, b) => [...a.keys()].filter((id) => !b.has(id)).sort();
  const differences = [];
  for (const [id, a] of left) {
    const b = right.get(id);
    if (!b) continue;
    if (a.status !== b.status)
      differences.push({ anonymousId: id, field: 'status', left: a.status, right: b.status });
    const missingLeft = missing(b.accounts, a.accounts),
      missingRight = missing(a.accounts, b.accounts);
    if (missingLeft.length || missingRight.length)
      differences.push({
        anonymousId: id,
        gameAccountsMissingLeft: missingLeft,
        gameAccountsMissingRight: missingRight
      });
    for (const [gameId, x] of a.accounts) {
      const y = b.accounts.get(gameId);
      if (!y) continue;
      const batchMissingLeft = y.batchIds.filter((v) => !x.batchIds.includes(v));
      const batchMissingRight = x.batchIds.filter((v) => !y.batchIds.includes(v));
      if (
        x.scope !== y.scope ||
        x.count !== y.count ||
        x.revision !== y.revision ||
        batchMissingLeft.length ||
        batchMissingRight.length
      )
        differences.push({
          anonymousId: id,
          gameAccountId: gameId,
          metadataChanged: x.scope !== y.scope || x.count !== y.count || x.revision !== y.revision,
          batchMissingLeft,
          batchMissingRight
        });
    }
  }
  return {
    coverage: 'catalog-metadata-only',
    partial: true,
    reason: 'Non-atomic catalog reads; batch existence, bodies and signatures are unverified',
    usersMissingLeft: missing(right, left),
    usersMissingRight: missing(left, right),
    differences
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error('Usage: node scripts/compare-data-inventory.mjs left.json right.json');
    const inputs = await Promise.all(
      process.argv.slice(2).map(async (file) => JSON.parse(await readFile(file, 'utf8')))
    );
    console.log(JSON.stringify(compareInventories(...inputs), null, 2));
  } catch {
    console.error(
      'Inventory comparison refused: invalid, incomplete, duplicate or changing report. Supply two complete JSON reports (ordered page arrays for pagination).'
    );
    process.exitCode = 1;
  }
}
