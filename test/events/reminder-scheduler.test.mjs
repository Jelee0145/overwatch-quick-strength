import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../server/runtime.mjs';
import { SqliteDatabase } from '../../server/storage.mjs';

const settle = () => new Promise(setImmediate);
const matchAt = (time) => ({
  id: 'scheduler-fixture',
  series: 'owcs',
  sourceUrl: 'https://liquipedia.net/overwatch/Overwatch_Champions_Series/2026/Test',
  teams: [{ name: 'A' }, { name: 'B' }],
  startsAt: new Date(time).toISOString(),
  status: 'scheduled',
  region: '韩国'
});

test('runtime preserves explicitly rewritten alarm even when it equals the dispatch lease', async () => {
  const runtime = createRuntime({}, { filename: ':memory:' });
  try {
    await runtime.ready;
    const store = runtime.database.store('reminders'),
      service = runtime.env.REMINDERS;
    let lease;
    service.alarm = async () => {
      lease = await store.getAlarm();
      await store.setAlarm(lease);
    };
    await store.setAlarm(Date.now() - 1);
    await runtime.tick();
    await settle();
    assert.ok(lease > Date.now());
    assert.equal(await store.getAlarm(), lease);
    service.alarm = async () => {};
    await store.setAlarm(Date.now() - 1);
    await runtime.tick();
    await settle();
    assert.equal(await store.getAlarm(), null, 'untouched lease must still be cleared');
  } finally {
    await runtime.close();
  }
});

test('real reminder handler stays scheduled after repeated runtime dispatch without page polling', async () => {
  const runtime = createRuntime({}, { filename: ':memory:' });
  try {
    await runtime.ready;
    const service = runtime.env.REMINDERS,
      store = runtime.database.store('reminders'),
      match = matchAt(Date.now() + 3600000);
    service.env = {
      EVENTS: { get: () => ({ fetch: async () => Response.json({ matches: [match] }) }) }
    };
    await service.decorate([match]);
    await service.handle('fixture', 'reserve', { matchId: match.id });
    for (let i = 0; i < 3; i++) {
      await store.setAlarm(Date.now() - 1);
      await runtime.tick();
      await settle();
      assert.ok(
        (await store.getAlarm()) > Date.now(),
        'next background check must survive dispatch'
      );
    }
  } finally {
    await runtime.close();
  }
});

test('runtime startup restores a missing alarm from persisted reservations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owqs-reminder-recovery-')),
    filename = path.join(dir, 'state.sqlite3');
  let runtime = createRuntime({}, { filename });
  try {
    await runtime.ready;
    const match = matchAt(Date.now() + 3600000);
    await runtime.env.REMINDERS.decorate([match]);
    await runtime.env.REMINDERS.handle('fixture', 'reserve', { matchId: match.id });
    await runtime.database.store('reminders').deleteAlarm();
    await runtime.close();
    runtime = null;
    runtime = createRuntime({}, { filename });
    await runtime.ready;
    const alarm = await runtime.database.store('reminders').getAlarm();
    assert.ok(
      Number.isFinite(alarm) && alarm >= Date.now() - 1000,
      'recovery must queue a fresh check immediately'
    );
  } finally {
    if (runtime) await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('alarm mutation revisions are shared across storage handles and namespaces remain isolated', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const a = db.store('a'),
      again = db.store('a'),
      b = db.store('b');
    await a.setAlarm(123);
    const revision = a.alarmRevision();
    await again.setAlarm(123);
    assert.equal(a.alarmRevision(), revision + 1);
    assert.equal(b.alarmRevision(), 0);
    await again.deleteAlarm();
    assert.equal(a.alarmRevision(), revision + 2);
  } finally {
    await db.close();
  }
});

test('lease cleanup atomically preserves a concurrent same-time reschedule', async () => {
  const db = new SqliteDatabase(':memory:');
  try {
    const store = db.store('reminders'),
      other = db.store('reminders'),
      lease = Date.now() + 60000;
    await store.setAlarm(lease);
    const revision = store.alarmRevision();
    // Queue another request ahead of cleanup; timestamp equality alone is unsafe.
    const reschedule = other.setAlarm(lease),
      cleanup = store.clearUnchangedAlarm(lease, revision);
    await reschedule;
    assert.equal(await cleanup, false);
    assert.equal(await store.getAlarm(), lease);
    assert.equal(await store.clearUnchangedAlarm(lease, store.alarmRevision()), true);
    assert.equal(await store.getAlarm(), null);
  } finally {
    await db.close();
  }
});
