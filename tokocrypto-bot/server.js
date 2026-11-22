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

const { getKlines, getTickerPrice, getAccountBalances, placeLiveOrder, splitSymbol } = require("./lib/tokocrypto");
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
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_HTML = path.join(__dirname, "public", "index.html");

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
    dailyPnlDate: new Date().toISOString().slice(0, 10),
    position: null, // { symbol, qty, entryPrice, costQuote, entryTime, highestPrice, stopLossPrice, takeProfitPrice, trailingActive, setupType, mode }
    lastPrice: null,
    usdtIdrRate: 16250,
    priceSource: "-",
    lastUpdatedAt: 0,
    lastClosedCandleTime: 0,
    lastAnalysis: null,
    lastAiDecision: null,
    candles: [], // 60 candle terakhir untuk grafik candlestick di dashboard (in-memory)
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

async function refreshUsdtIdrRate() {
  if (Date.now() - lastIdrFetchAt < 300000) return;
  lastIdrFetchAt = Date.now();
  try {
    const tick = await getTickerPrice("USDTIDR");
    if (tick && tick.price > 10000 && tick.price < 25000) {
      state.usdtIdrRate = tick.price;
    }
  } catch (_) {
    if (!state.usdtIdrRate) state.usdtIdrRate = 16250;
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return {
        ...createInitialState(),
        ...parsed,
        config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
        aiGuard: { locked: false, reason: "", retryAt: 0, failCount: 0 }
      };
    }
  } catch (_) { }
  return createInitialState();
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const { candles, ...persisted } = state;
    fs.writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
  } catch (_) { }
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

function resetDailyIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate !== today) {
    state.dailyPnlDate = today;
    state.dailyPnlQuote = 0;
  }
}

function notify(payload) {
  sendDiscord(state.config, payload).catch((err) => {
    addLog(`Discord gagal: ${err.message}`, "warn");
  });
}

// ---------- Eksekusi BUY & SELL (Paper & Live) ----------
async function openBuyPosition(price, analysis, aiDecision) {
  const cfg = state.config;
  const { base, quote } = splitSymbol(cfg.symbol);
  const spendQuote = Number(cfg.orderSizeQuote) || 100;

  if (cfg.mode === "paper") {
    if (state.paperBalance < spendQuote) {
      addLog(`Saldo paper (${state.paperBalance.toFixed(2)} ${quote}) kurang dari order size (${spendQuote}).`, "warn");
      return false;
    }
    const feeQuote = spendQuote * ((Number(cfg.feePct) || 0.15) / 100);
    const netQuote = spendQuote - feeQuote;
    const qty = netQuote / price;
    state.paperBalance -= spendQuote;

    state.position = {
      symbol: cfg.symbol,
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
    const orderRes = await placeLiveOrder(cfg, "BUY", { quoteOrderQty: spendQuote });
    await refreshLiveBalanceIfNeeded(true);
    const execQty = Number(orderRes?.data?.executedQty) || state.liveBaseBalance || (spendQuote * 0.9985) / price;
    state.position = {
      symbol: cfg.symbol,
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

  saveState();
  addLog(`BUY ${cfg.symbol} (${cfg.mode.toUpperCase()}) @ ${price} | SL ${state.position.stopLossPrice.toFixed(2)} | TP ${state.position.takeProfitPrice.toFixed(2)}`);

  notify({
    kind: "BUY",
    title: `🟢 BUY ${cfg.symbol} (${cfg.mode.toUpperCase()})`,
    description: aiDecision ? aiDecision.reason : analysis.signals.join("; "),
    fields: [
      { name: "Harga Masuk", value: String(price), inline: true },
      { name: "Stop Loss", value: `${state.position.stopLossPrice.toFixed(2)} (-${cfg.stopLossPct}%)`, inline: true },
      { name: "Take Profit", value: `${state.position.takeProfitPrice.toFixed(2)} (+${cfg.takeProfitPct}%)`, inline: true },
      { name: "Setup", value: analysis.setupType, inline: true }
    ]
  });
  return true;
}

async function closePosition(exitPrice, exitReason) {
  const pos = state.position;
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
    await placeLiveOrder(cfg, "SELL", { quantity: pos.qty });
    await refreshLiveBalanceIfNeeded(true);
    const grossProceeds = pos.qty * exitPrice;
    const feeQuote = grossProceeds * ((Number(cfg.feePct) || 0.15) / 100);
    pnlQuote = grossProceeds - feeQuote - pos.costQuote;
    pnlPct = (pnlQuote / pos.costQuote) * 100;
  }

  resetDailyIfNeeded();
  state.dailyPnlQuote += pnlQuote;

  const status = pnlQuote >= 0 ? "WIN" : "LOSS";
  const record = {
    time: new Date(pos.entryTime).toLocaleTimeString(),
    exitTime: new Date().toLocaleTimeString(),
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
  state.position = null;

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

// ---------- Monitor Harga & TP / SL / Trailing Stop (Tiap 10 Detik) ----------
async function checkPriceAndRisk() {
  try {
    refreshUsdtIdrRate();
    refreshLiveBalanceIfNeeded(false);
    const tick = await getTickerPrice(state.config.symbol);
    state.lastPrice = tick.price;
    state.priceSource = tick.source;
    state.lastUpdatedAt = Date.now();

    // Update candle terakhir secara live agar grafik bergerak tiap 10 detik
    if (Array.isArray(state.candles) && state.candles.length > 0) {
      const lastC = state.candles[state.candles.length - 1];
      lastC.close = tick.price;
      if (tick.price > lastC.high) lastC.high = tick.price;
      if (tick.price < lastC.low) lastC.low = tick.price;
    }

    const pos = state.position;
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
      await closePosition(p, "TAKE_PROFIT");
    } else if (p <= pos.stopLossPrice) {
      await closePosition(p, pos.trailingActive ? "TRAILING_STOP" : "STOP_LOSS");
    }
  } catch (err) {
    addLog(`Gagal update harga: ${err.message}`, "warn");
  }
}

// ---------- Scanner Strategi & AI Validator ----------
async function runMarketScan(manual = false) {
  if (busyScan) return { ok: false, message: "Scan sedang berjalan." };
  busyScan = true;
  try {
    const cfg = state.config;
    const now = Date.now();

    // Cek Fail-Safe AI 90 detik
    const isRecovery = state.aiGuard.locked && now >= state.aiGuard.retryAt;
    if (state.aiGuard.locked && !isRecovery && !manual) {
      return { ok: true, message: "AI dalam masa jeda recovery 90s." };
    }

    const kl = await getKlines(cfg.symbol, cfg.interval, 80);
    state.priceSource = kl.source;
    state.candles = kl.candles.slice(-60);
    if (kl.candles.length > 0) {
      state.lastPrice = kl.candles[kl.candles.length - 1].close;
      state.lastUpdatedAt = now;
    }

    const analysis = analyzeCandles(kl.candles, Boolean(state.position));
    state.lastAnalysis = analysis;

    if (!analysis.ready) {
      addLog(analysis.reason, "warn");
      return { ok: true, message: analysis.reason };
    }

    // Jika otomatis (bukan manual & bukan recovery), analisa AI hanya 1x per candle baru tutup
    if (!manual && !isRecovery && analysis.closedCandleTime === state.lastClosedCandleTime) {
      return { ok: true, message: "Menunggu candle baru tutup." };
    }
    state.lastClosedCandleTime = analysis.closedCandleTime;

    // Jika tidak ada usulan BUY/SELL dari sistem matematis (dan bukan manual/recovery), hemat AI
    if (analysis.proposal === "WAIT" && !manual && !isRecovery) {
      state.lastAiDecision = {
        decision: "WAIT",
        confidence: 0,
        risk: "LOW",
        reason: analysis.warnings[0] || analysis.signals[0] || "Belum ada setup valid.",
        at: now
      };
      saveState();
      return { ok: true, message: "Tidak ada setup valid (WAIT)." };
    }

    const posView = state.position
      ? {
        ...state.position,
        unrealizedPct: ((state.lastPrice - state.position.entryPrice) / state.position.entryPrice) * 100
      }
      : null;

    let aiRes;
    try {
      aiRes = await validateWithAI(cfg, analysis, posView);
    } catch (aiErr) {
      const wasLocked = state.aiGuard.locked;
      state.aiGuard.locked = true;
      state.aiGuard.reason = aiErr.message || "AI tidak merespons";
      state.aiGuard.retryAt = Date.now() + 90 * 1000;
      state.aiGuard.failCount += 1;
      addLog(`FAIL-SAFE AI: ${state.aiGuard.reason} (cek ulang 90s)`, "error");
      if (!wasLocked || state.aiGuard.failCount % 3 === 0) {
        notify({
          kind: "AI_ERROR",
          title: "🛡️ BID DIHENTIKAN — Issue AI (90s)",
          description: state.aiGuard.reason
        });
      }
      saveState();
      return { ok: false, message: state.aiGuard.reason };
    }

    // AI berhasil merespons
    if (state.aiGuard.locked) {
      state.aiGuard = { locked: false, reason: "", retryAt: 0, failCount: 0 };
      addLog("AI pulih setelah recovery. Scheduler dilanjutkan.");
      notify({ kind: "RECOVERY", title: "✅ AI Pulih — Bot Aktif Kembali", description: "Koneksi AI kembali normal." });
      if (isRecovery) {
        saveState();
        return { ok: true, message: "Recovery AI berhasil." };
      }
    }

    const combinedScore =
      aiRes.decision === analysis.proposal && analysis.proposal !== "WAIT"
        ? Math.round(0.6 * analysis.score + 0.4 * aiRes.confidence)
        : 0;

    state.lastAiDecision = {
      ...aiRes,
      combinedScore,
      systemProposal: analysis.proposal,
      systemScore: analysis.score,
      at: Date.now()
    };

    if (state.running || manual) {
      const minConf = Number(cfg.minConfidence) || 70;
      if (aiRes.decision === "BUY" && !state.position && combinedScore >= minConf) {
        await openBuyPosition(state.lastPrice, analysis, state.lastAiDecision);
      } else if (aiRes.decision === "SELL" && state.position && combinedScore >= minConf) {
        await closePosition(state.lastPrice, analysis.setupType || "AI_EXIT");
      } else {
        addLog(`Scan selesai: Sistem=${analysis.proposal}(${analysis.score}) AI=${aiRes.decision}(${aiRes.confidence}%) -> Gabungan=${combinedScore}%`);
      }
    }

    saveState();
    return { ok: true, message: `Hasil: ${aiRes.decision} (skor ${combinedScore}%)` };
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

function sanitizeStateForClient(token) {
  const { quote } = splitSymbol(state.config.symbol);
  const idrRate = quote === "IDR" || quote === "BIDR" ? 1 : Number(state.usdtIdrRate) || 16250;
  let pos = null;
  let positionValueQuote = 0;

  if (state.position) {
    const p = state.position;
    const cur = state.lastPrice || p.entryPrice;
    const feeRate = (Number(state.config.feePct) || 0.15) / 100;
    const grossValue = p.qty * cur;
    const netValue = grossValue * (1 - feeRate);
    const netPnlQuote = netValue - p.costQuote;
    const netPnlPct = p.costQuote > 0 ? (netPnlQuote / p.costQuote) * 100 : 0;
    const priceDiff = cur - p.entryPrice;
    const priceDiffPct = p.entryPrice > 0 ? (priceDiff / p.entryPrice) * 100 : 0;
    positionValueQuote = netValue;

    pos = {
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
    };
  }

  const activeCashQuote =
    state.config.mode === "live" && state.liveQuoteBalance !== null
      ? Number(state.liveQuoteBalance)
      : Number(state.paperBalance) || 0;
  const totalEquityQuote = activeCashQuote + positionValueQuote;

  return {
    ...state,
    auth: getAuthStatus(token),
    activeCashQuote,
    quoteCurrency: quote,
    idrRate,
    cashIdr: activeCashQuote * idrRate,
    totalEquityQuote,
    totalEquityIdr: totalEquityQuote * idrRate,
    dailyPnlIdr: (Number(state.dailyPnlQuote) || 0) * idrRate,
    position: pos
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
    const result = await runMarketScan(true);
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && urlPath === "/api/manual-buy") {
    if (state.position) {
      return sendJson(res, 400, { ok: false, message: "Sudah ada posisi aktif. Jual dulu sebelum BUY baru." });
    }
    if (!state.lastPrice) {
      try {
        const tick = await getTickerPrice(state.config.symbol);
        state.lastPrice = tick.price;
        state.priceSource = tick.source;
        state.lastUpdatedAt = Date.now();
      } catch (err) {
        return sendJson(res, 400, { ok: false, message: "Harga live belum tersedia: " + err.message });
      }
    }
    const ok = await openBuyPosition(
      state.lastPrice,
      { setupType: "MANUAL_BUY", signals: ["Eksekusi BUY manual (bypass AI)"] },
      { reason: "BUY manual dari Dashboard untuk uji simulasi & TP/SL." }
    );
    if (!ok) {
      return sendJson(res, 400, { ok: false, message: "Gagal BUY (cek saldo paper atau log)." });
    }
    return sendJson(res, 200, { ok: true, message: `BUY manual berhasil @ ${state.lastPrice}` });
  }

  if (req.method === "POST" && urlPath === "/api/close-position") {
    if (!state.position || !state.lastPrice) {
      return sendJson(res, 400, { ok: false, message: "Tidak ada posisi aktif." });
    }
    await closePosition(state.lastPrice, "MANUAL_CLOSE");
    return sendJson(res, 200, { ok: true, message: "Posisi berhasil dijual manual." });
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
    state.history = [];
    state.dailyPnlQuote = 0;
    saveState();
    addLog(`Saldo Paper Trading di-reset ke ${state.paperBalance}.`);
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Scheduler: cek harga & TP/SL tiap 10s, scan candle tiap 15s
setInterval(() => {
  checkPriceAndRisk();
}, 10000);

setInterval(() => {
  if (state.running) runMarketScan(false);
}, 15000);

server.listen(PORT, "0.0.0.0", () => {
  addLog(`Tokocrypto AI Spot Bot aktif di http://0.0.0.0:${PORT}`);
  checkPriceAndRisk().then(() => {
    if (state.running) runMarketScan(false);
  });
});
