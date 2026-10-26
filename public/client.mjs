import { validateStatus, record, text } from './model.mjs';

export class RequestFailure extends Error {
  constructor(message, status = 0, code = 'network') { super(message); this.status = status; this.code = code; }
}
export async function requestJSON(url, options = {}, { fetcher = fetch, signal: parentSignal, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController(); const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs); let reader; let response; let done = false;
  const abortReader = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', abortReader, { once: true });
  try {
    response = await fetcher(url, { ...options, signal, redirect: 'error', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new RequestFailure('Respons aplikasi tidak berupa JSON yang dapat diperiksa.');
    const maximum = url === '/api/state' ? 17 * 1024 * 1024 : 64 * 1024;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new RequestFailure('Respons aplikasi melampaui batas.');
    reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > maximum) throw new RequestFailure('Respons aplikasi melampaui batas.');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RequestFailure('JSON aplikasi tidak valid. Hasil terakhir dipertahankan.'); }
    if (!response.ok) {
      try { record(value, ['error', 'code']); text(value.error, 1000, 1); text(value.code, 100, 1); }
      catch { throw new RequestFailure('Permintaan belum berhasil; respons kesalahan tidak dapat diperiksa.', response.status); }
      throw new RequestFailure(value.error, response.status, value.code);
    }
    return value;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abortReader);
    if (reader) { if (!done) { try { await reader.cancel(); } catch { /* Release only this request body. */ } } reader.releaseLock(); }
    else { try { await response?.body?.cancel(); } catch { /* The response was rejected before opening a reader. */ } }
  }
}

export class DashboardClient {
  #request; #change; #uuid; #readTicket = 0; #statusTicket = 0; #epoch = 0; #closed = false;
  #controllers = new Set(); #checking = null;
  status = null; data = null; error = ''; busy = false; pendingStart = null; checkedMissing = false;
  constructor({ request = requestJSON, change = () => {}, uuid = () => crypto.randomUUID() } = {}) { this.#request = request; this.#change = change; this.#uuid = uuid; }
  #emit() { this.#change(this); }
  async #call(url, options) {
    const controller = new AbortController(); this.#controllers.add(controller);
    try { return await this.#request(url, options, { signal: controller.signal }); }
    finally { this.#controllers.delete(controller); }
  }
  #accept(value, withSnapshot = false) {
    validateStatus(value, withSnapshot);
    if (this.status?.instanceId === value.instanceId && this.status.revision > value.revision) return false;
    this.status = structuredClone(withSnapshot ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'snapshot')) : value);
    if (withSnapshot) this.data = structuredClone(value.snapshot);
    if (this.pendingStart && value.operation?.id === this.pendingStart.operationId) this.pendingStart = null;
    return true;
  }
  async refresh() {
    const ticket = ++this.#readTicket; const epoch = this.#epoch;
    const instance = this.status?.instanceId ?? null;
    try {
      const value = await this.#call('/api/state');
      if (this.#closed || ticket !== this.#readTicket || epoch !== this.#epoch) return false;
      if ((this.status?.instanceId ?? null) !== instance && this.status?.instanceId !== value.instanceId) return false;
      if (this.#accept(value, true)) this.error = '';
      return true;
    } catch (error) { if (!this.#closed && ticket === this.#readTicket && epoch === this.#epoch) this.error = error.message || 'Data belum dapat diperiksa.'; return false; }
    finally { if (!this.#closed && ticket === this.#readTicket && epoch === this.#epoch) this.#emit(); }
  }
  check() {
    if (this.#checking) return this.#checking;
    const ticket = ++this.#statusTicket; const epoch = this.#epoch;
    const instance = this.status?.instanceId ?? null;
    this.#checking = (async () => {
      try {
        const path = this.pendingStart ? `/api/status?operationId=${encodeURIComponent(this.pendingStart.operationId)}` : '/api/status';
        const value = await this.#call(path);
        if (this.#closed || ticket !== this.#statusTicket || epoch !== this.#epoch) return false;
        if ((this.status?.instanceId ?? null) !== instance && this.status?.instanceId !== value.instanceId) return false;
        if (this.#accept(value)) this.error = '';
        if ((this.data?.generation ?? null) !== value.generation || value.operation?.phase === 'saved') return await this.refresh();
        return true;
      } catch (error) {
        if (!this.#closed && ticket === this.#statusTicket && epoch === this.#epoch && this.pendingStart && error.status === 404) this.checkedMissing = true;
        if (!this.#closed && ticket === this.#statusTicket && epoch === this.#epoch) this.error = this.pendingStart && error.status === 404
          ? 'Operasi belum ditemukan. Hasil kirim masih belum pasti; periksa lagi atau ulangi permintaan yang sama.' : error.message || 'Status belum dapat diperiksa.';
        return false;
      } finally { this.#checking = null; if (!this.#closed && epoch === this.#epoch) this.#emit(); }
    })();
    return this.#checking;
  }
  async #mutate(path, body, isStart = false) {
    if (this.#closed || this.busy) return false;
    const epoch = ++this.#epoch; ++this.#readTicket; ++this.#statusTicket;
    this.busy = true; this.error = ''; this.#emit();
    try {
      const received = await this.#call(path, { method: 'POST', body: JSON.stringify(body) });
      if (this.#closed || epoch !== this.#epoch) return false;
      let value = received;
      if (isStart) {
        const { joined, replay, ...status } = received;
        if (typeof joined !== 'boolean' || typeof replay !== 'boolean') throw new TypeError('Balasan awal operasi tidak valid.');
        value = status;
      }
      this.#accept(value);
      if (isStart) this.pendingStart = null;
      return true;
    } catch (error) {
      if (!this.#closed && epoch === this.#epoch) {
        if (isStart && error instanceof RequestFailure && error.status >= 400 && error.status < 500) this.pendingStart = null;
        this.error = `${error.message || 'Balasan belum dapat diperiksa.'}${isStart ? ' Periksa status sebelum tindakan berikutnya.' : ''}`;
      }
      return false;
    } finally { if (!this.#closed && epoch === this.#epoch) { this.busy = false; this.#emit(); } }
  }
  start(replaceDamagedDigest = null) {
    if (!this.status || this.pendingStart || this.status.cache.pending || this.busy) return Promise.resolve(false);
    const input = { operationId: this.#uuid(), expectedGeneration: this.status.generation, replaceDamagedDigest };
    this.pendingStart = structuredClone(input);
    this.checkedMissing = false;
    return this.#mutate('/api/sync', input, true);
  }
  retryStart() { return this.pendingStart && this.checkedMissing ? this.#mutate('/api/sync', structuredClone(this.pendingStart), true) : Promise.resolve(false); }
  cancel() {
    const id = this.status?.operation?.id;
    return id ? this.#mutate('/api/cancel', { operationId: id }) : Promise.resolve(false);
  }
  async reconcile() {
    const id = this.status?.operation?.id;
    if (!id) return false;
    const accepted = await this.#mutate('/api/reconcile', { operationId: id });
    if (accepted) await this.refresh();
    return accepted;
  }
  dispose() {
    this.#closed = true; this.#epoch++; this.#readTicket++; this.#statusTicket++;
    for (const controller of this.#controllers) controller.abort(); this.#controllers.clear();
  }
}
