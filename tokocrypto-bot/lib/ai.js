"use strict";

const { fetchJsonWithTimeout } = require("./tokocrypto");

/**
 * Normalisasi URL Ollama:
 * - "bootoh-ai-developmet.up.railway.app" -> "https://bootoh-ai-developmet.up.railway.app/api/chat"
 * - "localhost:11434" -> "http://localhost:11434/api/chat"
 */
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
  const res = await fetchJsonWithTimeout(`${base}/api/tags`, { method: "GET" }, 10000);
  if (!res.ok) return [];
  const models = Array.isArray(res.data?.models) ? res.data.models : [];
  return models.map((m) => m.name || m.model).filter(Boolean);
}

function buildSpotPrompt(config, analysis, position) {
  const posText = position
    ? `HOLD ${position.qty.toFixed(6)} @ ${position.entryPrice} (PnL ${position.unrealizedPct.toFixed(2)}%)`
    : "KOSONG (belum pegang koin)";

  return `Validator risiko Spot Trading Crypto (${config.symbol}, timeframe ${config.interval}).
Posisi saat ini: ${posText}
USULAN SISTEM: ${analysis.proposal} | Setup: ${analysis.setupType} | Skor: ${analysis.score}/95
Indikator (candle tutup):
- Tren: ${analysis.trend} (EMA9=${analysis.ema9.toFixed(2)}, EMA21=${analysis.ema21.toFixed(2)}, EMA50=${analysis.ema50.toFixed(2)})
- RSI(14): ${analysis.rsi.toFixed(1)} (prev ${analysis.rsiPrev.toFixed(1)})
- Bollinger %B: ${analysis.bollinger ? Math.round(analysis.bollinger.percentB * 100) + "%" : "-"}
- Volume: ${analysis.volRatio.toFixed(2)}x rata-rata | ATR: ${analysis.atrPct.toFixed(2)}% | Candle: ${analysis.candleColor} (${analysis.rejection})
- Sinyal: ${analysis.signals.join("; ") || "-"}
- Peringatan: ${analysis.warnings.join("; ") || "tidak ada"}

Aturan: Jawab "${analysis.proposal}" jika setup layak & risiko wajar, atau "WAIT" jika berisiko. Dilarang membalik arah usulan.
Balas HANYA JSON valid:
{"decision":"${analysis.proposal === "WAIT" ? "WAIT" : analysis.proposal + '"|"WAIT'}","confidence":0-100,"risk":"LOW|MEDIUM|HIGH","reason":"1-2 kalimat Bahasa Indonesia"}`;
}

function extractJson(text) {
  if (!text) throw new Error("Respons AI kosong.");
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) return JSON.parse(fence[1].trim());
    const brace = trimmed.match(/\{[\s\S]*\}/);
    if (brace) return JSON.parse(brace[0]);
    throw new Error("AI tidak membalas JSON valid.");
  }
}

function normalize(raw, proposal) {
  const d = String(raw.decision || "WAIT").toUpperCase().trim();
  const decision = d === proposal ? d : "WAIT";
  const confidence = Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0)));
  const riskRaw = String(raw.risk || "MEDIUM").toUpperCase().trim();
  const risk = ["LOW", "MEDIUM", "HIGH"].includes(riskRaw) ? riskRaw : "MEDIUM";
  return {
    decision,
    confidence,
    risk,
    reason: String(raw.reason || "-").slice(0, 260)
  };
}

async function callOllamaChat(endpoint, model, prompt, timeoutMs = 120000) {
  const headers = { "Content-Type": "application/json" };
  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        keep_alive: "24h", // Kunci model di RAM Railway agar tidak di-unload tiap 5 menit
        options: { temperature: 0.1, num_predict: 120 },
        messages: [
          { role: "system", content: "Validator risiko spot crypto. Balas HANYA JSON valid." },
          { role: "user", content: prompt }
        ]
      })
    },
    timeoutMs
  );
}

async function validateWithAI(config, analysis, position) {
  const prompt = buildSpotPrompt(config, analysis, position);
  const provider = config.aiProvider || "ollama";

  if (provider === "ollama") {
    const endpoint = normalizeOllamaEndpoint(config.aiEndpoint);
    let model = (config.aiModel || "qwen2.5:3b").trim();
    // Remote Ollama CPU (Railway) butuh waktu cold-start load model ke RAM (bisa 60-90 detik pada request awal)
    const isRemote = !/localhost|127\.0\.0\.1/i.test(endpoint);
    const timeoutMs = isRemote ? 120000 : 30000;

    let res = await callOllamaChat(endpoint, model, prompt, timeoutMs);

    // Jika model tidak ditemukan di server Ollama (404), cek model apa yang tersedia di /api/tags
    const errMsg = res.data?.error || res.data?.raw || "";
    if (!res.ok && (res.status === 404 || /not found|pull/i.test(errMsg))) {
      const installed = await listOllamaModels(endpoint).catch(() => []);
      if (installed.length === 0) {
        throw new Error(
          `Ollama aktif di ${getOllamaBaseUrl(endpoint)}, tapi belum ada model terpasang (/api/tags kosong) atau path salah. Detail: ${errMsg || "HTTP " + res.status}`
        );
      }
      const match = installed.find((m) => m.toLowerCase().includes(model.toLowerCase())) || installed[0];
      model = match;
      res = await callOllamaChat(endpoint, model, prompt, timeoutMs);
    }

    if (!res.ok) {
      const detail = res.data?.error || (typeof res.data?.raw === "string" ? res.data.raw.slice(0, 120) : "");
      throw new Error(`Ollama (${model} @ ${endpoint}): HTTP ${res.status}${detail ? " - " + detail : ""}`);
    }
    const text = res.data?.message?.content || res.data?.response;
    const out = normalize(extractJson(text), analysis.proposal);
    out.modelUsed = model;
    out.endpointUsed = endpoint;
    return out;
  }

  if (provider === "gemini") {
    if (!config.aiApiKey) throw new Error("Gemini API Key belum diisi.");
    const model = (config.aiModel || "gemini-3.8-flash").trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.aiApiKey)}`;
    const res = await fetchJsonWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        })
      },
      15000
    );
    if (!res.ok) throw new Error(`Gemini (${model}): ${res.data?.error?.message || "HTTP " + res.status}`);
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return normalize(extractJson(text), analysis.proposal);
  }

  const defaultUrl =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/openai/v1/chat/completions";
  const endpoint = (config.aiEndpoint || defaultUrl).trim();
  const model = (config.aiModel || (provider === "groq" ? "llama-3.1-8b-instant" : "gpt-4o-mini")).trim();
  if (!config.aiApiKey) throw new Error(`API Key ${provider.toUpperCase()} belum diisi.`);

  const res = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: "Validator risiko spot crypto. Balas HANYA JSON valid." },
          { role: "user", content: prompt }
        ]
      })
    },
    15000
  );
  if (!res.ok) throw new Error(`AI API (${model}): ${res.data?.error?.message || "HTTP " + res.status}`);
  const text = res.data?.choices?.[0]?.message?.content;
  return normalize(extractJson(text), analysis.proposal);
}

async function testAiConnection(config) {
  const t0 = Date.now();
  const provider = config.aiProvider || "ollama";
  if (provider === "ollama") {
    const endpoint = normalizeOllamaEndpoint(config.aiEndpoint);
    const base = getOllamaBaseUrl(endpoint);
    const models = await listOllamaModels(endpoint);
    const chosenModel =
      models.find((m) => m.toLowerCase() === String(config.aiModel || "").toLowerCase()) ||
      models[0] ||
      config.aiModel ||
      "qwen2.5:3b";

    if (models.length === 0) {
      // Cek root / apakah Ollama hidup tapi belum pull model
      const rootRes = await fetchJsonWithTimeout(base, { method: "GET" }, 10000);
      if (rootRes.ok) {
        throw new Error(
          `Server Ollama di ${base} AKTIF, tapi belum ada model yang di-pull (/api/tags masih kosong). Pull model dulu di Railway (misal qwen2.5:3b).`
        );
      }
      throw new Error(`Tidak bisa menghubungi Ollama di ${base} (HTTP ${rootRes.status}).`);
    }

    const isRemote = !/localhost|127\.0\.0\.1/i.test(endpoint);
    const timeoutMs = isRemote ? 120000 : 30000;

    const res = await callOllamaChat(
      endpoint,
      chosenModel,
      'Balas HANYA JSON: {"decision":"WAIT","confidence":80,"risk":"LOW","reason":"Koneksi Ollama berhasil"}',
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Gagal chat ke ${endpoint} (model ${chosenModel}): HTTP ${res.status} ${res.data?.error || ""}`);
    }
    const ms = Date.now() - t0;
    return {
      ok: true,
      endpoint,
      model: chosenModel,
      models,
      ms,
      message: `Terhubung ke Ollama (${endpoint})! Model aktif: ${chosenModel} (tersedia: ${models.join(", ")}) • Respon ${ms}ms`
    };
  }

  // Tes provider non-Ollama
  const dummyAnalysis = {
    proposal: "BUY",
    setupType: "TEST_CONNECTION",
    score: 75,
    trend: "UPTREND",
    ema9: 90000,
    ema21: 89500,
    ema50: 89000,
    rsi: 55,
    rsiPrev: 52,
    bollinger: { percentB: 0.6 },
    volRatio: 1.2,
    atrPct: 0.5,
    candleColor: "GREEN",
    rejection: "NONE",
    signals: ["Tes koneksi AI"],
    warnings: []
  };
  const out = await validateWithAI(config, dummyAnalysis, null);
  const ms = Date.now() - t0;
  return {
    ok: true,
    model: config.aiModel,
    ms,
    message: `Koneksi ${provider.toUpperCase()} (${config.aiModel}) berhasil! Respon: ${out.decision} (${out.confidence}%) dalam ${ms}ms`
  };
}

module.exports = { validateWithAI, normalizeOllamaEndpoint, testAiConnection };
