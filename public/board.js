const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'searchForm', 'providerInput', 'queryInput', 'locationInput', 'searchButton',
  'cancelSearch', 'providerNote', 'searchError', 'resultCount', 'searchMessage',
  'sourceNote', 'searchResults', 'resultPagination', 'previousPage', 'nextPage',
  'pageLabel', 'refreshStatus', 'quotaDay', 'quotaValue', 'quotaNote',
  'statusMessage', 'queueError', 'pendingQueue', 'applicationHistory',
  'historySummary', 'historyList', 'appliedDialog', 'appliedForm', 'appliedJob',
  'appliedConfirm', 'closeAppliedDialog', 'confirmApplied',
].map((id) => [id, byId(id)]));

const state = {
  status: null,
  statusBusy: false,
  statusCertain: false,
  search: null,
  searchBusy: false,
  searchController: null,
  searchVersion: 0,
  mutationBusy: false,
  appliedId: null,
};
const providerNames = { jobstreet: 'JobStreet', glints: 'Glints' };
const dayFormatter = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium', timeZone: 'Asia/Jakarta',
});
const timeFormatter = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta',
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function showError(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}

function dayLabel(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return 'Tanggal belum tersedia';
  const date = new Date(`${day}T12:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? 'Tanggal belum tersedia' : dayFormatter.format(date);
}

function timestampLabel(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? timeFormatter.format(date) : null;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function sourceLink(value, label) {
  const href = safeLink(value);
  if (!href) return element('p', 'board-muted', 'Tautan sumber tidak tersedia.');
  const link = element('a', 'board-source-link', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${label}, buka tab baru`);
  return link;
}

async function request(path, { body, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, path === '/api/board/search' ? 75000 : 15000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Respons server tidak dapat dibaca. Periksa sambungan lalu coba lagi.'); }
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : 'Permintaan belum berhasil. Coba lagi.');
      error.code = typeof data?.code === 'string' ? data.code : '';
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (timedOut) throw new Error('Permintaan terlalu lama. Periksa sambungan lalu coba lagi.');
    if (error.name === 'TypeError') throw new Error('Server tidak terjangkau. Periksa sambungan lalu coba lagi.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function acceptStatus(data) {
  if (!data || !Array.isArray(data.providers) || !Array.isArray(data.queue) || !data.quota ||
      !Number.isInteger(data.quota.used) || !Number.isInteger(data.quota.remaining) || !Number.isInteger(data.quota.limit)) {
    throw new Error('Status antrean dari server tidak lengkap. Periksa antrean lagi.');
  }
  state.status = data;
  state.statusCertain = true;
}

function selectedProvider() {
  return state.status?.providers.find((provider) => provider.id === ui.providerInput.value);
}

function searchFields() {
  return {
    provider: ui.providerInput.value,
    query: ui.queryInput.value.trim(),
    location: ui.locationInput.value.trim(),
  };
}

function searchKey(fields) {
  return JSON.stringify([fields.provider, fields.query, fields.location]);
}

function renderControls() {
  const ready = Boolean(state.status);
  ui.providerInput.disabled = !ready;
  ui.queryInput.disabled = !ready;
  ui.locationInput.disabled = !ready;
  ui.searchButton.disabled = !ready || !selectedProvider()?.available || state.searchBusy;
  ui.cancelSearch.hidden = !state.searchBusy;
  ui.refreshStatus.disabled = state.statusBusy || state.mutationBusy;
  ui.refreshStatus.textContent = state.statusBusy ? 'Memeriksa…' : 'Periksa antrean';
  ui.searchResults.setAttribute('aria-busy', String(state.searchBusy));
  ui.pendingQueue.setAttribute('aria-busy', String(state.statusBusy || state.mutationBusy));
  if (ready) {
    for (const option of ui.providerInput.options) {
      const provider = state.status.providers.find((item) => item.id === option.value);
      option.textContent = `${providerNames[option.value]}${provider?.available ? '' : ' · belum tersedia'}`;
    }
    const provider = selectedProvider();
    ui.providerNote.textContent = `${provider?.available ? 'Konektor dikonfigurasi.' : 'Sumber belum tersedia.'} ${provider?.note || 'Periksa pengaturan sumber pada server.'}`;
  }
  renderSearchActions();
}

function queuedEntry(job) {
  return state.status?.queue.find((entry) => entry.provider === job.provider && entry.jobId === job.jobId);
}

function queueButton(job) {
  const existing = queuedEntry(job);
  const full = !state.status || state.status.quota.remaining <= 0;
  const label = existing ? (existing.status === 'applied' ? 'Sudah dilamar' : 'Dalam antrean') : (full ? 'Batas hari ini penuh' : 'Tambah ke antrean');
  const button = element('button', '', label);
  button.type = 'button';
  button.disabled = Boolean(existing) || full || !state.statusCertain || state.mutationBusy || state.statusBusy;
  button.addEventListener('click', () => mutate('/api/board/queue', job, 'Pilihan ditambahkan ke antrean.'));
  return button;
}

function renderSearchActions() {
  if (!state.search) return;
  for (const [index, job] of state.search.jobs.entries()) {
    const slot = ui.searchResults.querySelector(`[data-queue-slot="${index}"]`);
    slot?.replaceChildren(queueButton(job));
  }
  ui.previousPage.disabled = state.searchBusy || state.search.page <= 1;
  ui.nextPage.disabled = state.searchBusy || !state.search.hasMore || state.search.page >= 5;
}

function emptyResult(title, text) {
  const node = element('div', 'board-empty');
  node.append(element('h3', '', title), element('p', '', text));
  return node;
}

function renderSearch() {
  ui.searchResults.replaceChildren();
  ui.resultPagination.hidden = !state.search || (!state.search.jobs.length && state.search.page <= 1 && !state.search.hasMore);
  ui.resultCount.textContent = '';
  ui.sourceNote.hidden = !state.search?.sourceNote;
  ui.sourceNote.textContent = state.search?.sourceNote || '';
  if (!state.search) {
    ui.searchResults.append(state.searchBusy
      ? emptyResult('Mengambil lowongan dari sumber…', 'Menunggu respons sumber. Gunakan “Batalkan pencarian” untuk menghentikan permintaan ini.')
      : emptyResult('Belum ada pencarian.', 'Isi kata kunci untuk mengambil lowongan dari sumber yang dipilih.'));
    return;
  }
  const result = state.search;
  ui.resultCount.textContent = `${result.jobs.length} lowongan pada halaman ini`;
  ui.pageLabel.textContent = `Halaman ${result.page} dari maksimal 5`;
  if (!result.jobs.length) {
    ui.searchResults.append(emptyResult('Tidak ada hasil pada halaman ini.', 'Coba kata kunci atau lokasi lain. Ketersediaan lowongan mengikuti sumber.'));
  }
  result.jobs.forEach((job, index) => {
    const article = element('article', 'board-job');
    const body = element('div', 'board-job-body');
    body.append(element('h3', '', job.title || 'Judul tidak tersedia'), element('p', 'board-company', job.company || 'Perusahaan tidak dicantumkan'));
    const meta = element('div', 'board-job-meta');
    meta.append(element('span', '', providerNames[job.provider] || job.provider), element('span', '', job.location || 'Lokasi tidak dicantumkan'));
    const listed = timestampLabel(job.listedAt);
    if (listed) meta.append(element('span', '', `Tanggal sumber: ${listed} WIB`));
    body.append(meta);
    if (job.salary) body.append(element('p', 'board-salary', job.salary));
    const actions = element('div', 'board-job-actions');
    const slot = element('span');
    slot.dataset.queueSlot = String(index);
    slot.append(queueButton(job));
    actions.append(sourceLink(job.url, 'Baca di sumber'), slot);
    body.append(actions);
    article.append(body);
    const details = element('details', 'board-job-details');
    details.append(element('summary', '', 'Baca cuplikan deskripsi'), element('p', 'board-description', job.description || 'Deskripsi tidak disertakan sumber. Baca informasi lengkap pada tautan sumber.'));
    article.append(details);
    ui.searchResults.append(article);
  });
  renderSearchActions();
}

function resultContext(result) {
  const fetched = timestampLabel(result.fetchedAt);
  return `${providerNames[result.provider] || result.provider} · “${result.query}”${result.location ? ` · ${result.location}` : ''} · halaman ${result.page}${fetched ? ` · diambil ${fetched} WIB` : ''}`;
}

function clearSearch(message = 'Pilihan berubah. Jalankan pencarian untuk melihat hasilnya.') {
  state.searchVersion += 1;
  state.searchController?.abort();
  state.searchController = null;
  state.searchBusy = false;
  state.search = null;
  showError(ui.searchError);
  ui.searchMessage.textContent = message;
  renderSearch();
  renderControls();
}

async function search(page = 1) {
  const fields = searchFields();
  ui.queryInput.setCustomValidity(fields.query ? '' : 'Isi kata kunci pencarian.');
  if (!ui.searchForm.reportValidity()) return;
  if (!selectedProvider()?.available) {
    showError(ui.searchError, selectedProvider()?.note || 'Sumber ini belum tersedia. Pilih sumber lain.');
    return;
  }
  state.searchController?.abort();
  const controller = new AbortController();
  state.searchController = controller;
  const version = ++state.searchVersion;
  if (state.search && searchKey(state.search) !== searchKey(fields)) state.search = null;
  state.searchBusy = true;
  showError(ui.searchError);
  ui.searchMessage.textContent = `Mencari di ${providerNames[fields.provider]} untuk “${fields.query}”${fields.location ? `, ${fields.location}` : ''}, halaman ${page}…${state.search ? ' Hasil terakhir tetap ditampilkan selama menunggu.' : ''}`;
  renderSearch();
  renderControls();
  try {
    const data = await request('/api/board/search', { body: { ...fields, page }, signal: controller.signal });
    if (version !== state.searchVersion) return;
    if (!data || !Array.isArray(data.jobs) || data.provider !== fields.provider || data.query !== fields.query || data.location !== fields.location || data.page !== page) {
      throw new Error('Hasil sumber tidak sesuai pencarian. Jalankan pencarian lagi.');
    }
    state.search = data;
    ui.searchMessage.textContent = resultContext(data);
    renderSearch();
  } catch (error) {
    if (version !== state.searchVersion || controller.signal.aborted) return;
    showError(ui.searchError, error.message);
    ui.searchMessage.textContent = state.search ? `Permintaan gagal. Hasil terakhir: ${resultContext(state.search)}.` : 'Pencarian belum berhasil. Periksa catatan sumber, lalu coba lagi.';
    renderSearch();
  } finally {
    if (version === state.searchVersion) {
      state.searchBusy = false;
      state.searchController = null;
      renderControls();
    }
  }
}

function queueItem(entry, applied) {
  const item = element('li', 'board-queue-item');
  item.append(element('h4', '', entry.title), element('p', 'board-company', entry.company || 'Perusahaan tidak dicantumkan'));
  item.append(element('p', 'board-muted', `${providerNames[entry.provider] || entry.provider}${entry.location ? ` · ${entry.location}` : ''}`));
  item.append(element('p', 'board-item-status', applied ? `Sudah dilamar · ${dayLabel(entry.appliedDay)}` : `Antrean · ${dayLabel(entry.scheduledDay)}`));
  const actions = element('div', 'board-job-actions');
  actions.append(sourceLink(entry.applyUrl || entry.url, applied ? 'Buka sumber' : 'Buka sumber untuk melamar'));
  if (!applied) {
    const needsSlot = entry.scheduledDay !== state.status?.quota.day;
    const limitReached = needsSlot && state.status?.quota.remaining <= 0;
    const mark = element('button', '', limitReached ? 'Batas hari ini penuh' : 'Tandai sudah dilamar');
    mark.type = 'button';
    mark.disabled = limitReached || state.mutationBusy || state.statusBusy || !state.statusCertain;
    mark.addEventListener('click', () => openAppliedDialog(entry));
    const remove = element('button', 'board-remove', 'Hapus dari antrean');
    remove.type = 'button';
    remove.disabled = state.mutationBusy || state.statusBusy || !state.statusCertain;
    remove.addEventListener('click', () => mutate('/api/board/remove', { id: entry.id }, 'Pilihan dihapus dari antrean.'));
    actions.append(mark, remove);
  }
  item.append(actions);
  return item;
}

function queueGroups(entries, applied) {
  const fragment = document.createDocumentFragment();
  const groups = new Map();
  for (const entry of entries) {
    const day = (applied ? entry.appliedDay : entry.scheduledDay) || '';
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(entry);
  }
  const days = [...groups.keys()].sort((a, b) => applied ? b.localeCompare(a) : a.localeCompare(b));
  for (const day of days) {
    const group = element('section', 'board-queue-group');
    const label = !applied && day === state.status?.quota.day ? `Hari ini · ${dayLabel(day)}` : dayLabel(day);
    group.append(element('h3', '', label));
    const list = element('ul', 'board-queue-list');
    for (const entry of groups.get(day)) list.append(queueItem(entry, applied));
    group.append(list);
    fragment.append(group);
  }
  return fragment;
}

function renderQueue() {
  ui.pendingQueue.replaceChildren();
  ui.historyList.replaceChildren();
  if (!state.status) {
    ui.quotaValue.textContent = 'Batas belum terkonfirmasi';
    ui.quotaNote.textContent = 'Periksa antrean untuk memuat catatan dan batas hari ini.';
    ui.applicationHistory.hidden = true;
    return;
  }
  const { quota, queue } = state.status;
  ui.quotaDay.textContent = `${dayLabel(quota.day)} · WIB`;
  ui.quotaValue.textContent = `${quota.used} / ${quota.limit} pilihan hari ini`;
  ui.quotaNote.textContent = quota.remaining > 0 ? `Sisa ${quota.remaining} pilihan. Antrean dan catatan lamaran memakai batas yang sama.` : 'Batas hari ini penuh. Pilihan baru dapat ditambahkan saat tersedia ruang atau pada hari berikutnya.';
  const pending = queue.filter((entry) => entry.status === 'queued');
  const applied = queue.filter((entry) => entry.status === 'applied');
  if (pending.length) ui.pendingQueue.append(queueGroups(pending, false));
  else {
    const empty = element('div', 'board-empty');
    empty.append(element('h3', '', 'Antrean masih kosong.'), element('p', '', 'Tambahkan lowongan dari hasil pencarian setelah memeriksa informasinya.'));
    ui.pendingQueue.append(empty);
  }
  ui.applicationHistory.hidden = !applied.length;
  ui.historySummary.textContent = `Riwayat lamaran (${applied.length})`;
  if (applied.length) ui.historyList.append(queueGroups(applied, true));
}

async function refreshStatus({ initial = false } = {}) {
  if (state.statusBusy) return false;
  state.statusBusy = true;
  showError(ui.queueError);
  ui.statusMessage.textContent = 'Memeriksa antrean dan batas harian…';
  renderQueue();
  renderControls();
  try {
    acceptStatus(await request('/api/board/status'));
    if (initial) {
      const settings = state.status.searchSettings;
      if (settings && providerNames[settings.provider]) ui.providerInput.value = settings.provider;
      if (typeof settings?.query === 'string') ui.queryInput.value = settings.query.slice(0, 120);
      if (typeof settings?.location === 'string') ui.locationInput.value = settings.location.slice(0, 100);
    }
    ui.statusMessage.textContent = 'Antrean dan batas harian sudah diperiksa.';
    return true;
  } catch (error) {
    state.statusCertain = false;
    showError(ui.queueError, error.message);
    ui.statusMessage.textContent = state.status ? 'Menampilkan catatan terakhir. Periksa antrean sebelum mengubahnya.' : 'Antrean belum berhasil dimuat. Tekan “Periksa antrean” untuk mencoba lagi.';
    return false;
  } finally {
    state.statusBusy = false;
    renderQueue();
    renderControls();
  }
}

async function mutate(path, body, successMessage) {
  if (state.mutationBusy || state.statusBusy || !state.statusCertain) return;
  const focusOrigin = document.activeElement;
  const restoreFocus = focusOrigin?.tagName === 'BUTTON' &&
    (ui.searchResults.contains(focusOrigin) || ui.pendingQueue.contains(focusOrigin));
  state.mutationBusy = true;
  showError(ui.queueError);
  ui.statusMessage.textContent = 'Menyimpan perubahan antrean…';
  renderQueue();
  renderControls();
  try {
    acceptStatus(await request(path, { body }));
    ui.statusMessage.textContent = successMessage;
  } catch (error) {
    state.statusCertain = false;
    const confirmed = await refreshStatus();
    showError(ui.queueError, confirmed ? `${error.message} Antrean telah diperiksa kembali; lihat status terbaru sebelum mencoba lagi.` : `${error.message} Perubahan belum terkonfirmasi. Periksa antrean sebelum mencoba lagi.`);
  } finally {
    state.mutationBusy = false;
    renderQueue();
    renderControls();
    if (restoreFocus && document.activeElement === document.body) ui.refreshStatus.focus({ preventScroll: true });
  }
}

function openAppliedDialog(entry) {
  if (state.mutationBusy || !state.statusCertain) return;
  state.appliedId = entry.id;
  ui.appliedJob.textContent = `${entry.title}${entry.company ? ` · ${entry.company}` : ''}`;
  ui.appliedConfirm.checked = false;
  ui.confirmApplied.disabled = true;
  ui.appliedDialog.showModal();
}

ui.searchForm.addEventListener('submit', (event) => { event.preventDefault(); search(1); });
ui.queryInput.addEventListener('input', () => {
  ui.queryInput.setCustomValidity('');
  clearSearch();
});
ui.locationInput.addEventListener('input', () => clearSearch());
ui.providerInput.addEventListener('change', () => clearSearch());
ui.cancelSearch.addEventListener('click', () => clearSearch('Pencarian dibatalkan. Jalankan pencarian untuk mengambil hasil baru.'));
ui.previousPage.addEventListener('click', () => { if (state.search?.page > 1) search(state.search.page - 1); });
ui.nextPage.addEventListener('click', () => { if (state.search?.hasMore && state.search.page < 5) search(state.search.page + 1); });
ui.refreshStatus.addEventListener('click', () => refreshStatus());
ui.closeAppliedDialog.addEventListener('click', () => ui.appliedDialog.close());
ui.appliedConfirm.addEventListener('change', () => { ui.confirmApplied.disabled = !ui.appliedConfirm.checked; });
ui.appliedDialog.addEventListener('close', () => {
  state.appliedId = null;
  ui.appliedConfirm.checked = false;
  ui.confirmApplied.disabled = true;
});
ui.appliedForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ui.appliedConfirm.checked || !state.appliedId || !ui.appliedForm.reportValidity()) return;
  const id = state.appliedId;
  ui.appliedDialog.close();
  mutate('/api/board/mark-applied', { id }, 'Status dicatat sebagai sudah dilamar.');
});
window.addEventListener('pagehide', () => state.searchController?.abort());

renderSearch();
refreshStatus({ initial: true });
