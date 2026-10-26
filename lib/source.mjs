import { getLookbackStart, normalizeJob, toMap } from './jobs.mjs';
import { LIMITS } from './config.mjs';
import { Problem } from './errors.mjs';

const API = 'https://www.disnakerja.com/wp-json/wp/v2/';
function pagesHeader(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})$/.test(value)) throw new Problem('source_pages', 'Sumber tidak memberi jumlah halaman yang dapat diperiksa.', 502);
  return Number(value);
}
async function responseJSON(response, signal, budget) {
  if (!response.ok || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Problem('source_response', 'Respons sumber bukan data JSON yang berhasil dibaca.', 502);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.sourceBodyBytes)) throw new Problem('source_capacity', 'Respons sumber melampaui batas 4 MiB.', 502);
  if (!response.body) throw new Problem('source_response', 'Sumber tidak mengirim isi respons.', 502);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0; let ended = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) { ended = true; break; }
      bytes += part.value.byteLength; budget.bytes += part.value.byteLength;
      if (bytes > LIMITS.sourceBodyBytes || budget.bytes > LIMITS.sourceTotalBytes) throw new Problem('source_capacity', 'Batas unduhan sumber tercapai. Data terakhir dipertahankan.', 502);
      chunks.push(part.value);
    }
    const joined = Buffer.concat(chunks, bytes);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
    catch { throw new Problem('source_json', 'JSON sumber tidak valid. Data terakhir dipertahankan.', 502); }
    if (!Array.isArray(value) || value.length > LIMITS.pageSize) throw new Problem('source_schema', 'Halaman sumber tidak berupa daftar berukuran paling banyak 100.', 502);
    return value;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) { try { await reader.cancel(); } catch { /* Only this response reader is cancelled. */ } }
    reader.releaseLock();
  }
}

export async function wordpressSource({ config, signal, onProgress, clock, fetcher = fetch }) {
  const budget = { bytes: 0 }; const cutoff = getLookbackStart(new Date(clock()), config.lookbackMonths).toISOString();
  async function page(kind, number, extra = {}) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Problem('source_timeout', 'Permintaan sumber melewati batas 20 detik. Data terakhir dipertahankan.', 504)), LIMITS.sourceRequestMs);
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const url = new URL(kind, API);
      url.search = new URLSearchParams({ per_page: String(LIMITS.pageSize), page: String(number), ...extra }).toString();
      const response = await fetcher(url, { signal: requestSignal, redirect: 'error', headers: { accept: 'application/json' } });
      try {
        const totalPages = pagesHeader(response.headers.get('x-wp-totalpages'));
        const rows = await responseJSON(response, requestSignal, budget);
        if ((totalPages === 0 && rows.length !== 0) || (totalPages > 0 && (!rows.length || number > totalPages))) throw new Problem('source_pages', 'Isi halaman sumber tidak sesuai jumlah halamannya.', 502);
        return { rows, totalPages };
      } catch (error) { try { await response.body?.cancel(); } catch { /* An owned reader may already have released the body. */ } throw error; }
    } finally { clearTimeout(timeout); }
  }
  async function terms(kind) {
    const first = await page(kind, 1, { _fields: 'id,name,slug,count' });
    if (first.totalPages > Math.ceil(LIMITS.termsPerKind / LIMITS.pageSize)) throw new Problem('source_capacity', 'Daftar kategori atau lokasi melampaui batas 2000 istilah.', 502);
    const all = [...first.rows];
    for (let number = 2; number <= first.totalPages; number++) {
      const next = await page(kind, number, { _fields: 'id,name,slug,count' });
      if (next.totalPages !== first.totalPages) throw new Problem('source_changed', 'Jumlah halaman istilah berubah saat dibaca. Coba lagi.', 502);
      all.push(...next.rows);
    }
    return toMap(all);
  }
  onProgress({ phase: 'taxonomy', completedPages: 0, totalPages: 0 });
  const categories = await terms('categories'); const locations = await terms('tags');
  const fields = { _fields: 'id,date,modified,link,slug,title,excerpt,content,categories,tags', orderby: 'modified', order: 'desc', modified_after: cutoff };
  const first = await page('posts', 1, fields); const pagesRead = Math.min(config.maxPages, first.totalPages);
  const all = [...first.rows];
  onProgress({ phase: 'reading', completedPages: first.totalPages ? 1 : 0, totalPages: pagesRead });
  for (let number = 2; number <= pagesRead; number++) {
    const next = await page('posts', number, fields);
    if (next.totalPages !== first.totalPages) throw new Problem('source_changed', 'Jumlah halaman post berubah saat dibaca. Coba lagi.', 502);
    all.push(...next.rows); onProgress({ phase: 'reading', completedPages: number, totalPages: pagesRead });
  }
  if (all.length > LIMITS.jobs || new Set(all.map((job) => job?.id)).size !== all.length) throw new Problem('source_schema', 'Identitas post berulang atau jumlah hasil melampaui batas.', 502);
  signal.throwIfAborted();
  const jobs = all.map((post) => normalizeJob(post, categories, locations)).filter((job) => job.modifiedAt >= cutoff);
  return { jobs, cutoff, coverage: { pagesRead, totalPages: first.totalPages, truncated: pagesRead < first.totalPages } };
}
