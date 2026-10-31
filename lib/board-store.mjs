import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Problem } from './errors.mjs';

const DAILY_LIMIT = 20;
const RECORD_LIMIT = 2000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function iso(value) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))
    || !calendarDay(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23) {
    throw new Problem('queue_job', 'Tanggal antrean tidak valid.');
  }
  return new Date(value).toISOString();
}

function text(value, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /\u0000/.test(value)) {
    throw new Problem('queue_job', 'Data lowongan antrean tidak valid.');
  }
  return value;
}

function jobData(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job) || !['jobstreet', 'glints'].includes(job.provider)) {
    throw new Problem('queue_job', 'Sumber lowongan antrean tidak valid.');
  }
  const jobId = text(job.jobId, 200);
  const title = text(job.title, 500);
  const company = text(job.company, 500);
  const location = text(job.location, 500, true);
  const url = text(job.url, 2048);
  const applyUrl = text(job.applyUrl, 2048);
  for (const value of [url, applyUrl]) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Problem('queue_job', 'Alamat lowongan antrean tidak valid.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Problem('queue_job', 'Alamat lowongan antrean tidak valid.');
  }
  const salary = job.salary === null ? null : text(job.salary, 500, true);
  const description = text(job.description, 100_000, true);
  const listedAt = job.listedAt === null ? null : iso(job.listedAt);
  return { provider: job.provider, jobId, title, company, location, url, applyUrl, salary, description, listedAt };
}

function calendarDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function record(row) {
  try {
    const job = jobData({ provider: row.provider, jobId: row.job_id, title: row.title, company: row.company,
      location: row.location, url: row.url, applyUrl: row.apply_url, salary: row.salary,
      description: row.description, listedAt: row.listed_at });
    if (!UUID.test(row.id) || !calendarDay(row.scheduled_day)
      || !['queued', 'applied'].includes(row.status)
      || (row.status === 'queued' ? row.applied_day !== null : !calendarDay(row.applied_day))) throw new Error('Invalid stored queue state.');
    return { ...job, id: row.id, status: row.status, scheduledDay: row.scheduled_day,
      appliedDay: row.applied_day, createdAt: iso(row.created_at) };
  } catch (cause) {
    throw new Problem('queue_corrupt', 'Data antrean tersimpan tidak valid. Berkas dipertahankan.', 503, { cause });
  }
}

function prepareLocation(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new TypeError('An absolute queue database filename is required.');
  const target = path.resolve(filename);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const actual = realpathSync(directory);
  const equal = process.platform === 'win32' ? actual.toLowerCase() === directory.toLowerCase() : actual === directory;
  if (!equal || !lstatSync(directory).isDirectory()) throw new Problem('queue_location', 'Lokasi antrean harus berupa direktori biasa.', 503);
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Problem('queue_location', 'Berkas antrean harus berupa berkas biasa.', 503);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { closeSync(openSync(target, 'wx', 0o600)); }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Problem('queue_location', 'Berkas antrean harus berupa berkas biasa.', 503);
    }
  }
  return target;
}

export class ApplicationQueue {
  #db;
  #clock;

  constructor({ filename, clock = () => new Date().toISOString() }) {
    if (typeof clock !== 'function') throw new TypeError('Queue clock must be a function.');
    this.#clock = clock;
    const target = prepareLocation(filename);
    try {
      this.#db = new DatabaseSync(target);
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
      if (this.#db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Queue database integrity check failed.');
      this.#transaction(() => {
        const version = this.#db.prepare('PRAGMA user_version').get().user_version;
        if (version === 0) {
          if (this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()) {
            throw new Error('Unrecognized queue database schema.');
          }
          this.#db.exec(`CREATE TABLE application_queue (
            id TEXT PRIMARY KEY NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('jobstreet', 'glints')),
            job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
            title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL,
            url TEXT NOT NULL, apply_url TEXT NOT NULL, salary TEXT, description TEXT NOT NULL,
            listed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('queued', 'applied')),
            scheduled_day TEXT NOT NULL, applied_day TEXT, created_at TEXT NOT NULL,
            CHECK ((status = 'queued' AND applied_day IS NULL) OR (status = 'applied' AND applied_day IS NOT NULL)),
            UNIQUE (provider, job_id)
          ) STRICT;
          CREATE INDEX application_queue_days ON application_queue(status, scheduled_day, applied_day);
          PRAGMA user_version = 1;`);
        } else if (version !== 1) throw new Error('Unsupported queue database schema version.');
        this.#statusAt(this.#now().day);
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #now() {
    let now;
    try { now = iso(this.#clock()); }
    catch (cause) { throw new Problem('queue_clock', 'Waktu antrean belum dapat diperiksa.', 503, { cause }); }
    const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
    return { now, day: `${parts.year}-${parts.month}-${parts.day}` };
  }

  #transaction(action) {
    this.#assertOpen();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ }
      throw error;
    }
  }

  #assertOpen() {
    if (!this.#db) throw new Problem('queue_closed', 'Antrean sudah ditutup.', 503);
  }

  #statusAt(day) {
    const rows = this.#db.prepare('SELECT * FROM application_queue ORDER BY created_at DESC, rowid DESC LIMIT 2001').all();
    if (rows.length > RECORD_LIMIT) throw new Problem('queue_corrupt', 'Jumlah antrean tersimpan melampaui batas. Berkas dipertahankan.', 503);
    const queue = rows.map(record);
    const used = queue.filter((row) => row.status === 'queued' ? row.scheduledDay === day : row.appliedDay === day).length;
    if (used > DAILY_LIMIT) throw new Problem('queue_corrupt', 'Kuota antrean tersimpan melampaui batas. Berkas dipertahankan.', 503);
    return { quota: { day, limit: DAILY_LIMIT, used, remaining: DAILY_LIMIT - used }, queue };
  }

  #used(day) {
    return this.#db.prepare(`SELECT count(*) AS used FROM application_queue
      WHERE (status = 'queued' AND scheduled_day = ?) OR (status = 'applied' AND applied_day = ?)`)
      .get(day, day).used;
  }

  status() {
    this.#assertOpen();
    return this.#statusAt(this.#now().day);
  }

  add(value) {
    const job = jobData(value);
    return this.#transaction(() => {
      const { now, day } = this.#now();
      if (this.#db.prepare('SELECT id FROM application_queue WHERE provider = ? AND job_id = ?').get(job.provider, job.jobId)) return this.#statusAt(day);
      if (this.#db.prepare('SELECT count(*) AS count FROM application_queue').get().count >= RECORD_LIMIT) {
        throw new Problem('queue_full', 'Antrean mencapai batas 2000 catatan. Hapus antrean yang belum dilamar untuk menambah lowongan.', 409);
      }
      if (this.#used(day) >= DAILY_LIMIT) throw new Problem('quota', 'Kuota gabungan 20 lowongan untuk hari ini sudah penuh.', 409);
      this.#db.prepare(`INSERT INTO application_queue
        (id, provider, job_id, title, company, location, url, apply_url, salary, description, listed_at, status, scheduled_day, applied_day, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?)`).run(
        randomUUID(), job.provider, job.jobId, job.title, job.company, job.location, job.url, job.applyUrl,
        job.salary, job.description, job.listedAt, day, now,
      );
      return this.#statusAt(day);
    });
  }

  markApplied(id) {
    this.#validateId(id);
    return this.#transaction(() => {
      const { day } = this.#now();
      const row = this.#db.prepare('SELECT status, scheduled_day FROM application_queue WHERE id = ?').get(id);
      if (!row) throw new Problem('queue_not_found', 'Lowongan tidak ditemukan dalam antrean.', 404);
      if (row.status === 'applied') return this.#statusAt(day);
      if (row.scheduled_day !== day && this.#used(day) >= DAILY_LIMIT) {
        throw new Problem('quota', 'Kuota gabungan 20 lowongan untuk hari ini sudah penuh.', 409);
      }
      this.#db.prepare("UPDATE application_queue SET status = 'applied', applied_day = ? WHERE id = ?").run(day, id);
      return this.#statusAt(day);
    });
  }

  remove(id) {
    this.#validateId(id);
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT status FROM application_queue WHERE id = ?').get(id);
      if (!row) throw new Problem('queue_not_found', 'Lowongan tidak ditemukan dalam antrean.', 404);
      if (row.status === 'applied') throw new Problem('queue_applied', 'Riwayat lowongan yang sudah dilamar tidak dapat dihapus.', 409);
      this.#db.prepare('DELETE FROM application_queue WHERE id = ?').run(id);
      return this.#statusAt(this.#now().day);
    });
  }

  #validateId(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Problem('queue_not_found', 'Lowongan tidak ditemukan dalam antrean.', 404);
  }

  close() {
    if (!this.#db) return;
    this.#db.close();
    this.#db = undefined;
  }
}
