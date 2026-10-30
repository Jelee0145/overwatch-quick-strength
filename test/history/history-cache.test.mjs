import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCache } from '../../backend/src/history/cache.mjs';

test('response cache keeps the newest bodies within its byte budget', () => {
  const cache = createResponseCache({ bytes: 10, entries: 4 });
  assert.equal(cache.get('a'), null);
  cache.set('a', '12345');
  cache.set('b', '12345');
  cache.get('a');
  cache.set('c', '12345');
  assert.equal(cache.get('b'), null, 'the least recently used body is released first');
  assert.equal(cache.get('a'), '12345', 'the recently read body survives');
  cache.set('d', '12345');
  assert.equal(cache.get('c'), null);
  assert.equal(cache.get('a'), '12345');
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 10 });
});

test('oversized bodies are returned but never retained, and clear resets the budget', () => {
  const cache = createResponseCache({ bytes: 8, entries: 4 });
  assert.equal(cache.set('big', '123456789'), '123456789');
  assert.equal(cache.get('big'), null);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  cache.set('a', '1234');
  cache.clear();
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test('entry count is bounded as well as bytes', () => {
  const cache = createResponseCache({ bytes: 1000, entries: 2 });
  for (const key of ['a', 'b', 'c']) cache.set(key, 'x');
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), 'x');
});
