import test from 'node:test';
import assert from 'node:assert/strict';
import { wordpressSource } from '../lib/source.mjs';
import { readConfiguration } from '../lib/config.mjs';

const now = Date.parse('2026-10-26T04:00:00.000Z');
const configuration = readConfiguration(process.cwd(), { LOKER_MODE: 'live', MAX_PAGES: '2' });
const term = (id) => ({ id, name: `Istilah ${id}`, slug: `istilah-${id}`, count: 1 });
const post = (id, category = 101) => ({ id, title: { rendered: `Frontend Developer ${id}` }, excerpt: { rendered: '<p>Contoh sintetis transport.</p>' }, content: { rendered: '<h2>React</h2><li>Memahami React dan JavaScript untuk latihan.</li>' }, slug: `contoh-${id}`, date: '2026-10-25T09:00:00', modified: '2026-10-25T10:00:00', categories: [category], tags: [201], link: `https://www.disnakerja.com/contoh-${id}/` });
const response = (rows, pages = 1, headers = {}) => new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json', 'x-wp-totalpages': String(pages), ...headers } });
function options(fetcher, additions = {}) { return { config: configuration, clock: () => now, signal: new AbortController().signal, onProgress() {}, fetcher, ...additions }; }
function transport(url) {
  const kind = url.pathname.split('/').at(-1); const page = Number(url.searchParams.get('page'));
  if (kind === 'categories') return response(page === 1 ? Array.from({ length: 100 }, (_, i) => term(i + 1)) : [term(101)], 2);
  if (kind === 'tags') return response([term(201)]);
  return response([post(page)], 2);
}

test('taxonomy pagination retains terms beyond the first hundred and keeps the fixed HTTPS source', async () => {
  const seen = [];
  const result = await wordpressSource(options(async (url, request) => { seen.push(url.href); assert.equal(url.origin, 'https://www.disnakerja.com'); assert.equal(request.redirect, 'error'); return transport(url); }));
  assert.equal(result.jobs.length, 2); assert.equal(result.jobs[0].categories[0].id, 101);
  assert.ok(seen.some((url) => url.includes('categories?') && url.includes('page=2')));
  assert.deepEqual(result.coverage, { pagesRead: 2, totalPages: 2, truncated: false });
});
test('a configured post cap reports truncation rather than claiming the whole provider dataset', async () => {
  const result = await wordpressSource(options(async (url) => transport(url), { config: { ...configuration, maxPages: 1 } }));
  assert.equal(result.jobs.length, 1); assert.deepEqual(result.coverage, { pagesRead: 1, totalPages: 2, truncated: true });
});
test('duplicate posts and changing taxonomy page headers reject the entire candidate', async () => {
  await assert.rejects(wordpressSource(options(async (url) => url.pathname.endsWith('/posts') ? response([post(1)], 2) : transport(url))), (error) => error.code === 'source_schema');
  await assert.rejects(wordpressSource(options(async (url) => url.pathname.endsWith('/categories') && url.searchParams.get('page') === '2' ? response([term(101)], 3) : transport(url))), (error) => error.code === 'source_changed');
});
test('missing page metadata, oversized declared bodies and malformed JSON are rejected before normalization', async () => {
  for (const [build, code] of [
    [() => new Response('[]', { headers: { 'content-type': 'application/json' } }), 'source_pages'],
    [() => response([], 0, { 'content-length': '4194305' }), 'source_capacity'],
    [() => new Response('{bad', { headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } }), 'source_json'],
  ]) await assert.rejects(wordpressSource(options(async () => build())), (error) => error.code === code);
});
test('cancellation after response headers cancels the owned body and never yields a candidate', async () => {
  const controller = new AbortController(); let cancelled = false;
  const result = wordpressSource(options(async () => {
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    queueMicrotask(() => controller.abort());
    return new Response(body, { headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } });
  }, { signal: controller.signal }));
  await assert.rejects(result); assert.equal(cancelled, true);
});
