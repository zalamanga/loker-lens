const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUUID = (value) => typeof value === 'string' && UUID.test(value);
export const PROFILE_IDS = ['it-web', 'teknik-informatika', 'human-resources'];
export function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError('Bentuk data tidak sesuai.');
  return value;
}
export function text(value, maximum, minimum = 0) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
      || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new TypeError('Teks tidak valid atau melebihi batas.');
  return value;
}
export function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Bilangan tidak valid.');
  return value;
}
export function truncateGraphemes(value, maximum) {
  if (value.length <= maximum) return value;
  let end = 0;
  for (const part of new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(value)) {
    if (part.index + part.segment.length > maximum) break;
    end = part.index + part.segment.length;
  }
  return value.slice(0, end);
}
export function iso(value) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Tanggal tidak valid.');
  return value;
}
function array(value, maximum, inspect) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Daftar melebihi batas.');
  value.forEach(inspect);
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') throw new TypeError('Pilihan tidak valid.'); }
function term(value) {
  record(value, ['id', 'name', 'slug']); integer(value.id, 1, Number.MAX_SAFE_INTEGER);
  text(value.name, 2000, 1); text(value.slug, 2000, 1);
}
function unique(values) { if (new Set(values).size !== values.length) throw new TypeError('Identitas berulang.'); }
export function sourceDestination(value, mode, id) {
  text(value, 4000, 1);
  if (mode === 'demo') {
    if (value !== `/demo/source/${id}`) throw new TypeError('Tujuan demo tidak valid.');
  } else {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.disnakerja.com' || url.port || url.username || url.password) throw new TypeError('Tujuan sumber tidak valid.');
  }
  return value;
}
export function validateSnapshot(value, expectedMode) {
  record(value, ['application', 'version', 'mode', 'generation', 'savedAt', 'cutoff', 'lookbackMonths', 'coverage', 'jobs']);
  if (value.application !== 'loker-lens' || value.version !== 1 || !['demo', 'live'].includes(value.mode)
      || (expectedMode !== undefined && value.mode !== expectedMode) || !isUUID(value.generation)) throw new TypeError('Versi atau asal data tidak sesuai.');
  iso(value.savedAt); iso(value.cutoff); integer(value.lookbackMonths, 1, 12);
  if (value.cutoff > value.savedAt) throw new TypeError('Jendela data tidak valid.');
  record(value.coverage, ['pagesRead', 'totalPages', 'truncated']);
  integer(value.coverage.pagesRead, 0, 40); integer(value.coverage.totalPages, 0, 1_000_000); boolean(value.coverage.truncated);
  if (value.coverage.pagesRead > value.coverage.totalPages
      || value.coverage.truncated !== (value.coverage.pagesRead < value.coverage.totalPages)) throw new TypeError('Cakupan halaman tidak sesuai.');
  const termIdentity = { categories: new Map(), locations: new Map() };
  array(value.jobs, 4000, (job) => {
    record(job, ['id', 'title', 'summary', 'url', 'slug', 'publishedAt', 'modifiedAt', 'categories', 'locations', 'content', 'matches']);
    integer(job.id, 1, Number.MAX_SAFE_INTEGER); text(job.title, 500, 1); text(job.summary, 2000); text(job.slug, 2000);
    sourceDestination(job.url, value.mode, job.id); iso(job.publishedAt); iso(job.modifiedAt);
    if (job.modifiedAt < value.cutoff) throw new TypeError('Post di luar jendela yang disimpan.');
    for (const kind of ['categories', 'locations']) {
      array(job[kind], 200, (item) => {
        term(item);
        const before = termIdentity[kind].get(item.id);
        if (before && (before.name !== item.name || before.slug !== item.slug)) throw new TypeError('Istilah berubah dalam satu snapshot.');
        termIdentity[kind].set(item.id, item);
        if (termIdentity[kind].size > 2000) throw new TypeError('Jumlah istilah melebihi batas.');
      });
      unique(job[kind].map((item) => item.id));
    }
    record(job.content, ['text', 'truncated', 'headings', 'requirements', 'hasDocumentAttachment']);
    text(job.content.text, 18_000); boolean(job.content.truncated); boolean(job.content.hasDocumentAttachment);
    array(job.content.headings, 12, (item) => text(item, 120, 3));
    array(job.content.requirements, 18, (item) => text(item, 260, 12));
    array(job.matches, 3, (match) => {
      record(match, ['id', 'name', 'keywords', 'count']);
      if (!PROFILE_IDS.includes(match.id)) throw new TypeError('Profil tidak dikenal.');
      text(match.name, 100, 1); array(match.keywords, 40, (item) => text(item, 100, 1));
      integer(match.count, 1, 40); if (match.count !== match.keywords.length) throw new TypeError('Jumlah kata berbeda.');
      unique(match.keywords);
    });
    unique(job.matches.map((match) => match.id));
  });
  unique(value.jobs.map((job) => job.id));
  return value;
}

export function validateStatus(value, withSnapshot = false) {
  record(value, ['instanceId', 'mode', 'revision', 'generation', 'cache', 'operation', ...(withSnapshot ? ['snapshot'] : [])]);
  if (!isUUID(value.instanceId) || !['demo', 'live'].includes(value.mode) || (value.generation !== null && !isUUID(value.generation))) throw new TypeError('Status aplikasi tidak sesuai.');
  integer(value.revision, 0, Number.MAX_SAFE_INTEGER);
  record(value.cache, ['phase', 'hash', 'pending', 'savedAt', 'stale']);
  const cache = value.cache;
  if (!['missing', 'ready', 'damaged', 'unknown'].includes(cache.phase) || (cache.hash !== null && (typeof cache.hash !== 'string' || !/^[a-f0-9]{64}$/.test(cache.hash)))) throw new TypeError('Status cache tidak valid.');
  boolean(cache.pending); boolean(cache.stale);
  if (cache.pending !== (cache.phase === 'unknown')) throw new TypeError('Status simpan tidak sesuai.');
  if (cache.savedAt !== null) iso(cache.savedAt);
  if ((value.generation === null) !== (cache.savedAt === null)) throw new TypeError('Identitas cache tidak sesuai.');
  if (cache.phase === 'missing' && (cache.hash !== null || value.generation !== null)) throw new TypeError('Cache hilang berisi identitas.');
  if (cache.phase === 'ready' && (cache.hash === null || value.generation === null)) throw new TypeError('Cache siap tidak memiliki identitas.');
  if (value.operation !== null) {
    const operation = record(value.operation, ['id', 'phase', 'startedAt', 'finishedAt', 'progress', 'error', 'warnings', 'cancelRequested']);
    if (!isUUID(operation.id) || !['queued', 'taxonomy', 'reading', 'persisting', 'saved', 'failed', 'unknown', 'cancelled'].includes(operation.phase)) throw new TypeError('Operasi tidak valid.');
    integer(operation.startedAt, 0, Number.MAX_SAFE_INTEGER);
    if (operation.finishedAt !== null) integer(operation.finishedAt, operation.startedAt, Number.MAX_SAFE_INTEGER);
    record(operation.progress, ['completedPages', 'totalPages']);
    integer(operation.progress.totalPages, 0, 40); integer(operation.progress.completedPages, 0, operation.progress.totalPages);
    boolean(operation.cancelRequested); array(operation.warnings, 10, (warning) => text(warning, 500, 1));
    if (operation.error !== null) { record(operation.error, ['code', 'message']); text(operation.error.code, 100, 1); text(operation.error.message, 1000, 1); }
  }
  if (withSnapshot) {
    if (value.snapshot !== null) {
      validateSnapshot(value.snapshot, value.mode);
      if (value.snapshot.generation !== value.generation || value.snapshot.savedAt !== cache.savedAt) throw new TypeError('Data dan status berasal dari generasi berbeda.');
    } else if (value.generation !== null) throw new TypeError('Data terkonfirmasi tidak tersedia.');
  }
  return value;
}

export function facets(jobs, key) {
  const counts = new Map();
  for (const job of jobs) for (const item of job[key]) {
    const current = counts.get(item.id) ?? { ...item, count: 0 };
    current.count++; counts.set(item.id, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'id') || a.id - b.id);
}
export function normalize(value) { return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('id-ID').replace(/\s+/gu, ' ').trim(); }
export function keywords(value) {
  text(value, 500);
  const terms = [...new Set(value.split(',').map((term) => term.trim()).filter(Boolean))];
  if (terms.length > 12 || terms.some((term) => term.length < 2 || term.length > 60)) throw new TypeError('Gunakan maksimal 12 kata/frasa, masing-masing 2–60 karakter.');
  return terms;
}
export function sourceDate(value) { return new Date(Date.parse(value) + 7 * 3600_000).toISOString().slice(0, 10); }
function dateInput(value) {
  if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new TypeError('Tanggal filter tidak valid.');
}
export function filterJobs(jobs, filter) {
  const custom = keywords(filter.keywords); const query = normalize(text(filter.query, 200));
  dateInput(filter.dateFrom); dateInput(filter.dateTo);
  if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) throw new TypeError('Tanggal awal harus sama atau sebelum tanggal akhir.');
  if (!['latest', 'oldest', 'az'].includes(filter.sort)) throw new TypeError('Urutan tidak dikenal.');
  return jobs.filter((job) => {
    const haystack = normalize([job.title, job.summary, job.content.text, ...job.content.headings, ...job.content.requirements, ...job.categories.map((x) => x.name), ...job.locations.map((x) => x.name)].join(' '));
    const date = sourceDate(job.modifiedAt);
    return (!query || haystack.includes(query)) && (!filter.category || job.categories.some((x) => String(x.id) === filter.category))
      && (!filter.location || job.locations.some((x) => String(x.id) === filter.location))
      && (!filter.interest || job.matches.some((x) => x.id === filter.interest))
      && (!custom.length || custom.some((term) => haystack.includes(normalize(term))))
      && (!filter.dateFrom || date >= filter.dateFrom) && (!filter.dateTo || date <= filter.dateTo);
  }).sort((a, b) => (filter.sort === 'az' ? a.title.localeCompare(b.title, 'id') : filter.sort === 'oldest' ? a.modifiedAt.localeCompare(b.modifiedAt) : b.modifiedAt.localeCompare(a.modifiedAt)) || a.id - b.id);
}

export function relevantExcerpt(value, terms) {
  if (!value || !terms.length) return '';
  let folded = ''; const offsets = [];
  for (const { segment, index } of new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(value)) {
    const part = normalize(segment);
    const expanded = part || (/\s/u.test(segment) ? ' ' : '');
    if (expanded === ' ' && folded.endsWith(' ')) { offsets[offsets.length - 1].end = index + segment.length; continue; }
    for (let i = 0; i < expanded.length; i++) offsets.push({ start: index, end: index + segment.length });
    folded += expanded;
  }
  const match = terms.map(normalize).filter(Boolean).map((term) => ({ term, index: folded.indexOf(term) })).find((item) => item.index >= 0);
  if (!match) return '';
  const start = Math.max(0, offsets[match.index].start - 100);
  const end = Math.min(value.length, offsets[match.index + match.term.length - 1].end + 220);
  const segments = [...new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(value)];
  const safeStart = segments.find((x) => x.index >= start)?.index ?? 0;
  const safeEnd = segments.find((x) => x.index >= end)?.index ?? value.length;
  return `${safeStart ? '…' : ''}${value.slice(safeStart, safeEnd).trim()}${safeEnd < value.length ? '…' : ''}`;
}
