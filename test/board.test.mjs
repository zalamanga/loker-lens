import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { ApplicationQueue } from '../lib/board-store.mjs';
import { createBoard, jobstreetBase, normalizeJobstreet } from '../lib/board.mjs';
import { createServer } from '../server.js';

const parent = path.resolve(process.env.LOKER_TEST_ROOT ?? '.test-cache');
const initialTime = '2026-11-01T08:00:00.000Z';
const request = (query = 'React developer', extra = {}) => ({ provider: 'jobstreet', query, location: 'Jakarta', page: 1, ...extra });
const card = (id = '100001', extra = {}) => ({ id, title: `Synthetic developer ${id}`, link: `https://id.jobstreet.com/job/${id}`,
  company: { name: 'Synthetic fixture company' }, advertiser: { name: 'Fallback fixture advertiser' },
  locations: [{ label: 'Jakarta Selatan', country_code: 'ID' }], salary: { label: 'Rp 8.000.000 per bulan' },
  teaser: 'Synthetic fixture only.', bullet_points: ['Build test fixtures', 'Review synthetic contracts'],
  listed_at: '2026-11-01T10:00:00+07:00', ...extra });
const payload = (jobs = [card()], extra = {}) => ({ jobs, current_page: 1, total_pages: 2, ...extra });
const response = (data = payload()) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const hasCode = (code, status) => (error) => error.code === code && error.status === status;

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'board-provider-'));
  const owners = [];
  let current = initialTime;
  t.after(async () => {
    for (const board of owners) board.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('board-provider-'));
    assert.equal((await fs.realpath(resolved)).toLowerCase(), resolved.toLowerCase());
    await fs.rm(resolved, { recursive: true });
  });
  return { setTime(value) { current = value; },
    board(options = {}) {
      const queue = new ApplicationQueue({ filename: path.join(directory, 'queue.sqlite'), clock: () => current });
      const board = createBoard({ queue, apiURL: 'http://127.0.0.1:8131/', clock: () => current,
        fetcher: async () => { throw new Error('Unexpected external call in test.'); }, ...options });
      owners.push(board); return board;
    } };
}

test('the provider request fixes Indonesia, language, sort and page size while encoding validated search text', async (t) => {
  const f = await fixture(t); const calls = [];
  const board = f.board({ fetcher: async (url, options) => { calls.push({ url: new URL(url), options }); return response(payload([card()], { current_page: 3, total_pages: 8 })); } });
  const result = await board.search(request('  React & country=SG\n engineer  ', { location: '  Jakarta   Selatan ', page: 3 }));
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url.origin, 'http://127.0.0.1:8131');
  assert.equal(url.pathname, '/jobs/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), { country: 'ID', language: 'id', query: 'React & country=SG engineer', location: 'Jakarta Selatan', page: '3', page_size: '20', sort: 'date' });
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.accept, 'application/json');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.jobs[0].company, 'Synthetic fixture company');
  assert.equal(result.jobs[0].location, 'Jakarta Selatan');
  assert.equal(result.jobs[0].salary, 'Rp 8.000.000 per bulan');
  assert.equal(result.jobs[0].listedAt, '2026-11-01T03:00:00.000Z');
  assert.equal(result.jobs[0].applyUrl, 'https://id.jobstreet.com/job/100001');
  assert.equal(result.hasMore, true);
  assert.equal(board.status().quota.used, 0);
});

test('local service configuration cannot target remote hosts, credentials, alternate paths or privileged ports', () => {
  assert.equal(jobstreetBase(undefined), null);
  assert.equal(jobstreetBase(''), null);
  assert.equal(jobstreetBase('http://127.0.0.1:8131/').href, 'http://127.0.0.1:8131/');
  for (const url of ['https://127.0.0.1:8131/', 'http://localhost:8131/', 'http://[::1]:8131/',
    'http://127.0.0.2:8131/', 'http://192.168.1.1:8131/', 'http://example.com:8131/',
    'http://127.0.0.1:80/', 'http://127.0.0.1:8131/api/', 'http://127.0.0.1:8131/?url=https://example.com',
    'http://user:pass@127.0.0.1:8131/', 'http://127.0.0.1:8131/#anything', 'not a URL']) {
    assert.throws(() => jobstreetBase(url), hasCode('configuration', 503), url);
  }
});

test('invalid body shapes, excessive pages and parameter injection fields never reach the provider', async (t) => {
  const f = await fixture(t); let calls = 0;
  const board = f.board({ fetcher: async () => { calls++; return response(); } });
  for (const invalid of [null, [], request('', {}), request('x'.repeat(121)), request('x\u0000y'),
    request('ok', { location: 'x'.repeat(101) }), request('ok', { page: '1' }), request('ok', { page: 0 }),
    request('ok', { page: 6 }), request('ok', { provider: 'other' }), { ...request(), page_size: 1000 },
    { ...request(), country: 'SG' }, { provider: 'jobstreet', query: 'ok', page: 1 }]) {
    await assert.rejects(board.search(invalid), (error) => error.status === 422);
  }
  assert.equal(calls, 0);
});

test('Glints and an unconfigured local API report unavailable without external requests', async (t) => {
  const f = await fixture(t); let calls = 0;
  const fetcher = async () => { calls++; return response(); };
  const board = f.board({ fetcher });
  assert.equal(board.status().providers.find((row) => row.id === 'glints').available, false);
  await assert.rejects(board.search(request('engineer', { provider: 'glints' })), hasCode('provider_blocked', 503));
  const unconfigured = f.board({ apiURL: undefined, fetcher });
  await assert.rejects(unconfigured.search(request()), hasCode('provider_setup', 503));
  assert.equal(calls, 0);
});

test('sponsored duplicate IDs are deduplicated before the output is capped at twenty jobs', async (t) => {
  const f = await fixture(t);
  const cards = [card('100001'), card('100001', { title: 'Sponsored duplicate' }),
    ...Array.from({ length: 24 }, (_, i) => card(String(100002 + i)))];
  const board = f.board({ fetcher: async () => response(payload(cards)) });
  const result = await board.search(request());
  assert.equal(result.jobs.length, 20);
  assert.equal(new Set(result.jobs.map((job) => job.jobId)).size, 20);
  assert.equal(result.jobs[0].title, 'Synthetic developer 100001');
  assert.throws(() => board.add(normalizeJobstreet(card('100025'))), hasCode('queue_job', 422));
});

test('only an exact server-known job may enter the persistent queue and result mutations cannot forge one', async (t) => {
  const f = await fixture(t); const board = f.board({ fetcher: async () => response() });
  assert.throws(() => board.add(normalizeJobstreet(card())), hasCode('queue_job', 422));
  const result = await board.search(request());
  const original = structuredClone(result.jobs[0]);
  result.jobs[0].title = 'Forged client title';
  assert.throws(() => board.add(result.jobs[0]), hasCode('queue_job', 422));
  assert.throws(() => board.add({ ...original, applyUrl: 'https://evil.example/apply' }), hasCode('queue_job', 422));
  assert.throws(() => board.add({ ...original, extra: true }), hasCode('queue_job', 422));
  assert.equal(board.add(original).quota.used, 1);
  assert.equal(board.add(original).quota.used, 1);
  const refreshed = await board.search(request());
  assert.deepEqual(refreshed.jobs[0], original);
  const id = board.status().queue[0].id;
  assert.equal(board.markApplied({ id }).queue[0].status, 'applied');
  assert.throws(() => board.remove({ id }), hasCode('queue_applied', 409));
});

test('the immutable known-job check cannot bypass the combined SQLite quota with twenty-first result', async (t) => {
  const f = await fixture(t); let call = 0;
  const board = f.board({ fetcher: async () => {
    call++;
    return response(payload(Array.from({ length: 20 }, (_, i) => card(String(call * 100000 + i + 1)))));
  } });
  const first = await board.search(request('first'));
  for (const job of first.jobs) board.add(job);
  const second = await board.search(request('second'));
  assert.throws(() => board.add(second.jobs[0]), hasCode('quota', 409));
  assert.equal(board.status().queue.length, 20);
  assert.equal(board.status().quota.remaining, 0);
});

test('identical searches use detached cached results for sixty seconds and cache storage holds at most twenty keys', async (t) => {
  const f = await fixture(t); let calls = 0;
  const board = f.board({ fetcher: async () => { calls++; return response(); } });
  const first = await board.search(request('cache-0'));
  first.jobs[0].description = 'Outside mutation';
  f.setTime('2026-11-01T08:00:59.999Z');
  assert.notEqual((await board.search(request('cache-0'))).jobs[0].description, 'Outside mutation');
  assert.equal(calls, 1);
  f.setTime('2026-11-01T08:01:00.000Z');
  await board.search(request('cache-0'));
  assert.equal(calls, 2);
  for (let i = 1; i <= 20; i++) await board.search(request(`cache-${i}`));
  assert.equal(calls, 22);
  await board.search(request('cache-0'));
  assert.equal(calls, 23);
});

test('foreign country metadata and foreign links are rejected before a partial result becomes known', async (t) => {
  const f = await fixture(t);
  for (const foreign of [card('200002', { locations: [{ label: 'Singapore', country_code: 'SG' }] }),
    card('200002', { link: 'https://sg.jobstreet.com/job/200002' }),
    card('200002', { link: 'https://id.jobstreet.com.evil.example/job/200002' }),
    card('200002', { link: 'https://id.jobstreet.com/job/999999' })]) {
    const board = f.board({ fetcher: async () => response(payload([card(), foreign])) });
    await assert.rejects(board.search(request()), hasCode('provider_country', 502));
    assert.throws(() => board.add(normalizeJobstreet(card())), hasCode('queue_job', 422));
  }
  assert.equal(normalizeJobstreet(card('100003', { company: undefined })).company, 'Fallback fixture advertiser');
});

test('schema failures preserve the prior cache and previously known jobs', async (t) => {
  const f = await fixture(t); let next = payload(); let calls = 0;
  const board = f.board({ fetcher: async () => { calls++; return response(next); } });
  const saved = await board.search(request('saved'));
  for (const invalid of [payload([], { current_page: 2 }), payload([], { current_page: '1' }),
    payload([], { total_pages: 1.5 }), payload([], { total_pages: -1 }), { jobs: {}, current_page: 1, total_pages: 1 },
    payload(Array.from({ length: 101 }, () => card())), payload([card('not-numeric')])]) {
    next = invalid;
    await assert.rejects(board.search(request(`failure-${calls}`)), hasCode('provider_schema', 502));
  }
  const beforeCache = calls;
  assert.deepEqual(await board.search(request('saved')), saved);
  assert.equal(calls, beforeCache);
  assert.equal(board.add(saved.jobs[0]).quota.used, 1);
});

test('HTTP errors and non-JSON or oversized declared bodies are cancelled and never replace prior cache', async (t) => {
  const f = await fixture(t); let next = () => response();
  const board = f.board({ fetcher: async () => next() });
  const saved = await board.search(request('saved'));
  for (const failure of [
    { headers: { 'content-type': 'application/json' }, status: 503, code: 'provider_http' },
    { headers: { 'content-type': 'text/html' }, status: 200, code: 'provider_response' },
    { headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 + 1) }, status: 200, code: 'provider_capacity' },
    { headers: { 'content-type': 'application/json', 'content-length': 'invalid' }, status: 200, code: 'provider_capacity' },
  ]) {
    let cancelled = false;
    next = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('pending body')); }, cancel() { cancelled = true; } }), failure);
    await assert.rejects(board.search(request(failure.code + JSON.stringify(failure.headers))), hasCode(failure.code, 502));
    assert.equal(cancelled, true, `${failure.code} should cancel its owned response body`);
    assert.deepEqual(await board.search(request('saved')), saved);
  }
});

test('streaming and malformed JSON limits cancel their own body and leave the board reusable', async (t) => {
  const f = await fixture(t); let next = () => response();
  const board = f.board({ fetcher: async () => next() });
  let cancelled = false;
  next = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(board.search(request('oversize stream')), hasCode('provider_capacity', 502));
  assert.equal(cancelled, true);
  next = () => new Response('{broken', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(board.search(request('invalid JSON')), hasCode('provider_response', 502));
  next = () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(board.search(request('invalid UTF-8')), hasCode('provider_response', 502));
  next = () => response();
  assert.equal((await board.search(request('successful retry'))).jobs.length, 1);
});

test('timeout aborts the outgoing request and a later retry is neither busy nor cached as a failure', async (t) => {
  const f = await fixture(t); let timeout = true; let signal;
  const board = f.board({ timeoutMs: 10, fetcher: async (_url, options) => {
    signal = options.signal;
    if (!timeout) return response();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  } });
  await assert.rejects(board.search(request()), hasCode('provider_cancelled', 504));
  assert.equal(signal.aborted, true);
  timeout = false;
  assert.equal((await board.search(request())).jobs.length, 1);
});

test('busy concurrent searches reject independently while the active search can finish and cache', async (t) => {
  const f = await fixture(t); let release; let calls = 0;
  const board = f.board({ fetcher: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  const pending = board.search(request('active'));
  await assert.rejects(board.search(request('concurrent')), hasCode('provider_busy', 409));
  release(response());
  const saved = await pending;
  assert.deepEqual(await board.search(request('active')), saved);
  assert.equal(calls, 1);
});

test('client cancellation during body streaming does not poison prior cache or known jobs', async (t) => {
  const f = await fixture(t); let streaming = false; let ready; let calls = 0;
  const started = new Promise((resolve) => { ready = resolve; });
  const board = f.board({ fetcher: async (_url, { signal }) => {
    calls++;
    if (!streaming) return response();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jobs":['));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      ready();
    } }), { headers: { 'content-type': 'application/json' } });
  } });
  const saved = await board.search(request('saved'));
  streaming = true;
  const controller = new AbortController();
  const pending = board.search(request('cancelled'), controller.signal);
  await started; controller.abort();
  await assert.rejects(pending, hasCode('provider_cancelled', 504));
  assert.deepEqual(await board.search(request('saved')), saved);
  assert.equal(calls, 2);
  streaming = false;
  assert.equal((await board.search(request('cancelled'))).jobs.length, 1);
  assert.equal(board.add(saved.jobs[0]).quota.used, 1);
});

test('network redirects and unavailable transport surface failures without accepting returned records', async (t) => {
  const f = await fixture(t); let options;
  const board = f.board({ fetcher: async (_url, passed) => { options = passed; throw new TypeError('redirect disallowed'); } });
  await assert.rejects(board.search(request()), hasCode('provider_unreachable', 502));
  assert.equal(options.redirect, 'error');
  assert.equal(board.status().quota.used, 0);
  assert.throws(() => board.add(normalizeJobstreet(card())), hasCode('queue_job', 422));
  board.close();
  await assert.rejects(board.search(request()), hasCode('board_closed', 503));
});

async function localServer(t, board) {
  const server = createServer({ application: { status: () => ({ mode: 'demo' }) }, board });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, post(route, body, headers = {}) {
    return fetch(`${origin}${route}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } };
}

test('HTTP board routes require local Origin for mutation, accept exact known jobs, and never expose private SQLite files', async (t) => {
  const f = await fixture(t); let calls = 0;
  const board = f.board({ fetcher: async () => { calls++; return response(); } });
  const local = await localServer(t, board);
  const status = await fetch(`${local.origin}/api/board/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).quota.used, 0);
  const noOrigin = await fetch(`${local.origin}/api/board/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).code, 'origin');
  const foreignOrigin = await local.post('/api/board/search', request(), { origin: 'https://evil.example' });
  assert.equal(foreignOrigin.status, 403);
  const foreignSite = await local.post('/api/board/search', request(), { 'sec-fetch-site': 'cross-site' });
  assert.equal(foreignSite.status, 403);
  assert.equal(calls, 0);
  const search = await local.post('/api/board/search', request());
  assert.equal(search.status, 200);
  const savedJob = (await search.json()).jobs[0];
  const forged = await local.post('/api/board/queue', { ...savedJob, url: 'https://evil.example/job' });
  assert.equal(forged.status, 422);
  const queued = await local.post('/api/board/queue', savedJob);
  assert.equal(queued.status, 200);
  const queuedState = await queued.json();
  assert.equal(queuedState.quota.used, 1);
  assert.equal(queuedState.queue[0].title, savedJob.title);
  const oversized = await local.post('/api/board/queue', { ...savedJob, description: 'x'.repeat(17_000) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, 'body_capacity');
  for (const route of ['/.data/board/applications.sqlite', '/.data/board/applications.sqlite-journal', '/.test-cache/queue.sqlite', '/.git/config', '/lib/board-store.mjs']) {
    const privateResponse = await fetch(`${local.origin}${route}`);
    assert.equal(privateResponse.status, 404, route);
  }
  const applied = await local.post('/api/board/mark-applied', { id: queuedState.queue[0].id });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).queue[0].status, 'applied');
  const remove = await local.post('/api/board/remove', { id: queuedState.queue[0].id });
  assert.equal(remove.status, 409);
  assert.equal((await remove.json()).code, 'queue_applied');
});

test('disconnecting an HTTP search aborts the provider and the next search succeeds', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); let started; let aborted; let wait = true;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const requestAborted = new Promise((resolve) => { aborted = resolve; });
  const board = f.board({ fetcher: async (_url, { signal }) => {
    if (!wait) return response();
    started();
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }); });
  } });
  const local = await localServer(t, board);
  const body = JSON.stringify(request());
  const client = http.request(`${local.origin}/api/board/search`, { method: 'POST', headers: {
    origin: local.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } });
  client.on('error', () => {});
  client.end(body);
  await requestStarted;
  client.destroy();
  await requestAborted;
  wait = false;
  const retried = await local.post('/api/board/search', request());
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).jobs.length, 1);
  assert.equal(board.status().quota.used, 0);
});
