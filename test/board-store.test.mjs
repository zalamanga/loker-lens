import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { ApplicationQueue } from '../lib/board-store.mjs';

const parent = path.resolve(process.env.LOKER_TEST_ROOT ?? '.test-cache');
const moduleUrl = new URL('../lib/board-store.mjs', import.meta.url).href;
const initialTime = '2026-11-01T08:00:00.000Z';
function job(jobId = '1', provider = 'jobstreet') {
  return { provider, jobId, title: `Synthetic engineer ${jobId}`, company: 'Synthetic fixture company', location: 'Jakarta',
    url: provider === 'jobstreet' ? `https://id.jobstreet.com/job/${jobId}` : `https://glints.com/id/opportunities/jobs/fixture/${jobId}`,
    applyUrl: provider === 'jobstreet' ? `https://id.jobstreet.com/job/${jobId}/apply` : `https://glints.com/id/opportunities/jobs/fixture/${jobId}`,
    salary: null, description: 'Synthetic job fixture, no real opening.', listedAt: null };
}

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'board-store-'));
  const owners = [];
  let current = initialTime;
  t.after(async () => {
    for (const owner of owners) owner.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('board-store-'));
    assert.equal((await fs.realpath(resolved)).toLowerCase(), resolved.toLowerCase());
    await fs.rm(resolved, { recursive: true });
  });
  const filename = path.join(directory, 'private', 'queue.sqlite');
  return { filename, directory, setTime(value) { current = value; },
    open() { const owner = new ApplicationQueue({ filename, clock: () => current }); owners.push(owner); return owner; } };
}

function hasCode(code, status) {
  return (error) => error.code === code && error.status === status;
}

test('combined provider quota, global dedupe, and applied history survive restart', async (t) => {
  const f = await fixture(t); const queue = f.open();
  assert.deepEqual(queue.status(), { quota: { day: '2026-11-01', limit: 20, used: 0, remaining: 20 }, queue: [] });
  for (const provider of ['jobstreet', 'glints']) for (let i = 0; i < 10; i++) queue.add(job(String(i), provider));
  const full = queue.status();
  assert.equal(full.queue.length, 20);
  assert.equal(full.quota.used, 20);
  const original = full.queue.find((row) => row.provider === 'glints' && row.jobId === '1');
  const duplicate = queue.add({ ...job('1', 'glints'), title: 'Replacement must not alter the saved record' });
  assert.deepEqual(duplicate.queue.find((row) => row.id === original.id), original);
  assert.equal(duplicate.quota.used, 20);
  assert.throws(() => queue.add(job('new')), hasCode('quota', 409));
  assert.equal(queue.markApplied(original.id).quota.used, 20);
  assert.throws(() => queue.remove(original.id), hasCode('queue_applied', 409));
  queue.close();
  const reopened = f.open();
  assert.equal(reopened.status().quota.used, 20);
  assert.equal(reopened.status().queue.length, 20);
  assert.equal(reopened.add(job('1', 'glints')).queue.length, 20);
  assert.equal(reopened.status().queue.find((row) => row.id === original.id).status, 'applied');
});

test('WIB midnight resets only daily usage; an old queued item consumes the day it is marked applied', async (t) => {
  const f = await fixture(t);
  f.setTime('2026-11-01T16:59:59.999Z');
  const queue = f.open();
  queue.add(job('old-1'));
  queue.add(job('old-2', 'glints'));
  const old = queue.status().queue;
  assert.equal(queue.status().quota.day, '2026-11-01');
  f.setTime('2026-11-01T17:00:00.000Z');
  assert.deepEqual(queue.status().quota, { day: '2026-11-02', limit: 20, used: 0, remaining: 20 });
  for (let i = 0; i < 20; i++) queue.add(job(`today-${i}`));
  assert.throws(() => queue.markApplied(old[0].id), hasCode('quota', 409));
  assert.equal(queue.status().queue.find((row) => row.id === old[0].id).status, 'queued');
  const today = queue.status().queue.find((row) => row.jobId === 'today-0');
  assert.equal(queue.markApplied(today.id).quota.used, 20);
  const removable = queue.status().queue.find((row) => row.jobId === 'today-1');
  assert.equal(queue.remove(removable.id).quota.used, 19);
  const marked = queue.markApplied(old[0].id);
  const oldApplied = marked.queue.find((row) => row.id === old[0].id);
  assert.equal(marked.quota.used, 20);
  assert.equal(oldApplied.scheduledDay, '2026-11-01');
  assert.equal(oldApplied.appliedDay, '2026-11-02');
  assert.equal(oldApplied.createdAt, '2026-11-01T16:59:59.999Z');
  assert.equal(queue.markApplied(old[0].id).quota.used, 20);
  f.setTime('2026-11-02T17:00:00.000Z');
  assert.equal(queue.markApplied(old[0].id).quota.used, 0);
  assert.equal(queue.status().queue.find((row) => row.id === old[0].id).appliedDay, '2026-11-02');
  assert.equal(queue.status().queue.find((row) => row.id === old[1].id).scheduledDay, '2026-11-01');
});

test('removing pending records releases only their reservation and allows re-adding; missing records are 404', async (t) => {
  const f = await fixture(t); const queue = f.open();
  const added = queue.add(job()); const id = added.queue[0].id;
  const returned = queue.status(); returned.queue[0].title = 'Outside mutation';
  assert.equal(queue.status().queue[0].title, job().title);
  assert.equal(queue.remove(id).quota.used, 0);
  assert.throws(() => queue.remove(id), hasCode('queue_not_found', 404));
  assert.throws(() => queue.markApplied(randomUUID()), hasCode('queue_not_found', 404));
  assert.throws(() => queue.remove('not-an-id'), hasCode('queue_not_found', 404));
  assert.notEqual(queue.add(job()).queue[0].id, id);
});

test('invalid inputs and a clock failure leave committed records intact', async (t) => {
  const f = await fixture(t); const queue = f.open();
  const id = queue.add(job()).queue[0].id;
  for (const invalid of [null, { ...job(), provider: 'other' }, { ...job(), jobId: '' },
    { ...job(), title: 'x'.repeat(501) }, { ...job(), salary: 123 }, { ...job(), url: 'javascript:alert(1)' },
    { ...job(), applyUrl: 'https://user:password@id.jobstreet.com/job/1' }, { ...job(), listedAt: 'yesterday' },
    { ...job(), listedAt: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => queue.add(invalid), hasCode('queue_job', 422));
  }
  f.setTime('invalid');
  assert.throws(() => queue.add(job('2')), hasCode('queue_clock', 503));
  assert.throws(() => queue.remove(id), hasCode('queue_clock', 503));
  f.setTime(initialTime);
  assert.equal(queue.status().quota.used, 1);
  assert.equal(queue.status().queue.length, 1);
  assert.equal(queue.add(job('2')).quota.used, 2);
  queue.close(); queue.close();
  assert.throws(() => queue.status(), hasCode('queue_closed', 503));
});

test('dates use Asia/Jakarta even when the clock supplies a different ISO offset or moves backward', async (t) => {
  const f = await fixture(t);
  f.setTime('2026-11-02T01:00:00+08:00');
  const queue = f.open();
  const saved = queue.add({ ...job(), listedAt: '2026-10-31T20:00:00+08:00' });
  assert.equal(saved.quota.day, '2026-11-02');
  assert.equal(saved.queue[0].createdAt, '2026-11-01T17:00:00.000Z');
  assert.equal(saved.queue[0].listedAt, '2026-10-31T12:00:00.000Z');
  f.setTime('2026-11-01T16:59:59Z');
  assert.equal(queue.status().quota.day, '2026-11-01');
  assert.equal(queue.status().quota.used, 0);
  assert.equal(queue.status().queue[0].scheduledDay, '2026-11-02');
});

test('a full ledger rejects additions without purging applied history and still deduplicates', async (t) => {
  const f = await fixture(t); const queue = f.open(); queue.close();
  const db = new DatabaseSync(f.filename);
  try {
    db.exec('BEGIN');
    const insert = db.prepare(`INSERT INTO application_queue
      (id, provider, job_id, title, company, location, url, apply_url, salary, description, listed_at, status, scheduled_day, applied_day, created_at)
      VALUES (?, 'jobstreet', ?, 'Synthetic history', 'Fixture', '', 'https://id.jobstreet.com/job/1', 'https://id.jobstreet.com/job/1', NULL, '', NULL, 'applied', ?, ?, ?)`);
    for (let i = 0; i < 2000; i++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 20))).toISOString();
      const day = timestamp.slice(0, 10);
      insert.run(randomUUID(), `history-${i}`, day, day, timestamp);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const reopened = f.open();
  assert.equal(reopened.status().queue.length, 2000);
  assert.equal(reopened.status().quota.used, 0);
  assert.throws(() => reopened.add(job('fresh')), hasCode('queue_full', 409));
  assert.equal(reopened.add(job('history-0')).queue.length, 2000);
  assert.equal(reopened.status().queue.every((row) => row.status === 'applied'), true);
});

test('corrupt bytes and unknown database schemas throw without being reset', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.filename));
  const bytes = Buffer.from('controlled corrupt queue bytes');
  await fs.writeFile(f.filename, bytes);
  assert.throws(() => f.open());
  assert.deepEqual(await fs.readFile(f.filename), bytes);
  const other = path.join(f.directory, 'other.sqlite');
  const db = new DatabaseSync(other);
  db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserve');"); db.close();
  assert.throws(() => new ApplicationQueue({ filename: other }));
  const inspect = new DatabaseSync(other);
  assert.equal(inspect.prepare('SELECT value FROM unrelated').get().value, 'preserve'); inspect.close();
});

test('queue files stay in the explicit private directory and reject non-file paths', async (t) => {
  const f = await fixture(t); const queue = f.open(); queue.add(job()); queue.close();
  assert.deepEqual(await fs.readdir(f.directory), ['private']);
  assert.deepEqual(await fs.readdir(path.dirname(f.filename)), ['queue.sqlite']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.filename)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(f.filename))).mode & 0o077, 0);
  }
  assert.throws(() => new ApplicationQueue({ filename: 'relative.sqlite' }), TypeError);
  assert.throws(() => new ApplicationQueue({ filename: path.dirname(f.filename) }), hasCode('queue_location', 503));
});

test('simultaneous SQLite connections cannot reserve beyond the combined daily limit', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); f.open().close();
  const barrier = new SharedArrayBuffer(4);
  const workers = [];
  const outcomes = [];
  const ready = [];
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  for (let n = 0; n < 4; n++) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { ApplicationQueue } = await import(workerData.moduleUrl);
        const queue = new ApplicationQueue({ filename: workerData.filename, clock: () => workerData.time });
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        let accepted = 0; let denied = 0;
        for (let i = 0; i < 20; i++) {
          try { queue.add({ ...workerData.job, jobId: workerData.n + '-' + i }); accepted++; }
          catch (error) { if (error.code !== 'quota') throw error; denied++; }
        }
        queue.close(); parentPort.postMessage({ accepted, denied });
      })().catch((error) => { throw error; });
    `, { eval: true, workerData: { moduleUrl, filename: f.filename, time: initialTime, barrier,
      n, job: job('fixture', n % 2 ? 'glints' : 'jobstreet') } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.on('message', (message) => { if (message.ready) resolve(); }); worker.on('error', reject); }));
    outcomes.push(new Promise((resolve, reject) => { worker.on('message', (message) => { if (!message.ready) resolve(message); }); worker.on('error', reject); }));
  }
  await Promise.all(ready);
  Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
  const results = await Promise.all(outcomes);
  assert.equal(results.reduce((sum, row) => sum + row.accepted, 0), 20);
  assert.equal(results.reduce((sum, row) => sum + row.denied, 0), 60);
  const reopened = f.open();
  assert.equal(reopened.status().quota.used, 20);
  assert.equal(reopened.status().queue.length, 20);
});
