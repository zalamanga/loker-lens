import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DashboardClient, requestJSON, RequestFailure } from '../public/client.mjs';

function status(instanceId = randomUUID(), revision = 0) {
  return { instanceId, mode: 'demo', revision, generation: null, cache: { phase: 'missing', hash: null, pending: false, savedAt: null, stale: false }, operation: null };
}
const snapshot = (value) => ({ ...structuredClone(value), snapshot: null });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function operation(id, phase = 'queued') { return { id, phase, startedAt: 1, finishedAt: null, progress: { completedPages: 0, totalPages: 0 }, error: null, warnings: [], cancelRequested: false }; }

test('body deadline cancels a response that stalled after successful headers', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(requestJSON('/api/status', {}, { timeoutMs: 20, fetcher: async () => response }));
  assert.equal(cancelled, true);
});
test('misleading length cannot bypass streaming bounds and the owned body is cancelled', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(70_000)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json', 'content-length': '2' } });
  await assert.rejects(requestJSON('/api/status', {}, { fetcher: async () => response }), /melampaui batas/);
  assert.equal(cancelled, true);
});
test('a body rejected at the header gate is cancelled without acquiring a reader', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } });
  await assert.rejects(requestJSON('/api/status', {}, { fetcher: async () => response }), /JSON/);
  assert.equal(cancelled, true);
});
test('safe HTTP error responses carry an authoritative status while malformed error bodies do not become successful data', async () => {
  await assert.rejects(requestJSON('/api/sync', {}, { fetcher: async () => new Response(JSON.stringify({ code: 'generation_conflict', error: 'Data berubah.' }), { status: 409, headers: { 'content-type': 'application/json' } }) }), (error) => error instanceof RequestFailure && error.status === 409 && error.code === 'generation_conflict');
  await assert.rejects(requestJSON('/api/state', {}, { fetcher: async () => new Response('{bad', { headers: { 'content-type': 'application/json' } }) }), /JSON/);
});
test('an older refresh cannot replace a newer validated response, and malformed data preserve the confirmed state', async () => {
  const initial = status(); const first = deferred(); let count = 0;
  const client = new DashboardClient({ request: async () => ++count === 1 ? first.promise : snapshot({ ...initial, revision: 2 }) });
  const old = client.refresh(); await client.refresh(); first.resolve(snapshot(initial)); await old;
  assert.equal(client.status.revision, 2);
  const bad = new DashboardClient({ request: async () => count++ === 2 ? snapshot(initial) : { ...snapshot(initial), unexpected: true } });
  await bad.refresh(); const before = structuredClone(bad.status); assert.equal(await bad.refresh(), false); assert.deepEqual(bad.status, before); assert.ok(bad.error);
});
test('a delayed status from a previous server instance cannot displace a newly observed instance', async () => {
  const a = status(); const b = status(); const held = deferred(); let reads = 0;
  const client = new DashboardClient({ request: async (path) => path === '/api/status' ? held.promise : snapshot(reads++ === 0 ? a : b) });
  await client.refresh(); const checking = client.check(); await client.refresh(); held.resolve({ ...a, revision: 999 }); await checking;
  assert.equal(client.status.instanceId, b.instanceId);
});
test('polling shares one pending request instead of overlapping status reads', async () => {
  const value = status(); const held = deferred(); let calls = 0;
  const client = new DashboardClient({ request: async () => { calls++; return held.promise; } });
  const a = client.check(); const b = client.check(); assert.equal(a, b); assert.equal(calls, 1);
  held.resolve(value); await a; assert.equal(calls, 1);
});
test('lost start acknowledgement is checked before explicit retry and reuses the exact immutable request', async () => {
  const value = status(); const sent = []; let checked = false;
  const client = new DashboardClient({ request: async (path, options) => {
    if (path === '/api/state') return snapshot(value);
    if (path.startsWith('/api/status?')) { checked = true; throw new RequestFailure('Unknown.', 404, 'operation_unknown'); }
    sent.push(options.body);
    if (sent.length === 1) throw new Error('Controlled response loss.');
    const id = JSON.parse(options.body).operationId;
    return { ...value, revision: 1, operation: operation(id), joined: false, replay: false };
  } });
  await client.refresh(); assert.equal(await client.start(), false); assert.ok(client.pendingStart);
  assert.equal(await client.retryStart(), false); assert.equal(sent.length, 1);
  await client.check(); assert.equal(checked, true); assert.equal(sent.length, 1);
  assert.equal(await client.retryStart(), true); assert.equal(sent[0], sent[1]); assert.equal(client.pendingStart, null);
});
test('a complete authoritative refusal allows a later explicit start, while a malformed success stays uncertain', async () => {
  const value = status(); let attempts = 0;
  const client = new DashboardClient({ request: async (path) => {
    if (path === '/api/state') return snapshot(value);
    attempts++; if (attempts === 1) throw new RequestFailure('Data berubah.', 409, 'generation_conflict');
    return value;
  } });
  await client.refresh(); await client.start(); assert.equal(client.pendingStart, null);
  await client.start(); assert.ok(client.pendingStart); assert.match(client.error, /Balasan awal/);
});
test('pagehide disposal aborts owned requests and ignores their late completion', async () => {
  const held = deferred(); let signal; let changes = 0;
  const client = new DashboardClient({ change() { changes++; }, request: async (_path, _options, options) => { signal = options.signal; return held.promise; } });
  const loading = client.refresh(); client.dispose(); assert.equal(signal.aborted, true);
  held.resolve(snapshot(status())); await loading; assert.equal(client.status, null); assert.equal(changes, 0);
});
test('a mutation invalidates an already pending data read', async () => {
  const value = status(); const held = deferred(); let reads = 0;
  const client = new DashboardClient({ request: async (path, options) => {
    if (path === '/api/state') return reads++ === 0 ? snapshot(value) : held.promise;
    return { ...value, revision: 3, operation: operation(JSON.parse(options.body).operationId), joined: false, replay: false };
  } });
  await client.refresh(); const loading = client.refresh(); await client.start(); held.resolve(snapshot({ ...value, revision: 2 })); await loading;
  assert.equal(client.status.revision, 3); assert.equal(client.status.operation.phase, 'queued');
});
