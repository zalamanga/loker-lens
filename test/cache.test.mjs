import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SafeCache } from '../lib/cache.mjs';

const parent = path.resolve(process.env.LOKER_TEST_ROOT ?? '.test-cache');
const first = { format: 'synthetic-cache-contract', value: 'old' };
const second = { format: 'synthetic-cache-contract', value: 'new' };
function decode(raw) {
  const value = JSON.parse(raw.toString('utf8'));
  if (value?.format !== first.format || typeof value.value !== 'string') throw new Error('Controlled invalid schema.');
  return value;
}
async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'cache-contract-'));
  const resolved = path.resolve(directory);
  const cacheOwners = [];
  t.after(async () => {
    for (const cache of cacheOwners) await cache.close();
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('cache-contract-'));
    assert.equal((await fs.realpath(resolved)).toLowerCase(), resolved.toLowerCase());
    await fs.rm(resolved, { recursive: true });
  });
  return { directory, file: path.join(directory, 'jobs.json'), owners: cacheOwners,
    async open(adapter = fs) { const cache = await SafeCache.open(directory, decode, adapter); cacheOwners.push(cache); return cache; } };
}

test('a cache is missing until explicit save, then survives close and a fresh owner', async (t) => {
  const f = await fixture(t); const cache = await f.open();
  assert.equal(cache.status.phase, 'missing');
  assert.equal(cache.data, null);
  assert.equal((await cache.replace(first)).saved, true);
  assert.equal(cache.status.phase, 'ready');
  const copy = cache.data; copy.value = 'edited outside cache';
  assert.deepEqual(cache.data, first);
  await cache.close();
  assert.deepEqual((await f.open()).data, first);
});

test('a second owner cannot read or replace another active owner marker', async (t) => {
  const f = await fixture(t); const cache = await f.open();
  const marker = await fs.readFile(path.join(f.directory, '.loker-lens.lock'));
  await assert.rejects(f.open(), (error) => error.code === 'cache_in_use');
  assert.deepEqual(await fs.readFile(path.join(f.directory, '.loker-lens.lock')), marker);
  await cache.replace(first);
  await cache.close();
  assert.deepEqual((await f.open()).data, first);
});

test('corrupt bytes are preserved and require exact reviewed digest plus a verified recovery copy', async (t) => {
  const f = await fixture(t); const raw = Buffer.from('{broken synthetic');
  await fs.writeFile(f.file, raw);
  const cache = await f.open();
  assert.equal(cache.status.phase, 'damaged');
  assert.deepEqual(await fs.readFile(f.file), raw);
  await assert.rejects(cache.replace(first), (error) => error.code === 'cache_review');
  const hash = createHash('sha256').update(raw).digest('hex');
  assert.equal(cache.status.hash, hash);
  assert.equal((await cache.replace(first, { replaceDamagedDigest: hash })).saved, true);
  const copies = (await fs.readdir(f.directory)).filter((name) => /^recovery\..+\.json$/.test(name));
  assert.equal(copies.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, copies[0])), raw);
});

test('a write failure before rename keeps prior cache and removes only the created temporary file', async (t) => {
  const f = await fixture(t); let fail = false;
  const adapter = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (!fail || !String(file).endsWith('.tmp')) return handle;
    return { stat: handle.stat.bind(handle), async writeFile() { throw new Error('Controlled write denied.'); }, sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
  } };
  const cache = await f.open(adapter); await cache.replace(first); fail = true;
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_write');
  assert.deepEqual(cache.data, first);
  assert.deepEqual(decode(await fs.readFile(f.file)), first);
  assert.equal((await fs.readdir(f.directory)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('rename landed with lost acknowledgement stays unknown until a read-only check confirms it', async (t) => {
  const f = await fixture(t); let fail = false; let renames = 0;
  const cache = await f.open({ ...fs, async rename(...args) { renames++; await fs.rename(...args); if (fail) throw new Error('Controlled ACK loss.'); } });
  await cache.replace(first); fail = true;
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_unknown');
  assert.equal(cache.status.phase, 'unknown');
  assert.deepEqual(cache.data, first);
  assert.deepEqual(decode(await fs.readFile(f.file)), second);
  await assert.rejects(cache.replace(first), (error) => error.code === 'cache_blocked');
  assert.deepEqual(await cache.reconcile(), { saved: true });
  assert.deepEqual(cache.data, second);
  assert.equal(renames, 2);
});

test('rename rejection before landing is resolved from actual old bytes, without another write', async (t) => {
  const f = await fixture(t); let fail = false;
  const cache = await f.open({ ...fs, async rename(...args) { if (fail) throw new Error('Controlled rename denial.'); await fs.rename(...args); } });
  await cache.replace(first); fail = true;
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_unknown');
  assert.deepEqual(await cache.reconcile(), { saved: false });
  assert.deepEqual(cache.data, first);
  assert.deepEqual(decode(await fs.readFile(f.file)), first);
});

test('post-rename read denial preserves uncertainty and rejects a third unrecognized value', async (t) => {
  const f = await fixture(t); let fail = false; let renamed = false;
  const cache = await f.open({ ...fs,
    async rename(...args) { await fs.rename(...args); renamed = true; },
    async readFile(file, ...args) { if (fail && renamed && file === f.file) throw new Error('Controlled read denial.'); return fs.readFile(file, ...args); },
  });
  await cache.replace(first); fail = true; renamed = false;
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_unknown');
  await assert.rejects(cache.reconcile(), (error) => error.code === 'cache_unreadable');
  assert.deepEqual(cache.data, first);
  fail = false;
  await fs.writeFile(f.file, JSON.stringify({ ...first, value: 'third external value' }));
  await assert.rejects(cache.reconcile(), (error) => error.code === 'cache_changed');
  assert.equal(cache.status.phase, 'unknown');
});

test('cleanup failure after verified rename keeps saved outcome and a visible cleanup warning', async (t) => {
  const f = await fixture(t); let renamed = false;
  const cache = await f.open({ ...fs,
    async rename(...args) { await fs.rename(...args); renamed = true; },
    async lstat(file, ...args) { if (renamed && String(file).endsWith('.tmp')) throw new Error('Controlled cleanup denial.'); return fs.lstat(file, ...args); },
  });
  const result = await cache.replace(first);
  assert.equal(result.saved, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(cache.data, first);
});

test('closing never removes a marker that no longer has the exact owned bytes', async (t) => {
  const f = await fixture(t); const cache = await f.open();
  const marker = path.join(f.directory, '.loker-lens.lock');
  await fs.writeFile(marker, 'different synthetic owner');
  assert.equal((await cache.close()).warnings.length, 1);
  assert.equal(await fs.readFile(marker, 'utf8'), 'different synthetic owner');
});

test('an awaiting reconciliation excludes another check, replacement, and owner release', async (t) => {
  const f = await fixture(t); let loseAck = false; let holdRead = false;
  let releaseRead; let enteredRead;
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const held = new Promise((resolve) => { releaseRead = resolve; });
  const cache = await f.open({ ...fs,
    async rename(...args) { await fs.rename(...args); if (loseAck) throw new Error('Controlled ACK loss.'); },
    async readFile(file, ...args) {
      if (holdRead && file === f.file) { enteredRead(); await held; }
      return fs.readFile(file, ...args);
    },
  });
  await cache.replace(first); loseAck = true;
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_unknown');
  holdRead = true;
  const reconciliation = cache.reconcile();
  try {
    await entered;
    await assert.rejects(cache.reconcile(), (error) => error.code === 'cache_blocked');
    await assert.rejects(cache.replace(first), (error) => error.code === 'cache_blocked');
    await assert.rejects(cache.close(), (error) => error.code === 'cache_busy');
    assert.equal(cache.status.phase, 'unknown');
  } finally { holdRead = false; releaseRead(); }
  assert.deepEqual(await reconciliation, { saved: true });
  assert.deepEqual(cache.data, second);
  await assert.rejects(cache.replace(first), (error) => error.code === 'cache_unknown');
  assert.equal(cache.status.phase, 'unknown');
  assert.deepEqual(await cache.reconcile(), { saved: true });
  assert.deepEqual(cache.data, first);
});

test('owner release excludes replacement while the marker read awaits', async (t) => {
  const f = await fixture(t); let holdRead = false; let releaseRead; let enteredRead;
  const marker = path.join(f.directory, '.loker-lens.lock');
  const entered = new Promise((resolve) => { enteredRead = resolve; });
  const held = new Promise((resolve) => { releaseRead = resolve; });
  const cache = await f.open({ ...fs, async readFile(file, ...args) {
    if (holdRead && file === marker) { enteredRead(); await held; }
    return fs.readFile(file, ...args);
  } });
  await cache.replace(first); holdRead = true;
  const closing = cache.close();
  try {
    await entered;
    await assert.rejects(cache.replace(second), (error) => error.code === 'cache_blocked');
    await assert.rejects(cache.close(), (error) => error.code === 'cache_busy');
  } finally { holdRead = false; releaseRead(); }
  assert.deepEqual(await closing, { closed: true, warnings: [] });
  await assert.rejects(cache.replace(second), (error) => error.code === 'cache_blocked');
  assert.deepEqual((await f.open()).data, first);
});

test('cleanup compares descriptor identities when Windows path stat reports a different volume id', async (t) => {
  const f = await fixture(t);
  const adapter = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    return {
      async stat(options) { const stat = await handle.stat(options); stat.dev += 1000n; return stat; },
      writeFile: handle.writeFile.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle),
    };
  } };
  const cache = await f.open(adapter);
  await cache.replace(first);
  assert.deepEqual(await cache.close(), { closed: true, warnings: [] });
  assert.deepEqual((await f.open(adapter)).data, first);
});

test('cleanup preserves a different marker inode even when its contents match the old owner', async (t) => {
  const f = await fixture(t); const cache = await f.open();
  const marker = path.join(f.directory, '.loker-lens.lock');
  const previous = path.join(f.directory, 'previous-owner-marker');
  assert.equal(path.dirname(previous), f.directory);
  const bytes = await fs.readFile(marker);
  await fs.rename(marker, previous);
  await fs.writeFile(marker, bytes, { flag: 'wx' });
  assert.deepEqual((await cache.close()).warnings, ['Penanda pemilik cache belum dilepas. Cache tetap dipertahankan.']);
  assert.deepEqual(await fs.readFile(marker), bytes);
});
