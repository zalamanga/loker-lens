# Catatan verifikasi

Diperiksa di Windows dengan Node.js 22.14.0 dan Chrome headless, 26 Oktober 2026. Seluruh data uji bersifat sintetis. Tidak ada pembacaan cache atau profil browser dari folder proyek asal.

| Pemeriksaan | Hasil dan cakupan |
| --- | --- |
| Suite publik Node | 51 tes lulus: parser, model, filter, controller, adapter, filesystem dan HTTP loopback |
| Penyimpanan melalui HTTP | 11 skenario lulus dengan berkas nyata, dua proses pemilik, restart proses baru, korupsi, pembatalan, dan fault filesystem yang sengaja diinjeksi |
| Adapter melalui HTTP lokal | 13 skenario lulus: 101 istilah, halaman 40 dari 41, JSON/header/record rusak, duplikat, URL asing, batas 4/32 MiB, hasil 0, pembatalan dan deadline |
| Deadline nyata | Permintaan berhenti sekitar 20 detik; keseluruhan sinkronisasi sekitar 60 detik. Pesan timeout 20 detik yang dirapikan diuji ulang dengan durasi nyata |
| Kontrol Chrome final | 12 kelompok lulus: kosong, demo, semua kategori, pencarian/filter gabungan, tiga urutan, pagination, detail, sumber, tanggal, debounce/reset, reload dan fallback modul |
| Gangguan Chrome final | 14 kelompok lulus: respons rusak/gagal/terlambat, 0 hasil, gagal simpan, hilang ACK, retry identik, pembatalan, judul panjang, perpindahan halaman dan pemulihan |
| Reflow | Lebar 320/375/390/768/1050/1280/1440 piksel, masing-masing font root 100/200%; 14 kombinasi tanpa overflow halaman |
| Keterbacaan dan keyboard | 21 pasangan warna teks terukur memenuhi ambang AA, tinggi kontrol 44 piksel, fokus 3 piksel, Tab/Enter, detail native dan skip link |
| Screenshot | Tiga tangkapan Chrome asli: desktop kosong, filter gabungan/detail, dan elemen kartu hasil pada viewport 390 piksel |
| Pemulihan dan opsi lengkap | Enam kelompok tambahan: pemulihan cache rusak melalui UI, konfirmasi terikat identitas cache, label 44 piksel, setiap opsi kategori/lokasi/bidang, dan reflow keadaan pemulihan |

Uji adapter memakai transport yang hanya pada harness diarahkan ke server fixture loopback. Ini menjalankan pembacaan HTTP dan batas byte yang sebenarnya, tetapi **tidak membuktikan kompatibilitas penyedia live saat ini**.

Fault staging, rename, readback, dan cleanup diaktifkan pada driver filesystem khusus pengujian. Rename dan berkasnya tetap nyata; jenis kegagalan tertentu dibuat dengan sengaja. Skenario respons browser rusak/hilang memakai interception yang disebutkan sebagai fault, bukan gangguan penyedia nyata.

Navigasi halaman benar-benar diamati memicu `pagehide` dan abort signal request. Tombol Back memulihkan halaman yang berfungsi; browser pada pengujian tersebut melaporkan dokumen baru, bukan pemulihan BFCache. Handler `pageshow.persisted` diperiksa terpisah menggunakan event yang sengaja diinjeksi, lalu reload nyata diamati. Tidak ada klaim bahwa BFCache dipakai browser pada navigasi itu.

Ukuran font root 200% bukan pengujian zoom browser native. Pemeriksaan keyboard/kontras ini juga bukan audit lengkap semua teknologi bantu.

Pemeriksaan awal menemukan area klik logo 40 piksel; CSS diperbaiki menjadi 44 piksel lalu seluruh kombinasi reflow diperiksa kembali. Perapihan akhir hanya mengubah tanda baca contoh, penanda metrik belum dimuat, dan penulisan template di sumber; kontrol serta gangguan Chrome dijalankan pada sumber final. Pengujian deadline yang lama tidak dinyatakan dijalankan ulang untuk perubahan tampilan tersebut.

Harness awal yang keliru mengasumsikan whitespace visual selalu sama dengan teks DOM dan lifecycle interception selalu menghasilkan event kegagalan jaringan disimpan sebagai diagnostik. Asersi diperbaiki tanpa melonggarkan kontrak produk; pemeriksaan final memakai teks DOM dan signal abort yang benar-benar diamati.

Server fixture dan Chrome milik pengujian ditutup setelah setiap rangkaian. Cache uji, profil, log dan harness privat tidak menjadi isi repository.
