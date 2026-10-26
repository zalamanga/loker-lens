import { DashboardClient } from './client.mjs';
import { facets, filterJobs, keywords, normalize, relevantExcerpt, truncateGraphemes } from './model.mjs';

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries(['modeLabel', 'syncButton', 'refreshButton', 'syncTitle', 'syncMessage', 'savedLabel', 'syncProgress', 'progressLabel', 'cancelButton', 'reconcileButton', 'retryStartButton', 'networkError', 'damagedCache', 'damagedMessage', 'replaceDamaged', 'totalJobs', 'recentJobs', 'locationCount', 'freshGraduate', 'datasetNote', 'resultCount', 'searchInput', 'categoryFilter', 'locationFilter', 'interestFilter', 'keywordInput', 'dateFrom', 'dateTo', 'sortSelect', 'clearFilters', 'filterError', 'emptyState', 'jobList', 'pagination', 'insightBars'].map((id) => [id, $(id)]));
const number = new Intl.NumberFormat('id-ID');
const date = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeZone: 'Asia/Jakarta' });
const timestamp = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
const filters = { query: '', keywords: '', category: '', location: '', interest: '', dateFrom: '', dateTo: '', sort: 'latest' };
let page = 1; let filtered = []; let renderedData = undefined; let disposed = false; let pollTimer;
let repairConsent = null;
const debounce = new Map(); const client = new DashboardClient({ change: renderStatus });
const active = (operation) => operation && ['queued', 'taxonomy', 'reading', 'persisting'].includes(operation.phase);
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function renderStatus() {
  const status = client.status; const operation = status?.operation; const running = active(operation);
  elements.modeLabel.textContent = !status ? 'Mode belum terkonfirmasi' : status.mode === 'demo' ? 'Mode demo · seluruh post adalah contoh rekaan' : 'Sumber publik · DISNAKERJA.COM';
  elements.syncButton.textContent = status?.mode === 'live' ? 'Baca sumber publik' : 'Muat ulang contoh';
  if (!client.data) elements.syncButton.textContent = status?.mode === 'live' ? 'Baca sumber publik' : 'Muat contoh';
  const damaged = status?.cache.phase === 'damaged';
  if (!damaged || repairConsent?.instanceId !== status.instanceId || repairConsent?.hash !== status.cache.hash) {
    repairConsent = null;
    elements.replaceDamaged.checked = false;
  }
  const canReplace = damaged && repairConsent !== null && elements.replaceDamaged.checked;
  elements.syncButton.disabled = !status || client.busy || Boolean(client.pendingStart) || running || status.cache.pending || (damaged && !canReplace);
  elements.refreshButton.disabled = client.busy;
  elements.cancelButton.hidden = !running || operation.phase === 'persisting';
  elements.cancelButton.disabled = client.busy || operation?.cancelRequested;
  elements.reconcileButton.hidden = !status?.cache.pending;
  elements.reconcileButton.disabled = client.busy || operation?.phase !== 'unknown';
  elements.retryStartButton.hidden = !client.pendingStart;
  elements.retryStartButton.disabled = client.busy || !client.checkedMissing;
  elements.networkError.hidden = !client.error; elements.networkError.textContent = client.error;
  elements.damagedCache.hidden = !damaged;
  elements.damagedMessage.textContent = status?.cache.hash
    ? 'Data lama belum diganti. Jika dilanjutkan, aplikasi membuat dan memeriksa salinan pemulihan sebelum menyimpan hasil baru.'
    : 'Cache belum dapat diperiksa atau melampaui batas. Tidak ada penggantian otomatis. Periksa izin/lokasi cache atau pilih direktori data baru sesuai README.';
  const phase = operation?.phase;
  const titles = { queued: 'Menyiapkan pembacaan', taxonomy: 'Membaca kategori dan lokasi', reading: 'Membaca halaman post', persisting: 'Memeriksa hasil penyimpanan', saved: 'Data tersimpan', failed: 'Operasi belum berhasil', unknown: 'Hasil simpan belum pasti', cancelled: 'Pembacaan dibatalkan' };
  elements.syncTitle.textContent = client.pendingStart ? 'Balasan awal belum pasti' : titles[phase] ?? (damaged ? 'Cache perlu diperiksa' : client.data ? 'Data terakhir tersedia' : 'Belum ada data tersimpan');
  elements.syncMessage.textContent = client.pendingStart ? 'Periksa data/status dahulu. Permintaan yang sama memakai identitas operasi semula.'
    : operation?.error?.message ?? (operation?.warnings.length ? operation.warnings.join(' ') : running ? (operation.cancelRequested ? 'Pembatalan diminta. Menunggu pembacaan berhenti.' : 'Hasil terakhir tetap tersedia selama pembacaan berlangsung.')
      : phase === 'cancelled' ? 'Tidak ada hasil baru yang disimpan dari pembacaan ini.' : status?.mode === 'live' ? 'Pembacaan hanya dimulai lewat tombol. Status lowongan harus diperiksa di sumber.' : 'Muat contoh untuk mencoba semua filter. Tidak ada akses ke situs penyedia pada mode demo.');
  elements.savedLabel.textContent = client.data ? `Data yang ditampilkan tersimpan ${timestamp.format(new Date(client.data.savedAt))} WIB.${Date.now() - Date.parse(client.data.savedAt) > 30 * 60_000 ? ' Lebih dari 30 menit lalu.' : ''}` : 'Belum ada data terkonfirmasi.';
  elements.syncProgress.hidden = !running || !operation.progress.totalPages;
  if (running) { elements.syncProgress.max = Math.max(1, operation.progress.totalPages); elements.syncProgress.value = operation.progress.completedPages; }
  elements.progressLabel.textContent = running && operation.progress.totalPages ? `${operation.progress.completedPages} dari ${operation.progress.totalPages} halaman post` : '';
  if (client.data !== renderedData) { renderedData = client.data; renderDataset(); }
  schedulePoll();
}
function selectOptions(select, values, title, current) {
  const options = [new Option(title, ''), ...values.map((item) => new Option(`${item.name} (${number.format(item.count)})`, String(item.id)))];
  if (current && !values.some((item) => String(item.id) === current)) options.push(new Option('Pilihan sebelumnya (0)', current));
  select.replaceChildren(...options); select.value = current;
}
function renderDataset() {
  const data = client.data; const jobs = data?.jobs ?? [];
  const categories = facets(jobs, 'categories'); const locations = facets(jobs, 'locations');
  const notLoaded = '–';
  elements.totalJobs.textContent = data ? number.format(jobs.length) : notLoaded;
  elements.recentJobs.textContent = data ? number.format(jobs.filter((job) => Date.parse(job.modifiedAt) >= Date.parse(data.savedAt) - 7 * 86400_000).length) : notLoaded;
  elements.locationCount.textContent = data ? number.format(locations.length) : notLoaded;
  elements.freshGraduate.textContent = data ? number.format(jobs.filter((job) => normalize(`${job.title} ${job.summary} ${job.content.text}`).includes('fresh graduate')).length) : notLoaded;
  elements.datasetNote.textContent = data ? `${data.mode === 'demo' ? 'Contoh sintetis' : 'Metadata sumber publik'} · jendela perubahan ${date.format(new Date(data.cutoff))}–${date.format(new Date(data.savedAt))}. ${data.coverage.truncated ? `Cakupan dibatasi: ${data.coverage.pagesRead} dari ${data.coverage.totalPages} halaman post dibaca. ` : ''}Angka “diubah ≤ 7 hari” dihitung terhadap waktu penyimpanan, bukan status lowongan.` : 'Ringkasan menggambarkan metadata dan teks post, bukan kepastian lowongan masih dibuka.';
  selectOptions(elements.categoryFilter, categories, 'Semua kategori', filters.category);
  selectOptions(elements.locationFilter, locations, 'Semua lokasi', filters.location);
  elements.insightBars.innerHTML = categories.length ? categories.map((item) => `<div class="insight-row"><button type="button" data-category="${item.id}"><span>${escape(item.name)}</span><span>${number.format(item.count)}</span></button><progress max="${Math.max(1, jobs.length)}" value="${item.count}" aria-label="${escape(item.name)}: ${item.count} dari ${jobs.length} post"></progress></div>`).join('') : `<p>${data ? 'Tidak ada kategori pada data ini.' : 'Ringkasan muncul setelah data dimuat.'}</p>`;
  applyFilters();
}
function applyFilters() {
  try {
    filtered = filterJobs(client.data?.jobs ?? [], filters);
    elements.filterError.hidden = true;
    page = Math.min(page, Math.max(1, Math.ceil(filtered.length / 10))); renderJobs();
  } catch (error) {
    filtered = []; elements.filterError.textContent = error.message; elements.filterError.hidden = false;
    elements.jobList.replaceChildren(); elements.pagination.replaceChildren(); elements.emptyState.hidden = true;
    elements.resultCount.textContent = 'Periksa filter';
  }
}
function rank(items, terms) {
  const score = (value) => terms.filter((term) => normalize(value).includes(normalize(term))).length;
  return [...items].sort((a, b) => score(b) - score(a));
}
function renderJobs() {
  const rows = filtered.slice((page - 1) * 10, page * 10); const data = client.data;
  elements.resultCount.textContent = data ? `${number.format(filtered.length)} dari ${number.format(data.jobs.length)} post` : 'Belum ada data';
  elements.emptyState.hidden = rows.length > 0;
  elements.emptyState.querySelector('h3').textContent = !data ? 'Meja masih kosong.' : data.jobs.length ? 'Tidak ada hasil untuk filter ini.' : 'Data terkonfirmasi: 0 post.';
  elements.emptyState.querySelector('p').textContent = !data ? 'Muat data lewat tombol di atas untuk mencoba pencarian dan filter.' : data.jobs.length ? 'Coba kata lain, ubah rentang tanggal, atau reset semua filter.' : 'Pembacaan berhasil tanpa post dalam jendela ini. Angka nol bukan kesalahan pemuatan.';
  elements.jobList.innerHTML = rows.map((job) => {
    const profile = filters.interest ? job.matches.find((item) => item.id === filters.interest) : [...job.matches].sort((a, b) => b.count - a.count)[0];
    const custom = [...keywords(filters.keywords), ...(filters.query.trim().length >= 2 ? [filters.query.trim()] : [])];
    const haystack = normalize(`${job.title} ${job.summary} ${job.content.text}`);
    const terms = [...new Set([...(profile?.keywords ?? []), ...custom.filter((term) => haystack.includes(normalize(term)))])];
    const excerpt = relevantExcerpt(job.content.text, terms);
    const headings = rank(job.content.headings, terms).slice(0, 6); const requirements = rank(job.content.requirements, terms).slice(0, 5);
    const initials = [...job.title.replace(/^Contoh\s+\d+\s*·\s*/, '')].slice(0, 2).join('').toUpperCase();
    const preview = excerpt ? '' : truncateGraphemes(job.content.text, 500);
    return `<article class="job-card">
      <div class="job-overview">
        <div class="company-avatar" aria-hidden="true">${escape(initials)}</div>
        <div class="job-main">
          <h3>${escape(job.title)}</h3>
          <p>${escape(job.summary || 'Ringkasan tidak tersedia; baca teks yang tersimpan pada detail.')}</p>
          <div class="job-meta">${profile ? `<span>${profile.count} kata bidang ditemukan</span>` : ''}${job.categories.slice(0, 2).map((item) => `<span>${escape(item.name)}</span>`).join('')}${job.locations.slice(0, 2).map((item) => `<span>${escape(item.name)}</span>`).join('')}<time datetime="${job.modifiedAt}">Diubah ${date.format(new Date(job.modifiedAt))}</time></div>
        </div>
      </div>
      <details class="job-details">
        <summary>Baca cuplikan dan persyaratan</summary>
        <div class="job-detail-content">
          <div><h4>Hasil ekstraksi teks</h4><p>${profile ? `Teks memuat kata dari bidang ${escape(profile.name)}. Ini sinyal kata kunci, bukan penilaian pelamar.` : 'Belum ada sinyal bidang pada teks ini. Telusuri isi dan sumbernya.'} ${job.content.truncated ? 'Teks panjang dibatasi pada 18.000 unit UTF-16; cuplikan bukan salinan lengkap sumber.' : ''}</p></div>
          ${terms.length ? `<div><h4>Kata yang ditemukan</h4><div class="keyword-pills">${terms.map((term) => `<span>${escape(term)}</span>`).join('')}</div></div>` : ''}
          ${excerpt ? `<div><h4>Cuplikan terkait pencarian</h4><p class="relevant-snippet">${escape(excerpt)}</p></div>` : `<div><h4>Cuplikan teks</h4><p>${escape(preview)}${job.content.text.length > 500 ? '…' : ''}</p></div>`}
          ${headings.length ? `<div><h4>Posisi atau topik</h4><ul>${headings.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></div>` : ''}
          ${requirements.length ? `<div><h4>Poin persyaratan dari halaman</h4><ul>${requirements.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></div>` : ''}
          ${job.content.hasDocumentAttachment ? '<p><strong>Lampiran terdeteksi.</strong> Isi PDF atau dokumen tertaut tidak diunduh dan tidak dianalisis.</p>' : ''}
          <div class="detail-footer">
            <p>Diterbitkan ${date.format(new Date(job.publishedAt))}. Periksa informasi lengkap dan status pada sumber.</p>
            <a class="source-link" href="${escape(job.url)}" target="_blank" rel="noopener noreferrer">${data.mode === 'demo' ? 'Buka halaman contoh sintetis' : 'Buka sumber asli'} ↗</a>
          </div>
        </div>
      </details>
    </article>`;
  }).join('');
  renderPagination();
}
function renderPagination() {
  const total = Math.ceil(filtered.length / 10);
  if (total < 2) { elements.pagination.replaceChildren(); return; }
  const chosen = [...new Set([1, ...Array.from({ length: 5 }, (_, i) => page - 2 + i).filter((item) => item >= 1 && item <= total), total])].sort((a, b) => a - b);
  let previous = 0; let html = `<button type="button" data-page="${page - 1}" aria-label="Halaman sebelumnya" ${page === 1 ? 'disabled' : ''}>←</button>`;
  for (const item of chosen) {
    if (previous && item - previous > 1) html += '<span aria-hidden="true">…</span>';
    html += `<button type="button" data-page="${item}" aria-label="Halaman ${item}" ${item === page ? 'aria-current="page"' : ''}>${item}</button>`; previous = item;
  }
  elements.pagination.innerHTML = html + `<button type="button" data-page="${page + 1}" aria-label="Halaman berikutnya" ${page === total ? 'disabled' : ''}>→</button>`;
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (disposed || client.busy || !(active(client.status?.operation) || client.pendingStart || client.status?.cache.pending)) return;
  pollTimer = setTimeout(async () => { await client.check(); if (!disposed) schedulePoll(); }, 900);
}
function changeFilter(key, value) { filters[key] = value; page = 1; applyFilters(); }
for (const [id, key] of [['searchInput', 'query'], ['keywordInput', 'keywords']]) elements[id].addEventListener('input', (event) => {
  const value = event.target.value; clearTimeout(debounce.get(key));
  debounce.set(key, setTimeout(() => { if (!disposed) changeFilter(key, value); debounce.delete(key); }, 180));
});
for (const [id, key] of [['categoryFilter', 'category'], ['locationFilter', 'location'], ['interestFilter', 'interest'], ['dateFrom', 'dateFrom'], ['dateTo', 'dateTo'], ['sortSelect', 'sort']]) elements[id].addEventListener('change', (event) => changeFilter(key, event.target.value));
elements.clearFilters.addEventListener('click', () => {
  for (const timer of debounce.values()) clearTimeout(timer); debounce.clear();
  Object.assign(filters, { query: '', keywords: '', category: '', location: '', interest: '', dateFrom: '', dateTo: '', sort: 'latest' });
  for (const id of ['searchInput', 'keywordInput', 'categoryFilter', 'locationFilter', 'interestFilter', 'dateFrom', 'dateTo']) elements[id].value = '';
  elements.sortSelect.value = 'latest'; page = 1; applyFilters();
});
elements.insightBars.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-category]'); if (!button) return;
  elements.categoryFilter.value = button.dataset.category; changeFilter('category', button.dataset.category); elements.categoryFilter.focus();
});
elements.pagination.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page]'); if (!button || button.disabled) return;
  const next = Number(button.dataset.page); if (!Number.isSafeInteger(next) || next < 1 || next > Math.ceil(filtered.length / 10)) return;
  page = next; renderJobs(); $('results').focus();
});
elements.syncButton.addEventListener('click', async () => { await client.start(client.status?.cache.phase === 'damaged' ? repairConsent?.hash ?? null : null); });
elements.refreshButton.addEventListener('click', async () => { if (client.pendingStart) await client.check(); else await client.refresh(); });
elements.cancelButton.addEventListener('click', () => { void client.cancel(); });
elements.reconcileButton.addEventListener('click', () => { void client.reconcile(); });
elements.retryStartButton.addEventListener('click', () => { void client.retryStart(); });
elements.replaceDamaged.addEventListener('change', () => {
  const status = client.status;
  repairConsent = elements.replaceDamaged.checked && status?.cache.phase === 'damaged' && status.cache.hash
    ? { instanceId: status.instanceId, hash: status.cache.hash } : null;
  renderStatus();
});
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(pollTimer); for (const timer of debounce.values()) clearTimeout(timer); debounce.clear(); client.dispose(); }, { once: true });
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
$('filterControls').disabled = false;
$('bootMessage').hidden = true;
void client.refresh();
