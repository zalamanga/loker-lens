import { getLookbackStart, normalizeJob, toMap } from './jobs.mjs';

const categories = Array.from({ length: 13 }, (_, index) => ({ id: index + 1, name: ['Teknologi', 'Layanan pelanggan', 'Operasional', 'Administrasi', 'Keuangan', 'Pendidikan', 'Logistik', 'Desain', 'Pemasaran', 'Manufaktur', 'Riset', 'Sumber daya manusia', 'Program pemula'][index], slug: `contoh-kategori-${index + 1}`, count: 0 }));
const locations = ['Jakarta', 'Bandung', 'Surabaya', 'Jarak jauh'].map((name, index) => ({ id: index + 101, name, slug: `contoh-lokasi-${index + 1}`, count: 0 }));
const roles = [
  'Frontend Developer: React & JavaScript',
  'Staf Human Resources / HRD',
  'IT Support: Teknik Informatika',
  'Administrasi Operasional',
  'Desainer Komunikasi Visual',
  'Analis Data Pemula',
];
function localDate(value) { return new Date(value + 7 * 3600_000).toISOString().slice(0, 19); }

export async function demoSource({ config, signal, onProgress, clock }) {
  signal.throwIfAborted();
  onProgress({ phase: 'reading', completedPages: 0, totalPages: 1 });
  const now = clock(); const categoryMap = toMap(categories); const locationMap = toMap(locations);
  const cutoff = getLookbackStart(new Date(now), config.lookbackMonths).toISOString();
  const jobs = Array.from({ length: 24 }, (_, index) => {
    const modified = now - index * 20 * 3600_000;
    const role = roles[index % roles.length];
    const post = {
      id: index + 1, title: { rendered: `Contoh ${String(index + 1).padStart(2, '0')} · ${role}` },
      excerpt: { rendered: '<p>Data sintetis untuk mencoba filter. Ini bukan lowongan yang sedang dibuka.</p>' },
      content: { rendered: `<h2>${role}</h2><p>Organisasi Contoh ${index + 1} adalah nama rekaan untuk demonstrasi.</p><ul><li>Terbuka untuk fresh graduate dengan portofolio latihan yang relevan.</li><li>Mampu bekerja sama dan menjelaskan hasil pekerjaan secara tertulis.</li><li>${index % 3 === 0 ? 'Memahami HTML, CSS, JavaScript dan pengembangan website.' : index % 3 === 1 ? 'Memahami recruitment, human capital dan administrasi HRD.' : 'Memahami sistem informasi, database dan dukungan pengguna.'}</li></ul>${index % 5 === 0 ? '<a href="https://example.invalid/contoh.pdf">Lampiran contoh, tidak diunduh</a>' : ''}` },
      slug: `contoh-${index + 1}`, date: localDate(modified - 24 * 3600_000), modified: localDate(modified),
      categories: [categories[index % categories.length].id], tags: [locations[index % locations.length].id],
      link: `https://www.disnakerja.com/contoh-${index + 1}/`,
    };
    const job = normalizeJob(post, categoryMap, locationMap);
    return { ...job, url: `/demo/source/${job.id}` };
  }).filter((job) => job.modifiedAt >= cutoff);
  await Promise.resolve(); signal.throwIfAborted();
  onProgress({ phase: 'reading', completedPages: 1, totalPages: 1 });
  return { jobs, cutoff, coverage: { pagesRead: 1, totalPages: 1, truncated: false } };
}
