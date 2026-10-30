import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

// One connection and one queue: async transactions cannot interleave namespaces.
export class SqliteDatabase {
  constructor(filename) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    this.chain = Promise.resolve();
    this.alarmRevisions = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS kv(ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ns,key));
   CREATE TABLE IF NOT EXISTS blobs(ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(ns,key));
   CREATE TABLE IF NOT EXISTS alarms(ns TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
  }
  exclusive(fn) {
    const work = this.chain.then(fn);
    this.chain = work.catch(() => {});
    return work;
  }
  store(ns, transaction = false) {
    return new SqliteStorage(this, ns, transaction);
  }
  due(now = Date.now()) {
    return this.exclusive(() =>
      this.db
        .prepare('SELECT ns,at FROM alarms WHERE at<=? ORDER BY at LIMIT 32')
        .all(now)
        .map(({ ns, at }) => ({ ns, at }))
    );
  }
  async close() {
    await this.chain;
    this.db.close();
  }
}

export class SqliteStorage {
  constructor(database, ns, transaction = false) {
    this.database = database;
    this.ns = ns;
    this.inTransaction = transaction;
  }
  run(fn) {
    return this.inTransaction ? Promise.resolve().then(fn) : this.database.exclusive(fn);
  }
  get(key) {
    return this.run(() => {
      const row = this.database.db
        .prepare('SELECT value FROM kv WHERE ns=? AND key=?')
        .get(this.ns, key);
      return row ? JSON.parse(row.value) : undefined;
    });
  }
  put(key, value) {
    const body = JSON.stringify(value);
    return this.run(() =>
      this.database.db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?,?)').run(this.ns, key, body)
    );
  }
  delete(keys) {
    return this.run(() => {
      const stmt = this.database.db.prepare('DELETE FROM kv WHERE ns=? AND key=?');
      for (const key of Array.isArray(keys) ? keys : [keys]) stmt.run(this.ns, key);
    });
  }
  list({ prefix = '' } = {}) {
    return this.run(
      () =>
        new Map(
          this.database.db
            .prepare('SELECT key,value FROM kv WHERE ns=? AND substr(key,1,?)=? ORDER BY key')
            .all(this.ns, prefix.length, prefix)
            .map((r) => [r.key, JSON.parse(r.value)])
        )
    );
  }
  getBlob(key) {
    return this.run(() => {
      const row = this.database.db
        .prepare('SELECT value FROM blobs WHERE ns=? AND key=?')
        .get(this.ns, key);
      return row ? JSON.parse(row.value) : null;
    });
  }
  putBlob(key, value) {
    const body = JSON.stringify(value);
    return this.run(() =>
      this.database.db.prepare('INSERT OR REPLACE INTO blobs VALUES(?,?,?)').run(this.ns, key, body)
    );
  }
  deleteBlob(key) {
    return this.run(() =>
      this.database.db.prepare('DELETE FROM blobs WHERE ns=? AND key=?').run(this.ns, key)
    );
  }
  getAlarm() {
    return this.run(
      () => this.database.db.prepare('SELECT at FROM alarms WHERE ns=?').get(this.ns)?.at ?? null
    );
  }
  alarmRevision() {
    return this.database.alarmRevisions.get(this.ns) || 0;
  }
  clearUnchangedAlarm(at, revision) {
    return this.run(() => {
      if (this.alarmRevision() !== revision) return false;
      const result = this.database.db
        .prepare('DELETE FROM alarms WHERE ns=? AND at=?')
        .run(this.ns, Number(at));
      if (result.changes) this.database.alarmRevisions.set(this.ns, this.alarmRevision() + 1);
      return !!result.changes;
    });
  }
  setAlarm(at) {
    return this.run(() => {
      const result = this.database.db
        .prepare('INSERT OR REPLACE INTO alarms VALUES(?,?)')
        .run(this.ns, Number(at));
      this.database.alarmRevisions.set(this.ns, this.alarmRevision() + 1);
      return result;
    });
  }
  deleteAlarm() {
    return this.run(() => {
      const result = this.database.db.prepare('DELETE FROM alarms WHERE ns=?').run(this.ns);
      this.database.alarmRevisions.set(this.ns, this.alarmRevision() + 1);
      return result;
    });
  }
  transaction(fn) {
    if (this.inTransaction) return fn(this);
    return this.database.exclusive(async () => {
      this.database.db.exec('BEGIN IMMEDIATE');
      try {
        const value = await fn(this.database.store(this.ns, true));
        this.database.db.exec('COMMIT');
        return value;
      } catch (error) {
        this.database.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
}
