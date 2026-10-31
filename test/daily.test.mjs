import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ApplicationQueue } from '../lib/board-store.mjs';
import { createBoard, normalizeJobstreet } from '../lib/board.mjs';
import { collectDaily } from '../lib/daily.mjs';
import { Problem } from '../lib/errors.mjs';

const parent = path.resolve(process.env.LOKER_TEST_ROOT ?? '.test-cache');
const today = '2026-11-01T08:00:00.000Z';
const card = (id) => ({ id: String(id), title: `Synthetic daily fixture ${id}`, link: `https://id.jobstreet.com/job/${id}`,
  company: { name: 'Synthetic daily fixture company' }, locations: [{ label: 'Jakarta', country_code: 'ID' }],
  salary: { label: 'Synthetic fixture salary' }, teaser: 'Synthetic fixture only, no real application.', listed_at: null });
function json(jobs, page, totalPages = 8) {
  return new Response(JSON.stringify({ jobs, current_page: page, total_pages: totalPages }), { headers: { 'content-type': 'application/json' } });
}

async function fixture(t) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'daily-collector-'));
  const filename = path.join(directory, 'queue.sqlite');
  const owners = [];
  let current = today;
  t.after(async () => {
    for (const owner of owners) owner.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('daily-collector-'));
    assert.equal((await fs.realpath(resolved)).toLowerCase(), resolved.toLowerCase());
    await fs.rm(resolved, { recursive: true });
  });
  function queue() {
    const value = new ApplicationQueue({ filename, clock: () => current }); owners.push(value); return value;
  }
  return { queue, setTime(value) { current = value; }, board(fetcher) {
    const store = queue();
    const board = createBoard({ queue: store, apiURL: 'http://127.0.0.1:8131/', fetcher, clock: () => current });
    owners.push(board);
    return { board, store };
  } };
}

test('daily collection fills twenty new WIB reservations across actual board pages while skipping queued, applied and sponsored duplicates', async (t) => {
  const f = await fixture(t); f.setTime('2026-10-31T08:00:00.000Z');
  const previous = f.queue();
  previous.add(normalizeJobstreet(card(100001)));
  const appliedId = previous.add(normalizeJobstreet(card(100002))).queue.find((row) => row.jobId === '100002').id;
  previous.markApplied(appliedId);
  f.setTime(today);
  const calls = [];
  const { board } = f.board(async (url, options) => {
    const parsed = new URL(url); const page = Number(parsed.searchParams.get('page'));
    calls.push({ url: parsed, options });
    const rows = page === 1 ? [...Array.from({ length: 10 }, (_, i) => card(100001 + i)), card(100003)]
      : [card(100010), ...Array.from({ length: 20 }, (_, i) => card(100011 + i))];
    return json(rows, page);
  });
  const result = await collectDaily({ board, query: 'React & TypeScript', location: 'Jakarta Selatan' });
  assert.deepEqual(result, { day: '2026-11-01', added: 20, duplicatesSkipped: 3, pagesRead: 2,
    quota: { day: '2026-11-01', limit: 20, used: 20, remaining: 0 }, applicationsSent: 0 });
  assert.equal(board.status().queue.length, 22);
  assert.equal(board.status().queue.find((row) => row.id === appliedId).appliedDay, '2026-10-31');
  assert.equal(board.status().queue.filter((row) => row.status === 'queued' && row.scheduledDay === '2026-11-01').length, 20);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.url.origin, 'http://127.0.0.1:8131');
    assert.equal(call.url.pathname, '/jobs/search');
    assert.deepEqual(Object.fromEntries(call.url.searchParams), { country: 'ID', language: 'id', query: 'React & TypeScript', location: 'Jakarta Selatan', page: String(index + 1), page_size: '20', sort: 'date' });
    assert.equal(call.options.method ?? 'GET', 'GET');
    assert.equal(call.options.redirect, 'error');
  }
});

test('a full daily quota skips provider HTTP entirely and preserves existing manual applied status', async (t) => {
  const f = await fixture(t); const store = f.queue();
  for (let i = 0; i < 20; i++) store.add(normalizeJobstreet(card(200001 + i)));
  const appliedId = store.status().queue[0].id; store.markApplied(appliedId);
  let calls = 0;
  const { board } = f.board(async () => { calls++; throw new Error('A full queue must not call its provider.'); });
  const result = await collectDaily({ board, query: 'Synthetic developer' });
  assert.equal(calls, 0);
  assert.equal(result.pagesRead, 0);
  assert.equal(result.added, 0);
  assert.equal(result.duplicatesSkipped, 0);
  assert.equal(result.applicationsSent, 0);
  assert.equal(result.quota.remaining, 0);
  assert.equal(board.status().queue.find((row) => row.id === appliedId).status, 'applied');
});

test('restart and repeated collection deduplicate persistently and read no more than five pages per run', async (t) => {
  const f = await fixture(t); const pages = [];
  const fetcher = async (url) => {
    const page = Number(new URL(url).searchParams.get('page')); pages.push(page);
    return json([card(300001), card(300002)], page, 999);
  };
  const first = f.board(fetcher);
  const collected = await collectDaily({ board: first.board, query: 'Synthetic repeated' });
  assert.equal(collected.added, 2);
  assert.equal(collected.duplicatesSkipped, 8);
  assert.equal(collected.pagesRead, 5);
  const identities = first.board.status().queue.map((row) => row.id).sort();
  first.board.close();
  const restarted = f.board(fetcher);
  const repeated = await collectDaily({ board: restarted.board, query: 'Synthetic repeated' });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicatesSkipped, 10);
  assert.equal(repeated.pagesRead, 5);
  assert.equal(repeated.quota.used, 2);
  assert.equal(repeated.applicationsSent, 0);
  assert.deepEqual(restarted.board.status().queue.map((row) => row.id).sort(), identities);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
  const beforeCachedRepeat = pages.length;
  const cachedRepeat = await collectDaily({ board: restarted.board, query: 'Synthetic repeated' });
  assert.equal(cachedRepeat.added, 0);
  assert.equal(cachedRepeat.duplicatesSkipped, 10);
  assert.equal(pages.length, beforeCachedRepeat);
});

test('a source with no further pages stops before five even when daily quota is still available', async (t) => {
  const f = await fixture(t); let calls = 0;
  const { board } = f.board(async () => { calls++; return json([card(400001)], 1, 1); });
  const result = await collectDaily({ board, query: 'Synthetic single page' });
  assert.equal(result.added, 1);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.quota.remaining, 19);
  assert.equal(result.applicationsSent, 0);
  assert.equal(calls, 1);
});

test('another SQLite connection filling the quota between status and enqueue is handled as a quota race', async (t) => {
  const f = await fixture(t); const competingStore = f.queue(); let raced = false; let calls = 0;
  const { board } = f.board(async () => { calls++; return json([card(500001)], 1); });
  const racingBoard = { status: () => board.status(), search: (...args) => board.search(...args), add(job) {
    if (!raced) {
      raced = true;
      for (let i = 0; i < 20; i++) competingStore.add(normalizeJobstreet(card(510001 + i)));
    }
    return board.add(job);
  } };
  const result = await collectDaily({ board: racingBoard, query: 'Synthetic quota race' });
  assert.equal(result.added, 0);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.quota.used, 20);
  assert.equal(result.applicationsSent, 0);
  assert.equal(calls, 1);
  assert.equal(board.status().queue.length, 20);
  assert.equal(board.status().queue.some((row) => row.jobId === '500001'), false);
});

test('a later provider failure throws while already collected records remain committed across restart', async (t) => {
  const f = await fixture(t); const pages = [];
  const { board } = f.board(async (url) => {
    const page = Number(new URL(url).searchParams.get('page')); pages.push(page);
    if (page === 2) throw new Error('Controlled provider failure on the second page.');
    return json([card(600001), card(600002), card(600003)], page, 3);
  });
  await assert.rejects(collectDaily({ board, query: 'Synthetic partial failure' }), (error) => error.code === 'provider_unreachable' && error.status === 502);
  assert.deepEqual(pages, [1, 2]);
  const committed = board.status().queue;
  assert.equal(committed.length, 3);
  assert.equal(committed.every((row) => row.status === 'queued'), true);
  assert.equal(board.status().quota.used, 3);
  board.close();
  const reopened = f.queue();
  assert.deepEqual(reopened.status().queue, committed);
  assert.equal(reopened.status().quota.remaining, 17);
});

test('queue failures other than quota are surfaced and cannot be mistaken for successful collection', async (t) => {
  const f = await fixture(t);
  const { board } = f.board(async () => json([card(700001)], 1));
  const failingBoard = { status: () => board.status(), search: (...args) => board.search(...args),
    add() { throw new Problem('queue_full', 'Controlled ledger capacity failure.', 409); } };
  await assert.rejects(collectDaily({ board: failingBoard, query: 'Synthetic queue failure' }), (error) => error.code === 'queue_full' && error.status === 409);
  assert.equal(board.status().queue.length, 0);
  assert.equal(board.status().quota.used, 0);
});
