# Stockity Gemini AI — Firefox Extension

Ekstensi browser **Firefox** pribadi yang berjalan otomatis saat halaman Stockity dibuka: membaca harga live dari DOM, menghitung **Bollinger Bands & Momentum**, memicu **Google Gemini AI** lewat *Smart Trigger*, dan mendukung 2 mode (**Full Auto** sebagai default, atau **Signal Only**).

> **Peringatan Penting:** Selalu uji coba terlebih dahulu di **Akun Demo** Stockity! Analisa teknikal maupun AI tidak menjamin profit 100%, dan otomasi klik di platform trading memiliki risiko terhadap saldo maupun aturan platform.

---

## Fitur Utama
1. **Zero-Click Auto-Start**
   - Begitu halaman Stockity dibuka di Firefox, panel HUD otomatis aktif, memulihkan selector DOM tersimpan (atau menjalankan *Auto-Detect* harga live), lalu masuk mode otomatis.
2. **Smart Trigger untuk Gemini (`gemini-3.8-flash`)**
   - Memantau **Bollinger Bands** & **Momentum** secara lokal setiap tick (0 biaya kuota API).
   - Otomatis memanggil **Gemini** hanya saat ada momen teknikal (*Upper/Lower Band*, *Squeeze*, atau *Momentum Streak >= 4*) dengan jeda minimal 20 detik + *heartbeat* cadangan tiap 60 detik.
3. **2 Mode Eksekusi (Bisa Diganti Kapan Saja)**
   - **Full Auto (Default):** Gemini memutuskan `BUY` / `SELL` -> jika lolos semua pengaman, otomatis mengklik tombol BUY/SELL di halaman Stockity.
   - **Signal Only:** Gemini otomatis mengeluarkan keputusan + notifikasi suara, klik trading tetap manual di tangan Anda.
4. **Pengaman Ketat (Safety Guardrails)**
   - **Min Confidence (`80%`)**: hanya eksekusi jika keyakinan Gemini >= 80%.
   - **Trade Cooldown (`65 detik`)**: mencegah klik berulang sebelum posisi selesai.
   - **Stop Loss Beruntun (`3x`)**: otomatis **PAUSE** jika terjadi 3x LOSS berturut-turut.
   - **Max Order / Sesi (`15`)**: membatasi jumlah order otomatis per sesi browser.
   - **Tombol Darurat `⏹ STOP`** selalu tampil di bagian paling atas panel HUD.

---

## Cara Install di Firefox

### Cara 1: Uji Coba Cepat (`about:debugging`)
1. Buka Firefox, masuk ke `about:debugging#/runtime/this-firefox`.
2. Klik **Load Temporary Add-on...** dan pilih `manifest.json` di folder ini.
*(Catatan: di Firefox reguler, temporary add-on akan hilang saat Firefox ditutup total).*

### Cara 2: Permanen (Langsung Jalan Setiap Buka Firefox)
Agar tidak perlu load ulang setiap kali membuka Firefox:
- **Opsi A (Firefox Biasa):** Zip semua file di folder ini (tanpa folder pembungkusnya) lalu *self-sign* sebagai **Unlisted** (pribadi, tidak dipublikasikan) di https://addons.mozilla.org/developers/ untuk mendapatkan file `.xpi` yang bisa di-drag & drop permanen ke Firefox.
- **Opsi B (Firefox Developer Edition / Nightly):** Buka `about:config` -> ubah `xpinstall.signatures.required` menjadi `false` -> install file `.zip`/`.xpi` lokal secara permanen.

---

## Setup Pertama Kali (Cukup 1x)
1. Buka **Stockity (Akun Demo)** di Firefox.
2. Di panel HUD, buka tab **Pengaturan**:
   - Masukkan **Gemini API Key** Anda (gratis dari Google AI Studio).
   - Sesuaikan **Mode Eksekusi** (`Full Auto` atau `Signal Only`) dan batas pengaman, lalu klik **Simpan Pengaturan**.
3. Kembali ke tab **Dashboard**:
   - Klik **`🎯 Harga`** -> klik angka harga live di Stockity (atau biarkan `🔎 Auto` mendeteksinya).
   - *(Khusus mode Full Auto)* Klik **`🟢 Tombol BUY`** -> klik tombol Naik/Buy di Stockity, lalu klik **`🔴 Tombol SELL`** -> klik tombol Turun/Sell.
4. Selesai! Semua selector tersimpan permanen di Firefox — lain kali Anda buka Stockity, ekstensi langsung berjalan otomatis.
