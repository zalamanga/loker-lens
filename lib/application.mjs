import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.mjs';
import { Problem, publicFailure } from './errors.mjs';
import { isUUID, record } from '../public/model.mjs';
import { snapshotDecoder } from './snapshot.mjs';
import { demoSource } from './demo.mjs';
import { wordpressSource } from './source.mjs';

const HASH = /^[a-f0-9]{64}$/;
const running = (operation) => operation && ['queued', 'taxonomy', 'reading', 'persisting'].includes(operation.phase);

export function createApplication({ config, store, clock = Date.now, source = config.mode === 'demo' ? demoSource : wordpressSource, uuid = randomUUID }) {
  const instanceId = uuid(); const decode = snapshotDecoder(config.mode);
  const operations = new Map(); let current = null; let controller = null; let task = null; let recoveryTask = null; let revision = 0; let closed = false;
  let confirmed = store.data;
  function time() { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Problem('clock', 'Waktu aplikasi tidak valid.', 503); return value; }
  function operationDTO(operation) {
    if (!operation) return null;
    const { intent: omittedIntent, ...safe } = operation;
    return structuredClone(safe);
  }
  function cacheDTO() {
    const status = store.status; const savedAt = confirmed?.savedAt ?? null;
    return { ...status, savedAt, stale: savedAt !== null && time() - Date.parse(savedAt) > LIMITS.cacheFreshMs };
  }
  function status(operationId = null) {
    const selected = operationId === null ? current : operations.get(operationId);
    if (operationId !== null && !selected) throw new Problem('operation_unknown', 'Operasi tidak dikenal oleh proses ini. Periksa status dan data sebelum memulai ulang.', 404);
    return { instanceId, mode: config.mode, revision, generation: confirmed?.generation ?? null, cache: cacheDTO(), operation: operationDTO(selected) };
  }
  function snapshot() { return { ...status(), snapshot: structuredClone(confirmed) }; }
  function update(operation, values) { Object.assign(operation, values); revision++; }

  async function execute(operation, ownedController) {
    const timer = setTimeout(() => ownedController.abort(new Problem('sync_timeout', 'Sinkronisasi melewati batas 60 detik. Data terakhir dipertahankan.', 504)), LIMITS.syncMs);
    try {
      const staged = await source({ config, clock, signal: ownedController.signal, onProgress(progress) {
        if (current !== operation || ownedController.signal.aborted || !running(operation)) return;
        update(operation, { phase: progress.phase, progress: { completedPages: progress.completedPages, totalPages: progress.totalPages } });
      } });
      ownedController.signal.throwIfAborted();
      const candidate = decode(Buffer.from(JSON.stringify({
        application: 'loker-lens', version: 1, mode: config.mode, generation: operation.id,
        savedAt: new Date(time()).toISOString(), cutoff: staged.cutoff, lookbackMonths: config.lookbackMonths,
        coverage: staged.coverage, jobs: staged.jobs,
      })));
      ownedController.signal.throwIfAborted();
      update(operation, { phase: 'persisting' });
      clearTimeout(timer);
      const saved = await store.replace(candidate, { replaceDamagedDigest: operation.intent.replaceDamagedDigest });
      confirmed = candidate;
      update(operation, { phase: 'saved', finishedAt: time(), warnings: saved.warnings ?? [] });
    } catch (error) {
      if (store.status.pending) update(operation, { phase: 'unknown', finishedAt: time(), error: { code: 'cache_unknown', message: 'Hasil simpan belum pasti. Periksa cache sebelum memulai operasi lain.' } });
      else if (ownedController.signal.aborted && operation.cancelRequested) update(operation, { phase: 'cancelled', finishedAt: time() });
      else {
        const failure = publicFailure(ownedController.signal.aborted ? ownedController.signal.reason : error);
        update(operation, { phase: 'failed', finishedAt: time(), error: { code: failure.body.code, message: failure.body.error } });
      }
    } finally { clearTimeout(timer); if (controller === ownedController) controller = null; }
  }

  function start(input) {
    try { record(input, ['operationId', 'expectedGeneration', 'replaceDamagedDigest']); }
    catch { throw new Problem('request_schema', 'Permintaan sinkronisasi tidak valid.'); }
    if (!isUUID(input.operationId) || (input.expectedGeneration !== null && !isUUID(input.expectedGeneration))
        || (input.replaceDamagedDigest !== null && (typeof input.replaceDamagedDigest !== 'string' || !HASH.test(input.replaceDamagedDigest)))) throw new Problem('request_schema', 'Identitas atau konfirmasi cache tidak valid.');
    const intent = { expectedGeneration: input.expectedGeneration, replaceDamagedDigest: input.replaceDamagedDigest };
    const previous = operations.get(input.operationId);
    if (previous) {
      if (JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw new Problem('operation_conflict', 'Identitas operasi sudah digunakan untuk permintaan berbeda.', 409);
      return { ...status(previous.id), joined: false, replay: true };
    }
    if (closed) throw new Problem('closing', 'Aplikasi sedang ditutup.', 503);
    if (recoveryTask) throw new Problem('cache_busy', 'Pemeriksaan hasil simpan masih berjalan.', 409);
    if (running(current)) return { ...status(), joined: true, replay: false };
    if (store.status.pending) throw new Problem('cache_unknown', 'Periksa hasil simpan sebelumnya sebelum memulai sinkronisasi.', 409);
    if ((confirmed?.generation ?? null) !== input.expectedGeneration) throw new Problem('generation_conflict', 'Data sudah berubah. Muat hasil terakhir sebelum memulai sinkronisasi.', 409);
    if (store.status.phase === 'damaged' && (!store.status.hash || input.replaceDamagedDigest !== store.status.hash)) throw new Problem('cache_review', 'Cache rusak dipertahankan. Tinjau konfirmasi penggantian sebelum memulai.', 409);
    if (store.status.phase !== 'damaged' && input.replaceDamagedDigest !== null) throw new Problem('cache_review', 'Konfirmasi penggantian tidak sesuai keadaan cache.', 409);
    if (operations.size >= 1000) throw new Problem('operation_capacity', 'Batas 1000 operasi proses tercapai. Tutup aplikasi dengan tertib lalu jalankan kembali.', 409);
    const operation = { id: input.operationId, intent, phase: 'queued', startedAt: time(), finishedAt: null, progress: { completedPages: 0, totalPages: 0 }, error: null, warnings: [], cancelRequested: false };
    operations.set(operation.id, operation); current = operation; revision++;
    controller = new AbortController();
    const ownedController = controller;
    task = Promise.resolve().then(() => execute(operation, ownedController));
    return { ...status(), joined: false, replay: false };
  }

  function cancel(operationId) {
    if (!isUUID(operationId)) throw new Problem('request_schema', 'Identitas operasi tidak valid.');
    const operation = operations.get(operationId);
    if (!operation) throw new Problem('operation_unknown', 'Operasi tidak dikenal oleh proses ini.', 404);
    if (operation !== current || !running(operation)) return status(operationId);
    if (operation.phase === 'persisting') throw new Problem('saving', 'Penyimpanan sudah dimulai. Periksa hasil akhirnya sebelum tindakan berikutnya.', 409);
    update(operation, { cancelRequested: true });
    controller.abort(new Problem('cancelled', 'Sinkronisasi dibatalkan.', 409));
    return status(operationId);
  }
  async function reconcile(operationId) {
    if (closed || recoveryTask || !isUUID(operationId) || current?.id !== operationId || current.phase !== 'unknown') throw new Problem('operation_conflict', 'Tidak ada hasil simpan tertunda yang dapat diperiksa untuk operasi ini.', 409);
    const operation = current;
    recoveryTask = Promise.resolve().then(async () => {
      const result = await store.reconcile();
      if (result.saved) confirmed = store.data;
      update(operation, { phase: result.saved ? 'saved' : 'failed', finishedAt: time(), error: result.saved ? null : { code: 'not_saved', message: 'Cache lama terkonfirmasi. Hasil operasi ini tidak tersimpan.' } });
      return status(operationId);
    });
    try { return await recoveryTask; } finally { recoveryTask = null; }
  }
  async function close() {
    closed = true;
    if (controller && current?.phase !== 'persisting') { current.cancelRequested = true; controller.abort(new Problem('closing', 'Aplikasi ditutup.', 503)); }
    await task;
    try { await recoveryTask; } catch { /* Closing preserves uncertain bytes; it never retries a replacement. */ }
    return store.close();
  }
  return { status, snapshot, start, cancel, reconcile, close, async waitForIdle() { await task; } };
}
