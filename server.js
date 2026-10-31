import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfiguration } from './lib/config.mjs';
import { SafeCache } from './lib/cache.mjs';
import { snapshotDecoder } from './lib/snapshot.mjs';
import { createApplication } from './lib/application.mjs';
import { createBoard } from './lib/board.mjs';
import { ApplicationQueue } from './lib/board-store.mjs';
import { Problem, publicFailure } from './lib/errors.mjs';
import { isUUID, record } from './public/model.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
  ['/client.mjs', ['client.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/pencarian', ['board.html', 'text/html; charset=utf-8']],
  ['/board.js', ['board.js', 'text/javascript; charset=utf-8']],
  ['/board.css', ['board.css', 'text/css; charset=utf-8']],
]);
const HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function send(response, status, value, contentType = 'application/json; charset=utf-8') {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(contentType.startsWith('application/json') ? JSON.stringify(value) : value);
  response.writeHead(status, { ...HEADERS, 'content-type': contentType, 'content-length': bytes.length }); response.end(bytes);
}
function perimeter(request) {
  const authority = request.headers.host; const port = request.socket.localPort;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(authority)) throw new Problem('host', 'Alamat Host tidak diizinkan.', 403);
  if (request.method === 'POST') {
    if (request.headers.origin !== `http://${authority}` || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin')) throw new Problem('origin', 'Permintaan perubahan harus berasal dari aplikasi lokal ini.', 403);
  }
  if (request.method === 'GET' && (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))) throw new Problem('body', 'Permintaan baca tidak menerima isi.', 400);
}
async function jsonBody(request, maximum = 2048) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new Problem('content_type', 'Gunakan isi JSON UTF-8.', 415);
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Problem('body_capacity', `Isi permintaan melebihi ${maximum} byte.`, 413);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw new Problem('body_capacity', `Isi permintaan melebihi ${maximum} byte.`, 413); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new Problem('json', 'Isi JSON tidak valid.', 400); }
}
function operationBody(body) {
  try { record(body, ['operationId']); } catch { throw new Problem('request_schema', 'Permintaan operasi tidak valid.'); }
  if (!isUUID(body.operationId)) throw new Problem('request_schema', 'Identitas operasi tidak valid.');
  return body.operationId;
}
function escape(value) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

export function createServer({ application, board = null, publicDirectory = path.join(ROOT, 'public') }) {
  if (!application || !path.isAbsolute(publicDirectory)) throw new TypeError('Application and absolute public directory required.');
  const server = http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5000, maxHeaderSize: 8192 }, async (request, response) => {
    try {
      perimeter(request);
      if (!['GET', 'POST'].includes(request.method)) { response.setHeader('allow', 'GET, POST'); throw new Problem('method', 'Metode tidak diizinkan.', 405); }
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) throw new Problem('path', 'Alamat permintaan tidak valid.', 400);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/api/status' && url.search) throw new Problem('query', 'Rute ini tidak menerima parameter.', 400);
      if (url.pathname.startsWith('/api/board/')) {
        if (!board) throw new Problem('board_unavailable', 'Pencarian lintas sumber belum aktif pada server ini.', 503);
        if (request.method === 'GET' && url.pathname === '/api/board/status') return send(response, 200, board.status());
        const routes = ['/api/board/search', '/api/board/queue', '/api/board/mark-applied', '/api/board/remove'];
        if (request.method !== 'POST' || !routes.includes(url.pathname)) throw new Problem('route', 'Rute tidak ditemukan.', 404);
        const body = await jsonBody(request, url.pathname === '/api/board/queue' ? 16384 : 2048);
        if (url.pathname === '/api/board/search') {
          const controller = new AbortController();
          const disconnected = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', disconnected);
          try { const result = await board.search(body, controller.signal); if (!response.destroyed) return send(response, 200, result); return; }
          finally { response.removeListener('close', disconnected); }
        }
        const result = url.pathname === '/api/board/queue' ? board.add(body) : url.pathname === '/api/board/mark-applied' ? board.markApplied(body) : board.remove(body);
        return send(response, 200, result);
      }
      if (request.method === 'GET') {
        if (STATIC.has(url.pathname)) {
          const [name, type] = STATIC.get(url.pathname);
          return send(response, 200, await readFile(path.join(publicDirectory, name)), type);
        }
        if (url.pathname === '/api/health') return send(response, 200, { ok: true, application: 'loker-lens', mode: application.status().mode });
        if (url.pathname === '/api/state') return send(response, 200, application.snapshot());
        if (url.pathname === '/api/status') {
          const ids = url.searchParams.getAll('operationId');
          if ([...url.searchParams.keys()].some((key) => key !== 'operationId') || ids.length > 1 || (ids.length === 1 && !isUUID(ids[0]))) throw new Problem('query', 'Parameter status tidak valid.', 400);
          return send(response, 200, application.status(ids[0] ?? null));
        }
        if (/^\/demo\/source\/[1-9]\d{0,15}$/.test(url.pathname) && application.status().mode === 'demo') {
          const job = application.snapshot().snapshot?.jobs.find((item) => item.url === url.pathname);
          if (job) return send(response, 200, `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(job.title)} · Contoh sintetis</title><link rel="stylesheet" href="/styles.css"><main class="source-preview"><a href="/">← Kembali ke Loker Lens</a><p class="eyebrow">Sumber demo · data sintetis</p><h1>${escape(job.title)}</h1><p>Ini contoh rekaan untuk pengujian. Tidak ada lowongan, organisasi, atau lampiran nyata pada halaman ini.</p><p>${escape(job.summary)}</p><h2>Teks yang disimpan</h2><p>${escape(job.content.text)}</p><p>Lampiran tidak diunduh. Mode demo tidak menghubungi penyedia lowongan.</p></main></html>`, 'text/html; charset=utf-8');
        }
      } else {
        if (!['/api/sync', '/api/cancel', '/api/reconcile'].includes(url.pathname)) throw new Problem('route', 'Rute tidak ditemukan.', 404);
        const body = await jsonBody(request);
        if (url.pathname === '/api/sync') return send(response, 202, application.start(body));
        if (url.pathname === '/api/cancel') return send(response, 200, application.cancel(operationBody(body)));
        return send(response, 200, await application.reconcile(operationBody(body)));
      }
      throw new Problem('route', 'Rute tidak ditemukan.', 404);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const failure = publicFailure(error); response.setHeader('connection', 'close'); send(response, failure.status, failure.body);
    }
  });
  server.maxConnections = 32;
  return server;
}

export async function main() {
  const config = readConfiguration(ROOT);
  const store = await SafeCache.open(config.dataRoot, snapshotDecoder(config.mode));
  const application = createApplication({ config, store });
  let board;
  let queue;
  try {
    queue = new ApplicationQueue({ filename: path.join(ROOT, '.data', 'board', 'applications.sqlite') });
    board = createBoard({ queue, apiURL: process.env.JOBSTREET_API_URL });
  }
  catch (error) { queue?.close(); await application.close(); throw error; }
  const server = createServer({ application, board });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); }); }
  catch (error) { board.close(); await application.close(); throw error; }
  console.log(`Loker Lens · ${config.mode === 'demo' ? 'contoh sintetis' : 'sumber publik, akses manual'} · http://127.0.0.1:${config.port}`);
  console.log(`Pencarian API dan antrean: http://127.0.0.1:${config.port}/pencarian`);
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    board.close();
    server.close(); server.closeIdleConnections();
    try { const result = await application.close(); for (const warning of result.warnings) console.error(warning); }
    catch { console.error('Penutupan cache belum dapat dipastikan; jangan hapus penanda pemilik tanpa pemeriksaan.'); process.exitCode = 1; }
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return { server, application, close };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(publicFailure(error).body.error); process.exitCode = 1; });
}
