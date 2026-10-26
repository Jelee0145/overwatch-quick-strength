export async function putBlob(storage, key, value) {
  if (storage.putBlob) return storage.putBlob(key, value);
  await deleteBlob(storage, key);
  const s = JSON.stringify(value),
    chunks = [];
  for (let i = 0; i < s.length; i += 12000) {
    chunks.push(s.slice(i, i + 12000));
  }
  await storage.put(key + ':count', chunks.length);
  for (let i = 0; i < chunks.length; i++) await storage.put(key + ':' + i, chunks[i]);
}
export async function getBlob(storage, key) {
  if (storage.getBlob) return storage.getBlob(key);
  const n = await storage.get(key + ':count');
  if (n === undefined) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += await storage.get(key + ':' + i);
  return JSON.parse(s);
}
export async function deleteBlob(storage, key) {
  if (storage.deleteBlob) return storage.deleteBlob(key);
  const n = (await storage.get(key + ':count')) || 0;
  await storage.delete([key + ':count', ...Array.from({ length: n }, (_, i) => key + ':' + i)]);
}
