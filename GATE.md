# Delivery gate

## Perluasan API dan antrean, 1 November 2026

Design read: meja pencarian dan catatan lamaran pribadi, meneruskan tema terang hijau/krem/limau aplikasi ini; ENERGY 1 / RHYTHM 2 / MOTION 1. Reviewer utama membaca source, memeriksa hasil pengujian, menjalankan pencarian nyata, dan melihat screenshot desktop/ponsel serta fixture secara langsung.

Hard Gate PASS: 87 tes Node lulus lokal dan CI Windows/Linux; 15 skenario browser memakai fixture yang diberi label, tujuh keadaan layout/zoom tanpa overflow, dan satu pencarian nyata menghasilkan 20 kartu Indonesia. Tombol, dialog konfirmasi, pembatalan, kondisi kosong/error, fokus dan target 44 piksel diperiksa. JobStreet nyata dan Glints 403 dibedakan; tidak ada klaim auto-apply, kecocokan AI, atau angka keberhasilan rekaan.

Purpose-Gate PASS: warna dan font sistem meneruskan identitas utilitas riset; limau menandai pencarian utama, panel samping mengelompokkan kuota dan antrean. Border memisahkan record dan tugas. Tidak ada aset merek baru, efek dekoratif, atau section promosi. Warna teks terukur paling rendah 5,29:1 pada permukaan yang digunakan; border kontrol 3,83:1 atau lebih dan fokus 5,47:1 atau lebih.

Liveliness PASS: pencarian menjadi fokus, hasil mendapatkan kolom lebih lebar, dan antrean merupakan tugas pendamping. Susunan menumpuk pada ponsel; ritme form, hasil, dan catatan mengikuti pekerjaan. Tidak ada animasi otomatis. Tema terang yang sudah ada dipertahankan; tidak ada toggle yang tidak berfungsi.

Craftsmanship PASS: cap 20, transaksi konkuren, restart, rollover WIB, duplicate, pembatalan, error sumber dan pemulihan diuji. Reviewer utama melihat screenshot nyata dan fixture setelah pengujian. Sumber live JobStreet diuji terpisah dari transport sintetis. Jadwal Windows disediakan untuk aktivasi pengguna dan belum diregistrasikan pada komputer ini. Cakupan serta batasnya ada di [verifikasi perluasan](docs/BOARD-VERIFICATION.md).

## Catatan verifikasi versi sebelumnya

Status: **PASS**. Pemeriksaan ini ditulis langsung oleh reviewer utama setelah membaca sumber, menjalankan aplikasi, meninjau bukti pengujian, dan melihat ketiga screenshot asli. Arah sebelum implementasi: ENERGY 1 / RHYTHM 2 / MOTION 1.

## Hard gate

H01 PASS (R-02): Copy UI, contoh bawaan, dan dokumentasi tidak memakai tanda pisah panjang. Decoder entitas mempertahankan karakter data sumber melalui escape Unicode.
H02 PASS (R-03): Empat belas kombinasi lebar layar/font root tidak menghasilkan overflow; judul lebih dari 400 karakter utuh pada 320 piksel/font 200%.
H03 PASS (R-17): Keempat metrik dihitung dari snapshot yang diterima. Contoh sintetis dan data belum terkonfirmasi diberi label berbeda; hasil nol tetap 0.
H04 PASS (R-18): Tidak ada testimoni atau identitas pelanggan rekaan. Organisasi/post contoh ditandai sintetis pada judul, isi, sumber, dan README.
H05 PASS (R-23): Motif briefcase berasal dari sumber asli. Screenshot diambil dari aplikasi yang dijalankan sesuai permintaan; tidak ada mockup atau foto baru.
H06 PASS (R-24): Brand, skip link, pagination, dan tautan sumber menuju halaman/region nyata; sumber contoh dibuka melalui HTTP dalam pengujian Chrome.
H07 PASS (R-25): Sebanyak 21 pasangan warna teks terukur memenuhi ambang AA. Tidak ada perubahan warna setelah pengukuran tersebut.
H08 PASS (R-26): Tombol muat/periksa/batal/rekonsiliasi/retry/reset, setiap opsi kategori/lokasi/bidang, urutan, tanggal, detail, checkbox pemulihan dan pagination diuji.
H09 PASS (R-27): Kosong, membaca, menyimpan, gagal, dibatalkan, cache rusak, hasil belum pasti dan hasil 0 memiliki pesan dan perilaku terpisah.
H10 PASS (R-28): Tidak ada FAQ pengisi halaman; penjelasan menjawab pembacaan teks, lampiran dan asal data.
H11 PASS (R-32): Tab/Enter, fokus 3 piksel, skip link dan detail native bekerja. Label pemulihan 44 piksel dapat diklik untuk mencentang checkbox.
H12 PASS (R-33): Fitur final ditulis langsung pada modul sumber, termasuk template kartu dan pemulihan. Tidak ada patcher yang dijalankan aplikasi atau disertakan sebagai implementasi fitur.
H13 PASS (R-34): Satu tema terang disediakan; seluruh keadaan yang diuji memakai tema tersebut. Tidak ada toggle tema palsu.
H14 PASS (R-35): Aplikasi dijalankan melalui HTTP dan Chrome. Suite publik 51 tes, kontrol utama, fault, pemulihan dan restart proses dicatat terpisah.
H15 PASS (R-36): Tidak ada klaim keamanan/performa/pelanggan tanpa bukti. Kompatibilitas sumber live, sandbox memori dan audit teknologi bantu lengkap tidak diklaim.
H16 PASS (R-37): Design read pada rencana mendahului UI: hijau/krem/limau, utilitas riset, sistem font lokal, ENERGY 1 / RHYTHM 2 / MOTION 1.
H17 PASS (R-38): Semua post demo secara eksplisit rekaan; tidak ada jumlah pelamar, lowongan aktif, mitra atau hasil perekrutan yang dikarang.

## Purpose gate

P01 PASS (R-01): Permukaan datar membedakan filter, hasil dan status; tidak ada glow/gradient dekoratif.
P02 PASS (R-04): Briefcase menunjukkan konteks lowongan dan dipertahankan dari proyek asli; tidak ada ikon magic atau pustaka ikon generik.
P03 PASS (R-06): Font sistem mendukung utilitas lokal tanpa unduhan font. Label kecil membedakan konteks riset dan ringkasan, bukan menggandakan headline.
P04 PASS (R-07): Latar polos membantu membaca daftar; pola grid dekoratif lama dihapus.
P05 PASS (R-08): Panah dipakai untuk perpindahan halaman, kembali ke aplikasi dan membuka sumber, bukan pada setiap tindakan.
P06 PASS (R-09): Label pada kartu menunjukkan kategori/lokasi/kata yang terdeteksi; tidak ada badge promosi atau janji kualitas.
P07 PASS (R-10): Tidak ada glassmorphism; filter dan kartu putih mempertahankan kontras teks.
P08 PASS (R-12): Border memisahkan tugas; tidak ada bayangan besar pada setiap komponen.
P09 PASS (R-13): Tidak ada glow pada tombol, kartu, ikon atau latar.
P10 PASS (R-14): Kartu hasil konsisten karena mewakili record sejenis; panel filter dan ringkasan memiliki lebar berbeda sesuai tugas.
P11 PASS (R-19): Tidak ada animasi template. Progress native menunjukkan pembacaan; preferensi reduced motion dihormati.
P12 PASS (R-22): Tidak ada ilustrasi stok atau blob yang menggantikan isi aplikasi.

## Liveliness

L01 PASS: ENERGY 1 / RHYTHM 2 / MOTION 1 dinyatakan sebelum implementasi dan dicatat di sini.
L02 PASS: Energi tenang, kolom hasil lebih besar dan feedback progress terbatas sesuai tiga dial tersebut.
L03 PASS: Fokus halaman adalah penyaring dan daftar post; detail yang dibuka tetap berada pada record bersangkutan.
L04 PASS: Spasi memisahkan status, metrik, filter dan hasil; border mengikat kontrol yang bekerja bersama.
L05 PASS: Limau menandai tindakan memuat dan motif briefcase, sementara teks/status menggunakan hijau yang terbaca.
L06 PASS: Motif briefcase, palet hijau/krem dan bahasa post/cuplikannya memberi identitas utilitas lowongan.
L07 PASS: Design read mendahului penulisan UI; tiga screenshot final sudah dilihat reviewer utama pada resolusi aslinya.

## Craftsmanship dan quality locks

C01 PASS (C-1): Pilihan warna, sistem font, kolom dan border mengikuti konteks membaca teks lowongan serta arah proyek asli.
C02 PASS (C-2): Setiap kontrol memiliki tindakan nyata. Startup gagal menonaktifkan kontrol dan menampilkan penjelasan.
C03 PASS (C-3): Status, metrik, filter, hasil dan kategori mendukung riset; tidak ada pricing, testimonial atau section promosi pengisi.
C04 PASS (C-4): Respons rusak/terlambat, kehilangan balasan, kegagalan filesystem, pembatalan, navigasi, reload dan input panjang diuji.
C05 PASS (C-5): Data demo diberi label; angka hasil berasal dari record. Screenshot, deadline dan restart merupakan hasil yang benar-benar diamati.
C06 PASS (R-05): Struktur mengikuti meja riset dengan filter/hasil dan sidebar kategori, bukan hero/kartu fitur atau bento promosi.
C07 PASS (R-11): Border radius kecil pada kontrol/kartu mendukung kelompok tugas; seluruh komponen tidak dibuat seperti pil.
C08 PASS (R-15): Tindakan berbunyi Muat contoh, Periksa data, Batalkan pembacaan dan Periksa hasil simpan sesuai efeknya.
C09 PASS (R-16): Copy tidak memakai buzzword pemasaran AI atau janji kecepatan/keamanan tanpa sumber.
C10 PASS (R-20): Filter tanggal perubahan, sinyal bidang, catatan lampiran dan sebaran kategori tetap menunjukkan fungsi riset lowongan.
C11 PASS (R-21): Tema terang berasal dari identitas sumber dan kebutuhan membaca teks; mode gelap tidak dipaksakan.
C12 PASS (R-29): Hijau, krem dan putih menjadi warna dasar; limau adalah aksen, merah terbatas pada pesan error.
C13 PASS (R-30): Tidak ada tiruan tampilan produk lain; susunan mengikuti isi dan alur proyek asal.
C14 PASS (R-31): Hijau menandai identitas, limau tindakan, kolom lebar mengutamakan hasil, font sistem menghindari unduhan, border memisahkan tugas.

Hasil pengujian dan batasnya ada pada [catatan verifikasi](docs/VERIFICATION.md). Lulus gate ini tidak berarti kompatibilitas penyedia live atau semua teknologi bantu telah dibuktikan.
