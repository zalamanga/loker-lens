import { Problem } from './errors.mjs';
import { record } from '../public/model.mjs';

const JOB_KEYS = ['provider', 'jobId', 'title', 'company', 'location', 'url', 'applyUrl', 'salary', 'description', 'listedAt'];
const MAX_RESPONSE = 4 * 1024 * 1024;

function shortText(value, name, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Problem('search_input', `${name} tidak valid.`, 422);
  const text = value.trim().replace(/\s+/gu, ' ');
  if (required && !text) throw new Problem('search_input', `${name} wajib diisi.`, 422);
  return text;
}

export function jobstreetBase(raw) {
  if (raw === undefined || raw === '') return null;
  let url;
  try { url = new URL(raw); } catch { throw new Problem('configuration', 'JOBSTREET_API_URL harus berupa URL layanan lokal.', 503); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Problem('configuration', 'Gunakan JOBSTREET_API_URL seperti http://127.0.0.1:8131/.', 503);
  return url;
}

function optionalText(value, maximum) { return typeof value === 'string' ? value.trim().slice(0, maximum) : ''; }

export function normalizeJobstreet(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Problem('provider_schema', 'Record JobStreet tidak valid.', 502);
  const jobId = typeof card.id === 'number' ? String(card.id) : card.id;
  if (typeof jobId !== 'string' || !/^[1-9]\d{0,15}$/u.test(jobId) || !optionalText(card.title, 300)) throw new Problem('provider_schema', 'Identitas atau judul JobStreet tidak valid.', 502);
  const url = `https://id.jobstreet.com/job/${jobId}`;
  if (card.link) {
    let source;
    try { source = new URL(card.link); } catch { throw new Problem('provider_schema', 'Tautan JobStreet tidak valid.', 502); }
    if (source.protocol !== 'https:' || source.hostname !== 'id.jobstreet.com' || source.username || source.password || !new RegExp(`^/job/${jobId}(?:/|$)`, 'u').test(source.pathname)) throw new Problem('provider_country', 'Sumber mengembalikan tautan di luar JobStreet Indonesia.', 502);
  }
  if (card.locations !== undefined && !Array.isArray(card.locations)) throw new Problem('provider_schema', 'Lokasi JobStreet tidak valid.', 502);
  const locations = card.locations ?? [];
  if (locations.some(item => item?.country_code && item.country_code !== 'ID')) throw new Problem('provider_country', 'Sumber mengembalikan negara selain Indonesia.', 502);
  const salary = typeof card.salary === 'string' ? card.salary : card.salary?.label;
  const bullets = Array.isArray(card.bullet_points) ? card.bullet_points.filter(item => typeof item === 'string').slice(0, 5) : [];
  const listed = typeof card.listed_at === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(card.listed_at) && Number.isFinite(Date.parse(card.listed_at)) ? new Date(card.listed_at).toISOString() : null;
  return {
    provider: 'jobstreet', jobId, title: optionalText(card.title, 300),
    company: optionalText(card.company?.name || card.advertiser?.name, 200) || 'Perusahaan tidak dicantumkan',
    location: locations.map(item => optionalText(item?.label, 150)).filter(Boolean).join('; ').slice(0, 300) || 'Lokasi tidak dicantumkan',
    url, applyUrl: url, salary: optionalText(salary, 300) || null,
    description: [optionalText(card.teaser, 3500), ...bullets].filter(Boolean).join('\n').slice(0, 4000), listedAt: listed,
  };
}

async function readJSON(response) {
  async function reject(code, message) { try { await response.body?.cancel(); } catch {} throw new Problem(code, message, 502); }
  if (!/^application\/(?:[\w.+-]+\+)?json(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) return reject('provider_response', 'Layanan JobStreet tidak mengembalikan JSON.');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE)) return reject('provider_capacity', 'Respons JobStreet melebihi batas 4 MiB.');
  if (!response.body) throw new Problem('provider_response', 'Respons JobStreet kosong.', 502);
  const reader = response.body.getReader(); const chunks = []; let size = 0; let complete = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) throw new Problem('provider_capacity', 'Respons JobStreet melebihi batas 4 MiB.', 502);
      chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { throw new Problem('provider_response', 'JSON JobStreet tidak valid.', 502); }
  } finally { if (!complete) { try { await reader.cancel(); } catch {} } reader.releaseLock(); }
}

export function createBoard({ queue, apiURL, fetcher = fetch, clock = () => new Date().toISOString(), timeoutMs = 65_000 }) {
  const base = jobstreetBase(apiURL);
  const known = new Map(); const cache = new Map();
  let busy = false; let closed = false; let activeController;
  let searchSettings = { provider: 'jobstreet', query: '', location: '' };
  const providers = [
    { id: 'jobstreet', label: 'JobStreet Indonesia', available: Boolean(base), note: base ? 'API lokal dikonfigurasi. Koneksi dan hasil diperiksa saat pencarian; data bukan API resmi JobStreet.' : 'Jalankan scripts/Start-JobStreet.ps1, lalu scripts/Start.ps1. Konektor memakai API lokal dari repo yang telah diperiksa.' },
    { id: 'glints', label: 'Glints', available: false, note: 'Akses API Glints mendapat HTTP 403 pada pemeriksaan 1 November 2026. Konektor live belum tersedia; tidak ada data contoh yang ditampilkan sebagai loker nyata.' },
  ];
  function status() { return { ...queue.status(), providers, searchSettings }; }
  async function search(body, signal) {
    if (closed) throw new Problem('board_closed', 'Layanan sedang ditutup.', 503);
    try { record(body, ['provider', 'query', 'location', 'page']); } catch { throw new Problem('search_input', 'Gunakan provider, query, location dan page.', 422); }
    if (!['jobstreet', 'glints'].includes(body.provider)) throw new Problem('provider', 'Sumber tidak dikenal.', 422);
    const query = shortText(body.query, 'Kata kunci', 120, true);
    const location = shortText(body.location, 'Lokasi', 100);
    if (!Number.isInteger(body.page) || body.page < 1 || body.page > 5) throw new Problem('search_page', 'Halaman harus 1 sampai 5.', 422);
    if (body.provider === 'glints') throw new Problem('provider_blocked', providers[1].note, 503);
    if (!base) throw new Problem('provider_setup', providers[0].note, 503);
    const key = JSON.stringify([query, location, body.page]);
    const cached = cache.get(key);
    if (cached && Date.parse(clock()) - Date.parse(cached.fetchedAt) >= 0 && Date.parse(clock()) - Date.parse(cached.fetchedAt) < 60_000) { searchSettings = { provider: body.provider, query, location }; return structuredClone(cached); }
    if (busy) throw new Problem('provider_busy', 'Pencarian lain masih berjalan. Tunggu hasilnya atau batalkan.', 409);
    busy = true; const controller = new AbortController(); activeController = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const url = new URL('jobs/search', base);
      url.search = new URLSearchParams({ country: 'ID', language: 'id', query, location, page: String(body.page), page_size: '20', sort: 'date' });
      const response = await fetcher(url, { signal: combined, redirect: 'error', headers: { accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Problem('provider_http', `Layanan JobStreet mengembalikan HTTP ${response.status}. Hasil sebelumnya dipertahankan; periksa terminal layanan.`, 502);
      }
      const data = await readJSON(response); combined.throwIfAborted();
      if (!data || !Array.isArray(data.jobs) || data.jobs.length > 100 || !Number.isInteger(data.current_page) || data.current_page !== body.page || !Number.isInteger(data.total_pages) || data.total_pages < 0) throw new Problem('provider_schema', 'Skema atau halaman hasil JobStreet berubah.', 502);
      const unique = new Map();
      for (const card of data.jobs) { const job = normalizeJobstreet(card); if (!unique.has(job.jobId)) unique.set(job.jobId, job); }
      const jobs = [...unique.values()].slice(0, 20);
      for (const job of jobs) { const id = `${job.provider}:${job.jobId}`; known.delete(id); known.set(id, job); }
      while (known.size > 500) known.delete(known.keys().next().value);
      const result = { provider: 'jobstreet', query, location, page: body.page, jobs, hasMore: body.page < data.total_pages && body.page < 5, fetchedAt: clock(), sourceNote: 'Data pencarian JobStreet Indonesia melalui API scraper lokal. Ringkasan bukan deskripsi lengkap; periksa status dan persyaratan pada sumber. Hasil identik dicache selama 60 detik.' };
      cache.delete(key); cache.set(key, result); while (cache.size > 20) cache.delete(cache.keys().next().value);
      searchSettings = { provider: body.provider, query, location }; return structuredClone(result);
    } catch (error) {
      if (error instanceof Problem) throw error;
      if (combined.aborted) throw new Problem('provider_cancelled', 'Pencarian dibatalkan atau melewati batas waktu. Tidak ada lamaran yang dikirim.', 504);
      throw new Problem('provider_unreachable', 'API JobStreet lokal tidak terhubung. Jalankan scripts/Start-JobStreet.ps1 lalu coba lagi.', 502);
    } finally { clearTimeout(timer); busy = false; if (activeController === controller) activeController = undefined; }
  }
  return {
    status, search,
    add(body) {
      try { record(body, JOB_KEYS); } catch { throw new Problem('queue_job', 'Data lowongan tidak lengkap.', 422); }
      const job = known.get(`${body.provider}:${body.jobId}`);
      if (!job || JOB_KEYS.some(key => body[key] !== job[key])) throw new Problem('queue_job', 'Pilih hasil pencarian yang masih dikenali server. Ulangi pencarian setelah server dimulai ulang.', 422);
      queue.add(job); return status();
    },
    markApplied(body) { try { record(body, ['id']); } catch { throw new Problem('queue_job', 'Identitas antrean tidak valid.', 422); } queue.markApplied(body.id); return status(); },
    remove(body) { try { record(body, ['id']); } catch { throw new Problem('queue_job', 'Identitas antrean tidak valid.', 422); } queue.remove(body.id); return status(); },
    close() { if (closed) return; closed = true; activeController?.abort(); queue.close(); },
  };
}
