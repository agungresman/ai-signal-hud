"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// Load file .env lokal jika ada (pure Node.js tanpa dotenv)
const localEnvPath = path.join(__dirname, ".env");
if (fs.existsSync(localEnvPath)) {
  try {
    const rawEnv = fs.readFileSync(localEnvPath, "utf8");
    for (const rawLine of rawEnv.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, "$1");
        if (k && process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
    }
  } catch (_) {}
}

const { getKlines, getTickerPrice, getUsdIdrRate, getAccountBalances, placeLiveOrder, splitSymbol } = require("./lib/tokocrypto");
const { analyzeCandles } = require("./lib/strategy");
const { validateWithAI, normalizeOllamaEndpoint, testAiConnection } = require("./lib/ai");
const { sendDiscord } = require("./lib/discord");
const { sendEmail, sendPinEmail } = require("./lib/smtp");
const {
  isValidSession,
  revokeSession,
  getAuthStatus,
  verifyPinLogin,
  resetPin,
  getCurrentPin
} = require("./lib/auth");

const PORT = Number(process.env.PORT || 3456);
const DATA_DIR = path.join(__dirname, "data");
const REPORTS_DIR = path.join(__dirname, "reports");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_HTML = path.join(__dirname, "public", "index.html");
const PARALLEL_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

function createBotSlot(symbol) {
  return {
    symbol,
    lastPrice: null,
    priceSource: "-",
    lastUpdatedAt: 0,
    lastClosedCandleTime: 0,
    lastAnalysis: null,
    lastAiDecision: null,
    candles: [],
    position: null
  };
}

const DEFAULT_CONFIG = {
  mode: process.env.BOT_MODE || "paper", // "paper" | "live"
  symbol: process.env.SYMBOL || "BTCUSDT", // "BTCUSDT" | "BTCIDR" | "ETHUSDT" | "SOLUSDT"
  interval: process.env.INTERVAL || "5m", // "5m" | "15m" | "1h"
  paperInitialBalance: 1000,
  orderSizeQuote: 100,
  stopLossPct: 1.5,
  takeProfitPct: 3.0,
  trailingActivatePct: 1.5,
  trailingStopPct: 0.8,
  feePct: 0.15,
  minConfidence: 70,
  maxDailyLossPct: 5.0,
  dailyTargetIdr: 300000,
  aiProvider: process.env.AI_PROVIDER || "ollama",
  aiModel: process.env.AI_MODEL || "qwen2.5:3b",
  aiApiKey: process.env.AI_API_KEY || "",
  aiEndpoint: process.env.AI_ENDPOINT || "http://localhost:11434/api/chat",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  discordNotify: true,
  tokocryptoApiKey: process.env.TOKOCRYPTO_API_KEY || "",
  tokocryptoApiSecret: process.env.TOKOCRYPTO_API_SECRET || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpSecure: process.env.SMTP_SECURE !== "false",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "",
  smtpTo: process.env.SMTP_TO || ""
};

function createInitialState() {
  return {
    config: { ...DEFAULT_CONFIG },
    running: true,
    paperBalance: DEFAULT_CONFIG.paperInitialBalance,
    liveQuoteBalance: null,
    liveBaseBalance: null,
    dailyPnlQuote: 0,
    dailyPnlDate: getLocalDateStr(),
    dailyHistory: [], // { date, targetIdr, targetQuote, pnlQuote, pnlIdr, trades, wins, losses, achieved }
    symbols: [...PARALLEL_SYMBOLS],
    bots: Object.fromEntries(PARALLEL_SYMBOLS.map((s) => [s, createBotSlot(s)])),
    position: null, // { symbol, qty, entryPrice, costQuote, entryTime, highestPrice, stopLossPrice, takeProfitPrice, trailingActive, setupType, mode }
    lastPrice: null,
    usdtIdrRate: 16250,
    usdtIdrSource: "-",
    usdtIdrUpdatedAt: 0,
    priceSource: "-",
    lastUpdatedAt: 0,
    lastClosedCandleTime: 0,
    lastAnalysis: null,
    lastAiDecision: null,
    candles: [], // hingga 150 candle terakhir untuk grafik candlestick di dashboard (in-memory)
    aiGuard: { locked: false, reason: "", retryAt: 0, failCount: 0 },
    history: [], // { time, exitTime, symbol, mode, entryPrice, exitPrice, qty, pnlQuote, pnlPct, reason, status }
    logs: []
  };
}

let state = loadState();
let busyScan = false;
let lastIdrFetchAt = 0;
let lastLiveBalFetchAt = 0;

async function refreshLiveBalanceIfNeeded(force = false) {
  if (state.config.mode !== "live" || !state.config.tokocryptoApiKey || !state.config.tokocryptoApiSecret) return;
  if (!force && Date.now() - lastLiveBalFetchAt < 20000) return;
  lastLiveBalFetchAt = Date.now();
  try {
    const { base, quote } = splitSymbol(state.config.symbol);
    const map = await getAccountBalances(state.config);
    state.liveQuoteBalance = map[quote] ? map[quote].free : 0;
    state.liveBaseBalance = map[base] ? map[base].free : 0;
  } catch (err) {
    addLog(`Gagal baca saldo Live Tokocrypto: ${err.message}`, "warn");
  }
}

async function refreshUsdtIdrRate(force = false) {
  if (!force && Date.now() - lastIdrFetchAt < 300000) return;
  lastIdrFetchAt = Date.now();
  try {
    const res = await getUsdIdrRate();
    state.usdtIdrRate = res.rate;
    state.usdtIdrSource = res.source;
    state.usdtIdrUpdatedAt = Date.now();
    saveState();
  } catch (err) {
    if (!state.usdtIdrRate) state.usdtIdrRate = 16250;
    addLog(`Gagal update kurs USD/IDR: ${err.message}`, "warn");
  }
}

function formatDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const base = createInitialState();
      const merged = {
        ...base,
        ...parsed,
        config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
        aiGuard: { locked: false, reason: "", retryAt: 0, failCount: 0 }
      };
      const bots = {};
      for (const sym of PARALLEL_SYMBOLS) {
        const savedBot = parsed.bots && parsed.bots[sym] ? parsed.bots[sym] : {};
        bots[sym] = { ...createBotSlot(sym), ...savedBot, symbol: sym, candles: [] };
      }
      // Migrasi posisi/harga lama ke slot bot masing-masing jika belum ada
      const primarySym = PARALLEL_SYMBOLS.includes(merged.config.symbol) ? merged.config.symbol : "BTCUSDT";
      if (!parsed.bots) {
        if (merged.position && bots[merged.position.symbol]) {
          bots[merged.position.symbol].position = merged.position;
        }
        if (merged.lastPrice && bots[primarySym]) {
          bots[primarySym].lastPrice = merged.lastPrice;
          bots[primarySym].priceSource = merged.priceSource || "-";
          bots[primarySym].lastUpdatedAt = merged.lastUpdatedAt || 0;
          bots[primarySym].lastClosedCandleTime = merged.lastClosedCandleTime || 0;
          bots[primarySym].lastAnalysis = merged.lastAnalysis || null;
          bots[primarySym].lastAiDecision = merged.lastAiDecision || null;
        }
      }
      merged.bots = bots;
      merged.symbols = [...PARALLEL_SYMBOLS];
      return merged;
    }
  } catch (_) { }
  return createInitialState();
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const { candles, bots, ...persisted } = state;
    const cleanBots = {};
    for (const sym of PARALLEL_SYMBOLS) {
      const b = (bots && bots[sym]) || createBotSlot(sym);
      const { candles: _bc, ...restBot } = b;
      cleanBots[sym] = restBot;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...persisted, bots: cleanBots }, null, 2));
    saveReports();
  } catch (_) { }
}

function saveReports() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const idrRate = getActiveIdrRate();
    const dailyList = Array.isArray(state.dailyHistory) ? state.dailyHistory : [];
    const tradeList = Array.isArray(state.history) ? state.history : [];
    const nowIso = new Date().toISOString();
    const todayKey = state.dailyPnlDate || getLocalDateStr();

    // 1. Rekap Harian (reports/rekap_harian.json)
    const dailySummary = dailyList.reduce(
      (acc, d) => {
        acc.totalDays += 1;
        if (d.achieved) acc.achievedDays += 1;
        acc.totalTargetIdr += Number(d.targetIdr) || 0;
        acc.totalPnlIdr += Number(d.pnlIdr) || 0;
        acc.totalPnlQuote += Number(d.pnlQuote) || 0;
        acc.totalTrades += Number(d.trades) || 0;
        acc.totalWins += Number(d.wins) || 0;
        acc.totalLosses += Number(d.losses) || 0;
        return acc;
      },
      { totalDays: 0, achievedDays: 0, totalTargetIdr: 0, totalPnlIdr: 0, totalPnlQuote: 0, totalTrades: 0, totalWins: 0, totalLosses: 0 }
    );
    dailySummary.winratePct = dailySummary.totalTrades > 0 ? Math.round((dailySummary.totalWins / dailySummary.totalTrades) * 1000) / 10 : 0;

    fs.writeFileSync(
      path.join(REPORTS_DIR, "rekap_harian.json"),
      JSON.stringify({ updatedAt: nowIso, usdtIdrRate: idrRate, summary: dailySummary, days: dailyList }, null, 2)
    );

    // 2. Rekap Trade (reports/rekap_trade.json) — arsip hingga 500 trade terbaru
    const tradeFile = path.join(REPORTS_DIR, "rekap_trade.json");
    let archivedTrades = [];
    if (fs.existsSync(tradeFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(tradeFile, "utf8"));
        if (Array.isArray(prev.trades)) archivedTrades = prev.trades;
      } catch (_) {}
    }
    const seenKeys = new Set(tradeList.map((t) => `${t.symbol}_${t.entryTimestamp || t.time}_${t.exitTimestamp || t.exitTime}`));
    const mergedTrades = [...tradeList];
    for (const old of archivedTrades) {
      const k = `${old.symbol}_${old.entryTimestamp || old.time}_${old.exitTimestamp || old.exitTime}`;
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        mergedTrades.push(old);
      }
    }
    if (mergedTrades.length > 500) mergedTrades.length = 500;

    const tWins = mergedTrades.filter((t) => t.status === "WIN").length;
    const tTotal = mergedTrades.length;
    const tPnlQuote = mergedTrades.reduce((s, t) => s + (Number(t.pnlQuote) || 0), 0);
    const tradeSummary = {
      totalTrades: tTotal,
      wins: tWins,
      losses: tTotal - tWins,
      winratePct: tTotal > 0 ? Math.round((tWins / tTotal) * 1000) / 10 : 0,
      totalPnlQuote: tPnlQuote,
      totalPnlIdr: tPnlQuote * idrRate
    };

    fs.writeFileSync(
      tradeFile,
      JSON.stringify({ updatedAt: nowIso, usdtIdrRate: idrRate, summary: tradeSummary, trades: mergedTrades }, null, 2)
    );

    // 3. Snapshot per tanggal (reports/harian_YYYY-MM-DD.json)
    const todayRec = dailyList.find((d) => d.date === todayKey) || null;
    const todayTrades = mergedTrades.filter((t) => {
      if (t.exitTimestamp) return getLocalDateStr(t.exitTimestamp) === todayKey;
      return false;
    });
    fs.writeFileSync(
      path.join(REPORTS_DIR, `harian_${todayKey}.json`),
      JSON.stringify({ updatedAt: nowIso, date: todayKey, usdtIdrRate: idrRate, daily: todayRec, trades: todayTrades }, null, 2)
    );
  } catch (_) {}
}

function addLog(msg, level = "info") {
  const entry = {
    time: new Date().toLocaleTimeString(),
    level,
    msg: String(msg)
  };
  state.logs.unshift(entry);
  if (state.logs.length > 40) state.logs.pop();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${entry.msg}`);
}

function getLocalDateStr(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getActiveIdrRate() {
  const { quote } = splitSymbol(state.config.symbol);
  return quote === "IDR" || quote === "BIDR" ? 1 : Number(state.usdtIdrRate) || 16250;
}

function syncTodayDailyHistory({ tradeStatus = null } = {}) {
  if (!Array.isArray(state.dailyHistory)) state.dailyHistory = [];
  const dateKey = state.dailyPnlDate || getLocalDateStr();
  const idrRate = getActiveIdrRate();
  const targetIdr = Math.max(0, Number(state.config.dailyTargetIdr) || 0);
  const pnlQuote = Number(state.dailyPnlQuote) || 0;
  const pnlIdr = pnlQuote * idrRate;
  const targetQuote = idrRate > 0 ? targetIdr / idrRate : 0;

  let entry = state.dailyHistory.find((d) => d.date === dateKey);
  if (!entry) {
    entry = {
      date: dateKey,
      targetIdr,
      targetQuote,
      pnlQuote: 0,
      pnlIdr: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      achieved: false
    };
    state.dailyHistory.unshift(entry);
  }

  entry.targetIdr = targetIdr;
  entry.targetQuote = targetQuote;
  entry.pnlQuote = pnlQuote;
  entry.pnlIdr = pnlIdr;
  if (tradeStatus === "WIN") {
    entry.trades += 1;
    entry.wins += 1;
  } else if (tradeStatus === "LOSS") {
    entry.trades += 1;
    entry.losses += 1;
  }
  entry.achieved = targetIdr > 0 ? entry.pnlIdr >= targetIdr : false;

  state.dailyHistory.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (state.dailyHistory.length > 90) state.dailyHistory.length = 90;
}

function resetDailyIfNeeded() {
  const today = getLocalDateStr();
  if (state.dailyPnlDate !== today) {
    syncTodayDailyHistory();
    state.dailyPnlDate = today;
    state.dailyPnlQuote = 0;
    syncTodayDailyHistory();
  }
}

function notify(payload) {
  sendDiscord(state.config, payload).catch((err) => {
    addLog(`Discord gagal: ${err.message}`, "warn");
  });
}

// ---------- Eksekusi BUY & SELL (Paper & Live) ----------
async function openBuyPosition(symbol, price, analysis, aiDecision) {
  const sym = PARALLEL_SYMBOLS.includes(symbol) ? symbol : "BTCUSDT";
  const bot = state.bots[sym] || (state.bots[sym] = createBotSlot(sym));
  if (bot.position) return false;
  const cfg = state.config;
  const { base, quote } = splitSymbol(sym);
  const spendQuote = Number(cfg.orderSizeQuote) || 100;

  if (cfg.mode === "paper") {
    if (state.paperBalance < spendQuote) {
      addLog(`[${sym}] Saldo paper (${state.paperBalance.toFixed(2)} ${quote}) kurang dari order size (${spendQuote}).`, "warn");
      return false;
    }
    const feeQuote = spendQuote * ((Number(cfg.feePct) || 0.15) / 100);
    const netQuote = spendQuote - feeQuote;
    const qty = netQuote / price;
    state.paperBalance -= spendQuote;

    bot.position = {
      symbol: sym,
      base,
      quote,
      mode: "paper",
      qty,
      entryPrice: price,
      costQuote: spendQuote,
      entryTime: Date.now(),
      highestPrice: price,
      stopLossPrice: price * (1 - (Number(cfg.stopLossPct) || 1.5) / 100),
      takeProfitPrice: price * (1 + (Number(cfg.takeProfitPct) || 3.0) / 100),
      trailingActive: false,
      setupType: analysis.setupType
    };
  } else {
    const orderRes = await placeLiveOrder({ ...cfg, symbol: sym }, "BUY", { quoteOrderQty: spendQuote });
    await refreshLiveBalanceIfNeeded(true);
    const execQty = Number(orderRes?.data?.executedQty) || (spendQuote * 0.9985) / price;
    bot.position = {
      symbol: sym,
      base,
      quote,
      mode: "live",
      qty: execQty,
      entryPrice: price,
      costQuote: spendQuote,
      entryTime: Date.now(),
      highestPrice: price,
      stopLossPrice: price * (1 - (Number(cfg.stopLossPct) || 1.5) / 100),
      takeProfitPrice: price * (1 + (Number(cfg.takeProfitPct) || 3.0) / 100),
      trailingActive: false,
      setupType: analysis.setupType
    };
  }

  if (sym === state.config.symbol) state.position = bot.position;
  saveState();
  addLog(`BUY ${sym} (${cfg.mode.toUpperCase()}) @ ${price} | SL ${bot.position.stopLossPrice.toFixed(2)} | TP ${bot.position.takeProfitPrice.toFixed(2)}`);

  notify({
    kind: "BUY",
    title: `🟢 BUY ${sym} (${cfg.mode.toUpperCase()})`,
    description: aiDecision ? aiDecision.reason : analysis.signals.join("; "),
    fields: [
      { name: "Harga Masuk", value: String(price), inline: true },
      { name: "Stop Loss", value: `${bot.position.stopLossPrice.toFixed(2)} (-${cfg.stopLossPct}%)`, inline: true },
      { name: "Take Profit", value: `${bot.position.takeProfitPrice.toFixed(2)} (+${cfg.takeProfitPct}%)`, inline: true },
      { name: "Setup", value: analysis.setupType, inline: true }
    ]
  });
  return true;
}

async function closePosition(symbol, exitPrice, exitReason) {
  const sym = PARALLEL_SYMBOLS.includes(symbol) ? symbol : "BTCUSDT";
  const bot = state.bots[sym];
  const pos = bot ? bot.position : null;
  if (!pos) return false;
  const cfg = state.config;

  let pnlQuote = 0;
  let pnlPct = 0;

  if (pos.mode === "paper") {
    const grossProceeds = pos.qty * exitPrice;
    const feeQuote = grossProceeds * ((Number(cfg.feePct) || 0.15) / 100);
    const netProceeds = grossProceeds - feeQuote;
    pnlQuote = netProceeds - pos.costQuote;
    pnlPct = (pnlQuote / pos.costQuote) * 100;
    state.paperBalance += netProceeds;
  } else {
    await placeLiveOrder({ ...cfg, symbol: sym }, "SELL", { quantity: pos.qty });
    await refreshLiveBalanceIfNeeded(true);
    const grossProceeds = pos.qty * exitPrice;
    const feeQuote = grossProceeds * ((Number(cfg.feePct) || 0.15) / 100);
    pnlQuote = grossProceeds - feeQuote - pos.costQuote;
    pnlPct = (pnlQuote / pos.costQuote) * 100;
  }

  resetDailyIfNeeded();
  state.dailyPnlQuote += pnlQuote;

  const entryTs = pos.entryTime || Date.now();
  const exitTs = Date.now();
  const status = pnlQuote >= 0 ? "WIN" : "LOSS";
  syncTodayDailyHistory({ tradeStatus: status });
  const record = {
    time: formatDateTime(entryTs),
    exitTime: formatDateTime(exitTs),
    entryTimestamp: entryTs,
    exitTimestamp: exitTs,
    symbol: pos.symbol,
    mode: pos.mode,
    entryPrice: pos.entryPrice,
    exitPrice,
    qty: pos.qty,
    pnlQuote,
    pnlPct,
    reason: exitReason,
    status
  };

  state.history.unshift(record);
  if (state.history.length > 60) state.history.pop();
  bot.position = null;
  if (sym === state.config.symbol) state.position = null;

  // Cek batas rugi harian
  const maxDailyLossQuote = (Number(cfg.paperInitialBalance) || 1000) * ((Number(cfg.maxDailyLossPct) || 5) / 100);
  if (state.dailyPnlQuote <= -maxDailyLossQuote && state.running) {
    state.running = false;
    addLog(`AUTO-PAUSE: Batas rugi harian (${cfg.maxDailyLossPct}%) tercapai.`, "warn");
    notify({
      kind: "PAUSE",
      title: "⛔ AUTO-PAUSE: Batas Rugi Harian Tercapai",
      description: `PnL hari ini ${state.dailyPnlQuote.toFixed(2)} ${pos.quote} melewati batas -${cfg.maxDailyLossPct}%. Bot dihentikan.`
    });
  }

  saveState();
  addLog(`SELL ${pos.symbol} (${exitReason}) @ ${exitPrice} | ${status} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);

  notify({
    kind: status,
    title: `${status === "WIN" ? "🏆 WIN" : "❌ LOSS"} — SELL ${pos.symbol} (${exitReason})`,
    description: `Entry ${pos.entryPrice} → Exit ${exitPrice}`,
    fields: [
      { name: "PnL Bersih (setelah fee)", value: `${pnlQuote >= 0 ? "+" : ""}${pnlQuote.toFixed(2)} ${pos.quote} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`, inline: true },
      { name: "Saldo Paper", value: `${state.paperBalance.toFixed(2)} ${pos.quote}`, inline: true }
    ]
  });
  return true;
}

// ---------- Monitor Harga & TP / SL / Trailing Stop (Tiap 10 Detik, Paralel 3 Pair) ----------
async function checkBotPriceAndRisk(sym) {
  const bot = state.bots[sym] || (state.bots[sym] = createBotSlot(sym));
  try {
    const tick = await getTickerPrice(sym);
    bot.lastPrice = tick.price;
    bot.priceSource = tick.source;
    bot.lastUpdatedAt = Date.now();

    if (sym === state.config.symbol) {
      state.lastPrice = tick.price;
      state.priceSource = tick.source;
      state.lastUpdatedAt = bot.lastUpdatedAt;
    }

    if (Array.isArray(bot.candles) && bot.candles.length > 0) {
      const lastC = bot.candles[bot.candles.length - 1];
      lastC.close = tick.price;
      if (tick.price > lastC.high) lastC.high = tick.price;
      if (tick.price < lastC.low) lastC.low = tick.price;
    }

    const pos = bot.position;
    if (!pos) return;

    const p = tick.price;
    if (p > pos.highestPrice) {
      pos.highestPrice = p;
      const gainPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const trailAct = Number(state.config.trailingActivatePct) || 1.5;
      const trailPct = Number(state.config.trailingStopPct) || 0.8;
      if (gainPct >= trailAct) {
        const newSl = pos.highestPrice * (1 - trailPct / 100);
        if (newSl > pos.stopLossPrice) {
          pos.stopLossPrice = newSl;
          pos.trailingActive = true;
        }
      }
    }

    if (p >= pos.takeProfitPrice) {
      await closePosition(sym, p, "TAKE_PROFIT");
    } else if (p <= pos.stopLossPrice) {
      await closePosition(sym, p, pos.trailingActive ? "TRAILING_STOP" : "STOP_LOSS");
    }
  } catch (err) {
    addLog(`[${sym}] Gagal update harga: ${err.message}`, "warn");
  }
}

async function checkPriceAndRisk() {
  refreshUsdtIdrRate();
  refreshLiveBalanceIfNeeded(false);
  await Promise.allSettled(PARALLEL_SYMBOLS.map((sym) => checkBotPriceAndRisk(sym)));
}

// ---------- Scanner Strategi & AI Validator (Paralel 3 Pair: BTC, ETH, SOL) ----------
async function runMarketScan(manual = false, targetSymbol = null) {
  if (busyScan) return { ok: false, message: "Scan sedang berjalan." };
  busyScan = true;
  try {
    const now = Date.now();
    const isRecovery = state.aiGuard.locked && now >= state.aiGuard.retryAt;
    if (state.aiGuard.locked && !isRecovery && !manual) {
      return { ok: true, message: "AI dalam masa jeda recovery 90s." };
    }

    const targets = targetSymbol && PARALLEL_SYMBOLS.includes(targetSymbol) ? [targetSymbol] : PARALLEL_SYMBOLS;
    const cfg = state.config;

    // 1. Ambil klines & analisa teknikal untuk ke-3 pair secara paralel sekaligus
    const klineResults = await Promise.allSettled(
      targets.map(async (sym) => {
        const kl = await getKlines(sym, cfg.interval, 160);
        const bot = state.bots[sym] || (state.bots[sym] = createBotSlot(sym));
        bot.priceSource = kl.source;
        bot.candles = kl.candles.slice(-150);
        if (kl.candles.length > 0) {
          bot.lastPrice = kl.candles[kl.candles.length - 1].close;
          bot.lastUpdatedAt = now;
        }
        const analysis = analyzeCandles(kl.candles, Boolean(bot.position));
        bot.lastAnalysis = analysis;
        return { sym, kl, analysis, bot };
      })
    );

    const summaries = [];
    const aiQueue = [];

    for (let i = 0; i < targets.length; i++) {
      const sym = targets[i];
      const res = klineResults[i];
      if (res.status === "rejected") {
        const errMsg = res.reason?.message || "Gagal ambil candle";
        addLog(`[${sym}] Scan gagal: ${errMsg}`, "warn");
        summaries.push(`${sym}: ERR`);
        continue;
      }

      const { kl, analysis, bot } = res.value;
      if (!analysis.ready) {
        addLog(`[${sym}] ${analysis.reason}`, "warn");
        summaries.push(`${sym}: DATA KURANG`);
        continue;
      }

      if (!manual && !isRecovery && analysis.closedCandleTime === bot.lastClosedCandleTime) {
        summaries.push(`${sym}: ${analysis.trend} (WAIT)`);
        continue;
      }
      bot.lastClosedCandleTime = analysis.closedCandleTime;

      if (analysis.proposal === "WAIT") {
        const bbPct = analysis.bollinger ? Math.round(analysis.bollinger.percentB * 100) + "%" : "-";
        bot.lastAiDecision = {
          decision: "WAIT",
          confidence: 0,
          combinedScore: 0,
          systemProposal: "WAIT",
          systemScore: 0,
          risk: "LOW",
          reason: `[${sym}] ${analysis.trend} | RSI ${analysis.rsi.toFixed(1)} | %B ${bbPct} — ${analysis.warnings[0] || analysis.signals[0] || "Belum ada setup valid."}`,
          at: now
        };
        summaries.push(`${sym}: ${analysis.trend} (WAIT)`);
        continue;
      }

      aiQueue.push({ sym, kl, analysis, bot });
    }

    // 2. Validasi AI untuk pair yang punya sinyal BUY/SELL (atau recovery)
    for (const item of aiQueue) {
      const { sym, kl, analysis, bot } = item;
      const symCfg = { ...cfg, symbol: sym };
      const posView = bot.position
        ? {
          ...bot.position,
          unrealizedPct: ((bot.lastPrice - bot.position.entryPrice) / bot.position.entryPrice) * 100
        }
        : null;

      const idrRate = getActiveIdrRate();
      const dailyPnlIdr = (Number(state.dailyPnlQuote) || 0) * idrRate;
      const dailyTargetIdr = Math.max(0, Number(cfg.dailyTargetIdr) || 0);
      const aiContext = {
        dailyTargetIdr,
        dailyPnlIdr,
        dailyTargetAchieved: dailyTargetIdr > 0 && dailyPnlIdr >= dailyTargetIdr,
        recentHistory: Array.isArray(state.history) ? state.history.slice(0, 4) : [],
        recentCandles: Array.isArray(kl.candles) ? kl.candles.slice(-7, -1) : []
      };

      let aiRes;
      try {
        aiRes = await validateWithAI(symCfg, analysis, posView, aiContext);
      } catch (aiErr) {
        const wasLocked = state.aiGuard.locked;
        state.aiGuard.locked = true;
        state.aiGuard.reason = aiErr.message || "AI tidak merespons";
        state.aiGuard.retryAt = Date.now() + 90 * 1000;
        state.aiGuard.failCount += 1;
        addLog(`FAIL-SAFE AI (${sym}): ${state.aiGuard.reason} (cek ulang 90s)`, "error");
        if (!wasLocked || state.aiGuard.failCount % 3 === 0) {
          notify({
            kind: "AI_ERROR",
            title: "🛡️ BID DIHENTIKAN — Issue AI (90s)",
            description: state.aiGuard.reason
          });
        }
        summaries.push(`${sym}: AI ERR`);
        if (!manual) break;
        continue;
      }

      if (state.aiGuard.locked) {
        state.aiGuard = { locked: false, reason: "", retryAt: 0, failCount: 0 };
        addLog("AI pulih setelah recovery. Scheduler dilanjutkan.");
        notify({ kind: "RECOVERY", title: "✅ AI Pulih — Bot Aktif Kembali", description: "Koneksi AI kembali normal." });
      }

      const combinedScore =
        aiRes.decision === analysis.proposal && analysis.proposal !== "WAIT"
          ? Math.round(0.6 * analysis.score + 0.4 * aiRes.confidence)
          : 0;

      bot.lastAiDecision = {
        ...aiRes,
        combinedScore,
        systemProposal: analysis.proposal,
        systemScore: analysis.score,
        at: Date.now()
      };

      if (state.running || manual) {
        const minConf = Number(cfg.minConfidence) || 70;
        if (aiRes.decision === "BUY" && !bot.position && combinedScore >= minConf) {
          await openBuyPosition(sym, bot.lastPrice, analysis, bot.lastAiDecision);
        } else if (aiRes.decision === "SELL" && bot.position && combinedScore >= minConf) {
          await closePosition(sym, bot.lastPrice, analysis.setupType || "AI_EXIT");
        }
      }
      summaries.push(`${sym}: ${aiRes.decision} (${combinedScore}%)`);
    }

    if (manual) {
      addLog(`Scan Manual 3 Pair: ${summaries.join(" | ")}`);
    }

    saveState();
    return { ok: true, message: summaries.join(" | "), summaries };
  } catch (err) {
    addLog(`Error scan: ${err.message}`, "error");
    return { ok: false, message: err.message };
  } finally {
    busyScan = false;
  }
}

// ---------- HTTP Server Web Dashboard ----------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function extractToken(req) {
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (req.headers["x-auth-token"]) {
    return String(req.headers["x-auth-token"]).trim();
  }
  const cookies = req.headers["cookie"] || "";
  const match = cookies.match(/(?:^|;\s*)bot_session=([^;]+)/);
  if (match) return decodeURIComponent(match[1]).trim();
  return "";
}

function enrichBotPosition(bot, idrRate) {
  if (!bot || !bot.position) return { pos: null, valueQuote: 0 };
  const p = bot.position;
  const cur = bot.lastPrice || p.entryPrice;
  const feeRate = (Number(state.config.feePct) || 0.15) / 100;
  const grossValue = p.qty * cur;
  const netValue = grossValue * (1 - feeRate);
  const netPnlQuote = netValue - p.costQuote;
  const netPnlPct = p.costQuote > 0 ? (netPnlQuote / p.costQuote) * 100 : 0;
  const priceDiff = cur - p.entryPrice;
  const priceDiffPct = p.entryPrice > 0 ? (priceDiff / p.entryPrice) * 100 : 0;
  return {
    valueQuote: netValue,
    pos: {
      ...p,
      currentPrice: cur,
      currentValueQuote: netValue,
      currentValueIdr: netValue * idrRate,
      costIdr: p.costQuote * idrRate,
      priceDiff,
      priceDiffPct,
      unrealizedQuote: netPnlQuote,
      unrealizedIdr: netPnlQuote * idrRate,
      unrealizedPct: netPnlPct,
      pnlState: netPnlQuote > 0 ? "UNTUNG" : netPnlQuote < 0 ? "RUGI" : "IMPAS"
    }
  };
}

function sanitizeStateForClient(token) {
  const { quote } = splitSymbol(state.config.symbol);
  const idrRate = quote === "IDR" || quote === "BIDR" ? 1 : Number(state.usdtIdrRate) || 16250;
  let totalPositionValueQuote = 0;
  let activePositionsCount = 0;
  const enrichedBots = {};

  for (const sym of PARALLEL_SYMBOLS) {
    const rawBot = (state.bots && state.bots[sym]) || createBotSlot(sym);
    const { pos: bPos, valueQuote } = enrichBotPosition(rawBot, idrRate);
    totalPositionValueQuote += valueQuote;
    if (bPos) activePositionsCount += 1;
    enrichedBots[sym] = {
      ...rawBot,
      position: bPos
    };
  }

  const primarySym = PARALLEL_SYMBOLS.includes(state.config.symbol) ? state.config.symbol : "BTCUSDT";
  const primaryBot = enrichedBots[primarySym] || enrichedBots.BTCUSDT;

  const activeCashQuote =
    state.config.mode === "live" && state.liveQuoteBalance !== null
      ? Number(state.liveQuoteBalance)
      : Number(state.paperBalance) || 0;
  const totalEquityQuote = activeCashQuote + totalPositionValueQuote;

  const dailyPnlIdr = (Number(state.dailyPnlQuote) || 0) * idrRate;
  const dailyTargetIdr = Math.max(0, Number(state.config.dailyTargetIdr) || 0);
  const dailyTargetAchieved = dailyTargetIdr > 0 && dailyPnlIdr >= dailyTargetIdr;
  const dailyTargetProgressPct = dailyTargetIdr > 0 ? (dailyPnlIdr / dailyTargetIdr) * 100 : 0;

  // Pastikan rekap hari ini selalu sinkron di daftar dailyHistory untuk client
  const todayKey = state.dailyPnlDate || getLocalDateStr();
  const rawDaily = Array.isArray(state.dailyHistory) ? state.dailyHistory.slice() : [];
  const hasToday = rawDaily.some((d) => d.date === todayKey);
  if (!hasToday) {
    rawDaily.unshift({
      date: todayKey,
      targetIdr: dailyTargetIdr,
      targetQuote: idrRate > 0 ? dailyTargetIdr / idrRate : 0,
      pnlQuote: Number(state.dailyPnlQuote) || 0,
      pnlIdr: dailyPnlIdr,
      trades: 0,
      wins: 0,
      losses: 0,
      achieved: dailyTargetAchieved
    });
  } else {
    for (let i = 0; i < rawDaily.length; i++) {
      if (rawDaily[i].date === todayKey) {
        rawDaily[i] = {
          ...rawDaily[i],
          targetIdr: dailyTargetIdr,
          targetQuote: idrRate > 0 ? dailyTargetIdr / idrRate : 0,
          pnlQuote: Number(state.dailyPnlQuote) || 0,
          pnlIdr: dailyPnlIdr,
          achieved: dailyTargetAchieved
        };
      }
    }
  }

  return {
    ...state,
    auth: getAuthStatus(token),
    activeCashQuote,
    quoteCurrency: quote,
    idrRate,
    cashIdr: activeCashQuote * idrRate,
    totalEquityQuote,
    totalEquityIdr: totalEquityQuote * idrRate,
    dailyPnlIdr,
    dailyTargetIdr,
    dailyTargetAchieved,
    dailyTargetProgressPct,
    dailyHistory: rawDaily,
    symbols: [...PARALLEL_SYMBOLS],
    bots: enrichedBots,
    activePositionsCount,
    position: primaryBot.position,
    lastPrice: primaryBot.lastPrice,
    candles: primaryBot.candles,
    lastAnalysis: primaryBot.lastAnalysis,
    lastAiDecision: primaryBot.lastAiDecision
  };
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  const clientToken = extractToken(req);

  if (req.method === "GET" && urlPath === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(PUBLIC_HTML, "utf8"));
  }

  // --- Auth Endpoints (Tanpa Database) ---
  if (req.method === "POST" && urlPath === "/api/auth/login") {
    const body = await readBody(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const result = verifyPinLogin(body.pin, ip);
    if (!result.ok) {
      return sendJson(res, 401, result);
    }

    res.setHeader(
      "Set-Cookie",
      `bot_session=${result.token}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax; HttpOnly`
    );

    if (result.pinRotated) {
      addLog(`🔐 PIN telah digunakan 10x! PIN baru digenerate: ${result.currentPin}`);
      // Kirim email notifikasi PIN baru jika SMTP aktif
      if (state.config.smtpHost && (state.config.smtpTo || state.config.smtpUser)) {
        try {
          await sendPinEmail(state.config, {
            pin: result.currentPin,
            reason: "PIN berganti secara otomatis setelah mencapai 10x batas penggunaan login."
          });
          addLog(`📧 PIN baru telah dikirimkan ke email: ${state.config.smtpTo || state.config.smtpUser}`);
        } catch (mailErr) {
          addLog(`⚠️ Gagal mengirim email PIN baru: ${mailErr.message}`, "warn");
        }
      }

      try {
        await sendDiscord(state.config, {
          kind: "TEST",
          title: "🔐 PIN Akses Diperbarui (10x Tercapai)",
          description: `PIN lama (\`${result.oldPin}\`) telah digunakan 10 kali dan kini kadaluarsa.\n\n🔑 **PIN BARU:** \`${result.currentPin}\`\n\nPIN ini berlaku untuk 10 kali login berikutnya.`,
          fields: [
            { name: "Waktu Rotasi", value: new Date().toLocaleString("id-ID"), inline: true },
            { name: "Maksimal Pemakaian", value: "10 kali", inline: true }
          ]
        });
      } catch (_) {}
    }

    return sendJson(res, 200, result);
  }

  // Endpoint Reset PIN / Lupa PIN (Bisa diakses tanpa token)
  if (req.method === "POST" && urlPath === "/api/auth/reset-pin") {
    const body = await readBody(req);
    const reason = body.reason || "Permintaan Reset / Lupa PIN";
    const resData = resetPin(reason);
    let emailSent = false;
    let emailMsg = "";

    const recipient = String(body.email || state.config.smtpTo || state.config.smtpUser || "").trim();

    if (state.config.smtpHost && recipient) {
      try {
        await sendPinEmail(state.config, {
          pin: resData.newPin,
          reason: "Permintaan Reset PIN via Dashboard Web",
          recipient
        });
        emailSent = true;
        emailMsg = `PIN baru berhasil dikirim ke email: ${recipient}`;
        addLog(`📧 Reset PIN berhasil, dikirim ke: ${recipient}`);
      } catch (mailErr) {
        emailMsg = `PIN berhasil direset ke [${resData.newPin}], tetapi gagal kirim email: ${mailErr.message}`;
        addLog(`⚠️ Gagal mengirim email reset PIN: ${mailErr.message}`, "warn");
      }
    } else {
      emailMsg = `PIN berhasil direset ke: ${resData.newPin} (SMTP belum dikonfigurasi untuk kirim email)`;
      addLog(`🔐 PIN berhasil direset secara manual ke: ${resData.newPin}`);
    }

    return sendJson(res, 200, {
      ok: true,
      message: emailMsg,
      emailSent,
      newPin: resData.newPin
    });
  }

  if (req.method === "POST" && urlPath === "/api/auth/logout") {
    revokeSession(clientToken);
    res.setHeader("Set-Cookie", "bot_session=; Path=/; Max-Age=0; HttpOnly");
    return sendJson(res, 200, { ok: true, message: "Berhasil logout." });
  }

  if (req.method === "GET" && urlPath === "/api/auth/status") {
    return sendJson(res, 200, { ok: true, ...getAuthStatus(clientToken) });
  }

  // Middleware proteksi: semua API harus memiliki token valid
  if (urlPath.startsWith("/api/")) {
    if (!isValidSession(clientToken)) {
      return sendJson(res, 401, {
        ok: false,
        error: "UNAUTHORIZED",
        message: "Akses ditolak: PIN keamanan diperlukan atau sesi telah berakhir."
      });
    }
  }

  if (req.method === "GET" && urlPath === "/api/state") {
    return sendJson(res, 200, sanitizeStateForClient(clientToken));
  }

  if (req.method === "POST" && urlPath === "/api/config") {
    const body = await readBody(req);
    const prevSymbol = state.config.symbol;
    const prevInterval = state.config.interval;
    if (body.aiProvider === "ollama" || (!body.aiProvider && state.config.aiProvider === "ollama")) {
      if (body.aiEndpoint) body.aiEndpoint = normalizeOllamaEndpoint(body.aiEndpoint);
    }
    state.config = { ...state.config, ...body };
    state.aiGuard = { locked: false, reason: "", retryAt: 0, failCount: 0 };
    if (state.config.symbol !== prevSymbol || state.config.interval !== prevInterval) {
      state.lastClosedCandleTime = 0;
    }
    syncTodayDailyHistory();
    saveState();
    addLog(`Pengaturan diperbarui (${state.config.mode.toUpperCase()} • ${state.config.symbol} ${state.config.interval} • AI ${state.config.aiProvider}/${state.config.aiModel}).`);
    return sendJson(res, 200, { ok: true, config: state.config });
  }

  if (req.method === "POST" && urlPath === "/api/toggle") {
    state.running = !state.running;
    saveState();
    addLog(state.running ? "Bot dilanjutkan." : "Bot dijeda manual.");
    return sendJson(res, 200, { ok: true, running: state.running });
  }

  if (req.method === "POST" && urlPath === "/api/scan") {
    const body = await readBody(req);
    const sym = body.symbol && PARALLEL_SYMBOLS.includes(body.symbol) ? body.symbol : null;
    const result = await runMarketScan(true, sym);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && urlPath === "/api/manual-buy") {
    const body = await readBody(req);
    const sym = PARALLEL_SYMBOLS.includes(body.symbol) ? body.symbol : (PARALLEL_SYMBOLS.includes(state.config.symbol) ? state.config.symbol : "BTCUSDT");
    const bot = state.bots[sym] || (state.bots[sym] = createBotSlot(sym));
    if (bot.position) {
      return sendJson(res, 400, { ok: false, message: `Sudah ada posisi aktif di ${sym}. Jual dulu sebelum BUY baru.` });
    }
    if (!bot.lastPrice) {
      try {
        const tick = await getTickerPrice(sym);
        bot.lastPrice = tick.price;
        bot.priceSource = tick.source;
        bot.lastUpdatedAt = Date.now();
      } catch (err) {
        return sendJson(res, 400, { ok: false, message: `Harga live ${sym} belum tersedia: ` + err.message });
      }
    }
    const ok = await openBuyPosition(
      sym,
      bot.lastPrice,
      { setupType: "MANUAL_BUY", signals: ["Eksekusi BUY manual (bypass AI)"] },
      { reason: `BUY manual ${sym} dari Dashboard untuk uji simulasi & TP/SL.` }
    );
    if (!ok) {
      return sendJson(res, 400, { ok: false, message: "Gagal BUY (cek saldo paper atau log)." });
    }
    return sendJson(res, 200, { ok: true, message: `BUY manual ${sym} berhasil @ ${bot.lastPrice}` });
  }

  if (req.method === "POST" && urlPath === "/api/close-position") {
    const body = await readBody(req);
    const sym = PARALLEL_SYMBOLS.includes(body.symbol) ? body.symbol : (PARALLEL_SYMBOLS.includes(state.config.symbol) ? state.config.symbol : "BTCUSDT");
    const bot = state.bots[sym];
    if (!bot || !bot.position || !bot.lastPrice) {
      return sendJson(res, 400, { ok: false, message: `Tidak ada posisi aktif di ${sym}.` });
    }
    await closePosition(sym, bot.lastPrice, "MANUAL_CLOSE");
    return sendJson(res, 200, { ok: true, message: `Posisi ${sym} berhasil dijual manual.` });
  }

  if (req.method === "POST" && urlPath === "/api/test-ai") {
    const body = await readBody(req);
    const testCfg = {
      ...state.config,
      aiProvider: body.aiProvider || state.config.aiProvider,
      aiModel: (body.aiModel || state.config.aiModel || "").trim(),
      aiApiKey: (body.aiApiKey !== undefined ? body.aiApiKey : state.config.aiApiKey || "").trim(),
      aiEndpoint: (body.aiEndpoint || state.config.aiEndpoint || "").trim()
    };
    try {
      const r = await testAiConnection(testCfg);
      if (r.endpoint && testCfg.aiProvider === "ollama") {
        state.config.aiEndpoint = r.endpoint;
      }
      if (r.model) {
        state.config.aiModel = r.model;
      }
      state.aiGuard = { locked: false, reason: "", retryAt: 0, failCount: 0 };
      saveState();
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === "POST" && urlPath === "/api/test-tokocrypto") {
    const body = await readBody(req);
    const testCfg = {
      ...state.config,
      tokocryptoApiKey: (body.apiKey || state.config.tokocryptoApiKey || "").trim(),
      tokocryptoApiSecret: (body.apiSecret || state.config.tokocryptoApiSecret || "").trim()
    };
    try {
      const map = await getAccountBalances(testCfg);
      const { base, quote } = splitSymbol(state.config.symbol);
      const qFree = map[quote] ? map[quote].free : 0;
      const bFree = map[base] ? map[base].free : 0;
      state.liveQuoteBalance = qFree;
      state.liveBaseBalance = bFree;
      const idrFree = map.IDR ? map.IDR.free : map.BIDR ? map.BIDR.free : 0;
      const usdtFree = map.USDT ? map.USDT.free : 0;
      return sendJson(res, 200, {
        ok: true,
        message: `Terhubung ke Tokocrypto! Saldo Spot: ${qFree} ${quote} | ${bFree} ${base} (IDR: ${idrFree}, USDT: ${usdtFree})`
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === "POST" && urlPath === "/api/test-discord") {
    const body = await readBody(req);
    try {
      await sendDiscord(
        state.config,
        {
          kind: "TEST",
          title: "✅ Tes Webhook Tokocrypto AI Bot Berhasil!",
          description: "Notifikasi BUY, WIN/LOSS (TP/SL/Trailing), dan Issue AI siap masuk ke channel ini."
        },
        body.webhookUrl || state.config.discordWebhookUrl
      );
      return sendJson(res, 200, { ok: true, message: "Pesan tes berhasil dikirim ke Discord!" });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === "POST" && urlPath === "/api/test-smtp") {
    const body = await readBody(req);
    const testCfg = {
      ...state.config,
      smtpHost: (body.smtpHost || state.config.smtpHost || "").trim(),
      smtpPort: Number(body.smtpPort || state.config.smtpPort || 465),
      smtpUser: (body.smtpUser || state.config.smtpUser || "").trim(),
      smtpPass: (body.smtpPass !== undefined ? body.smtpPass : state.config.smtpPass || "").trim(),
      smtpFrom: (body.smtpFrom || state.config.smtpFrom || body.smtpUser || state.config.smtpUser || "").trim(),
      smtpTo: (body.smtpTo || state.config.smtpTo || body.smtpUser || state.config.smtpUser || "").trim()
    };
    try {
      await sendPinEmail(testCfg, {
        pin: getCurrentPin(),
        reason: "Tes Koneksi Email SMTP dari Web Dashboard",
        recipient: testCfg.smtpTo
      });
      return sendJson(res, 200, {
        ok: true,
        message: `Email tes berhasil terkirim ke ${testCfg.smtpTo}! PIN saat ini dikirimkan.`
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, message: err.message });
    }
  }

  if (req.method === "POST" && urlPath === "/api/reset-paper") {
    state.paperBalance = Number(state.config.paperInitialBalance) || 1000;
    state.position = null;
    for (const sym of PARALLEL_SYMBOLS) {
      if (state.bots[sym]) state.bots[sym].position = null;
    }
    state.history = [];
    state.dailyPnlQuote = 0;
    state.dailyHistory = [];
    syncTodayDailyHistory();
    saveState();
    addLog(`Saldo Paper Trading di-reset ke ${state.paperBalance}.`);
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Scheduler: cek harga & TP/SL tiap 10s, scan candle tiap 15s, kurs USD/IDR tiap 5 menit
setInterval(() => {
  checkPriceAndRisk();
}, 10000);

setInterval(() => {
  if (state.running) runMarketScan(false);
}, 15000);

setInterval(() => {
  refreshUsdtIdrRate(true);
}, 300000);

server.listen(PORT, "0.0.0.0", () => {
  addLog(`Tokocrypto AI Spot Bot aktif di http://0.0.0.0:${PORT}`);
  syncTodayDailyHistory();
  saveReports();
  refreshUsdtIdrRate(true);
  checkPriceAndRisk().then(() => {
    if (state.running) runMarketScan(false);
  });
});
