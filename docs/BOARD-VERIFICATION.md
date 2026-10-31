# Verifikasi pencarian dan antrean

Diperiksa pada 1 November 2026 WIB, Windows, Node 22.14.0, Python 3.13.1, dan Microsoft Edge. Ini hasil pengujian yang diamati, bukan jaminan kompatibilitas penyedia berikutnya.

## Tes otomatis

`node --test` meluluskan **87 tes**, tanpa kegagalan, pembatalan, atau skip. Sebanyak 51 tes sebelumnya tetap lulus; tambahan terdiri dari 18 tes konektor/API/HTTP, sembilan tes ledger SQLite, tujuh tes kolektor harian, dan dua regresi portabilitas cache. Tes provider menggunakan transport dan data sintetis, bukan traffic live. [CI yang lulus](https://github.com/zalamanga/loker-lens/actions/runs/41225505847) memeriksa source `b169595c0e33574510f9bba099e08a4d05fdd6e3` pada Windows dan Linux, masing-masing 87 tes lulus.

Kasus mencakup parameter Indonesia, schema drift, duplikat sponsored card, response JSON/batas byte, body yang dibatalkan, timeout, cache, URL layanan loopback, kartu yang dipalsukan, Origin dan akses berkas privat. Uji konkurensi SQLite mencoba 80 penambahan melalui koneksi worker berbeda dan menerima tepat 20. Restart, pergantian hari WIB, transaksi rollback, riwayat immutable, dan database rusak juga diperiksa.

Kolektor diuji ketika kuota penuh, melintasi beberapa halaman, melewati riwayat/duplikat, mencapai batas lima halaman, mengalami race dengan koneksi lain, dan gagal setelah sebagian pilihan tersimpan. Tidak ada tes yang mengirim lamaran ke penyedia.

Run CI pertama mengungkap perbedaan identitas volume antara path stat dan descriptor stat pada Windows. Cleanup kini membandingkan identitas descriptor dengan descriptor dan memeriksa kestabilan path secara terpisah. Tes tambahan mencakup perbedaan itu dan penolakan marker yang diganti dengan inode berbeda walaupun isi sama; run final lulus kedua OS. Pemeriksaan ini tidak diklaim atomik terhadap pergantian path oleh proses penyerang.

## Browser dengan fixture

**15 skenario lulus** pada aplikasi HTTP dan SQLite nyata dengan source transport sintetis: awal kosong, input wajib, Glints belum tersedia, hasil nol, pagination, detail dan tautan, tambah/hapus/duplikat, dialog manual, reopen database, kuota penuh, riwayat immutable, rollover WIB, cancel/stale results, error/retry, status recovery, serta keyboard.

Tujuh keadaan layout mencakup 320, 390, 768, 1024, dan 1440 piksel, ditambah teks 200 persen pada 320 dan 640 piksel. Seluruhnya tanpa overflow horizontal; kontrol terlihat memiliki target minimal 44 piksel, termasuk checkbox melalui labelnya. Tidak ada uncaught page error atau request browser ke origin luar. HTTP 409/502/503 sengaja diinjeksi; request favicon yang tidak disediakan menghasilkan 404.

## Koneksi JobStreet nyata

API Python yang dipatok pada revisi `47c0b1712671d07e56696b3f4a69013ba4f66a0c` berhasil mengembalikan HTTP 200 untuk pencarian `backend developer`, Indonesia, bahasa Indonesia, halaman pertama berisi 20 kartu. Pencarian melalui REST API Node lalu UI juga berhasil menampilkan 20 kartu dengan tautan JobStreet Indonesia.

Reviewer utama membuka detail cuplikan, melihat desktop dan ponsel, memeriksa jumlah kartu, pilihan Glints 403, dan kondisi antrean kosong. Tidak ada pilihan pribadi yang ditambahkan atau ditandai sebagai sudah dilamar selama smoke live. [Screenshot desktop](screenshots/jobstreet-api.png), [ponsel](screenshots/jobstreet-mobile.png), dan [Glints](screenshots/glints-status.png) berasal dari run ini.

Layanan Python hanya teramati pada loopback. Health GET berhasil; POST ditolak 405; Host dan Origin asing ditolak 403. Setup pertama serta ulang dan `pip check` berhasil. Paket runtime memakai versi dan hash wheel tetap.

## Batas yang tetap berlaku

Glints API mendapat 403 dan belum terintegrasi. Pengiriman formulir, login dan unggahan CV tidak diimplementasikan. Kolektor hanya memilih hasil pencarian penyedia menurut urutannya, tanpa mengevaluasi kemampuan atau kecocokan CV. Status sudah dilamar berasal dari konfirmasi pengguna, bukan bukti yang diambil dari penyedia.

Skrip registrasi Windows Task Scheduler belum dijalankan. Syntax PowerShell diperiksa, sedangkan mekanisme task Windows yang benar-benar terjadwal belum diklaim lulus. Komputer harus menyala, login dan terhubung internet. Aktivasi memerlukan kriteria pengguna. Tidak ada klaim audit aksesibilitas lengkap atau pengujian semua perangkat/browser.
