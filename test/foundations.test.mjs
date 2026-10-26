import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readConfiguration } from '../lib/config.mjs';
import { publicFailure } from '../lib/errors.mjs';
import { decodeHtml, extractContent, getLookbackStart, matchContent, normalizeJob, safeSourceUrl, toMap } from '../lib/jobs.mjs';

test('the content cap keeps an astral character and combining grapheme whole instead of creating invalid source text', () => {
  for (const suffix of ['😀', 'e\u0301', '👩🏽‍💻']) {
    const result = extractContent(`<p>${'a'.repeat(17_999)}${suffix} suite</p>`);
    assert.equal(result.text, 'a'.repeat(17_999));
    assert.equal(result.truncated, true);
  }
});

test('startup defaults to a separate synthetic cache and live mode requires an explicit value', () => {
  const root = path.resolve('synthetic-root');
  const demo = readConfiguration(root, {});
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.dataRoot, path.join(root, '.data', 'demo'));
  assert.equal(readConfiguration(root, { LOKER_MODE: 'live' }).dataRoot, path.join(root, '.data', 'live'));
  const configured = readConfiguration(root, { LOKER_DATA_DIR: path.join(root, 'isolated'), PORT: '65535', MAX_PAGES: '1', LOOKBACK_MONTHS: '12' });
  assert.equal(configured.port, 65535);
  assert.equal(configured.lookbackMonths, 12);
  assert.equal(configured.dataRoot, path.join(root, 'isolated'));
});

test('invalid configuration fails before a listener, source call or filesystem operation can start', () => {
  for (const env of [
    { PORT: '0' }, { PORT: '65536' }, { PORT: '3000.5' }, { PORT: 'Infinity' },
    { MAX_PAGES: '41' }, { MAX_PAGES: '-1' }, { LOOKBACK_MONTHS: '13' },
    { LOOKBACK_MONTHS: '' }, { LOOKBACK_MONTHS: '1e3' },
    { LOKER_MODE: 'production' }, { LOKER_DATA_DIR: 'relative-cache' },
  ]) {
    assert.throws(() => readConfiguration(path.resolve('.'), env), (error) => error.code === 'configuration');
  }
});

test('untrusted numeric entities preserve valid Unicode and replace invalid scalar values without RangeError', () => {
  assert.equal(decodeHtml('Caf&#233; &#x1F4BB; &amp;'), 'Café 💻 &');
  assert.equal(decodeHtml('&#1114112; &#xD800; &#0; &#9999999999999999999999999;'), '� � � �');
  assert.equal(decodeHtml('&unrecognized;'), '&unrecognized;');
});

test('source destinations exclude credentials, alternate ports and lookalike hosts', () => {
  for (const value of ['https://name:secret@www.disnakerja.com/a', 'https://www.disnakerja.com:444/a', 'https://www.disnakerja.com.evil.test/a', 'javascript:alert(1)', '//www.disnakerja.com/a']) {
    assert.equal(safeSourceUrl(value), null);
  }
  assert.equal(safeSourceUrl('https://www.disnakerja.com/a?b=c#d'), 'https://www.disnakerja.com/a?b=c#d');
});

test('a malformed source record fails as a whole instead of inventing identity, date or destination', () => {
  const post = { id: 1, title: { rendered: 'Post sintetis' }, excerpt: { rendered: '<p>Ringkasan sintetis</p>' },
    content: { rendered: '<h3>Web developer</h3><li>Pengalaman JavaScript</li>' }, slug: 'synthetic',
    link: 'https://www.disnakerja.com/synthetic', date: '2026-10-02T10:00:00', modified: '2026-10-02T11:00:00', categories: [10], tags: [] };
  const terms = toMap([{ id: 10, name: 'IT &amp; teknologi', slug: 'it', count: 1 }]);
  assert.equal(normalizeJob(post, terms, new Map()).categories[0].name, 'IT & teknologi');
  assert.equal(normalizeJob(post, terms, new Map()).modifiedAt, '2026-10-02T04:00:00.000Z');
  for (const replacement of [{ id: '1' }, { title: [] }, { categories: [99] }, { tags: [4, 4] },
    { modified: '2026-02-30T10:00:00' }, { link: 'https://evil.example.test/' }, { content: { rendered: false } }]) {
    assert.throws(() => normalizeJob({ ...post, ...replacement }, terms, new Map()), (error) => error.code === 'source_schema');
  }
  assert.throws(() => toMap([{ id: 1, name: 'Example', slug: 'example', count: '1' }]), (error) => error.code === 'source_schema');
});

test('Jakarta calendar windows clamp the target day and refuse an invalid clock or window', () => {
  assert.equal(getLookbackStart(new Date('2026-05-31T05:00:00Z'), 1).toISOString(), '2026-04-29T17:00:00.000Z');
  assert.equal(getLookbackStart(new Date('2024-03-31T05:00:00Z'), 1).toISOString(), '2024-02-28T17:00:00.000Z');
  assert.throws(() => getLookbackStart(new Date('invalid'), 2));
  for (const months of [0, 13, 2.5, Infinity, '2']) assert.throws(() => getLookbackStart(new Date(), months));
});

test('retained interest heuristics require meaningful whole-keyword signals, not a promised applicant match', () => {
  assert.deepEqual(matchContent('Buka website dan simpan ke database.'), []);
  const matches = matchContent('Web developer, Teknik Informatika dan HRD.');
  assert.deepEqual(matches.map((row) => row.id), ['it-web', 'teknik-informatika', 'human-resources']);
  assert.deepEqual(matchContent('HRD.').map((row) => row.id), ['human-resources']);
  assert.equal(matchContent('foohrdbar').length, 0);
  assert.equal(matchContent('shredding aircraft').length, 0);
});

test('unexpected failures cannot expose local paths or provider details to the browser', () => {
  const result = publicFailure(new Error('private provider path and diagnostic'));
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result).includes('private provider'), false);
});
