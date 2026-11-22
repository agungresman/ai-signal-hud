/**
 * Background Script Firefox (MV2)
 * Menggunakan Promise API native Firefox (`browser.*`) untuk storage & messaging.
 */
(function () {
  "use strict";

  const DEFAULT_CONFIG = {
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
  };

  async function getConfig() {
    const res = await browser.storage.local.get("aiConfig");
    const cfg = { ...DEFAULT_CONFIG, ...(res && res.aiConfig ? res.aiConfig : {}) };
    if (cfg.provider === "gemini" && (!cfg.model || cfg.model === "gemini-2.5-flash" || cfg.model === "gemini-2.0-flash")) {
      cfg.model = "gemini-3.8-flash";
    }
    return cfg;
  }

  async function saveConfig(next) {
    const merged = { ...DEFAULT_CONFIG, ...next };
    if (merged.provider === "ollama" && merged.customEndpoint) {
      merged.customEndpoint = normalizeOllamaEndpoint(merged.customEndpoint);
    }
    await browser.storage.local.set({ aiConfig: merged });
    return merged;
  }

  function formatSmallPct(val) {
    if (typeof val !== "number" || !Number.isFinite(val)) return "0";
    if (Math.abs(val) >= 0.01) return `${val.toFixed(4)}%`;
    // Untuk aset micro-pip (seperti Crypto IDX / Forex), tampilkan dalam ppm (1% = 10,000 ppm)
    const ppm = val * 10000;
    return `${val.toFixed(7)}% (${ppm >= 0 ? "+" : ""}${ppm.toFixed(2)} ppm)`;
  }

  function buildPrompt(snapshot, assetName, triggerReason, expirySeconds) {
    const conf = snapshot.confluence || {};
    const rsi = snapshot.rsi;
    const bb = snapshot.bollinger;
    const mom = snapshot.momentum;
    const proposal = conf.bias === "BUY_SETUP" ? "BUY" : conf.bias === "SELL_SETUP" ? "SELL" : "WAIT";

    const candles = (snapshot.candleSummary || [])
      .map((c) => `${c.color[0]}(${Math.round(c.bodyPct * 100)}%${c.rejection !== "NONE" ? "," + c.rejection[0] + "W" : ""})`)
      .join(" ");

    return `Validator sinyal trading ${expirySeconds || 60}s (${assetName || "-"}).
USULAN: ${proposal} | Setup: ${conf.setupType || "-"} | Skor: ${conf.score || 0}/92 | Regime: ${conf.regime || "-"}
Sinyal: ${(conf.signals || []).join("; ") || "-"}
Peringatan: ${(conf.warnings || []).join("; ") || "tidak ada"}
RSI(9): ${rsi ? `${rsi.value.toFixed(0)} (prev ${rsi.prev.toFixed(0)})` : "-"} | BB %B: ${bb ? Math.round(bb.percentB * 100) + "%" : "-"} | Tick: +${mom ? mom.upTicks : 0}/-${mom ? mom.downTicks : 0} | 4 Candle: ${candles || "-"}

Aturan: Jawab "${proposal}" jika sinyal searah dan tidak ada tanda bahaya, atau "WAIT" jika berisiko. Dilarang membalik arah.
Balas HANYA JSON: {"decision":"${proposal === "WAIT" ? "WAIT" : proposal + '"|"WAIT'}","confidence":0-100,"pattern":"singkat","risk":"LOW|MEDIUM|HIGH","reason":"1 kalimat Bahasa Indonesia"}`;
  }

  function extractJson(text) {
    if (!text) throw new Error("Respons AI kosong.");
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch && fenceMatch[1]) {
        return JSON.parse(fenceMatch[1].trim());
      }
      const braceMatch = trimmed.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        return JSON.parse(braceMatch[0]);
      }
      throw new Error("Format respons AI bukan JSON valid: " + trimmed.slice(0, 140));
    }
  }

  function normalizeDecision(raw) {
    const d = String(raw.decision || "WAIT").toUpperCase().trim();
    const decision = d === "BUY" || d === "SELL" || d === "WAIT" ? d : "WAIT";
    const confidence = Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0)));
    const riskRaw = String(raw.risk || "MEDIUM").toUpperCase().trim();
    const risk = ["LOW", "MEDIUM", "HIGH"].includes(riskRaw) ? riskRaw : "MEDIUM";
    return {
      decision,
      confidence,
      pattern: String(raw.pattern || "AI Technical Analysis").slice(0, 80),
      risk,
      reason: String(raw.reason || "Tidak ada keterangan tambahan.").slice(0, 320),
      timestamp: Date.now()
    };
  }

  async function fetchWithTimeout(url, options, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`AI_TIMEOUT: Tidak ada respons dari server AI dalam ${Math.round(timeoutMs / 1000)} detik.`);
      }
      throw new Error(`AI_NETWORK_ERROR: ${err && err.message ? err.message : "Koneksi ke AI gagal."}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestGeminiModel(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    }, 12000);
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  }

  async function callGemini(config, prompt) {
    if (!config.apiKey) throw new Error("API Key Gemini belum diisi di tab Pengaturan.");
    const primaryModel = (config.model || "gemini-3.8-flash").trim();
    const fallbackModels = [primaryModel, "gemini-3.5-flash-lite", "gemini-3.8-flash"]
      .filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    let lastError = "Gagal menghubungi Gemini.";

    for (let i = 0; i < fallbackModels.length; i++) {
      const model = fallbackModels[i];
      const { resp, data } = await requestGeminiModel(config.apiKey, model, prompt);

      if (resp.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const result = normalizeDecision(extractJson(text));
        result.modelUsed = model;
        return result;
      }

      const msg = data?.error?.message || `HTTP ${resp.status}`;
      lastError = `Gemini (${model}): ${msg}`;

      // Jika 429 (rate limit per model), 503 (high demand), atau 404 -> coba model cadangan (kuota model berbeda)
      if (resp.status === 429 || resp.status === 503 || resp.status === 404 || /high demand|overloaded|quota|rate|no longer available/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      throw new Error(lastError);
    }

    if (/429|quota|rate/i.test(lastError)) {
      throw new Error("RATE_LIMIT_429: Kuota sementara Gemini penuh, jeda otomatis 90 detik.");
    }
    throw new Error(lastError);
  }

  async function discoverOpenAIModel(endpoint, apiKey) {
    const modelsUrl = endpoint.replace(/\/chat\/completions\/?$/, "/models");
    const headers = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const resp = await fetchWithTimeout(modelsUrl, { method: "GET", headers }, 8000);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => ({}));
    const list = Array.isArray(data && data.data) ? data.data : [];
    const chatModels = list
      .map((m) => String(m && m.id ? m.id : ""))
      .filter(
        (id) =>
          id &&
          !/whisper|tts|audio|guard|embed|moderation|orpheus|playai|allam/i.test(id)
      );
    if (chatModels.length === 0) return null;

    // Prioritaskan model chat utama yang cepat & akurat
    const preferredPatterns = [
      /llama-4/i,
      /llama-3\.3/i,
      /llama-3\.1-8b-instant/i,
      /qwen/i,
      /gpt-oss/i,
      /deepseek/i,
      /llama/i
    ];
    for (const pat of preferredPatterns) {
      const hit = chatModels.find((id) => pat.test(id));
      if (hit) return hit;
    }
    return chatModels[0];
  }

  async function callOpenAICompatible(config, prompt, defaultUrl, defaultModel) {
    if (!config.apiKey && !config.customEndpoint.includes("localhost") && !config.customEndpoint.includes("127.0.0.1")) {
      throw new Error(`API Key ${config.provider.toUpperCase()} belum diisi di Pengaturan.`);
    }
    const endpoint = (config.customEndpoint || defaultUrl).trim();
    let model = (config.model || defaultModel).trim();

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const doRequest = async (modelName) => {
      const resp = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelName,
          temperature: 0.2,
          messages: [
            { role: "system", content: "Kamu adalah analis teknikal trading yang selalu membalas dengan JSON valid." },
            { role: "user", content: prompt }
          ]
        })
      }, 12000);
      const data = await resp.json().catch(() => ({}));
      return { resp, data };
    };

    let { resp, data } = await doRequest(model);

    // Jika model tidak tersedia / sudah deprecated (misal di Groq), otomatis cari model chat aktif dari akun user
    const errMsg = data?.error?.message || data?.message || "";
    if (!resp.ok && (resp.status === 404 || /does not exist|not found|decommissioned|no longer supported/i.test(errMsg))) {
      const discovered = await discoverOpenAIModel(endpoint, config.apiKey).catch(() => null);
      if (discovered && discovered !== model) {
        model = discovered;
        await saveConfig({ ...config, model });
        ({ resp, data } = await doRequest(model));
      }
    }

    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
      throw new Error(`AI API Error (${model}): ${msg}`);
    }

    const text = data?.choices?.[0]?.message?.content;
    const result = normalizeDecision(extractJson(text));
    result.modelUsed = model;
    return result;
  }

  function normalizeOllamaEndpoint(rawUrl) {
    let u = String(rawUrl || "http://localhost:11434/api/chat").trim();
    if (!u) u = "http://localhost:11434/api/chat";
    if (!/^https?:\/\//i.test(u)) {
      const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u);
      u = (isLocal ? "http://" : "https://") + u;
    }
    try {
      const parsed = new URL(u);
      if (!parsed.pathname || parsed.pathname === "/" || parsed.pathname === "") {
        parsed.pathname = "/api/chat";
      } else if (!/\/api\/(chat|generate)/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/api/chat";
      }
      return parsed.toString();
    } catch (_) {
      return u;
    }
  }

  function getOllamaBaseUrl(chatEndpoint) {
    const norm = normalizeOllamaEndpoint(chatEndpoint);
    return norm.replace(/\/api\/(chat|generate)\/?$/i, "");
  }

  async function listOllamaModels(chatEndpoint) {
    const base = getOllamaBaseUrl(chatEndpoint);
    const resp = await fetchWithTimeout(`${base}/api/tags`, { method: "GET" }, 10000);
    if (!resp.ok) return [];
    const data = await resp.json().catch(() => ({}));
    const models = Array.isArray(data && data.models) ? data.models : [];
    return models.map((m) => m.name || m.model).filter(Boolean);
  }

  async function requestOllamaChat(endpoint, model, prompt, timeoutMs) {
    const resp = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          options: {
            temperature: 0.1,
            num_predict: 110
          },
          messages: [
            { role: "system", content: "Kamu adalah analis teknikal trading yang selalu membalas dengan JSON valid." },
            { role: "user", content: prompt }
          ]
        })
      },
      timeoutMs
    );
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  }

  async function callOllama(config, prompt) {
    const endpoint = normalizeOllamaEndpoint(config.customEndpoint);
    let model = (config.model || "qwen2.5:3b").trim();
    const isRemote = !/localhost|127\.0\.0\.1/i.test(endpoint);
    const timeoutMs = isRemote ? 55000 : 20000;

    let resp, data;
    try {
      ({ resp, data } = await requestOllamaChat(endpoint, model, prompt, timeoutMs));
    } catch (err) {
      throw new Error(`Ollama (${endpoint}) tidak terjangkau: ${err && err.message ? err.message : "cek server/URL"}`);
    }

    if (resp.status === 403) {
      throw new Error("Ollama menolak izin CORS (403). Set environment variable OLLAMA_ORIGINS=\"*\" di server Ollama/Railway.");
    }

    // Jika model 404 / belum cocok, cek daftar model yang terpasang di /api/tags
    const errMsg = data?.error || "";
    if (!resp.ok && (resp.status === 404 || /not found|pull/i.test(errMsg))) {
      const installed = await listOllamaModels(endpoint).catch(() => []);
      if (installed.length === 0) {
        throw new Error(
          `Ollama aktif di ${getOllamaBaseUrl(endpoint)}, tapi belum ada model di-pull (/api/tags kosong).`
        );
      }
      const match = installed.find((m) => m.toLowerCase().includes(model.toLowerCase())) || installed[0];
      model = match;
      await saveConfig({ ...config, model, customEndpoint: endpoint });
      ({ resp, data } = await requestOllamaChat(endpoint, model, prompt, timeoutMs));
    }

    if (!resp.ok) {
      const msg = data?.error || `HTTP ${resp.status}`;
      throw new Error(`Ollama (${model}): ${msg}`);
    }

    const text = data?.message?.content || data?.response;
    const result = normalizeDecision(extractJson(text));
    result.modelUsed = model;
    return result;
  }

  async function testAiConnection(overrideCfg) {
    const saved = await getConfig();
    const cfg = { ...saved, ...(overrideCfg || {}) };
    const t0 = Date.now();

    if (cfg.provider === "ollama") {
      const endpoint = normalizeOllamaEndpoint(cfg.customEndpoint);
      const base = getOllamaBaseUrl(endpoint);
      const models = await listOllamaModels(endpoint).catch(() => []);

      if (models.length === 0) {
        const rootResp = await fetchWithTimeout(base, { method: "GET" }, 10000);
        if (rootResp.status === 403) {
          throw new Error(`Ollama di ${base} menolak CORS Firefox (403). Tambahkan env OLLAMA_ORIGINS="*" di Railway.`);
        }
        if (rootResp.ok) {
          throw new Error(`Server Ollama di ${base} AKTIF, tapi belum ada model terpasang (/api/tags kosong). Pull model dulu.`);
        }
        throw new Error(`Tidak dapat menghubungi Ollama di ${base} (HTTP ${rootResp.status}).`);
      }

      const chosenModel =
        models.find((m) => m.toLowerCase() === String(cfg.model || "").toLowerCase()) ||
        models.find((m) => m.toLowerCase().includes(String(cfg.model || "").toLowerCase())) ||
        models[0];

      const testPrompt = 'Balas HANYA JSON: {"decision":"WAIT","confidence":80,"pattern":"Test","risk":"LOW","reason":"Tes koneksi Ollama berhasil"}';
      const { resp, data } = await requestOllamaChat(endpoint, chosenModel, testPrompt, 55000);
      if (resp.status === 403) {
        throw new Error(`Ollama di ${base} menolak CORS Firefox (403). Tambahkan env OLLAMA_ORIGINS="*" di Railway.`);
      }
      if (!resp.ok) {
        throw new Error(`Gagal chat Ollama (${chosenModel}): ${data?.error || "HTTP " + resp.status}`);
      }
      const ms = Date.now() - t0;
      await saveConfig({ ...cfg, model: chosenModel, customEndpoint: endpoint });
      return {
        ok: true,
        endpoint,
        model: chosenModel,
        models,
        ms,
        message: `Terhubung ke Ollama! Model: ${chosenModel} (tersedia: ${models.join(", ")}) • ${ms}ms`
      };
    }

    // Tes provider Cloud (Gemini / Groq / OpenAI)
    const dummySnap = {
      candleSeconds: 15,
      confluence: { bias: "BUY_SETUP", setupType: "TEST", score: 75, regime: "TREND_UP", signals: ["Test"], warnings: [] },
      rsi: { value: 55, prev: 52 },
      bollinger: { percentB: 0.6 },
      momentum: { upTicks: 10, downTicks: 5 },
      candleSummary: [{ color: "GREEN", bodyPct: 0.6, rejection: "NONE" }]
    };
    await saveConfig(cfg);
    const out = await analyzeWithAI(dummySnap, "TestAsset", "TEST");
    const ms = Date.now() - t0;
    return {
      ok: true,
      model: out.modelUsed || cfg.model,
      ms,
      message: `Koneksi ${cfg.provider.toUpperCase()} (${out.modelUsed || cfg.model}) berhasil! Respon: ${out.decision} (${ms}ms)`
    };
  }

  async function analyzeWithAI(snapshot, assetName, triggerReason) {
    const config = await getConfig();
    const prompt = buildPrompt(snapshot, assetName, triggerReason, config.expirySeconds);

    switch (config.provider) {
      case "gemini":
        return callGemini(config, prompt);
      case "groq":
        return callOpenAICompatible(
          config,
          prompt,
          "https://api.groq.com/openai/v1/chat/completions",
          "llama-3.3-70b-versatile"
        );
      case "openai":
        return callOpenAICompatible(
          config,
          prompt,
          "https://api.openai.com/v1/chat/completions",
          "gpt-4o-mini"
        );
      case "ollama":
        return callOllama(config, prompt);
      default:
        throw new Error(`Provider AI tidak dikenal: ${config.provider}`);
    }
  }

  async function sendDiscordWebhook(payload, overrideUrl) {
    const config = await getConfig();
    const url = String(overrideUrl !== undefined ? overrideUrl : config.discordWebhookUrl || "").trim();
    if (!url) return { ok: false, skipped: true, error: "Discord Webhook URL belum diisi." };
    if (!overrideUrl && !config.discordNotify) return { ok: false, skipped: true };

    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url)) {
      throw new Error("Format URL Discord Webhook tidak valid (harus diawali https://discord.com/api/webhooks/...).");
    }

    const colorMap = {
      WIN: 0x10b981,
      RECOVERY: 0x10b981,
      ORDER: 0x38bdf8,
      TEST: 0x38bdf8,
      DRAW: 0x94a3b8,
      LOSS: 0xf43f5e,
      AI_ERROR: 0xf43f5e,
      PAUSE: 0xf59e0b
    };

    const embed = {
      title: String(payload.title || "Stockity AI Signal").slice(0, 200),
      description: String(payload.description || "").slice(0, 1500),
      color: colorMap[payload.kind] || 0x38bdf8,
      fields: Array.isArray(payload.fields) ? payload.fields.slice(0, 10) : [],
      footer: { text: "Stockity AI Signal HUD" },
      timestamp: new Date().toISOString()
    };

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Stockity AI Bot",
          embeds: [embed]
        })
      },
      8000
    );

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Discord HTTP ${resp.status}${txt ? ": " + txt.slice(0, 100) : ""}`);
    }
    return { ok: true };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return undefined;

    if (message.type === "GET_CONFIG") {
      return getConfig().then((config) => ({ ok: true, config }));
    }

    if (message.type === "SAVE_CONFIG") {
      return saveConfig(message.config).then((config) => ({ ok: true, config }));
    }

    if (message.type === "ANALYZE_MARKET") {
      return analyzeWithAI(message.snapshot, message.assetName, message.triggerReason)
        .then((result) => ({ ok: true, result }))
        .catch((err) => ({ ok: false, error: err.message || String(err) }));
    }

    if (message.type === "TEST_AI") {
      return testAiConnection(message.config)
        .then((r) => r)
        .catch((err) => ({ ok: false, error: err.message || String(err) }));
    }

    if (message.type === "SEND_DISCORD") {
      return sendDiscordWebhook(message.payload)
        .then((r) => r)
        .catch((err) => ({ ok: false, error: err.message || String(err) }));
    }

    if (message.type === "TEST_DISCORD") {
      return sendDiscordWebhook(
        {
          kind: "TEST",
          title: "✅ Koneksi Discord Webhook Berhasil!",
          description: "Notifikasi WIN, LOSS, Order, AI Error, dan Auto-Pause dari Stockity AI Signal HUD siap dikirim ke channel ini."
        },
        message.webhookUrl
      )
        .then((r) => r)
        .catch((err) => ({ ok: false, error: err.message || String(err) }));
    }

    return undefined;
  });
})();
