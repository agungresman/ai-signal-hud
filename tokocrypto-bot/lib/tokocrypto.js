"use strict";

const crypto = require("crypto");

const TOKOCRYPTO_BASE = "https://www.tokocrypto.com";
const BINANCE_DATA_BASE = "https://data-api.binance.vision";
const BINANCE_BASE = "https://api.binance.com";
const OKX_BASE = "https://www.okx.com";

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json"
};

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const mergedHeaders = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    const resp = await fetch(url, { ...options, headers: mergedHeaders, signal: controller.signal });
    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    const causeCode = err && err.cause && err.cause.code ? ` (${err.cause.code})` : "";
    if (err && err.name === "AbortError") {
      throw new Error(`Timeout ${Math.round(timeoutMs / 1000)}s saat akses ${new URL(url).hostname}`);
    }
    throw new Error(`${err && err.message ? err.message : "fetch failed"}${causeCode}`);
  } finally {
    clearTimeout(timer);
  }
}

function toTokocryptoSymbol(symbol) {
  const s = String(symbol || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (s.includes("_")) return s;
  for (const quote of ["USDT", "BIDR", "IDR", "BUSD", "BTC", "ETH", "BNB"]) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return `${s.slice(0, -quote.length)}_${quote}`;
    }
  }
  return s;
}

function toBinanceSymbol(symbol) {
  const s = String(symbol || "BTCUSDT").toUpperCase().replace(/_/g, "");
  if (s.endsWith("IDR") && !s.endsWith("BIDR")) {
    return s.replace(/IDR$/, "BIDR");
  }
  return s;
}

function toOkxInstId(symbol) {
  const { base, quote } = splitSymbol(symbol);
  const q = quote === "IDR" || quote === "BIDR" ? "USDT" : quote;
  return `${base}-${q}`;
}

function toOkxBar(interval) {
  const map = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D" };
  return map[interval] || "5m";
}

function splitSymbol(symbol) {
  const tc = toTokocryptoSymbol(symbol);
  const parts = tc.split("_");
  if (parts.length === 2) return { base: parts[0], quote: parts[1], tcSymbol: tc };
  return { base: tc, quote: "USDT", tcSymbol: tc };
}

function parseKlinesArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6])
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0);
}

function parseOkxCandles(arr, intervalMs) {
  if (!Array.isArray(arr)) return [];
  // OKX mengembalikan terbaru dulu -> balik ke lama -> baru
  return arr
    .slice()
    .reverse()
    .map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[0]) + intervalMs
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0);
}

function intervalToMs(interval) {
  const m = String(interval || "5m").match(/^(\d+)([mhd])$/i);
  if (!m) return 300000;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === "m") return n * 60000;
  if (u === "h") return n * 3600000;
  return n * 86400000;
}

/**
 * Ambil data candle OHLCV publik (multi-endpoint bebas blokir ISP Indonesia):
 * 1. Tokocrypto Open API
 * 2. Binance Public Data API (data-api.binance.vision — likuiditas sama, bebas blokir ISP ID)
 * 3. OKX Public API (cadangan)
 * 4. Binance Main API (cadangan jika pakai VPN)
 */
async function getKlines(symbol, interval = "5m", limit = 80) {
  const tcSym = toTokocryptoSymbol(symbol);
  const bnSym = toBinanceSymbol(symbol);
  const errors = [];

  // 1. Tokocrypto Open API
  try {
    const url = `${TOKOCRYPTO_BASE}/open/v1/market/klines?symbol=${encodeURIComponent(tcSym)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetchJsonWithTimeout(url, {}, 7000);
    const list = Array.isArray(res.data) ? res.data : res.data && Array.isArray(res.data.data) ? res.data.data : null;
    if (res.ok && list && list.length > 0) {
      return { source: "tokocrypto", symbol: tcSym, candles: parseKlinesArray(list) };
    }
    errors.push(`tokocrypto: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`tokocrypto: ${e.message}`);
  }

  // 2. Binance Public Market Data CDN (data-api.binance.vision)
  try {
    const url = `${BINANCE_DATA_BASE}/api/v3/klines?symbol=${encodeURIComponent(bnSym)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetchJsonWithTimeout(url, {}, 7000);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return { source: "binance_vision", symbol: bnSym, candles: parseKlinesArray(res.data) };
    }
    errors.push(`binance_vision: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`binance_vision: ${e.message}`);
  }

  // 3. OKX Public Market API (cadangan untuk pair USDT)
  try {
    const instId = toOkxInstId(symbol);
    const bar = toOkxBar(interval);
    const url = `${OKX_BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`;
    const res = await fetchJsonWithTimeout(url, {}, 7000);
    if (res.ok && res.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
      return { source: "okx", symbol: instId, candles: parseOkxCandles(res.data.data, intervalToMs(interval)) };
    }
    errors.push(`okx: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`okx: ${e.message}`);
  }

  // 4. Binance Main API (jika VPN aktif)
  try {
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(bnSym)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetchJsonWithTimeout(url, {}, 7000);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return { source: "binance", symbol: bnSym, candles: parseKlinesArray(res.data) };
    }
    errors.push(`binance: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`binance: ${e.message}`);
  }

  throw new Error(`Semua sumber klines gagal (${symbol}): ${errors.join(" | ")}`);
}

async function getTickerPrice(symbol) {
  const tcSym = toTokocryptoSymbol(symbol);
  const bnSym = toBinanceSymbol(symbol);
  const errors = [];

  // 1. Tokocrypto
  try {
    const url = `${TOKOCRYPTO_BASE}/open/v1/market/ticker/price?symbol=${encodeURIComponent(tcSym)}`;
    const res = await fetchJsonWithTimeout(url, {}, 6000);
    const price = Number(res.data?.data?.price ?? res.data?.price);
    if (res.ok && Number.isFinite(price) && price > 0) {
      return { source: "tokocrypto", price };
    }
    errors.push(`tokocrypto: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`tokocrypto: ${e.message}`);
  }

  // 2. Binance Public Data CDN (bebas blokir ISP Indonesia)
  try {
    const url = `${BINANCE_DATA_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(bnSym)}`;
    const res = await fetchJsonWithTimeout(url, {}, 6000);
    const price = Number(res.data?.price);
    if (res.ok && Number.isFinite(price) && price > 0) {
      return { source: "binance_vision", price };
    }
    errors.push(`binance_vision: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`binance_vision: ${e.message}`);
  }

  // 3. OKX Public Ticker
  try {
    const instId = toOkxInstId(symbol);
    const url = `${OKX_BASE}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
    const res = await fetchJsonWithTimeout(url, {}, 6000);
    const price = Number(res.data?.data?.[0]?.last);
    if (res.ok && Number.isFinite(price) && price > 0) {
      return { source: "okx", price };
    }
    errors.push(`okx: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`okx: ${e.message}`);
  }

  // 4. Binance Main
  try {
    const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(bnSym)}`;
    const res = await fetchJsonWithTimeout(url, {}, 6000);
    const price = Number(res.data?.price);
    if (res.ok && Number.isFinite(price) && price > 0) {
      return { source: "binance", price };
    }
    errors.push(`binance: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`binance: ${e.message}`);
  }

  throw new Error(`Gagal ambil harga (${symbol}): ${errors.join(" | ")}`);
}

/**
 * Ambil kurs USD/IDR (atau USDT/IDR) dengan fallback berjenjang:
 * 1. Tokocrypto (USDT_IDR - real-time)
 * 2. Indodax (usdtidr - real-time)
 * 3. ExchangeRate-API Open Access (USD -> IDR)
 * 4. Frankfurter API / ECB (USD -> IDR)
 */
async function getUsdIdrRate() {
  const errors = [];
  const isValidRate = (v) => Number.isFinite(v) && v > 10000 && v < 30000;

  // 1. Tokocrypto USDT_IDR
  try {
    const res = await fetchJsonWithTimeout(`${TOKOCRYPTO_BASE}/open/v1/market/ticker/price?symbol=USDT_IDR`, {}, 6000);
    const rate = Number(res.data?.data?.price ?? res.data?.price);
    if (res.ok && isValidRate(rate)) return { source: "tokocrypto", rate };
    errors.push(`tokocrypto: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`tokocrypto: ${e.message}`);
  }

  // 2. Indodax USDT/IDR
  try {
    const res = await fetchJsonWithTimeout("https://indodax.com/api/ticker/usdtidr", {}, 6000);
    const rate = Number(res.data?.ticker?.last);
    if (res.ok && isValidRate(rate)) return { source: "indodax", rate };
    errors.push(`indodax: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`indodax: ${e.message}`);
  }

  // 3. ExchangeRate-API Open Access (gratis tanpa API key)
  try {
    const res = await fetchJsonWithTimeout("https://open.er-api.com/v6/latest/USD", {}, 6000);
    const rate = Number(res.data?.rates?.IDR);
    if (res.ok && isValidRate(rate)) return { source: "open.er-api.com", rate };
    errors.push(`open.er-api: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`open.er-api: ${e.message}`);
  }

  // 4. Frankfurter API (referensi ECB resmi)
  try {
    const res = await fetchJsonWithTimeout("https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR", {}, 6000);
    const rate = Number(res.data?.rates?.IDR);
    if (res.ok && isValidRate(rate)) return { source: "frankfurter.dev", rate };
    errors.push(`frankfurter: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`frankfurter: ${e.message}`);
  }

  throw new Error(`Semua sumber kurs USD/IDR gagal: ${errors.join(" | ")}`);
}

let serverTimeOffsetMs = 0;
let lastTimeSyncAt = 0;

async function getSyncedTimestamp() {
  if (Date.now() - lastTimeSyncAt > 300000) {
    try {
      const res = await fetchJsonWithTimeout(`${TOKOCRYPTO_BASE}/open/v1/common/time`, {}, 5000);
      const srvTime = Number(res.data?.data?.serverTime ?? res.data?.serverTime);
      if (res.ok && Number.isFinite(srvTime) && srvTime > 1e12) {
        serverTimeOffsetMs = srvTime - Date.now();
        lastTimeSyncAt = Date.now();
      }
    } catch (_) {}
  }
  return Date.now() + serverTimeOffsetMs;
}

function floorToDecimals(num, decimals) {
  const factor = Math.pow(10, decimals);
  return (Math.floor(Number(num) * factor) / factor).toFixed(decimals);
}

function getBaseStepDecimals(baseAsset) {
  const b = String(baseAsset || "BTC").toUpperCase();
  if (b === "BTC") return 5;
  if (b === "ETH" || b === "BNB") return 4;
  if (b === "SOL" || b === "AVAX" || b === "LINK") return 2;
  return 2;
}

/**
 * Ambil saldo asli dompet Spot Tokocrypto (GET /open/v1/account/spot).
 */
async function getAccountBalances(config) {
  if (!config.tokocryptoApiKey || !config.tokocryptoApiSecret) {
    throw new Error("API Key & Secret Tokocrypto belum diisi.");
  }

  const ts = await getSyncedTimestamp();
  const params = new URLSearchParams({
    timestamp: String(ts),
    recvWindow: "15000"
  });
  const signature = crypto
    .createHmac("sha256", config.tokocryptoApiSecret)
    .update(params.toString())
    .digest("hex");
  params.set("signature", signature);

  const url = `${TOKOCRYPTO_BASE}/open/v1/account/spot?${params.toString()}`;
  const res = await fetchJsonWithTimeout(
    url,
    {
      method: "GET",
      headers: { "X-MBX-APIKEY": config.tokocryptoApiKey }
    },
    10000
  );

  if (!res.ok || (res.data && typeof res.data.code === "number" && res.data.code !== 0)) {
    const msg = res.data?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`Tokocrypto Auth Error: ${msg}`);
  }

  const assets = res.data?.data?.accountAssets || res.data?.accountAssets || [];
  const map = {};
  for (const a of assets) {
    const sym = String(a.asset || "").toUpperCase();
    const free = Number(a.free) || 0;
    const locked = Number(a.locked) || 0;
    if (free > 0 || locked > 0 || ["IDR", "BIDR", "USDT", "BTC", "ETH", "SOL"].includes(sym)) {
      map[sym] = { free, locked, total: free + locked };
    }
  }
  return map;
}

/**
 * Eksekusi Spot Market Order LIVE ke Tokocrypto Open API (HMAC-SHA256).
 */
async function placeLiveOrder(config, side, { quoteOrderQty, quantity }) {
  if (!config.tokocryptoApiKey || !config.tokocryptoApiSecret) {
    throw new Error("API Key & Secret Tokocrypto belum diisi untuk mode LIVE.");
  }

  const { base, quote, tcSymbol } = splitSymbol(config.symbol);
  const sideCode = side === "BUY" ? 0 : 1;
  const ts = await getSyncedTimestamp();
  const params = new URLSearchParams({
    symbol: tcSymbol,
    side: String(sideCode),
    type: "2",
    timestamp: String(ts),
    recvWindow: "15000"
  });

  if (side === "BUY" && quoteOrderQty) {
    const qDec = quote === "IDR" || quote === "BIDR" ? 0 : 2;
    params.set("quoteOrderQty", floorToDecimals(quoteOrderQty, qDec));
  } else if (side === "SELL") {
    // Cek saldo free aktual agar tidak pernah gagal Insufficient Balance karena potongan fee beli
    let sellQty = Number(quantity) || 0;
    try {
      const balances = await getAccountBalances(config);
      const actualFree = balances[base] ? balances[base].free : 0;
      if (actualFree > 0) {
        sellQty = Math.min(sellQty || actualFree, actualFree);
      }
    } catch (_) {}
    const stepDec = getBaseStepDecimals(base);
    const roundedQty = floorToDecimals(sellQty, stepDec);
    if (Number(roundedQty) <= 0) {
      throw new Error(`Jumlah ${base} untuk dijual terlalu kecil (${roundedQty}).`);
    }
    params.set("quantity", roundedQty);
  }

  const signature = crypto
    .createHmac("sha256", config.tokocryptoApiSecret)
    .update(params.toString())
    .digest("hex");
  params.set("signature", signature);

  const url = `${TOKOCRYPTO_BASE}/open/v1/orders?${params.toString()}`;
  const res = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": config.tokocryptoApiKey,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    },
    12000
  );

  if (!res.ok || (res.data && typeof res.data.code === "number" && res.data.code !== 0)) {
    const msg = res.data?.msg || res.data?.message || `HTTP ${res.status}`;
    throw new Error(`Tokocrypto Order Error: ${msg}`);
  }
  return res.data;
}

module.exports = {
  toTokocryptoSymbol,
  toBinanceSymbol,
  splitSymbol,
  getKlines,
  getTickerPrice,
  getUsdIdrRate,
  getAccountBalances,
  placeLiveOrder,
  fetchJsonWithTimeout
};
