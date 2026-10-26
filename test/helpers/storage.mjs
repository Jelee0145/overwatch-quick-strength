export class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.alarmTime = null;
  }
  async get(k) {
    return structuredClone(this.map.get(k));
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
  }
  async list({ prefix = '' } = {}) {
    return new Map(
      [...this.map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])
    );
  }
  async setAlarm(t) {
    this.alarmTime = t;
  }
  async getAlarm() {
    return this.alarmTime;
  }
  async transaction(fn) {
    const before = this.map;
    this.map = structuredClone(before);
    try {
      return await fn(this);
    } catch (error) {
      this.map = before;
      throw error;
    }
  }
}
