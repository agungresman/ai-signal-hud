# Tokocrypto AI Spot Trading Bot

Bot Spot Trading berbasis **Node.js (zero-dependency)** + **Web Dashboard Lokal** untuk **Tokocrypto** (`BTCUSDT`, `BTCIDR`, `ETHUSDT`, `SOLUSDT`, dll).

## Fitur Utama
- **Mode Paper Trading (Default):** Simulasi saldo virtual memakai **harga & candle OHLCV LIVE resmi** dari API Tokocrypto (dengan fallback Binance Cloud) + simulasi fee `0.15%` per sisi agar hasil realistis.
- **Siap Switch ke Live Trading:** Sudah mendukung HMAC-SHA256 signing untuk API resmi Tokocrypto (`/open/v1/orders`).
- **Strategi Spot Disiplin (Anti-Repaint):**
  - Menghitung `EMA 9 / 21 / 50`, `RSI (14)`, `Bollinger Bands (20, 2)`, `ATR (14)`, `Volume Ratio`, dan `Efficiency Ratio` dari candle yang sudah tutup.
  - Manajemen risiko otomatis tiap 10 detik: **Stop Loss (`-1.5%`)**, **Take Profit (`+3.0%`)**, **Trailing Stop**, dan **Batas Rugi Harian (`-5%`)**.
- **AI Validator (Ollama Qwen Lokal / Groq / Gemini / OpenAI)** + **Fail-Safe 90 detik** jika AI error.
- **Notifikasi Discord Webhook** untuk BUY, WIN/LOSS (TP/SL/Trailing), AI Error, Recovery, Auto-Pause, serta rotasi PIN Keamanan.
- **Keamanan PIN Tanpa Database (Flat-File JSON) & Pengiriman Email SMTP:**
  - Akses Web Dashboard dilindungi 6-digit PIN.
  - Setiap **10 kali login sukses**, PIN akan otomatis kadaluarsa dan berganti ke PIN acak baru.
  - Fitur **Lupa PIN / Reset PIN** langsung dari halaman login modal atau tab Pengaturan.
  - Notifikasi pergantian & reset PIN otomatis dikirimkan ke **Email via SMTP** (SSL Port 465 / STARTTLS Port 587) tanpa dependensi eksternal, serta ke Discord & console log.
  - PIN awal bawaan: `123456`.
  - Disimpan di `data/pin_auth.json` (tanpa perlu database MySQL/MongoDB).

## Cara Menjalankan di Railway (Cloud 24/7)
1. Push folder `tokocrypto-bot` ke GitHub repository Anda.
2. Buat New Project di Railway > **Deploy from GitHub repo**.
3. Railway otomatis menjalankan `npm start` (`node server.js`).
4. Generate domain publik di menu **Settings** Railway (contoh: `https://tokocrypto-bot.up.railway.app`).
5. (Disarankan) Tambahkan Railway Volume ke path `/app/data` agar file konfigurasi dan PIN tidak hilang saat rebuild.

## Cara Menjalankan di Komputer Lokal
1. Pastikan **Ollama** sedang berjalan (jika pakai `qwen2.5:3b` lokal):
   ```bash
   ollama serve
   ```
2. Jalankan bot di Terminal:
   ```bash
   cd /Users/agungresman/Works/UNTITELD/tokocrypto-bot
   node server.js
   ```
3. Buka Web Dashboard di browser: **http://localhost:3456**
4. Masukkan PIN keamanan awal: **`123456`**.
5. Buka tab **Pengaturan** untuk memilih pair (`BTCUSDT` / `BTCIDR`), timeframe (`5m` / `15m`), provider AI, dan memasukkan **Discord Webhook URL** lalu klik **Simpan Pengaturan**.
