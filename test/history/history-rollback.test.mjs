import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudHistory } from '../../src/history/cloud-history.mjs';
import { signSnapshot, getBlob, putBlob } from '../../src/security.mjs';
import { restoreLegacyHistory } from '../../scripts/history-storage-rollback.mjs';
import { MemoryStorage } from '../helpers/storage.mjs';

const env = { CACHE_SIGNING_KEY: 'rollback-fixture', DASHEN_SERVER: '1', DASHEN_DTS: '2026' };
async function fixture() {
  const storage = new MemoryStorage(),
    history = new CloudHistory(storage, env);
  for (const tag of ['A#100', 'B#100']) {
    const envelope = await signSnapshot(
      'u',
      {
        battletag: tag,
        queriedAt: '2026-10-20T00:00:00Z',
        matches: [{ mid: tag, t: 1, players: [] }]
      },
      env
    );
    await history.handle('u', { action: 'push', envelopes: [envelope] });
  }
  const keys = [...(await storage.list({ prefix: 'history:v1:' }))]
    .filter(
      ([key]) => key.endsWith(':count') && key.includes(':account:') && !key.includes(':batch:')
    )
    .map(([key]) => key.slice(0, -6));
  assert.equal(keys.length, 2);
  return { storage, history, keys };
}

for (const failure of ['missing', 'tampered', 'write'])
  test(`multi-account downgrade is atomic on ${failure} batch failure`, async () => {
    const { storage, keys } = await fixture(),
      second = await getBlob(storage, keys[1]),
      id = Object.keys(second.batchMeta)[0],
      batch = keys[1] + ':batch:' + id;
    if (failure === 'missing') {
      const { deleteBlob } = await import('../../src/security.mjs');
      await deleteBlob(storage, batch);
    } else if (failure === 'tampered') {
      const envelope = await getBlob(storage, batch);
      envelope.signature = 'tampered';
      await putBlob(storage, batch, envelope);
    } else {
      const put = storage.put.bind(storage);
      storage.put = async (key, value) => {
        if (key.startsWith(keys[1] + ':') && !key.includes(':batch:'))
          throw Error('fixture write failure');
        return put(key, value);
      };
    }
    const before = structuredClone(storage.map);
    await assert.rejects(
      () => restoreLegacyHistory(storage, keys, { apply: true }),
      failure === 'write' ? /fixture write failure/ : /integrity/
    );
    assert.deepEqual(
      storage.map,
      before,
      'account, catalog and all batch chunks roll back together'
    );
  });

test('multi-account downgrade/re-upgrade is repeatable and preserves signed envelopes and revisions', async () => {
  const { storage, history, keys } = await fixture(),
    read = (h) =>
      Promise.all(['A#100', 'B#100'].map((tag) => h.handle('u', { action: 'pull', tag }))),
    before = await read(history);
  for (let round = 0; round < 2; round++) {
    const snapshot = structuredClone(storage.map);
    assert.equal(await restoreLegacyHistory(storage, keys), 2);
    assert.deepEqual(storage.map, snapshot);
    assert.equal(await restoreLegacyHistory(storage, keys, { apply: true }), 2);
    assert.equal(await restoreLegacyHistory(storage, keys, { apply: true }), 0);
    assert.deepEqual(await read(new CloudHistory(storage, env)), before);
  }
});
