import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Development only: one process, atomic file replacement, never Cloud Run disk.
export class FileStore {
  constructor(directory) { this.directory = directory; this.events = new EventEmitter(); this.queue = Promise.resolve(); }
  async read(id) { try { return JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  update(id, change) {
    const result = this.queue.then(async () => {
      const next = await change(await this.read(id));
      await mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, `${id}.json`);
      await writeFile(`${target}.tmp`, JSON.stringify(next));
      await rename(`${target}.tmp`, target);
      this.events.emit(id, structuredClone(next));
      return next;
    });
    this.queue = result.catch(() => {}); return result;
  }
  watch(id, callback) { this.events.on(id, callback); return () => this.events.off(id, callback); }
  async preview(id, role, value) { this.events.emit(`preview:${id}`, { role, ...value }); }
  watchPreview(id, callback) { this.events.on(`preview:${id}`, callback); return () => this.events.off(`preview:${id}`, callback); }
  async close() { await this.queue; }
}
export class FirestoreStore {
  constructor(db) { this.db = db; }
  ref(id) { return this.db.collection('wozSessions').doc(id); }
  async read(id) { const snap = await this.ref(id).get(); return snap.exists ? JSON.parse(snap.data().json) : null; }
  async update(id, change) {
    return this.db.runTransaction(async tx => {
      const ref = this.ref(id), snap = await tx.get(ref);
      const record = await change(snap.exists ? JSON.parse(snap.data().json) : null);
      tx.set(ref, { json: JSON.stringify(record) }); return record;
    });
  }
  watch(id, callback, onError) { return this.ref(id).onSnapshot(s => { if (s.exists) callback(JSON.parse(s.data().json)); }, onError); }
  async preview(id, role, value) { await this.ref(id).collection('previews').doc(role).set({ json: JSON.stringify({ role, ...value }) }); }
  watchPreview(id, callback, onError) {
    return this.ref(id).collection('previews').onSnapshot(s => s.docChanges().forEach(c => { if (c.type !== 'removed') callback(JSON.parse(c.doc.data().json)); }), onError);
  }
  async close() { await this.db.terminate(); }
}
