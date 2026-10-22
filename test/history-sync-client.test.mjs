import {createDataService} from '../src/services/data.mjs';
import * as historyGeometry from '../src/services/history-geometry.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {signSnapshot, verifySnapshot} from '../src/security.mjs';

const modelSource = await readFile(new URL('../web/history-model.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../web/cloud-history.js', import.meta.url), 'utf8');
const tag = 'Main#100';
const session = {user: {id: 'u'}, scope: {server: '1', dts: '2026'}};
const signingKey = 'history-sync-client-fixture-key';
const clone = value => structuredClone(value);
const batchId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeKey = value => [value.user.id, value.scope.server, value.scope.dts].join('|');
const signingEnv = value => ({
 DASHEN_SERVER: value.scope.server, DASHEN_DTS: value.scope.dts, CACHE_SIGNING_KEY: signingKey
});
const game = i => ({
 mid: '900719925474099' + String(i).padStart(4, '0'), t: i * 1000,
 mapGuid: 'map-' + i, mapName: 'Fixture map', ret: 1,
 players: [{name: tag, hero: 'hero-1', stats: {kill: i + 1, death: 2}}]
});
function signed(matches, value = session, queriedAt = '2026-10-14T00:00:00Z') {
 return signSnapshot(value.user.id, {battletag: tag, queriedAt, matches}, signingEnv(value));
}

// Clone at the store boundary, as IndexedDB does: callers cannot accidentally
// persist in-memory mutations. Requests complete asynchronously, including reads.
function memoryDB() {
 const tables = {cache: new Map(), historyAccounts: new Map()};
 return {
  tables,
  transaction(name) {
   assert.ok(tables[name], 'unexpected object store: ' + name);
   const tx = {
    objectStore(storeName) {
     assert.equal(storeName, name);
     function request(operation) {
      const r = {};
      queueMicrotask(() => {
       r.result = clone(operation());
       r.onsuccess?.();
       tx.oncomplete?.();
      });
      return r;
     }
     return {
      get: key => request(() => tables[name].get(key)),
      getAll: () => request(() => [...tables[name].values()]),
      put: (value, key) => request(() => {
       tables[name].set(key, clone(value));
       return key;
      })
     };
    }
   };
   return tx;
  }
 };
}

// One server shared by independent VM clients. The authenticated session scopes
// every API operation; pagination deliberately requires more than one pull.
function syncServer() {
 const scopes = new Map(), calls = [];
 const server = {
  calls,
  offline: false,
  hideListedBatches: false,
  failPushNumber: null,
  pushAttempts: 0,
  accounts(value) {
   const key = scopeKey(value);
   if (!scopes.has(key)) scopes.set(key, new Map());
   return scopes.get(key);
  },
  async api(value, path, body) {
   assert.equal(path, '/api/v1/history');
   calls.push({scope: scopeKey(value), body: clone(body)});
   if (server.offline) throw Error('offline');
   const accounts = server.accounts(value);
   if (body.action === 'list') {
    return {accounts: [...accounts].map(([accountTag, batches]) => ({
     tag: accountTag, batchIds: server.hideListedBatches ? [] : [...batches.keys()]
    }))};
   }
   if (body.action === 'push') {
    server.pushAttempts++;
    if (server.pushAttempts === server.failPushNumber) throw Error('interrupted push');
    for (const envelope of body.envelopes) {
     assert.equal(envelope.content.user, value.user.id);
     assert.equal(envelope.content.scope.server, value.scope.server);
     assert.equal(envelope.content.scope.dts, value.scope.dts);
     const accountTag = envelope.content.data.battletag;
     if (!accounts.has(accountTag)) accounts.set(accountTag, new Map());
     accounts.get(accountTag).set(batchId(envelope), clone(envelope));
    }
    return {ok: true};
   }
   if (body.action === 'pull') {
    const batches = [...(accounts.get(body.tag)?.values() || [])];
    const cursor = Number(body.cursor || 0);
    return {envelopes: clone(batches.slice(cursor, cursor + 1)), nextCursor: cursor + 1 < batches.length ? cursor + 1 : null};
   }
   assert.fail('unexpected history action: ' + body.action);
  }
 };
 return server;
}

async function device(server, db = memoryDB(), value = session) {
 const status = {textContent: ''};
 const window = {OWQS_SERVICES:{data:createDataService(),historyGeometry},document: {getElementById: id => id === 'historySyncStatus' ? status : null}};
 const context = vm.createContext({
  window,
  Cloud: {key: async envelope => batchId(envelope), api: (path, body) => server.api(value, path, body)}
 });
 vm.runInContext(modelSource, context);
 // Browser globals are properties of window; the VM sandbox supplies the alias.
 context.QS_HISTORY_MODEL = window.QS_HISTORY_MODEL;
 vm.runInContext(clientSource, context);
 await window.CloudHistory.initialize(db, value);
 return {history: window.CloudHistory, db, status};
}
const plain = value => JSON.parse(JSON.stringify(value));
const pushes = server => server.calls.filter(call => call.body.action === 'push');

test('device A migrates old signed cache batches; empty device B pulls complete envelopes across pages', async () => {
 const server = syncServer(), dbA = memoryDB();
 const first = await signed([game(0), game(1)]);
 const second = await signed([game(1), game(2)], session, '2026-10-14T01:00:00Z');
 dbA.tables.cache.set('old-cache-one', first);
 dbA.tables.cache.set('old-cache-two', second);
 const a = await device(server, dbA);
 assert.equal((await a.history.load(tag)).matches.length, 3);
 assert.equal((await a.history.sync()).ok, true);
 assert.equal(pushes(server).length, 2);
 assert.deepEqual(new Set(server.accounts(session).get(tag).keys()), new Set([batchId(first), batchId(second)]));

 const b = await device(server);
 assert.equal(await b.history.load(tag), null);
 assert.equal((await b.history.sync()).ok, true);
 assert.equal((await b.history.load(tag)).matches.length, 3);
 assert.deepEqual(plain(await b.history.envelope(tag, game(0).mid)), first);
 assert.deepEqual(plain(await b.history.envelope(tag, game(1).mid)), second);
 assert.deepEqual(plain(await b.history.envelope(tag, game(2).mid)), second);
 const recovered = await b.history.envelope(tag, game(0).mid);
 assert.deepEqual(await verifySnapshot(recovered, session.user.id, signingEnv(session), tag), first.content.data);
 assert.equal(server.calls.filter(call => call.body.action === 'pull').length, 2);
 assert.equal(pushes(server).length, 2, 'an empty receiving device must not upload anything');
});

test('retry and restart do not re-upload an acknowledged batch when a later push fails', async () => {
 const server = syncServer(), a = await device(server);
 const first = await signed([game(0)]), second = await signed([game(1)]);
 await a.history.save(first);
 await a.history.save(second);
 server.failPushNumber = 2;
 assert.equal((await a.history.sync()).ok, false);
 assert.equal(server.accounts(session).get(tag).size, 1);
 assert.equal((await a.history.load(tag)).matches.length, 2);

 // A stale listing makes the persisted local acknowledgement the only reason
 // the first batch is skipped, instead of merely exercising remote deduplication.
 server.hideListedBatches = true;
 const restarted = await device(server, a.db);
 assert.equal((await restarted.history.sync()).ok, true);
 const uploadedIds = pushes(server).map(call => batchId(call.body.envelopes[0]));
 assert.deepEqual(uploadedIds, [batchId(first), batchId(second), batchId(second)]);
 assert.equal(server.accounts(session).get(tag).size, 2);
 const restartedAgain = await device(server, a.db);
 assert.equal((await restartedAgain.history.sync()).ok, true);
 assert.equal(pushes(server).length, 3, 'acknowledgements for both batches survive reload');
});

test('a failed upload still pulls remote history, preserves the failed batch and retries it later', async () => {
 const server = syncServer(), a = await device(server);
 const remote = await signed([game(0)]);
 const failed = await signed([game(1)]);
 const successful = await signed([game(2)]);
 server.accounts(session).set(tag, new Map([[batchId(remote), remote]]));
 await a.history.save(failed);
 await a.history.save(successful);
 server.failPushNumber = 1;
 const result = await a.history.sync();
 assert.equal(result.ok, false);
 assert.match(result.error, /interrupted push/);
 assert.deepEqual(plain(await a.history.envelope(tag, game(0).mid)), remote, 'remote recovery continues after an upload error');
 assert.deepEqual(plain(await a.history.envelope(tag, game(1).mid)), failed, 'failed uploads retain the original local signature');
 assert.deepEqual(server.accounts(session).get(tag).get(batchId(successful)), successful, 'later local batches are still uploaded');
 assert.equal(server.accounts(session).get(tag).has(batchId(failed)), false);
 assert.match(a.status.textContent, /本地历史仍可查看/);

 const restarted = await device(server, a.db);
 assert.equal((await restarted.history.sync()).ok, true);
 assert.deepEqual(pushes(server).map(call => batchId(call.body.envelopes[0])), [batchId(failed), batchId(successful), batchId(failed)]);
 assert.equal((await restarted.history.load(tag)).matches.length, 3);
 assert.equal(server.accounts(session).get(tag).size, 3);
});

test('offline synchronization preserves local history and later reconnect uploads it', async () => {
 const server = syncServer(), a = await device(server);
 const envelope = await signed([game(0), game(1)]);
 await a.history.save(envelope);
 server.offline = true;
 assert.equal((await a.history.sync()).ok, false);
 assert.match(a.history.status(), /offline/);
 assert.match(a.status.textContent, /本地历史仍可查看/);
 assert.deepEqual(plain(await a.history.envelope(tag, game(0).mid)), envelope);
 assert.equal((await a.history.list())[0].matches.length, 2);
 assert.equal(pushes(server).length, 0);

 server.offline = false;
 const restarted = await device(server, a.db);
 assert.equal((await restarted.history.sync()).ok, true);
 assert.deepEqual(server.accounts(session).get(tag).get(batchId(envelope)), envelope);
});

test('local migration and synchronization isolate users, seasons and servers', async () => {
 const server = syncServer(), db = memoryDB();
 const sessions = [
  session,
  {...session, user: {id: 'other'}},
  {...session, scope: {server: '1', dts: '2025'}},
  {...session, scope: {server: '2', dts: '2026'}}
 ];
 const envelopes = await Promise.all(sessions.map((value, i) => signed([game(i)], value)));
 envelopes.forEach((envelope, i) => db.tables.cache.set('old-' + i, envelope));
 for (const [i, value] of sessions.entries()) {
  const a = await device(server, db, value);
  assert.deepEqual(plain((await a.history.load(tag)).matches.map(row => row.mid)), [game(i).mid]);
  for (const [j, envelope] of envelopes.entries()) {
   if (j !== i) await assert.rejects(() => a.history.save(envelope), /签名范围不匹配/);
  }
  assert.equal((await a.history.sync()).ok, true);
  assert.deepEqual([...server.accounts(value).get(tag).keys()], [batchId(envelopes[i])]);
  const b = await device(server, memoryDB(), value);
  assert.equal(await b.history.load(tag), null);
  assert.equal((await b.history.sync()).ok, true);
  assert.deepEqual(plain(await b.history.envelope(tag, game(i).mid)), envelopes[i]);
  assert.equal((await b.history.list()).length, 1);
  for (let j = 0; j < sessions.length; j++) {
   if (j !== i) assert.equal(await b.history.envelope(tag, game(j).mid), null);
  }
 }
 assert.equal(pushes(server).length, sessions.length);
 assert.equal(db.tables.historyAccounts.size, sessions.length);
});

test('equal queriedAt resolves overlapping games by stable batchId on devices with opposite save order', async () => {
 const server = syncServer();
 const first = await signed([game(0), game(1)]);
 const second = await signed([{...game(0), ret: -1}, game(2)]);
 const [lower, higher] = [first, second].sort((a, b) => batchId(a) < batchId(b) ? -1 : 1);
 const a = await device(server), b = await device(server);
 await a.history.save(lower);
 await a.history.save(higher);
 await b.history.save(higher);
 await b.history.save(lower);
 for (const client of [a, b]) {
  assert.equal((await client.history.load(tag)).matches.find(row => row.mid === game(0).mid).batchId, batchId(higher));
  assert.deepEqual(plain(await client.history.envelope(tag, game(0).mid)), higher);
 }
 assert.equal((await a.history.sync()).ok, true);
 assert.equal((await b.history.sync()).ok, true);
 const c = await device(server);
 assert.equal((await c.history.sync()).ok, true);
 assert.deepEqual(plain(await c.history.load(tag)), plain(await a.history.load(tag)));
 assert.deepEqual(plain(await b.history.load(tag)), plain(await a.history.load(tag)));
 assert.equal(pushes(server).length, 2);
});

test('concurrent saves to one account retain every record and its signed envelope', async () => {
 const server = syncServer(), a = await device(server);
 const envelopes = await Promise.all(Array.from({length: 20}, (_, i) => signed([game(i)])));
 await Promise.all(envelopes.map(envelope => a.history.save(envelope)));
 const account = await a.history.load(tag);
 assert.equal(account.matches.length, envelopes.length);
 assert.equal(Object.keys(account.batches).length, envelopes.length);
 assert.deepEqual(plain(account.matches.map(row => row.mid)), envelopes.map(envelope => envelope.content.data.matches[0].mid));
 for (const envelope of envelopes) {
  assert.deepEqual(plain(await a.history.envelope(tag, envelope.content.data.matches[0].mid)), envelope);
 }
 assert.equal((await a.history.sync()).ok, true);
 const b = await device(server);
 assert.equal((await b.history.sync()).ok, true);
 assert.deepEqual(plain(await b.history.load(tag)), plain(account));
});
