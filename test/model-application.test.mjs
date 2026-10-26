import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readConfiguration } from '../lib/config.mjs';
import { createApplication } from '../lib/application.mjs';
import { demoSource } from '../lib/demo.mjs';
import { snapshotDecoder } from '../lib/snapshot.mjs';
import { validateSnapshot, validateStatus, filterJobs, relevantExcerpt, facets } from '../public/model.mjs';
import { Problem } from '../lib/errors.mjs';

const now = Date.parse('2026-10-26T04:00:00.000Z'); const clock = () => now;
const config = readConfiguration(process.cwd(), {});
async function example() {
  const result = await demoSource({ config, clock, signal: new AbortController().signal, onProgress() {} });
  return { application: 'loker-lens', version: 1, mode: 'demo', generation: randomUUID(), savedAt: new Date(now).toISOString(), lookbackMonths: config.lookbackMonths, ...result };
}
function memoryStore(initial = null, hook = null) {
  let data = structuredClone(initial); let pending = false; let candidate; let phase = initial ? 'ready' : 'missing';
  return {
    writes: 0, closed: false,
    get data() { return structuredClone(data); },
    get status() { return { phase: pending ? 'unknown' : phase, hash: data ? createHash('sha256').update(JSON.stringify(data)).digest('hex') : null, pending }; },
    async replace(value) { this.writes++; candidate = structuredClone(value); if (hook) { pending = true; await hook(); } data = candidate; phase = 'ready'; pending = false; return { saved: true, warnings: [] }; },
    async reconcile() { data = candidate; phase = 'ready'; pending = false; return { saved: true }; },
    async close() { this.closed = true; return { closed: true, warnings: [] }; },
  };
}
const request = (generation = null) => ({ operationId: randomUUID(), expectedGeneration: generation, replaceDamagedDigest: null });
const filters = { query: '', keywords: '', category: '', location: '', interest: '', dateFrom: '', dateTo: '', sort: 'latest' };

test('the full synthetic dataset passes strict browser and cache contracts with all thirteen categories', async () => {
  const value = await example(); assert.equal(validateSnapshot(value), value);
  assert.deepEqual(snapshotDecoder('demo')(Buffer.from(JSON.stringify(value))), value);
  assert.equal(value.jobs.length, 24); assert.equal(facets(value.jobs, 'categories').length, 13);
  assert.ok(value.jobs.every((job) => job.url === `/demo/source/${job.id}`));
});
test('unknown fields, corrupt Unicode, duplicate identities, mismatched provenance and derived matches fail whole snapshots', async () => {
  const value = await example();
  for (const mutate of [
    (x) => { x.extra = true; }, (x) => { x.jobs[0].title = '\ud800'; },
    (x) => { x.jobs.push(x.jobs[0]); }, (x) => { x.jobs[0].url = 'https://www.disnakerja.com/'; },
    (x) => { x.generation = [x.generation]; }, (x) => { x.coverage.truncated = true; },
    (x) => { x.jobs[0].modifiedAt = '2026-02-31T00:00:00.000Z'; },
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => validateSnapshot(changed)); }
  const changed = structuredClone(value); changed.jobs[0].matches = [];
  assert.throws(() => snapshotDecoder('demo')(Buffer.from(JSON.stringify(changed))), (error) => error.code === 'cache_schema');
  assert.throws(() => snapshotDecoder('live')(Buffer.from(JSON.stringify(value))));
});
test('filters keep zero as a real result, reach category thirteen, and reject reversed calendar dates', async () => {
  const value = await example();
  assert.equal(filterJobs(value.jobs, { ...filters, query: 'not-a-real-example' }).length, 0);
  assert.equal(filterJobs(value.jobs, { ...filters, category: '13' }).length, 1);
  assert.ok(filterJobs(value.jobs, { ...filters, keywords: 'React,HRD' }).length > 0);
  assert.throws(() => filterJobs(value.jobs, { ...filters, dateFrom: '2026-10-25', dateTo: '2026-10-01' }));
  assert.throws(() => filterJobs(value.jobs, { ...filters, dateFrom: '2026-02-30' }));
  assert.throws(() => filterJobs(value.jobs, { ...filters, keywords: 'a,b' }));
});
test('accent-folded matching extracts from original grapheme offsets without breaking emoji', () => {
  const prefix = 'é👩🏽‍💻 '.repeat(90); const value = `${prefix}Peluang CAFÉ React untuk pengembang. ${'Lanjutan '.repeat(80)}`;
  const excerpt = relevantExcerpt(value, ['cafe react']);
  assert.ok(excerpt.includes('CAFÉ React')); assert.ok(excerpt.startsWith('…'));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(excerpt), false);
  assert.ok(relevantExcerpt(`${prefix}CAFÉ \t \n React tersedia`, ['cafe react']).includes('CAFÉ \t \n React'));
});
test('start replay preserves one operation, rejects changed intent and checks generation only for fresh operations', async () => {
  const store = memoryStore(); const app = createApplication({ config, store, clock }); const input = request();
  const started = app.start(input); assert.equal(started.operation.id, input.operationId);
  assert.equal(app.start(input).replay, true);
  assert.throws(() => app.start({ ...input, expectedGeneration: randomUUID() }), (error) => error.code === 'operation_conflict');
  await app.waitForIdle(); assert.equal(store.writes, 1); assert.equal(app.status().operation.phase, 'saved');
  assert.equal(app.start(input).replay, true);
  assert.throws(() => app.start(request()), (error) => error.code === 'generation_conflict');
  assert.throws(() => app.start({ ...request(), operationId: [randomUUID()] }), (error) => error.code === 'request_schema');
  validateStatus(app.snapshot(), true); await app.close();
});
test('instances remain independent and a failed new source leaves the previously confirmed rows', async () => {
  const original = await example(); const store = memoryStore(original);
  const app = createApplication({ config, store, clock, source: async () => { throw new Error('private raw filesystem or provider error'); } });
  const other = createApplication({ config, store: memoryStore(), clock });
  app.start(request(original.generation)); await app.waitForIdle();
  assert.equal(app.status().operation.phase, 'failed'); assert.deepEqual(app.snapshot().snapshot, original);
  assert.equal(app.status().operation.error.message.includes('private raw'), false);
  assert.equal(other.snapshot().snapshot, null); assert.equal(other.status().operation, null);
  await app.close(); await other.close();
});
test('cancellation invalidates even a late source that ignored its abort signal', async () => {
  const original = await example(); let release; const held = new Promise((resolve) => { release = resolve; });
  const store = memoryStore(original); const app = createApplication({ config, store, clock, source: async (arguments_) => { await held; return demoSource({ ...arguments_, signal: new AbortController().signal }); } });
  const input = request(original.generation); app.start(input); app.cancel(input.operationId); release(); await app.waitForIdle();
  assert.equal(app.status().operation.phase, 'cancelled'); assert.equal(store.writes, 0); assert.deepEqual(store.data, original);
  await app.close();
});
test('possible persistence is unknown, blocks another sync, then read-only reconciliation confirms it', async () => {
  const store = memoryStore(null, async () => { throw new Problem('cache_unknown', 'Controlled uncertain write.', 503); });
  const app = createApplication({ config, store, clock }); const input = request(); app.start(input); await app.waitForIdle();
  assert.equal(app.status().operation.phase, 'unknown'); assert.equal(app.snapshot().snapshot, null);
  assert.throws(() => app.start(request()), (error) => error.code === 'cache_unknown');
  await app.reconcile(input.operationId); assert.equal(app.status().operation.phase, 'saved'); assert.equal(store.writes, 1);
  validateStatus(app.snapshot(), true); await app.close();
});
