"use strict";

const { fetchJsonWithTimeout } = require("./tokocrypto");

const COLORS = {
  BUY: 0x38bdf8,
  WIN: 0x10b981,
  LOSS: 0xf43f5e,
  AI_ERROR: 0xf43f5e,
  RECOVERY: 0x10b981,
  PAUSE: 0xf59e0b,
  TEST: 0x38bdf8
};

async function sendDiscord(config, { kind, title, description, fields = [] }, overrideUrl) {
  const url = String(overrideUrl !== undefined ? overrideUrl : config.discordWebhookUrl || "").trim();
  if (!url) return { ok: false, skipped: true, error: "Discord Webhook URL belum diisi." };
  if (!overrideUrl && !config.discordNotify) return { ok: false, skipped: true };

  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(url)) {
    throw new Error("URL Discord Webhook harus diawali https://discord.com/api/webhooks/...");
  }

  const res = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Tokocrypto AI Spot Bot",
        embeds: [
          {
            title: String(title || "Tokocrypto AI Bot").slice(0, 200),
            description: String(description || "").slice(0, 1500),
            color: COLORS[kind] || 0x38bdf8,
            fields: fields.slice(0, 10),
            footer: { text: `Mode: ${(config.mode || "paper").toUpperCase()} • ${config.symbol || "BTCUSDT"}` },
            timestamp: new Date().toISOString()
          }
        ]
      })
    },
    8000
  );

  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
  return { ok: true };
}

module.exports = { sendDiscord };
