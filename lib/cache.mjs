import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from './config.mjs';
import { Problem } from './errors.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => value === null ? null : structuredClone(value);

export class SafeCache {
  #fs; #directory; #decode; #lock; #lockBytes; #lockIdentity;
  #state = { phase: 'missing', data: null, hash: null };
  #pending = null;
  #busy = false;
  #closed = false;

  static async open(directory, decode, fs = nativeFs) {
    if (!path.isAbsolute(directory) || typeof decode !== 'function') throw new TypeError('Absolute cache directory and decoder required.');
    const cache = new SafeCache();
    cache.#fs = fs;
    cache.#directory = path.resolve(directory);
    cache.#decode = decode;
    await fs.mkdir(cache.#directory, { recursive: true });
    const stat = await fs.lstat(cache.#directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Problem('cache_location', 'Lokasi cache harus berupa direktori biasa.', 503);
    cache.#lock = cache.#child('.loker-lens.lock');
    cache.#lockBytes = Buffer.from(JSON.stringify({ application: 'loker-lens-cache', version: 1, token: randomUUID(), pid: process.pid }));
    let handle;
    let failure;
    try {
      handle = await fs.open(cache.#lock, 'wx', 0o600);
      cache.#lockIdentity = await handle.stat({ bigint: true });
      await handle.writeFile(cache.#lockBytes);
      await handle.sync();
      if (!(await fs.readFile(cache.#lock)).equals(cache.#lockBytes)) throw new Error('Owner marker readback differs.');
    } catch (error) {
      failure = error;
    } finally {
      try { await handle?.close(); } catch (error) { failure ??= error; }
    }
    if (failure) {
      if (cache.#lockIdentity) {
        try { await cache.#unlinkOwned(cache.#lock, cache.#lockIdentity); } catch { /* Keep an uncertain marker instead of deleting a different owner. */ }
      }
      if (failure?.code === 'EEXIST') throw new Problem('cache_in_use', 'Direktori cache memiliki penanda pemilik. Gunakan satu proses atau direktori cache lain.', 409);
      throw new Problem('cache_lock', 'Penanda pemilik cache belum dapat disiapkan. Cache tidak dibaca atau diganti.', 503, { cause: failure });
    }
    await cache.#inspect();
    return cache;
  }

  get status() { return { phase: this.#pending ? 'unknown' : this.#state.phase, hash: this.#state.hash, pending: this.#pending !== null }; }
  get data() { return clone(this.#state.data); }
  #child(name) {
    const target = path.resolve(this.#directory, name);
    if (path.dirname(target) !== this.#directory) throw new TypeError('Cache path escaped its directory.');
    return target;
  }
  async #read() {
    const file = this.#child('jobs.json');
    const stat = await this.#fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.cacheBytes) throw new Problem('cache_invalid', 'Cache tersimpan tidak dapat diperiksa dalam batas aplikasi.', 503);
    const raw = await this.#fs.readFile(file);
    if (raw.length > LIMITS.cacheBytes) throw new Problem('cache_invalid', 'Cache tersimpan melampaui batas aplikasi.', 503);
    return { raw, hash: digest(raw) };
  }
  async #inspect() {
    let bytes;
    try {
      bytes = await this.#read();
      this.#state = { phase: 'ready', data: this.#decode(bytes.raw), hash: bytes.hash };
    } catch (error) {
      this.#state = error?.code === 'ENOENT'
        ? { phase: 'missing', data: null, hash: null }
        : { phase: 'damaged', data: null, hash: bytes?.hash ?? null };
    }
  }
  async #unlinkOwned(file, identity) {
    let before;
    try { before = await this.#fs.lstat(file, { bigint: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (!identity || !before.isFile() || before.isSymbolicLink()) throw new Error('Owned temporary identity changed.');
    // Windows path-stat and descriptor-stat may use different volume identifiers.
    const handle = await this.#fs.open(file, 'r');
    try {
      const actual = await handle.stat({ bigint: true });
      if (actual.dev !== identity.dev || actual.ino !== identity.ino || !actual.isFile()) throw new Error('Owned temporary identity changed.');
    } finally { await handle.close(); }
    const after = await this.#fs.lstat(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Owned temporary path changed.');
    await this.#fs.unlink(file);
  }
  async #writeNew(file, raw) {
    const handle = await this.#fs.open(file, 'wx', 0o600);
    let identity;
    let failure;
    try {
      identity = await handle.stat({ bigint: true });
      await handle.writeFile(raw);
      await handle.sync();
    } catch (error) { failure = error; }
    finally { try { await handle.close(); } catch (error) { failure ??= error; } }
    if (!failure) {
      try { if (digest(await this.#fs.readFile(file)) !== digest(raw)) throw new Error('Temporary readback differs.'); }
      catch (error) { failure = error; }
    }
    if (failure) {
      try { await this.#unlinkOwned(file, identity); } catch { /* The cache is unchanged; retain an unconfirmed temporary file. */ }
      throw failure;
    }
    return identity;
  }

  async replace(candidate, { replaceDamagedDigest = null } = {}) {
    if (this.#closed || this.#busy || this.#pending) throw new Problem('cache_blocked', 'Selesaikan pemeriksaan cache sebelumnya sebelum mengganti data.', 409);
    const raw = Buffer.from(JSON.stringify(candidate));
    if (!raw.length || raw.length > LIMITS.cacheBytes) throw new Problem('cache_capacity', 'Hasil melebihi batas cache 16 MiB. Cache sebelumnya dipertahankan.', 507);
    const data = this.#decode(raw);
    this.#busy = true;
    const temporary = this.#child(`jobs.${randomUUID()}.tmp`);
    const candidateHash = digest(raw);
    let identity;
    let attemptedRename = false;
    const warnings = [];
    try {
      if (this.#state.phase === 'damaged') {
        if (!this.#state.hash || replaceDamagedDigest !== this.#state.hash) throw new Problem('cache_review', 'Penggantian cache rusak memerlukan konfirmasi atas data yang sudah ditinjau.', 409);
        const previous = await this.#read();
        if (previous.hash !== this.#state.hash) throw new Problem('cache_changed', 'Cache berubah sesudah ditinjau. Tidak ada penggantian.', 409);
        await this.#writeNew(this.#child(`recovery.${randomUUID()}.json`), previous.raw);
      } else {
        let current;
        try { current = await this.#read(); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if ((current?.hash ?? null) !== this.#state.hash) throw new Problem('cache_changed', 'Cache berubah di luar proses ini. Periksa data sebelum menggantinya.', 409);
      }
      identity = await this.#writeNew(temporary, raw);
      this.#pending = { data, hash: candidateHash, previous: this.#state };
      attemptedRename = true;
      await this.#fs.rename(temporary, this.#child('jobs.json'));
      const observed = await this.#read();
      if (observed.hash !== candidateHash) throw new Error('Published cache readback differs.');
      this.#state = { phase: 'ready', data, hash: candidateHash };
      this.#pending = null;
      return { saved: true, warnings };
    } catch (error) {
      if (attemptedRename) {
        throw new Problem('cache_unknown', 'Hasil penggantian cache belum dapat dipastikan. Periksa cache; jangan mulai penggantian baru.', 503, { cause: error });
      }
      if (error instanceof Problem) throw error;
      throw new Problem('cache_write', 'Cache belum diganti. Hasil terakhir tetap dipertahankan.', 507, { cause: error });
    } finally {
      if (identity) {
        try { await this.#unlinkOwned(temporary, identity); }
        catch { warnings.push('Berkas sementara milik proses belum dapat dibersihkan.'); }
      }
      this.#busy = false;
    }
  }

  async reconcile() {
    if (this.#busy || this.#closed || !this.#pending) throw new Problem('cache_blocked', 'Tidak ada hasil cache tertunda yang dapat diperiksa.', 409);
    this.#busy = true;
    const pending = this.#pending;
    try {
      let observed;
      try { observed = await this.#read(); }
      catch (error) { if (error?.code !== 'ENOENT') throw new Problem('cache_unreadable', 'Cache belum dapat dibaca. Status penggantian tetap belum pasti.', 503); }
      if (observed?.hash === pending.hash) {
        this.#state = { phase: 'ready', data: pending.data, hash: pending.hash };
        this.#pending = null;
        return { saved: true };
      }
      if ((observed?.hash ?? null) === pending.previous.hash) {
        this.#state = pending.previous;
        this.#pending = null;
        return { saved: false };
      }
      throw new Problem('cache_changed', 'Isi cache berbeda dari kedua hasil yang diketahui. Tidak ada data yang diganti.', 409);
    } finally {
      this.#busy = false;
    }
  }

  async close() {
    if (this.#closed) return { closed: true, warnings: [] };
    if (this.#busy) throw new Problem('cache_busy', 'Pemeriksaan atau penulisan cache masih berjalan.', 409);
    this.#busy = true;
    const warnings = [];
    try {
      const raw = await this.#fs.readFile(this.#lock);
      if (!raw.equals(this.#lockBytes)) throw new Error('Cache owner changed.');
      await this.#unlinkOwned(this.#lock, this.#lockIdentity);
    } catch { warnings.push('Penanda pemilik cache belum dilepas. Cache tetap dipertahankan.'); }
    this.#closed = true;
    this.#busy = false;
    return { closed: true, warnings };
  }
}
