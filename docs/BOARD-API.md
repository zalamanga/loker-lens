# Pencarian API dan antrean

## Alur

Browser mengirim pencarian ke server Node lokal. Server memanggil `/jobs/search` pada layanan Python loopback, selalu dengan `country=ID`, `language=id`, `page_size=20`, dan `sort=date`. Hasil dinormalisasi menjadi kartu teks. Tidak ada cookie akun, profil pelamar, CV, atau kredensial yang dikirim pada alur ini.

```text
Browser /pencarian
  -> POST /api/board/search
  -> Python 127.0.0.1:8131/jobs/search
  -> endpoint data JobStreet
  -> kartu hasil dan tautan ke sumber

Tambah pilihan -> transaksi SQLite -> antrean maksimal 20/hari WIB
Tandai dilamar -> konfirmasi pengguna -> perubahan catatan lokal
Kolektor harian -> alur pencarian dan transaksi yang sama
```

`/api/board/search` merupakan API buatan proyek ini. API lokal Python berasal dari scraper pihak ketiga, bukan integrasi resmi JobStreet. Pada pemeriksaan 1 November 2026, API Glints mendapat 403 dan tidak mengembalikan skema JSON; konektornya dinonaktifkan. Tidak ada operasi GraphQL Glints yang dikarang untuk memberi kesan integrasi berhasil.

## REST API

Layanan Node hanya mendengarkan loopback. POST memerlukan `Origin` yang sama dengan alamat server, `Content-Type: application/json`, dan batas isi yang sesuai. Tidak ada CORS publik. Untuk mencoba dari PowerShell:

```powershell
$base = 'http://127.0.0.1:8132'
$headers = @{ Origin = $base }
$body = @{ provider = 'jobstreet'; query = 'backend developer'; location = 'Jakarta'; page = 1 } | ConvertTo-Json
$result = Invoke-RestMethod "$base/api/board/search" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$result.jobs | Select-Object title, company, location, salary, url
```

| Metode dan rute | Fungsi |
| --- | --- |
| `GET /api/board/status` | Ketersediaan konektor, kuota WIB, antrean dan riwayat |
| `POST /api/board/search` | `provider`, `query` wajib 1–120 karakter, `location` 0–100, `page` 1–5 |
| `POST /api/board/queue` | Simpan satu objek kartu yang persis sama dengan hasil pencarian server |
| `POST /api/board/mark-applied` | `{ "id": "UUID antrean" }`; catatan manual, tanpa pengiriman ke penyedia |
| `POST /api/board/remove` | Hapus pilihan yang masih antre; riwayat yang dilamar tidak bisa dihapus |

Kartu mempunyai `provider`, `jobId`, `title`, `company`, `location`, `url`, `applyUrl`, `salary`, `description`, dan `listedAt`. Nilai gaji/tanggal yang tidak tersedia adalah `null`. `applyUrl` kartu pencarian mengarah ke halaman sumber; informasi/formulir lengkap diperiksa di situs tersebut. Data HTML tidak dieksekusi di UI.

Server hanya mengantrekan kartu yang dikenal dari pencarian terakhir dalam prosesnya. Mengubah judul/URL di payload atau memakai kartu yang tidak dikenal ditolak. Setelah server dimulai ulang, lakukan pencarian lagi untuk penambahan baru; antrean lama tetap bisa dibaca dan dikelola. Hingga 500 kartu dikenal dan 20 pencarian disimpan di memori. Cache pencarian identik berlaku 60 detik; maksimum satu pencarian aktif per proses.

Kesalahan berbentuk `{ "error": "penjelasan", "code": "identitas" }`. Respons 409 mencakup kuota atau pencarian yang masih berlangsung; 422 mencakup input tidak sah; 502 mencakup layanan sumber gagal; 503 mencakup konektor yang belum tersedia; 504 mencakup pembatalan/batas waktu. Tidak ada penggantian kegagalan sumber dengan daftar kosong yang seolah berhasil.

## File dan fungsi

| File | Tanggung jawab |
| --- | --- |
| [server.js](../server.js) | Rute, perimeter Host/Origin, batas JSON, pembatalan ketika koneksi browser tutup |
| [board.mjs](../lib/board.mjs) | `createBoard`: konektor, normalisasi kartu, deduplikasi, cache, pencarian dan validasi pilihan |
| [board-store.mjs](../lib/board-store.mjs) | `ApplicationQueue`: transaksi, identitas persisten, kuota WIB dan riwayat |
| [daily.mjs](../lib/daily.mjs) | `collectDaily`: paling banyak lima halaman untuk mengisi sisa kuota |
| [board.js](../public/board.js) | Form, pembatalan hasil lama, kartu, dialog konfirmasi dan rekonsiliasi antrean |
| [Collect-Daily.mjs](../scripts/Collect-Daily.mjs) | CLI, kriteria sebagai data, layanan Python milik proses dan penutupannya |
| [Install-DailyTask.ps1](../scripts/Install-DailyTask.ps1) | Registrasi jadwal Windows yang dijalankan eksplisit oleh pengguna |
| [jobstreet-service.py](../scripts/jobstreet-service.py) | Runner upstream WSGI pada loopback dengan metode baca saja |

## Kuota dan kegagalan

`BEGIN IMMEDIATE` memperoleh hak tulis sebelum memeriksa kuota dan memasukkan/mengubah catatan. Dua proses yang berjalan bersamaan memakai database yang sama dan tidak dapat melewati kuota 20. SQLite memakai `synchronous=FULL`, pemeriksaan integritas, versi skema dan batas tunggu penguncian lima detik. Database yang rusak atau tidak dikenal ditolak dan dipertahankan.

Kuota hari ini menghitung pilihan `queued` dengan `scheduledDay` hari ini ditambah catatan `applied` dengan `appliedDay` hari ini. Menandai pilihan hari sebelumnya sebagai sudah dilamar harus memperoleh tempat dalam kuota hari sekarang. Pengulangan identitas lowongan atau penandaan yang sama tidak memakai tempat tambahan. Pilihan lama tidak dipindah hari otomatis.

Database di `.data/board/applications.sqlite` terpisah dari cache riset demo/live. Mengganti mode riset tidak menghapus kuota dan riwayat. Batas 20 ini merupakan batas pilihan/catatan aplikasi, bukan pembatas jumlah request API penyedia. Pengiriman otomatis formulir, unggahan CV, dan login akun belum diimplementasikan.
