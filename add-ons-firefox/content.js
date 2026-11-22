/**
 * Content Script — Stockity AI Signal & Auto Engine HUD (Firefox)
 * - Auto-start saat halaman Stockity dibuka
 * - Membaca harga DOM -> Bollinger Bands & Momentum -> Smart Trigger -> Gemini AI
 * - Mendukung 2 mode: Full Auto (Auto-Signal + Auto-Click BUY/SELL) & Signal Only
 * - Pengaman: Min Confidence, Cooldown, Max Consecutive Losses, Max Trades/Sesi, Tombol STOP
 */
(function () {
  "use strict";

  if (globalThis.__STOCKITY_AI_HUD_LOADED__) return;

  const indicators = globalThis.StockityIndicators || window.StockityIndicators;
  if (!indicators) {
    console.error("[Stockity AI HUD] StockityIndicators belum termuat.");
    return;
  }
  const { MarketAnalyzer, evaluateSmartTrigger, parsePriceText, MIN_CLOSED_CANDLES } = indicators;
  globalThis.__STOCKITY_AI_HUD_LOADED__ = true;

  const STORAGE_KEYS = {
    price: `selector:price:${location.hostname}`,
    buy: `selector:buy:${location.hostname}`,
    sell: `selector:sell:${location.hostname}`
  };

  const analyzer = new MarketAnalyzer({ candleSeconds: 15, bbPeriod: 20, bbStdDev: 2, momentumPeriod: 10 });

  const state = {
    visible: false,
    minimized: false,
    activeTab: "signal",
    pickingTarget: null, // null | "price" | "buy" | "sell"
    autoDetecting: false,
    analyzing: false,
    paused: false,
    // Elemen DOM & WebSocket Price Source
    priceSource: "none", // "none" | "ws" | "dom"
    wsSymbols: [],
    selectedWsSymbol: null,
    priceEl: null,
    priceSelector: null,
    buyEl: null,
    buySelector: null,
    sellEl: null,
    sellSelector: null,
    // Timers & Observers
    observer: null,
    pollTimer: null,
    loopTimer: null,
    // Tracking waktu & pengaman risiko
    lastPrice: null,
    lastTickAt: 0,
    lastAiCallAt: 0,
    lastTradeAt: 0,
    lastEvaluatedSeq: -1,
    lastScanNote: "Menunggu candle tutup...",
    perfResetAt: 0,
    aiGuard: {
      locked: false,
      reason: "",
      retryAt: 0,
      failCount: 0
    },
    sessionTrades: 0,
    consecutiveLosses: 0,
    lastDecision: null,
    history: [],
    config: {
      provider: "gemini",
      apiKey: "",
      model: "gemini-3.8-flash",
      customEndpoint: "",
      candleSeconds: 15,
      autoAnalyze: true,
      triggerMode: "smart",
      aiMinGapSec: 30,
      heartbeatSec: 120,
      autoIntervalSec: 45,
      executionMode: "auto",
      minConfidence: 80,
      tradeCooldownSec: 65,
      maxConsecutiveLosses: 3,
      maxTradesPerSession: 15,
      expirySeconds: 60,
      soundAlert: true,
      discordWebhookUrl: "",
      discordNotify: true
    }
  };

  let hudEl = null;
  let hoveredEl = null;

  const PROVIDER_DEFAULTS = {
    gemini: { model: "gemini-3.8-flash", endpoint: "" },
    groq: { model: "llama-3.3-70b-versatile", endpoint: "https://api.groq.com/openai/v1/chat/completions" },
    openai: { model: "gpt-4o-mini", endpoint: "https://api.openai.com/openai/v1/chat/completions" },
    ollama: { model: "qwen2.5:3b", endpoint: "http://localhost:11434/api/chat" }
  };

  // --- Audio Beep (Web Audio API, tanpa file eksternal) ---
  function playAlertTone(type) {
    if (!state.config.soundAlert) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = type === "BUY" ? 780 : type === "SELL" ? 420 : 560;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {
      // Abaikan jika browser memblokir autoplay audio sebelum interaksi
    }
  }

  // --- Utility Selector ---
  function buildCssSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }
    const path = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.body && path.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
        part = `#${CSS.escape(current.id)}`;
        path.unshift(part);
        break;
      }
      const classes = Array.from(current.classList || [])
        .filter((c) => c && !c.startsWith("stockity-ai-") && c.length < 40)
        .slice(0, 2);
      if (classes.length > 0) {
        part += "." + classes.map((c) => CSS.escape(c)).join(".");
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(part);
      current = parent;
    }
    return path.join(" > ");
  }

  function resolveElement(el, selector) {
    if (el && document.contains(el)) return el;
    if (selector) {
      try {
        return document.querySelector(selector);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function setStatus(text, isError = false) {
    if (!hudEl) return;
    const el = hudEl.querySelector("#hud-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", Boolean(isError));
  }

  // --- Price Reader ---
  function readTargetPrice() {
    state.priceEl = resolveElement(state.priceEl, state.priceSelector);
    if (!state.priceEl) return;

    const raw = state.priceEl.textContent || state.priceEl.innerText || "";
    const price = parsePriceText(raw);
    if (price === null) return;

    if (state.lastPrice === null || price !== state.lastPrice) {
      const now = Date.now();
      state.lastPrice = price;
      state.lastTickAt = now;
      analyzer.addTick(price, now);
      evaluatePendingHistory(price);
      updateTelemetryUI();
    }
  }

  function attachPriceElement(el, selectorStr) {
    if (state.observer) state.observer.disconnect();
    if (state.pollTimer) clearInterval(state.pollTimer);

    state.priceSource = "dom";
    state.priceEl = el;
    state.priceSelector = selectorStr || buildCssSelector(el);
    if (state.priceSelector) {
      browser.storage.local.set({ [STORAGE_KEYS.price]: state.priceSelector });
    }

    analyzer.reset();
    state.lastPrice = null;

    state.observer = new MutationObserver(() => readTargetPrice());
    state.observer.observe(el, { childList: true, characterData: true, subtree: true });
    state.pollTimer = setInterval(readTargetPrice, 400);
    readTargetPrice();

    updateTargetButtonsUI();
    updateBannerUI();
    setStatus(`Harga DOM terhubung (${state.priceSelector}). Mengumpulkan tick...`);
  }

  function attachActionElement(kind, el, selectorStr) {
    const sel = selectorStr || buildCssSelector(el);
    if (kind === "buy") {
      state.buyEl = el;
      state.buySelector = sel;
      if (sel) browser.storage.local.set({ [STORAGE_KEYS.buy]: sel });
      setStatus(`Tombol BUY terhubung (${sel}).`);
    } else if (kind === "sell") {
      state.sellEl = el;
      state.sellSelector = sel;
      if (sel) browser.storage.local.set({ [STORAGE_KEYS.sell]: sel });
      setStatus(`Tombol SELL terhubung (${sel}).`);
    }
    updateTargetButtonsUI();
    updateBannerUI();
  }

  // --- DOM Picker (price | buy | sell) ---
  function startPicker(targetKind = "price") {
    ensureHudVisible();
    if (state.pickingTarget === targetKind) {
      stopPicker();
      return;
    }
    stopPicker();
    state.pickingTarget = targetKind;
    updateTargetButtonsUI();

    const labels = {
      price: "angka HARGA LIVE",
      buy: "tombol BUY / NAIK",
      sell: "tombol SELL / TURUN"
    };
    setStatus(`Arahkan kursor ke ${labels[targetKind]} di Stockity lalu klik (ESC untuk batal).`);

    document.addEventListener("mouseover", onPickerMouseOver, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKeyDown, true);
  }

  function stopPicker() {
    state.pickingTarget = null;
    if (hoveredEl) {
      hoveredEl.classList.remove("stockity-ai-picker-hover");
      hoveredEl = null;
    }
    document.removeEventListener("mouseover", onPickerMouseOver, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("keydown", onPickerKeyDown, true);
    updateTargetButtonsUI();
  }

  function onPickerMouseOver(e) {
    if (!state.pickingTarget) return;
    if (hudEl && hudEl.contains(e.target)) return;
    if (hoveredEl) hoveredEl.classList.remove("stockity-ai-picker-hover");
    hoveredEl = e.target;
    hoveredEl.classList.add("stockity-ai-picker-hover");
  }

  function onPickerClick(e) {
    if (!state.pickingTarget) return;
    if (hudEl && hudEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    const kind = state.pickingTarget;
    const el = e.target;
    stopPicker();

    if (kind === "price") {
      const parsed = parsePriceText(el.textContent || "");
      if (parsed === null) {
        setStatus("Elemen yang diklik tidak mengandung angka harga. Coba klik tepat pada angka harganya.", true);
        return;
      }
      attachPriceElement(el, buildCssSelector(el));
    } else {
      // Cari elemen tombol terdekat jika user klik span/icon di dalam button
      const clickable = el.closest("button, [role='button'], a") || el;
      attachActionElement(kind, clickable, buildCssSelector(clickable));
    }
  }

  function onPickerKeyDown(e) {
    if (e.key === "Escape") {
      stopPicker();
      setStatus("Pemilihan elemen dibatalkan.");
    }
  }

  // --- Auto-Detect Price Element ---
  function isClockOrTimeElement(el, text) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    const parentTag = el.parentElement ? (el.parentElement.tagName || "").toLowerCase() : "";
    if (/clock|timer|time|countdown/.test(tag + " " + cls + " " + parentTag)) return true;
    if (text && (text.includes(":") || /gmt|utc|am|pm/i.test(text))) return true;
    return false;
  }

  function autoDetectPriceElement(isSilent = false) {
    if (state.autoDetecting) return;
    state.autoDetecting = true;
    if (!isSilent) setStatus("Memindai DOM selama 3 detik untuk mencari angka harga live...");

    const counts = new Map();
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const node = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (!node || (hudEl && hudEl.contains(node))) continue;
        const txt = (node.textContent || "").trim();
        if (txt.length > 24 || txt.length < 2) continue;
        if (isClockOrTimeElement(node, txt)) continue;
        const val = parsePriceText(txt);
        if (val !== null) {
          counts.set(node, (counts.get(node) || 0) + 1);
        }
      }
    });

    obs.observe(document.body, { childList: true, characterData: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      state.autoDetecting = false;

      let bestEl = null;
      let bestScore = 0;
      for (const [el, count] of counts.entries()) {
        if (!document.contains(el)) continue;
        const penalty = el.children.length > 2 ? 0.5 : 1;
        const score = count * penalty;
        if (score > bestScore) {
          bestScore = score;
          bestEl = el;
        }
      }

      if (bestEl) {
        attachPriceElement(bestEl, buildCssSelector(bestEl));
      } else if (!isSilent) {
        setStatus("Harga belum terdeteksi otomatis. Klik '🎯 Harga' untuk memilih langsung di layar.", true);
      }
    }, 3000);
  }

  // --- Safe DOM Click Execution ---
  function triggerDomClick(el) {
    if (!el || !document.contains(el)) return false;
    try {
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.click();
      return true;
    } catch (_) {
      try {
        el.click();
        return true;
      } catch (__) {
        return false;
      }
    }
  }

  const AI_RECOVERY_WAIT_SEC = 90;

  function notifyDiscord(kind, title, description, fields = []) {
    if (!state.config.discordNotify || !state.config.discordWebhookUrl) return;
    browser.runtime
      .sendMessage({
        type: "SEND_DISCORD",
        payload: { kind, title, description, fields }
      })
      .catch(() => {});
  }

  function lockBidForAiFailure(reasonText) {
    const wasLocked = state.aiGuard.locked;
    state.aiGuard.locked = true;
    state.aiGuard.reason = String(reasonText || "AI tidak merespons").slice(0, 140);
    state.aiGuard.retryAt = Date.now() + AI_RECOVERY_WAIT_SEC * 1000;
    state.aiGuard.failCount += 1;
    updateBannerUI();
    setStatus(
      `🛡️ BID DIHENTIKAN: ${state.aiGuard.reason} — cek ulang AI otomatis dalam ${AI_RECOVERY_WAIT_SEC}s.`,
      true
    );
    // Kirim notif Discord saat pertama kali terkunci atau kelipatan 3 agar tidak spam
    if (!wasLocked || state.aiGuard.failCount % 3 === 0) {
      notifyDiscord(
        "AI_ERROR",
        "🛡️ BID DIHENTIKAN — Issue AI",
        state.aiGuard.reason,
        [
          { name: "Provider / Model", value: `${state.config.provider} / ${state.config.model}`, inline: true },
          { name: "Cek Ulang", value: `${AI_RECOVERY_WAIT_SEC} detik`, inline: true },
          { name: "Gagal Ke-", value: String(state.aiGuard.failCount), inline: true }
        ]
      );
    }
  }

  function unlockBidAfterRecovery() {
    const prevFail = state.aiGuard.failCount;
    state.aiGuard.locked = false;
    state.aiGuard.reason = "";
    state.aiGuard.retryAt = 0;
    state.aiGuard.failCount = 0;
    updateBannerUI();
    if (prevFail > 0) {
      notifyDiscord(
        "RECOVERY",
        "✅ AI Kembali Normal — Scheduler Lanjut",
        "Koneksi AI sudah pulih setelah jeda recovery. Scheduler & eksekusi bid aktif kembali.",
        [{ name: "Provider / Model", value: `${state.config.provider} / ${state.config.model}`, inline: true }]
      );
    }
  }

  const BREAKEVEN_WINRATE = 0.55; // payout ~83% -> impas di ~54.6%

  function getMinGapSec() {
    if (state.config.provider === "ollama") return 15;
    return Math.max(20, Number(state.config.aiMinGapSec) || 30);
  }

  /**
   * Gerbang keputusan: AI hanya boleh MENGONFIRMASI arah sistem atau MEMBATALKAN.
   * - Sistem tidak punya setup  -> WAIT (apa pun kata AI)
   * - AI beda arah / WAIT        -> WAIT
   * - AI setuju                  -> skor gabungan = 60% skor sistem + 40% confidence AI
   */
  function applyDecisionGate(aiResult, snap) {
    const conf = (snap && snap.confluence) || {};
    const sysDir = conf.bias === "BUY_SETUP" ? "BUY" : conf.bias === "SELL_SETUP" ? "SELL" : "WAIT";
    const final = {
      ...aiResult,
      aiDecision: aiResult.decision,
      aiConfidence: aiResult.confidence,
      systemDecision: sysDir,
      systemScore: conf.score || 0
    };

    if (sysDir === "WAIT") {
      final.decision = "WAIT";
      final.confidence = 0;
      final.pattern = conf.regime || "NO_SETUP";
      final.reason = `Tidak ada setup valid: ${(conf.blockers || [])[0] || "kondisi belum terpenuhi"}.`;
    } else if (aiResult.decision !== sysDir) {
      final.decision = "WAIT";
      final.confidence = 0;
      final.pattern = `${conf.setupType} (dibatalkan AI)`;
      final.reason = `AI tidak mengonfirmasi ${sysDir} (AI: ${aiResult.decision}) → batal entry. ${aiResult.reason}`;
    } else {
      final.decision = sysDir;
      final.confidence = Math.round(0.6 * (conf.score || 0) + 0.4 * aiResult.confidence);
      final.pattern = conf.setupType;
    }
    return final;
  }

  function maybeAutoExecute(result, requestStartedAt, isRecoveryCheck = false, snap = null) {
    if (isRecoveryCheck) {
      return { executed: false, note: "Recovery Check berhasil — bid dilanjutkan di siklus berikutnya" };
    }
    if (state.aiGuard.locked) {
      return { executed: false, note: "BID TERKUNCI (Fail-Safe AI Error)" };
    }
    if (state.paused) return { executed: false, note: "Sistem sedang PAUSE" };
    if (state.config.executionMode !== "auto") return { executed: false, note: "Mode Signal Only" };
    if (result.decision !== "BUY" && result.decision !== "SELL") return { executed: false, note: "AI WAIT" };

    const now = Date.now();
    // Stale Decision Guard: beri toleransi lebih panjang jika memakai Ollama remote (Railway CPU)
    const isRemoteOllama =
      state.config.provider === "ollama" &&
      state.config.customEndpoint &&
      !/localhost|127\.0\.0\.1/i.test(state.config.customEndpoint);
    const maxAiLatencyMs = isRemoteOllama ? 45000 : 12000;
    if (requestStartedAt && now - requestStartedAt > maxAiLatencyMs) {
      return { executed: false, note: `Dibatalkan: respons AI terlalu lambat (>${Math.round(maxAiLatencyMs / 1000)}s)` };
    }
    // Stale Feed Guard: tolak bid jika data harga Stockity macet (> 10 detik)
    if (state.lastTickAt > 0 && now - state.lastTickAt > 10000) {
      return { executed: false, note: "Dibatalkan: feed harga Stockity tidak update (>10s)" };
    }
    // Entry Timing Guard: sinyal hanya valid di awal candle baru (untuk Ollama remote beri batas penuh 1 candle)
    if (snap && snap.lastClosedAt && !isRemoteOllama) {
      const candleMs = (snap.candleSeconds || 15) * 1000;
      const intoNew = now - snap.lastClosedAt;
      if (intoNew > candleMs * 0.6) {
        return { executed: false, note: `Dibatalkan: sinyal basi (${Math.round(intoNew / 1000)}s setelah candle tutup)` };
      }
    }
    // Price Drift Guard: batal jika harga sudah berbalik atau sudah lari terlalu jauh
    const atr = snap && snap.confluence ? snap.confluence.atr : 0;
    if (atr > 0 && snap.lastClosedClose && state.lastPrice) {
      const drift = (state.lastPrice - snap.lastClosedClose) * (result.decision === "BUY" ? 1 : -1);
      if (drift < -0.4 * atr) return { executed: false, note: "Dibatalkan: harga sudah berbalik melawan sinyal" };
      if (drift > 0.8 * atr) return { executed: false, note: "Dibatalkan: harga sudah lari jauh (anti kejar harga)" };
    }

    const minConf = Number(state.config.minConfidence) || 80;
    if (result.confidence < minConf) {
      return { executed: false, note: `Skor gabungan ${result.confidence}% < batas ${minConf}%` };
    }

    const cooldownMs = Math.max(15, Number(state.config.tradeCooldownSec) || 65) * 1000;
    if (now - state.lastTradeAt < cooldownMs) {
      const rem = Math.ceil((cooldownMs - (now - state.lastTradeAt)) / 1000);
      return { executed: false, note: `Cooldown aktif (${rem}s lagi)` };
    }

    const maxLoss = Number(state.config.maxConsecutiveLosses) || 3;
    if (state.consecutiveLosses >= maxLoss) {
      state.paused = true;
      updateBannerUI();
      notifyDiscord("PAUSE", "⛔ AUTO-PAUSE: Stop Loss Beruntun", `Batas ${maxLoss}x LOSS beruntun tercapai. Bot dihentikan otomatis.`);
      return { executed: false, note: `Auto-Pause: ${state.consecutiveLosses}x LOSS beruntun` };
    }

    const maxTrades = Number(state.config.maxTradesPerSession) || 15;
    if (state.sessionTrades >= maxTrades) {
      state.paused = true;
      updateBannerUI();
      notifyDiscord("PAUSE", "⛔ AUTO-PAUSE: Batas Order Sesi", `Batas maksimal ${maxTrades} order per sesi tercapai.`);
      return { executed: false, note: `Auto-Pause: batas ${maxTrades} order sesi tercapai` };
    }

    const targetBtn =
      result.decision === "BUY"
        ? resolveElement(state.buyEl, state.buySelector)
        : resolveElement(state.sellEl, state.sellSelector);

    if (!targetBtn) {
      return {
        executed: false,
        note: `Tombol ${result.decision} belum dipilih (pilih dulu di HUD agar bisa auto-klik)`
      };
    }

    const ok = triggerDomClick(targetBtn);
    if (ok) {
      state.lastTradeAt = now;
      state.sessionTrades += 1;
      updateBannerUI();
      return { executed: true, note: `AUTO-KLIK ${result.decision} dieksekusi!`, entryPrice: state.lastPrice };
    }
    return { executed: false, note: `Gagal klik tombol ${result.decision}` };
  }

  // --- AI Analysis ---
  function requestAIAnalysis(triggerReason = "MANUAL", options = {}) {
    if (state.analyzing) return;
    const isRecovery = Boolean(options.isRecovery);
    const snap = analyzer.getSnapshot();
    if (!snap.currentPrice || snap.tickCount < 3) {
      if (triggerReason === "MANUAL") {
        setStatus("Data harga belum cukup (minimal 3 tick). Pastikan elemen harga terhubung.", true);
      }
      return;
    }

    const startedAt = Date.now();
    state.analyzing = true;
    state.lastAiCallAt = startedAt;
    updateAnalyzeButton();
    setStatus(isRecovery ? "🔄 Mengecek ulang respons AI setelah jeda 90s..." : `AI menganalisa (${triggerReason})...`);

    const assetName = document.title || location.hostname;
    browser.runtime
      .sendMessage({ type: "ANALYZE_MARKET", snapshot: snap, assetName, triggerReason })
      .then((res) => {
        state.analyzing = false;

        if (!res || !res.ok || !res.result) {
          const errMsg = res && res.error ? res.error : "AI tidak memberikan respons valid.";
          lockBidForAiFailure(errMsg);
          return;
        }

        const rawDecision = res.result;

        if (isRecovery || state.aiGuard.locked) {
          state.lastDecision = rawDecision;
          renderDecisionUI(rawDecision);
          unlockBidAfterRecovery();
          setStatus(`✅ AI kembali normal! Scheduler & bid aktif kembali.`);
          return;
        }

        const decision = applyDecisionGate(rawDecision, snap);
        state.lastDecision = decision;
        renderDecisionUI(decision);

        updateAnalyzeButton();
        if (decision.decision === "BUY" || decision.decision === "SELL") {
          playAlertTone(decision.decision);
          const exec = maybeAutoExecute(decision, startedAt, false, snap);
          // Di mode Full Auto, hanya catat ke Riwayat jika order benar-benar dieksekusi
          // agar daftar & statistik Riwayat 100% sinkron dengan list Perdagangan Stockity.
          if (exec.executed || state.config.executionMode !== "auto") {
            const entry = exec.entryPrice || state.lastPrice || snap.currentPrice;
            recordPrediction(decision, entry, exec.executed);
            if (exec.executed) {
              const expLabel = state.history[0] ? state.history[0].expiryLabel : "-";
              notifyDiscord(
                "ORDER",
                `${decision.decision === "BUY" ? "🟢" : "🔴"} ORDER ${decision.decision} DIEKSEKUSI`,
                decision.reason || "Order otomatis dieksekusi.",
                [
                  { name: "Aset", value: state.selectedWsSymbol || document.title || "Stockity", inline: true },
                  { name: "Harga Masuk", value: String(entry), inline: true },
                  { name: "Jam Tutup", value: expLabel, inline: true },
                  { name: "Skor / Pola", value: `${decision.confidence}% • ${decision.pattern}`, inline: true }
                ]
              );
            }
          }
          setStatus(`${decision.decision} (skor ${decision.confidence}%) — ${exec.note}`);
        } else {
          setStatus(`WAIT • ${decision.reason.slice(0, 140)}`);
        }
      })
      .catch((err) => {
        state.analyzing = false;
        const msg = err && err.message ? err.message : String(err);
        lockBidForAiFailure(`Koneksi AI gagal: ${msg}`);
      });
  }

  // --- WebSocket Live Tick Receiver (Untuk chart berbasis <canvas> seperti Stockity) ---
  function handleIncomingWsTicks(ticks, ts) {
    if (!Array.isArray(ticks) || ticks.length === 0) return;

    let listChanged = false;
    for (const item of ticks) {
      if (!item || typeof item.price !== "number" || !Number.isFinite(item.price)) continue;
      const sym = String(item.symbol || "LIVE");
      if (!state.wsSymbols.includes(sym)) {
        state.wsSymbols.push(sym);
        listChanged = true;
      }
      if (!state.selectedWsSymbol) {
        state.selectedWsSymbol = sym;
        listChanged = true;
      }
      // Prioritaskan feed WebSocket otomatis (terutama jika sebelumnya terhubung ke elemen jam/clock)
      const isWrongClockDom = state.priceSource === "dom" && isClockOrTimeElement(state.priceEl, state.priceEl ? state.priceEl.textContent : "");
      if ((state.priceSource !== "dom" || isWrongClockDom) && sym === state.selectedWsSymbol) {
        if (isWrongClockDom) {
          if (state.observer) state.observer.disconnect();
          if (state.pollTimer) clearInterval(state.pollTimer);
          state.priceEl = null;
          state.priceSelector = null;
          browser.storage.local.remove(STORAGE_KEYS.price).catch(() => {});
          analyzer.reset();
          state.lastPrice = null;
        }
        if (state.priceSource !== "ws") {
          state.priceSource = "ws";
          updateTargetButtonsUI();
          updateBannerUI();
          setStatus(`Harga live terhubung otomatis via WebSocket (${sym}).`);
        }
        if (state.lastPrice === null || item.price !== state.lastPrice) {
          const tickTs = ts || Date.now();
          state.lastPrice = item.price;
          state.lastTickAt = tickTs;
          analyzer.addTick(item.price, tickTs);
          evaluatePendingHistory(item.price);
          updateTelemetryUI();
        }
      }
    }

    if (listChanged) {
      renderWsSymbolSelect();
    }
  }

  function renderWsSymbolSelect() {
    if (!hudEl) return;
    const wrap = hudEl.querySelector("#hud-ws-wrap");
    const sel = hudEl.querySelector("#hud-ws-select");
    const label = hudEl.querySelector("#hud-price-source-label");
    if (!wrap || !sel) return;

    if (label) {
      label.textContent =
        state.priceSource === "ws"
          ? `Harga Live (WebSocket • ${state.selectedWsSymbol || "LIVE"})`
          : state.priceSource === "dom"
            ? "Harga Live (DOM)"
            : "Harga Live (Menunggu Stream...)";
    }

    if (state.wsSymbols.length === 0) {
      wrap.classList.add("hud-hidden");
      return;
    }

    wrap.classList.remove("hud-hidden");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const sym of state.wsSymbols) {
      const opt = document.createElement("option");
      opt.value = sym;
      opt.textContent = `Aset WS: ${sym}`;
      if (sym === state.selectedWsSymbol) opt.selected = true;
      sel.appendChild(opt);
    }
    if (prev && state.wsSymbols.includes(prev)) {
      sel.value = state.selectedWsSymbol || prev;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;
    if (data.source === "STOCKITY_WS_HOOK") {
      handleIncomingWsTicks(data.ticks, data.ts);
    } else if (data.source === "STOCKITY_WS_STATUS" && state.priceSource === "none") {
      setStatus(`WS aktif (${data.totalMessages} pesan), mencari format harga...`);
    }
  });

  // --- Smart Automation Loop (Berjalan otomatis + Fail-Safe Recovery 90s) ---
  function startAutomationLoop() {
    if (state.loopTimer) clearInterval(state.loopTimer);
    state.loopTimer = setInterval(() => {
      updateAnalyzeButton();
      if (state.lastPrice !== null) {
        evaluatePendingHistory(state.lastPrice);
      }

      if (state.paused || !state.config.autoAnalyze || state.analyzing) return;
      const hasPriceFeed = state.priceSource === "ws" || Boolean(state.priceEl);
      if (!hasPriceFeed || (!state.config.apiKey && state.config.provider !== "ollama")) return;

      const now = Date.now();

      // Mode Fail-Safe: jika AI error/429/timeout -> bid berhenti total, tunggu 90s lalu cek ulang AI
      if (state.aiGuard.locked) {
        updateBannerUI();
        if (now >= state.aiGuard.retryAt) {
          requestAIAnalysis("RECOVERY_CHECK", { isRecovery: true });
        }
        return;
      }

      const snap = analyzer.getSnapshot();
      const minClosed = MIN_CLOSED_CANDLES || 12;
      if (snap.closedCandleCount < minClosed) {
        state.lastScanNote = `Warm-up ${snap.closedCandleCount}/${minClosed} candle`;
        return;
      }

      // Evaluasi hanya 1x per candle yang baru TUTUP (anti-repaint, entry di awal candle)
      if (snap.closedSeq === state.lastEvaluatedSeq) return;
      state.lastEvaluatedSeq = snap.closedSeq;

      const elapsedSec = (now - state.lastAiCallAt) / 1000;

      if (state.config.triggerMode === "interval") {
        const interval = Math.max(15, Number(state.config.autoIntervalSec) || 30);
        if (elapsedSec < interval) {
          state.lastScanNote = "Menunggu interval berikutnya";
          return;
        }
        requestAIAnalysis("INTERVAL");
        return;
      }

      const trig = evaluateSmartTrigger(snap);
      if (!trig.shouldTrigger) {
        state.lastScanNote = `Tidak entry — ${trig.reason}`;
        return;
      }
      const minGap = getMinGapSec();
      if (elapsedSec < minGap) {
        state.lastScanNote = `Setup dilewati (jeda AI ${Math.ceil(minGap - elapsedSec)}s)`;
        return;
      }
      state.lastScanNote = `Setup: ${trig.reason}`;
      requestAIAnalysis(`SETUP: ${trig.reason}`);
    }, 1000);
  }

  // --- History & Winrate Evaluation (Sinkron dengan jam tutup FTT Stockity) ---
  function computeStockityExpiryAt(createdAt, expirySeconds) {
    const secDur = Math.max(10, Number(expirySeconds) || 60);
    // Di Stockity FTT (1 menit), order sebelum detik :30 tutup di menit berikutnya :00,
    // sedangkan order di detik >= :30 tutup di 2 menit berikutnya :00.
    if (secDur === 60) {
      const d = new Date(createdAt);
      const sec = d.getSeconds();
      const baseMinuteMs = Math.floor(createdAt / 60000) * 60000;
      return sec < 30 ? baseMinuteMs + 60000 : baseMinuteMs + 120000;
    }
    return createdAt + secDur * 1000;
  }

  function recordPrediction(result, entryPrice, isAutoExecuted) {
    const createdAt = Date.now();
    const expiryAt = computeStockityExpiryAt(createdAt, state.config.expirySeconds);
    const expStr = new Date(expiryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const item = {
      id: createdAt + Math.random(),
      createdAt,
      time: new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      expiryLabel: expStr,
      decision: result.decision,
      confidence: result.confidence,
      setupType: result.pattern,
      entryPrice,
      expiryAt,
      exitPrice: null,
      status: "PENDING",
      autoExecuted: Boolean(isAutoExecuted)
    };
    state.history.unshift(item);
    if (state.history.length > 50) state.history.pop();
    renderHistoryUI();
  }

  // Pengaman performa: jika winrate 10 order auto terakhir < breakeven -> pause otomatis
  function checkRollingPerformance() {
    const recent = state.history
      .filter((h) => h.autoExecuted && h.createdAt > state.perfResetAt && (h.status === "WIN" || h.status === "LOSS"))
      .slice(0, 10);
    if (recent.length < 8) return;
    const wr = recent.filter((h) => h.status === "WIN").length / recent.length;
    if (wr < BREAKEVEN_WINRATE && !state.paused) {
      state.paused = true;
      updateBannerUI();
      const pct = Math.round(wr * 100);
      setStatus(
        `AUTO-PAUSE: winrate ${recent.length} order terakhir ${pct}% < breakeven ~55%. Kondisi pasar sedang tidak cocok.`,
        true
      );
      notifyDiscord(
        "PAUSE",
        "⛔ AUTO-PAUSE: Winrate Di Bawah Breakeven",
        `Winrate ${recent.length} order terakhir turun ke ${pct}% (< 55%). Bot dijeda otomatis untuk menjaga saldo.`
      );
    }
  }

  function evaluatePendingHistory(currentPrice) {
    const now = Date.now();
    let updated = false;
    for (const item of state.history) {
      if (item.status === "PENDING" && now >= item.expiryAt) {
        item.exitPrice = currentPrice;
        const diff = currentPrice - item.entryPrice;
        if (diff === 0) {
          item.status = "DRAW";
        } else {
          const isWin = (item.decision === "BUY" && diff > 0) || (item.decision === "SELL" && diff < 0);
          item.status = isWin ? "WIN" : "LOSS";
        }

        const settled = state.history.filter((h) => h.status === "WIN" || h.status === "LOSS");
        const wins = settled.filter((h) => h.status === "WIN").length;
        const wrPct = settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0;
        const emoji = item.status === "WIN" ? "🏆" : item.status === "LOSS" ? "❌" : "➖";
        notifyDiscord(
          item.status,
          `${emoji} HASIL ${item.status} — ${item.decision}`,
          `Order ${item.time} → ${item.expiryLabel || "-"} selesai.`,
          [
            { name: "Aset", value: state.selectedWsSymbol || "Stockity", inline: true },
            { name: "Entry → Exit", value: `${item.entryPrice} → ${item.exitPrice}`, inline: true },
            { name: "Winrate Sesi", value: `${wins}W / ${settled.length - wins}L (${wrPct}%)`, inline: true }
          ]
        );

        if (item.autoExecuted && item.status !== "DRAW") {
          if (item.status === "WIN") {
            state.consecutiveLosses = 0;
          } else {
            state.consecutiveLosses += 1;
            const maxLoss = Number(state.config.maxConsecutiveLosses) || 3;
            if (state.consecutiveLosses >= maxLoss) {
              state.paused = true;
              updateBannerUI();
              setStatus(`AUTO-PAUSE: ${state.consecutiveLosses}x LOSS beruntun tercapai!`, true);
              notifyDiscord(
                "PAUSE",
                "⛔ AUTO-PAUSE: Stop Loss Beruntun",
                `Terjadi ${state.consecutiveLosses}x LOSS berturut-turut. Eksekusi otomatis dihentikan.`
              );
            }
          }
        }
        updated = true;
      }
    }
    if (updated) {
      checkRollingPerformance();
      renderHistoryUI();
    }
  }

  // --- UI Helpers ---
  function updateAnalyzeButton() {
    if (!hudEl) return;
    const btn = hudEl.querySelector("#hud-analyze-btn");
    const ticker = hudEl.querySelector("#hud-auto-ticker");
    if (!btn || !ticker) return;

    const isAutoRunning = Boolean(state.config.autoAnalyze && !state.paused);
    if (isAutoRunning) {
      btn.classList.add("hud-hidden");
      ticker.classList.remove("hud-hidden");
      ticker.classList.toggle("locked", Boolean(state.aiGuard.locked));

      const now = Date.now();
      if (state.analyzing) {
        ticker.textContent = state.aiGuard.locked
          ? "🔄 Mengecek ulang koneksi AI..."
          : "⏳ AI sedang menganalisa pasar...";
      } else if (state.aiGuard.locked) {
        const rem = Math.max(0, Math.ceil((state.aiGuard.retryAt - now) / 1000));
        ticker.textContent = `🛡️ BID BERHENTI (AI Error) • Cek ulang AI dalam ${rem}s`;
      } else if (state.lastTradeAt > 0 && now - state.lastTradeAt < (Number(state.config.tradeCooldownSec) || 65) * 1000) {
        const rem = Math.ceil(((Number(state.config.tradeCooldownSec) || 65) * 1000 - (now - state.lastTradeAt)) / 1000);
        ticker.textContent = `🛡 Cooldown Order: ${rem}s lagi`;
      } else {
        const elapsed = Math.floor((now - state.lastAiCallAt) / 1000);
        if (state.config.triggerMode === "smart") {
          const minGap = getMinGapSec();
          if (state.lastAiCallAt > 0 && elapsed < minGap) {
            ticker.textContent = `⚡ Jeda AI ${minGap - elapsed}s • ${state.lastScanNote}`;
          } else {
            ticker.textContent = `🔍 Scan tiap candle tutup • ${state.lastScanNote}`;
          }
        } else {
          const interval = Math.max(12, Number(state.config.autoIntervalSec) || 30);
          const rem = state.lastAiCallAt > 0 ? Math.max(0, interval - elapsed) : 0;
          ticker.textContent = `⚡ Auto-Analisa berikutnya: ${rem}s lagi`;
        }
      }
    } else {
      ticker.classList.add("hud-hidden");
      btn.classList.remove("hud-hidden");
      btn.disabled = state.analyzing;
      btn.textContent = state.analyzing ? "⏳ AI Menganalisa..." : "🤖 Analisa Manual";
    }
  }

  function updateTargetButtonsUI() {
    if (!hudEl) return;
    const pBtn = hudEl.querySelector("#hud-pick-price");
    const bBtn = hudEl.querySelector("#hud-pick-buy");
    const sBtn = hudEl.querySelector("#hud-pick-sell");

    if (pBtn) {
      const hasPrice = state.priceSource === "ws" || Boolean(state.priceEl);
      pBtn.classList.toggle("picking", state.pickingTarget === "price");
      pBtn.classList.toggle("linked", hasPrice);
      pBtn.textContent =
        state.pickingTarget === "price"
          ? "Klik Harga..."
          : state.priceSource === "ws"
            ? "⚡ WS Live ✓"
            : state.priceEl
              ? "🎯 Harga ✓"
              : "🎯 Harga";
    }
    if (bBtn) {
      bBtn.classList.toggle("picking", state.pickingTarget === "buy");
      bBtn.classList.toggle("linked", Boolean(resolveElement(state.buyEl, state.buySelector)));
      bBtn.textContent = state.pickingTarget === "buy" ? "Klik BUY..." : resolveElement(state.buyEl, state.buySelector) ? "🟢 BUY ✓" : "🟢 Tombol BUY";
    }
    if (sBtn) {
      sBtn.classList.toggle("picking", state.pickingTarget === "sell");
      sBtn.classList.toggle("linked", Boolean(resolveElement(state.sellEl, state.sellSelector)));
      sBtn.textContent = state.pickingTarget === "sell" ? "Klik SELL..." : resolveElement(state.sellEl, state.sellSelector) ? "🔴 SELL ✓" : "🔴 Tombol SELL";
    }
  }

  function updateBannerUI() {
    if (!hudEl) return;
    const banner = hudEl.querySelector("#hud-auto-banner");
    const title = hudEl.querySelector("#hud-banner-title");
    const sub = hudEl.querySelector("#hud-banner-sub");
    const stopBtn = hudEl.querySelector("#hud-stop-btn");
    const dot = hudEl.querySelector(".hud-dot");

    const modeLabel = state.config.executionMode === "auto" ? "FULL AUTO" : "SIGNAL ONLY";
    const trigLabel = state.config.triggerMode === "smart" ? "Smart Trigger" : `Interval ${state.config.autoIntervalSec}s`;

    banner.classList.remove("paused", "locked");

    if (state.paused || !state.config.autoAnalyze) {
      banner.classList.add("paused");
      title.textContent = "⏸ OTOMATIS DIJEDA";
      sub.textContent = `Mode: ${modeLabel} • Order sesi: ${state.sessionTrades}/${state.config.maxTradesPerSession}`;
      stopBtn.textContent = "▶ LANJUT";
      stopBtn.classList.add("resume");
      if (dot) {
        dot.classList.remove("live");
        dot.classList.add("paused");
      }
    } else if (state.aiGuard.locked) {
      banner.classList.add("locked");
      const rem = Math.max(0, Math.ceil((state.aiGuard.retryAt - Date.now()) / 1000));
      title.textContent = `🛡️ BID DIHENTIKAN (Cek AI: ${rem}s)`;
      sub.textContent = `AI gagal #${state.aiGuard.failCount} • Scheduler akan lanjut otomatis setelah AI pulih`;
      stopBtn.textContent = "⏹ STOP";
      stopBtn.classList.remove("resume");
      if (dot) {
        dot.classList.remove("live");
        dot.classList.add("paused");
      }
    } else {
      title.textContent = `⚡ ${modeLabel} AKTIF (${trigLabel})`;
      sub.textContent = `Min Conf: ${state.config.minConfidence}% • Order: ${state.sessionTrades}/${state.config.maxTradesPerSession} • Loss Beruntun: ${state.consecutiveLosses}`;
      stopBtn.textContent = "⏹ STOP";
      stopBtn.classList.remove("resume");
      if (dot) {
        dot.classList.remove("paused");
        dot.classList.toggle("live", state.priceSource === "ws" || Boolean(state.priceEl));
      }
    }
    updateAnalyzeButton();
  }

  function renderSparkline(snap) {
    if (!hudEl) return;
    const svg = hudEl.querySelector("#hud-sparkline");
    if (!svg) return;

    const prices = snap.recentPrices || [];
    if (prices.length < 2) {
      svg.innerHTML = "";
      return;
    }

    const bb = snap.bollinger;
    const allVals = [...prices];
    if (bb) allVals.push(bb.upper, bb.lower);

    const min = Math.min(...allVals);
    const max = Math.max(...allVals);
    const span = max - min || 1;
    const w = 310;
    const h = 54;
    const pad = 4;

    const mapY = (v) => pad + (h - pad * 2) * (1 - (v - min) / span);
    const points = prices
      .map((p, i) => `${((i / (prices.length - 1)) * w).toFixed(1)},${mapY(p).toFixed(1)}`)
      .join(" ");

    let bandsHtml = "";
    if (bb) {
      const yUp = mapY(bb.upper).toFixed(1);
      const yMid = mapY(bb.middle).toFixed(1);
      const yLow = mapY(bb.lower).toFixed(1);
      bandsHtml = `
        <line x1="0" y1="${yUp}" x2="${w}" y2="${yUp}" stroke="rgba(251,113,133,0.55)" stroke-dasharray="3 3" stroke-width="1"/>
        <line x1="0" y1="${yMid}" x2="${w}" y2="${yMid}" stroke="rgba(148,163,184,0.4)" stroke-dasharray="2 2" stroke-width="1"/>
        <line x1="0" y1="${yLow}" x2="${w}" y2="${yLow}" stroke="rgba(52,211,153,0.55)" stroke-dasharray="3 3" stroke-width="1"/>
      `;
    }

    svg.innerHTML = `${bandsHtml}<polyline fill="none" stroke="#38bdf8" stroke-width="2" points="${points}" />`;
  }

  function updateTelemetryUI() {
    if (!hudEl) return;
    const snap = analyzer.getSnapshot();

    const priceEl = hudEl.querySelector("#hud-price");
    if (priceEl && snap.currentPrice !== null) {
      priceEl.textContent = String(snap.currentPrice);
      priceEl.classList.remove("up", "down");
      if (snap.lastDelta > 0) priceEl.classList.add("up");
      else if (snap.lastDelta < 0) priceEl.classList.add("down");
    }

    const minC = MIN_CLOSED_CANDLES || 12;
    const warmText = `Butuh ${minC} candle`;
    const metaEl = hudEl.querySelector("#hud-tick-meta");
    if (metaEl) {
      const arrow = snap.lastDelta > 0 ? "▲" : snap.lastDelta < 0 ? "▼" : "•";
      const warm =
        snap.closedCandleCount < minC ? ` (Warm-up ${snap.closedCandleCount}/${minC} candle)` : " (Siap analisa)";
      metaEl.textContent = `${arrow} Tick: ${snap.tickCount} | Candle ${snap.candleSeconds}s tutup: ${snap.closedCandleCount}${warm}`;
    }

    const bbZoneEl = hudEl.querySelector("#hud-bb-zone");
    const bbPctEl = hudEl.querySelector("#hud-bb-pct");
    if (snap.bollinger) {
      bbZoneEl.textContent = snap.bollinger.squeeze ? "SQUEEZE" : snap.bollinger.zone.replace(/_/g, " ");
      bbPctEl.textContent = `%B: ${(snap.bollinger.percentB * 100).toFixed(0)}%`;
    } else {
      bbZoneEl.textContent = "Warm-up...";
      bbPctEl.textContent = warmText;
    }

    const momBiasEl = hudEl.querySelector("#hud-mom-bias");
    const momRocEl = hudEl.querySelector("#hud-mom-roc");
    if (snap.momentum) {
      momBiasEl.textContent = snap.momentum.bias.replace(/_/g, " ");
      momRocEl.textContent = `Tick ▲${snap.momentum.upTicks} ▼${snap.momentum.downTicks} | ${snap.momentum.streakDir} x${snap.momentum.streak}`;
    } else {
      momBiasEl.textContent = "Warm-up...";
      momRocEl.textContent = warmText;
    }

    const trendValEl = hudEl.querySelector("#hud-trend-val");
    const trendSubEl = hudEl.querySelector("#hud-trend-sub");
    if (trendValEl && trendSubEl) {
      const conf = snap.confluence;
      if (snap.trend && conf) {
        trendValEl.textContent = `${snap.trend.state.replace(/_/g, " ")} • ER ${snap.trend.er.toFixed(2)}`;
        trendSubEl.textContent =
          conf.bias === "NO_SETUP"
            ? "Tidak ada setup"
            : `${conf.bias.replace(/_/g, " ")} ${conf.setupType} (${conf.score})`;
      } else {
        trendValEl.textContent = "Warm-up...";
        trendSubEl.textContent = warmText;
      }
    }

    const rsiValEl = hudEl.querySelector("#hud-rsi-val");
    const rsiSubEl = hudEl.querySelector("#hud-rsi-sub");
    if (rsiValEl && rsiSubEl) {
      if (snap.rsi) {
        rsiValEl.textContent = `RSI ${snap.rsi.value.toFixed(1)}`;
        rsiSubEl.textContent = snap.rsi.zone.replace(/_/g, " ");
      } else {
        rsiValEl.textContent = "Warm-up...";
        rsiSubEl.textContent = warmText;
      }
    }

    renderSparkline(snap);
  }

  function renderDecisionUI(result) {
    if (!hudEl) return;
    const box = hudEl.querySelector("#hud-decision-box");
    const badge = hudEl.querySelector("#hud-decision-badge");
    const conf = hudEl.querySelector("#hud-decision-conf");
    const reason = hudEl.querySelector("#hud-decision-reason");
    const meta = hudEl.querySelector("#hud-decision-meta");

    box.classList.remove("BUY", "SELL", "WAIT");
    box.classList.add(result.decision);
    badge.classList.remove("BUY", "SELL", "WAIT");
    badge.classList.add(result.decision);

    const labelMap = {
      BUY: "🟢 BUY (NAIK)",
      SELL: "🔴 SELL (TURUN)",
      WAIT: "🟡 WAIT (TUNGGU)"
    };
    badge.textContent = labelMap[result.decision] || result.decision;
    conf.textContent = result.systemDecision ? `Skor ${result.confidence}%` : `Keyakinan ${result.confidence}%`;
    reason.textContent = result.reason;
    meta.textContent = result.systemDecision
      ? `Setup: ${result.pattern} • Sistem: ${result.systemDecision} (${result.systemScore}) • AI: ${result.aiDecision} (${result.aiConfidence}%)`
      : `Pola: ${result.pattern} • Risiko: ${result.risk}`;
  }

  function renderHistoryUI() {
    if (!hudEl) return;
    const list = hudEl.querySelector("#hud-history-list");
    const stats = hudEl.querySelector("#hud-history-stats");
    if (!list || !stats) return;

    const settled = state.history.filter((h) => h.status === "WIN" || h.status === "LOSS");
    const wins = settled.filter((h) => h.status === "WIN").length;
    const draws = state.history.filter((h) => h.status === "DRAW").length;
    const winrate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0;
    stats.textContent = `Evaluasi (${state.config.expirySeconds}s): ${wins}W / ${settled.length - wins}L / ${draws}D • Winrate ${winrate}% (impas ~55%)`;

    list.innerHTML = "";
    if (state.history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hud-subtext";
      empty.textContent = "Belum ada riwayat keputusan BUY/SELL dari AI.";
      list.appendChild(empty);
      return;
    }

    for (const h of state.history) {
      const row = document.createElement("div");
      row.className = "hud-history-item";

      const left = document.createElement("div");
      const autoTag = h.autoExecuted ? "[AUTO] " : "";
      const expInfo = h.expiryLabel ? ` → ${h.expiryLabel}` : "";
      const exitInfo = h.exitPrice !== null ? ` → ${h.exitPrice}` : "";
      left.textContent = `${h.time}${expInfo} • ${autoTag}${h.decision} (${h.confidence}%) @ ${h.entryPrice}${exitInfo}`;

      const right = document.createElement("span");
      right.className = `hud-tag ${h.status}`;
      right.textContent = h.status;

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    }
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    hudEl.querySelectorAll(".hud-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    hudEl.querySelector("#tab-signal").classList.toggle("hud-hidden", tabName !== "signal");
    hudEl.querySelector("#tab-history").classList.toggle("hud-hidden", tabName !== "history");
    hudEl.querySelector("#tab-settings").classList.toggle("hud-hidden", tabName !== "settings");
  }

  function populateSettingsForm() {
    if (!hudEl) return;
    hudEl.querySelector("#cfg-provider").value = state.config.provider;
    hudEl.querySelector("#cfg-apikey").value = state.config.apiKey || "";
    hudEl.querySelector("#cfg-model").value = state.config.model || "gemini-3.8-flash";
    hudEl.querySelector("#cfg-endpoint").value = state.config.customEndpoint || "";
    hudEl.querySelector("#cfg-exec-mode").value = state.config.executionMode || "auto";
    hudEl.querySelector("#cfg-trigger-mode").value = state.config.triggerMode || "smart";
    hudEl.querySelector("#cfg-min-conf").value = String(state.config.minConfidence || 80);
    hudEl.querySelector("#cfg-cooldown").value = String(state.config.tradeCooldownSec || 65);
    hudEl.querySelector("#cfg-max-loss").value = String(state.config.maxConsecutiveLosses || 3);
    hudEl.querySelector("#cfg-max-trades").value = String(state.config.maxTradesPerSession || 15);
    hudEl.querySelector("#cfg-candle").value = String(state.config.candleSeconds || 15);
    hudEl.querySelector("#cfg-expiry").value = String(state.config.expirySeconds || 60);
    hudEl.querySelector("#cfg-auto-analyze").checked = Boolean(state.config.autoAnalyze);
    hudEl.querySelector("#cfg-sound").checked = Boolean(state.config.soundAlert);
    hudEl.querySelector("#cfg-discord-url").value = state.config.discordWebhookUrl || "";
    hudEl.querySelector("#cfg-discord-notify").checked = state.config.discordNotify !== false;
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      panel.style.right = "auto";
      panel.style.left = `${origLeft}px`;
      panel.style.top = `${origTop}px`;
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const nextLeft = Math.max(0, Math.min(window.innerWidth - 100, origLeft + (e.clientX - startX)));
      const nextTop = Math.max(0, Math.min(window.innerHeight - 40, origTop + (e.clientY - startY)));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function createHud() {
    if (hudEl) return;

    hudEl = document.createElement("div");
    hudEl.id = "stockity-ai-hud";
    hudEl.innerHTML = `
      <div class="hud-header" id="hud-drag-handle">
        <div class="hud-title">
          <span class="hud-dot"></span>
          <span>Stockity AI Signal</span>
        </div>
        <div class="hud-header-actions">
          <button class="hud-icon-btn" id="hud-min-btn" title="Minimize">_</button>
          <button class="hud-icon-btn" id="hud-close-btn" title="Sembunyikan">✕</button>
        </div>
      </div>
      <div class="hud-body">
        <div class="hud-tabs">
          <button class="hud-tab active" data-tab="signal">Dashboard</button>
          <button class="hud-tab" data-tab="history">Riwayat</button>
          <button class="hud-tab" data-tab="settings">Pengaturan</button>
        </div>

        <div class="hud-section" id="tab-signal">
          <div class="hud-banner" id="hud-auto-banner">
            <div class="hud-banner-text">
              <div class="hud-banner-title" id="hud-banner-title">⚡ FULL AUTO AKTIF</div>
              <div class="hud-subtext" id="hud-banner-sub">Menunggu data harga...</div>
            </div>
            <button class="hud-stop-btn" id="hud-stop-btn">⏹ STOP</button>
          </div>

          <div class="hud-price-card">
            <div>
              <div class="hud-metric-label" id="hud-price-source-label">Harga Live (Menunggu Stream...)</div>
              <div class="hud-price-val" id="hud-price">--</div>
              <div class="hud-subtext" id="hud-tick-meta">Menunggu WebSocket / DOM harga...</div>
            </div>
          </div>

          <div class="hud-sparkline-wrap">
            <svg id="hud-sparkline" viewBox="0 0 310 54" preserveAspectRatio="none"></svg>
          </div>

          <div class="hud-grid">
            <div class="hud-metric">
              <div class="hud-metric-label">Trend (EMA 5/12)</div>
              <div class="hud-metric-val" id="hud-trend-val">--</div>
              <div class="hud-subtext" id="hud-trend-sub">--</div>
            </div>
            <div class="hud-metric">
              <div class="hud-metric-label">RSI (9)</div>
              <div class="hud-metric-val" id="hud-rsi-val">--</div>
              <div class="hud-subtext" id="hud-rsi-sub">--</div>
            </div>
            <div class="hud-metric">
              <div class="hud-metric-label">Bollinger Bands</div>
              <div class="hud-metric-val" id="hud-bb-zone">--</div>
              <div class="hud-subtext" id="hud-bb-pct">--</div>
            </div>
            <div class="hud-metric">
              <div class="hud-metric-label">Momentum</div>
              <div class="hud-metric-val" id="hud-mom-bias">--</div>
              <div class="hud-subtext" id="hud-mom-roc">--</div>
            </div>
          </div>

          <div class="hud-decision-box" id="hud-decision-box">
            <div class="hud-decision-top">
              <div class="hud-badge" id="hud-decision-badge">MENUNGGU AI</div>
              <div class="hud-conf-pill" id="hud-decision-conf">--%</div>
            </div>
            <div class="hud-reason" id="hud-decision-reason">Atur Provider AI (Ollama / Groq / Google / OpenAI) di tab Pengaturan. Setelah data candle cukup, AI otomatis menganalisa.</div>
            <div class="hud-meta-row" id="hud-decision-meta">Keputusan tervalidasi AI</div>
          </div>

          <div class="hud-btn-row">
            <button class="hud-btn primary hud-hidden" id="hud-analyze-btn">🤖 Analisa Manual</button>
            <div class="hud-auto-ticker" id="hud-auto-ticker">⚡ Auto-Scan Aktif...</div>
          </div>

          <div class="hud-status-bar" id="hud-status">Siap. Selalu uji coba di Akun Demo dulu!</div>
        </div>

        <div class="hud-section hud-hidden" id="tab-history">
          <div class="hud-subtext" id="hud-history-stats" style="margin-bottom:8px;">Belum ada evaluasi.</div>
          <div id="hud-history-list"></div>
          <button class="hud-btn" id="hud-clear-hist-btn" style="width:100%;margin-top:6px;">Hapus Riwayat & Reset Counter</button>
        </div>

        <div class="hud-section hud-hidden" id="tab-settings">
          <div class="hud-note-box">
            ⚠️ <strong>Penting:</strong> Uji coba dulu di <strong>Akun Demo</strong> Stockity sebelum memakai mode Full Auto.
          </div>

          <div class="hud-field hud-hidden" id="hud-ws-wrap">
            <label for="hud-ws-select">Sumber Aset WebSocket</label>
            <select id="hud-ws-select"></select>
          </div>

          <div class="hud-field">
            <label>Target Elemen DOM (Klik untuk pilih)</label>
            <div class="hud-btn-row" style="margin-bottom:4px;">
              <button class="hud-btn" id="hud-pick-price">🎯 Harga</button>
              <button class="hud-btn" id="hud-pick-buy">🟢 Tombol BUY</button>
              <button class="hud-btn" id="hud-pick-sell">🔴 Tombol SELL</button>
            </div>
            <button class="hud-btn" id="hud-auto-detect-btn" style="width:100%;">🔎 Auto-Cari Harga DOM</button>
          </div>

          <div class="hud-grid">
            <div class="hud-field">
              <label for="cfg-provider">Provider AI</label>
              <select id="cfg-provider">
                <option value="ollama">Ollama Lokal</option>
                <option value="groq">Groq</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI / Custom</option>
              </select>
            </div>
            <div class="hud-field">
              <label for="cfg-model">Model</label>
              <input type="text" id="cfg-model" placeholder="qwen2.5:3b" />
            </div>
          </div>
          <div class="hud-field">
            <label for="cfg-apikey">API Key (kosongkan jika Ollama Lokal)</label>
            <input type="password" id="cfg-apikey" placeholder="Masukkan API Key..." />
          </div>
          <div class="hud-field">
            <label for="cfg-endpoint">Custom Endpoint (opsional)</label>
            <input type="text" id="cfg-endpoint" placeholder="Kosongkan untuk default provider" />
          </div>
          <div class="hud-grid">
            <div class="hud-field">
              <label for="cfg-exec-mode">Mode Eksekusi</label>
              <select id="cfg-exec-mode">
                <option value="auto">Full Auto (Auto-Klik)</option>
                <option value="signal_only">Signal Only (Manual Klik)</option>
              </select>
            </div>
            <div class="hud-field">
              <label for="cfg-trigger-mode">Pemicu AI</label>
              <select id="cfg-trigger-mode">
                <option value="smart">Smart Trigger (Rekomendasi)</option>
                <option value="interval">Interval Waktu Tetap</option>
              </select>
            </div>
          </div>
          <div class="hud-grid">
            <div class="hud-field">
              <label for="cfg-min-conf">Min Confidence (%)</label>
              <input type="number" id="cfg-min-conf" min="50" max="99" value="80" />
            </div>
            <div class="hud-field">
              <label for="cfg-cooldown">Cooldown Order (detik)</label>
              <input type="number" id="cfg-cooldown" min="15" max="600" value="65" />
            </div>
          </div>
          <div class="hud-grid">
            <div class="hud-field">
              <label for="cfg-max-loss">Stop Loss Beruntun</label>
              <input type="number" id="cfg-max-loss" min="1" max="20" value="3" />
            </div>
            <div class="hud-field">
              <label for="cfg-max-trades">Max Order / Sesi</label>
              <input type="number" id="cfg-max-trades" min="1" max="100" value="15" />
            </div>
          </div>
          <div class="hud-grid">
            <div class="hud-field">
              <label for="cfg-candle">Candle (detik)</label>
              <input type="number" id="cfg-candle" min="3" max="300" value="15" />
            </div>
            <div class="hud-field">
              <label for="cfg-expiry">Expiry Cek Winrate (s)</label>
              <input type="number" id="cfg-expiry" min="10" max="600" value="60" />
            </div>
          </div>
          <div class="hud-check-row">
            <span>Jalan otomatis saat buka halaman</span>
            <input type="checkbox" id="cfg-auto-analyze" checked />
          </div>
          <div class="hud-check-row">
            <span>Notifikasi suara saat BUY / SELL</span>
            <input type="checkbox" id="cfg-sound" checked />
          </div>
          <div class="hud-field">
            <label for="cfg-discord-url">Discord Webhook URL (Notif WIN/LOSS/Error)</label>
            <input type="password" id="cfg-discord-url" placeholder="https://discord.com/api/webhooks/..." />
          </div>
          <div class="hud-check-row">
            <span>Kirim notifikasi ke Discord</span>
            <input type="checkbox" id="cfg-discord-notify" checked />
          </div>
          <div class="hud-btn-row">
            <button class="hud-btn" id="cfg-ai-test-btn">🤖 Tes AI</button>
            <button class="hud-btn" id="cfg-discord-test-btn">🧪 Tes Discord</button>
            <button class="hud-btn primary" id="cfg-save-btn">💾 Simpan</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(hudEl);
    makeDraggable(hudEl, hudEl.querySelector("#hud-drag-handle"));

    hudEl.querySelector("#hud-min-btn").addEventListener("click", () => {
      state.minimized = !state.minimized;
      hudEl.classList.toggle("minimized", state.minimized);
    });

    hudEl.querySelector("#hud-close-btn").addEventListener("click", () => {
      state.visible = false;
      hudEl.style.display = "none";
    });

    hudEl.querySelector("#hud-stop-btn").addEventListener("click", () => {
      state.paused = !state.paused;
      if (!state.paused) {
        state.consecutiveLosses = 0;
        state.perfResetAt = Date.now();
        if (!state.config.autoAnalyze) {
          state.config.autoAnalyze = true;
          browser.runtime.sendMessage({ type: "SAVE_CONFIG", config: state.config }).catch(() => {});
        }
      }
      updateBannerUI();
      setStatus(state.paused ? "Sistem dijeda manual." : "Sistem otomatis dilanjutkan.");
    });

    hudEl.querySelectorAll(".hud-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    hudEl.querySelector("#hud-pick-price").addEventListener("click", () => startPicker("price"));
    hudEl.querySelector("#hud-pick-buy").addEventListener("click", () => startPicker("buy"));
    hudEl.querySelector("#hud-pick-sell").addEventListener("click", () => startPicker("sell"));
    hudEl.querySelector("#hud-auto-detect-btn").addEventListener("click", () => autoDetectPriceElement(false));
    hudEl.querySelector("#hud-analyze-btn").addEventListener("click", () => requestAIAnalysis("MANUAL"));

    hudEl.querySelector("#hud-ws-select").addEventListener("change", (e) => {
      state.selectedWsSymbol = e.target.value;
      state.priceSource = "ws";
      state.lastPrice = null;
      analyzer.reset();
      renderWsSymbolSelect();
      updateTelemetryUI();
      setStatus(`Berpindah ke stream WebSocket: ${state.selectedWsSymbol}`);
    });

    hudEl.querySelector("#hud-clear-hist-btn").addEventListener("click", () => {
      state.history = [];
      state.sessionTrades = 0;
      state.consecutiveLosses = 0;
      renderHistoryUI();
      updateBannerUI();
    });

    hudEl.querySelector("#cfg-provider").addEventListener("change", (e) => {
      const def = PROVIDER_DEFAULTS[e.target.value];
      if (def) {
        hudEl.querySelector("#cfg-model").value = def.model;
        hudEl.querySelector("#cfg-endpoint").value = def.endpoint;
      }
    });

    hudEl.querySelector("#cfg-ai-test-btn").addEventListener("click", () => {
      const btn = hudEl.querySelector("#cfg-ai-test-btn");
      const testCfg = {
        provider: hudEl.querySelector("#cfg-provider").value,
        apiKey: hudEl.querySelector("#cfg-apikey").value.trim(),
        model: hudEl.querySelector("#cfg-model").value.trim(),
        customEndpoint: hudEl.querySelector("#cfg-endpoint").value.trim()
      };
      btn.disabled = true;
      btn.textContent = "⏳ Tes...";
      setStatus("Mengetes koneksi AI (untuk Railway CPU bisa 5-30 detik saat cold start)...");
      browser.runtime
        .sendMessage({ type: "TEST_AI", config: testCfg })
        .then((res) => {
          btn.disabled = false;
          btn.textContent = "🤖 Tes AI";
          if (res && res.ok) {
            if (res.endpoint) {
              hudEl.querySelector("#cfg-endpoint").value = res.endpoint;
              state.config.customEndpoint = res.endpoint;
            }
            if (res.model) {
              hudEl.querySelector("#cfg-model").value = res.model;
              state.config.model = res.model;
            }
            unlockBidAfterRecovery();
            setStatus(`✅ ${res.message}`);
          } else {
            setStatus(`❌ Gagal Tes AI: ${res && res.error ? res.error : "Unknown error"}`, true);
          }
        })
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = "🤖 Tes AI";
          setStatus(`❌ Error Tes AI: ${err && err.message ? err.message : String(err)}`, true);
        });
    });

    hudEl.querySelector("#cfg-discord-test-btn").addEventListener("click", () => {
      const url = hudEl.querySelector("#cfg-discord-url").value.trim();
      const btn = hudEl.querySelector("#cfg-discord-test-btn");
      if (!url) {
        setStatus("Masukkan Discord Webhook URL dulu sebelum tes.", true);
        return;
      }
      btn.disabled = true;
      btn.textContent = "⏳ Mengirim...";
      browser.runtime
        .sendMessage({ type: "TEST_DISCORD", webhookUrl: url })
        .then((res) => {
          btn.disabled = false;
          btn.textContent = "🧪 Tes Discord";
          if (res && res.ok) {
            setStatus("✅ Pesan tes berhasil dikirim ke Discord!");
          } else {
            setStatus(`Gagal kirim Discord: ${res && res.error ? res.error : "Unknown error"}`, true);
          }
        })
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = "🧪 Tes Discord";
          setStatus(`Error Discord: ${err && err.message ? err.message : String(err)}`, true);
        });
    });

    hudEl.querySelector("#cfg-save-btn").addEventListener("click", () => {
      const nextConfig = {
        ...state.config,
        provider: hudEl.querySelector("#cfg-provider").value,
        apiKey: hudEl.querySelector("#cfg-apikey").value.trim(),
        model: hudEl.querySelector("#cfg-model").value.trim() || "gemini-3.8-flash",
        customEndpoint: hudEl.querySelector("#cfg-endpoint").value.trim(),
        executionMode: hudEl.querySelector("#cfg-exec-mode").value,
        triggerMode: hudEl.querySelector("#cfg-trigger-mode").value,
        minConfidence: Math.max(50, Math.min(99, Number(hudEl.querySelector("#cfg-min-conf").value) || 80)),
        tradeCooldownSec: Math.max(15, Number(hudEl.querySelector("#cfg-cooldown").value) || 65),
        maxConsecutiveLosses: Math.max(1, Number(hudEl.querySelector("#cfg-max-loss").value) || 3),
        maxTradesPerSession: Math.max(1, Number(hudEl.querySelector("#cfg-max-trades").value) || 15),
        candleSeconds: Math.max(3, Number(hudEl.querySelector("#cfg-candle").value) || 15),
        expirySeconds: Math.max(10, Number(hudEl.querySelector("#cfg-expiry").value) || 60),
        autoAnalyze: hudEl.querySelector("#cfg-auto-analyze").checked,
        soundAlert: hudEl.querySelector("#cfg-sound").checked,
        discordWebhookUrl: hudEl.querySelector("#cfg-discord-url").value.trim(),
        discordNotify: hudEl.querySelector("#cfg-discord-notify").checked
      };

      state.config = nextConfig;
      analyzer.setCandleSeconds(nextConfig.candleSeconds);
      unlockBidAfterRecovery();
      updateBannerUI();

      browser.runtime
        .sendMessage({ type: "SAVE_CONFIG", config: nextConfig })
        .then((res) => {
          if (res && res.config && res.config.customEndpoint) {
            state.config.customEndpoint = res.config.customEndpoint;
            hudEl.querySelector("#cfg-endpoint").value = res.config.customEndpoint;
          }
          switchTab("signal");
          setStatus("Pengaturan AI & Otomatisasi tersimpan.");
        })
        .catch((err) => {
          setStatus(`Gagal simpan: ${err && err.message ? err.message : String(err)}`, true);
        });
    });

    populateSettingsForm();
    updateTargetButtonsUI();
    updateBannerUI();
    renderHistoryUI();
  }

  function ensureHudVisible() {
    if (!hudEl) createHud();
    state.visible = true;
    hudEl.style.display = "block";
  }

  function toggleHud() {
    if (!hudEl) {
      ensureHudVisible();
      return true;
    }
    state.visible = !state.visible;
    hudEl.style.display = state.visible ? "block" : "none";
    return state.visible;
  }

  // --- Bootstrap (Zero-Click Auto-Start) ---
  function init() {
    browser.runtime
      .sendMessage({ type: "GET_CONFIG" })
      .then((res) => {
        if (res && res.ok && res.config) {
          state.config = { ...state.config, ...res.config };
          analyzer.setCandleSeconds(state.config.candleSeconds);
          populateSettingsForm();
          updateBannerUI();
        }
      })
      .catch(() => {});

    const isStockityDomain = /stockity/i.test(location.hostname);
    if (isStockityDomain) {
      ensureHudVisible();
    }

    // Pulihkan selector DOM (harga, tombol BUY, tombol SELL) untuk domain ini
    browser.storage.local
      .get([STORAGE_KEYS.price, STORAGE_KEYS.buy, STORAGE_KEYS.sell])
      .then((res) => {
        const priceSel = res && res[STORAGE_KEYS.price];
        const buySel = res && res[STORAGE_KEYS.buy];
        const sellSel = res && res[STORAGE_KEYS.sell];

        if (priceSel || buySel || sellSel) {
          ensureHudVisible();
        }

        if (buySel) {
          state.buySelector = buySel;
          state.buyEl = resolveElement(null, buySel);
        }
        if (sellSel) {
          state.sellSelector = sellSel;
          state.sellEl = resolveElement(null, sellSel);
        }

        if (priceSel && !/clock|timer/i.test(priceSel)) {
          state.priceSelector = priceSel;
          const found = resolveElement(null, priceSel);
          if (found && !isClockOrTimeElement(found, found.textContent)) {
            attachPriceElement(found, priceSel);
          } else {
            setTimeout(() => {
              if (state.priceSource === "ws") return;
              const retryEl = resolveElement(null, priceSel);
              if (retryEl && !isClockOrTimeElement(retryEl, retryEl.textContent)) {
                attachPriceElement(retryEl, priceSel);
              }
            }, 2500);
          }
        } else if (priceSel && /clock|timer/i.test(priceSel)) {
          browser.storage.local.remove(STORAGE_KEYS.price).catch(() => {});
        }

        updateTargetButtonsUI();
        updateBannerUI();
      })
      .catch(() => {});

    startAutomationLoop();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return undefined;
    if (msg.type === "TOGGLE_HUD") {
      const shown = toggleHud();
      return Promise.resolve({
        ok: true,
        message: shown ? "Panel HUD ditampilkan." : "Panel HUD disembunyikan."
      });
    }
    if (msg.type === "START_PICKER") {
      startPicker("price");
      return Promise.resolve({ ok: true, message: "Klik angka harga di halaman." });
    }
    return undefined;
  });

  init();
})();
