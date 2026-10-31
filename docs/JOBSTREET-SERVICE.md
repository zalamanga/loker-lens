# Layanan JobStreet lokal

Layanan ini opsional dan berjalan hanya di `127.0.0.1`. Loker Lens mengaksesnya dari server aplikasi melalui `JOBSTREET_API_URL=http://127.0.0.1:8131/`.

## Menyiapkan dan menjalankan

Prasyarat: Windows x64, Git, PowerShell, dan Python 3.13 yang tersedia melalui `py -3.13`.

Dari direktori proyek:

```powershell
.\scripts\Start-JobStreet.ps1 -SetupOnly
.\scripts\Start-JobStreet.ps1
```

Perintah pertama hanya menyiapkan dependensi. Perintah kedua juga menyiapkan dependensi bila diperlukan, lalu menjalankan layanan di terminal tersebut. `Ctrl+C` menghentikannya. Gunakan `-Port 8132` bila perlu port lain, lalu sesuaikan `JOBSTREET_API_URL`. Alamat bind tetap `127.0.0.1`; tidak ada opsi untuk membuka akses jaringan.

Penyiapan mengunduh checkout Git pada revisi tetap dan wheel dependensi dengan versi serta SHA-256 terkunci di [jobstreet-requirements.txt](../scripts/jobstreet-requirements.txt). Checkout, virtual environment, cache pip, bytecode, dan berkas sementara disimpan di direktori `.local/jobstreet-service/` yang diabaikan Git. Penyiapan tidak mengubah Python global, kebijakan PowerShell, maupun pengaturan jendela. Checkout yang berubah atau berbeda revisi ditolak, bukan ditimpa.

Pemeriksaan lokal berikut tidak mengambil lowongan:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8131/health'
```

Permintaan pencarian berikut mengakses JobStreet Indonesia:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8131/jobs/search?country=ID&language=id&query=backend%20developer&page=1&page_size=20&sort=date'
```

Jika penyedia memblokir permintaan, hentikan pengambilan. Penyiapan ini tidak menyediakan CAPTCHA solver, proxy, autentikasi, cookie akun, maupun percobaan ulang tambahan. Respons gagal tidak membuktikan bahwa pencarian tidak memiliki lowongan.

## Sumber dan batas layanan

Sumber yang diimpor adalah [omkarcloud/jobstreet-scraper](https://github.com/omkarcloud/jobstreet-scraper), tepat pada [commit `47c0b1712671d07e56696b3f4a69013ba4f66a0c`](https://github.com/omkarcloud/jobstreet-scraper/commit/47c0b1712671d07e56696b3f4a69013ba4f66a0c). Lisensi MIT dan pemberitahuan hak cipta **Copyright (c) 2026 Chetan Jain** tetap berada di checkout sumber. [Lisensi upstream](https://github.com/omkarcloud/jobstreet-scraper/blob/47c0b1712671d07e56696b3f4a69013ba4f66a0c/LICENSE).

Ini bukan API resmi JobStreet. Kode upstream membaca endpoint JSON/GraphQL publik situs; perubahan situs dapat memutus layanan. Jalur lokal tidak memerlukan RapidAPI. Runner proyek mengimpor aplikasi WSGI dan menjalankannya dengan Cheroot; runner bawaan upstream yang membuka `0.0.0.0` tidak digunakan.

Transport upstream memakai `curl_cffi` dengan profil TLS `chrome`, yaitu peniruan fingerprint TLS/HTTP browser. Tidak ada browser otomatis atau CAPTCHA solver yang dijalankan. Kebijakan retry upstream tetap berlaku; proyek tidak menambahkan kebijakan retry. Proxy dan penyimpanan respons debug dinonaktifkan dalam proses layanan ini.

Layanan hanya menerima GET dengan Host loopback, menolak permintaan browser lintas origin, membaca lowongan, dan tidak mengirim lamaran maupun mengubah akun. Rute pencarian serta detail harus selalu menyertakan `country=ID`; tautan lowongan Indonesia saja tidak menentukan negara. `language=id` memilih Bahasa Indonesia. Detail yang telah kedaluwarsa masih dapat muncul dengan `is_expired=true`.

Paket uji `pytest` tidak diperlukan oleh jalur impor layanan dan tidak dipasang. Dependensi runtime serta dependensi transitif dikunci untuk Python 3.13; pembaruan versi atau revisi sumber perlu ditinjau dan diuji kembali.

## Verifikasi 1 November 2026

Penyiapan awal dan penyiapan ulang berhasil; `pip check` tidak menemukan dependensi rusak. Layanan teramati mendengarkan hanya pada `127.0.0.1:8131`. GET `/health` mengembalikan 200, POST ditolak dengan 405, serta Host dan Origin asing ditolak dengan 403.

Satu permintaan pencarian Indonesia pada contoh di atas berhasil dengan HTTP 200, `count=873`, dan 20 kartu lowongan. Ini hasil saat pengujian, bukan jaminan ketersediaan berikutnya. Bukti lokal di `.local/jobstreet-service/live-smoke.json` hanya menyimpan waktu, status, jumlah, ID, dan judul lowongan; isi mentah respons, profil perusahaan, dan data pelamar tidak disimpan.
