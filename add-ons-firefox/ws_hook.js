/**
 * Passive WebSocket Price Stream Reader (Page Context)
 * Membaca pesan WebSocket masuk (read-only) untuk mengekstrak harga live Stockity
 * tanpa memodifikasi koneksi atau data apa pun.
 */
(function () {
  "use strict";

  if (window.__STOCKITY_WS_HOOKED__) return;
  window.__STOCKITY_WS_HOOKED__ = true;

  const PRICE_KEYS = ["rate", "price", "quote", "last", "close", "ask", "bid", "p", "c", "value"];
  const SYMBOL_KEYS = ["ric", "symbol", "asset", "ticker", "pair", "instrument", "name", "s"];

  let totalMessages = 0;
  let totalTicksFound = 0;
  let lastStatusPost = 0;

  function isValidPrice(val) {
    if (typeof val === "string") {
      if (!/^\d+(\.\d+)?$/.test(val.trim())) return false;
      val = Number(val);
    }
    if (typeof val !== "number" || !Number.isFinite(val)) return false;
    if (val <= 0 || val > 1e9) return false;
    return true;
  }

  function extractTicks(node, inheritedSymbol, out, depth) {
    if (!node || depth > 8 || out.length >= 12) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        extractTicks(node[i], inheritedSymbol, out, depth + 1);
      }
      return;
    }

    if (typeof node !== "object") return;

    let sym = inheritedSymbol;
    for (const k of SYMBOL_KEYS) {
      if (typeof node[k] === "string" && node[k].length >= 2 && node[k].length <= 36) {
        sym = node[k];
        break;
      }
    }

    let foundPrice = null;
    for (const pk of PRICE_KEYS) {
      if (pk in node && isValidPrice(node[pk])) {
        const num = Number(node[pk]);
        if ((pk === "value" || pk === "c" || pk === "p") && Number.isInteger(num) && num < 100 && !sym) {
          continue;
        }
        foundPrice = num;
        break;
      }
    }

    if (foundPrice !== null && sym) {
      out.push({ symbol: sym, price: foundPrice });
    } else if (foundPrice !== null && ("rate" in node || "quote" in node || "price" in node)) {
      out.push({ symbol: sym || "LIVE", price: foundPrice });
    }

    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const child = node[key];
      if (child && typeof child === "object") {
        extractTicks(child, sym, out, depth + 1);
      }
    }
  }

  function tryParseMessage(raw) {
    if (typeof raw !== "string" || raw.length < 4) return null;
    const trimmed = raw.trim();
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        return null;
      }
    }
    const jsonStart = trimmed.search(/[\[{]/);
    if (jsonStart > 0 && jsonStart <= 6) {
      try {
        return JSON.parse(trimmed.slice(jsonStart));
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function postStatus(sample) {
    const now = Date.now();
    if (now - lastStatusPost < 2000) return;
    lastStatusPost = now;
    window.postMessage(
      {
        source: "STOCKITY_WS_STATUS",
        totalMessages,
        totalTicksFound,
        sample: sample || ""
      },
      "*"
    );
  }

  function processTextData(text) {
    totalMessages += 1;
    const parsed = tryParseMessage(text);
    if (!parsed) {
      postStatus(text.slice(0, 120));
      return;
    }

    const ticks = [];
    extractTicks(parsed, null, ticks, 0);
    if (ticks.length > 0) {
      totalTicksFound += ticks.length;
      window.postMessage(
        {
          source: "STOCKITY_WS_HOOK",
          ticks,
          ts: Date.now()
        },
        "*"
      );
    } else {
      postStatus(text.slice(0, 120));
    }
  }

  function handleWsData(data) {
    if (typeof data === "string") {
      processTextData(data);
    } else if (data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder("utf-8").decode(data);
        processTextData(text);
      } catch (_) {
        // Binary non-UTF8
      }
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.text().then(processTextData).catch(() => {});
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;

  function WrappedWebSocket(url, protocols) {
    const ws =
      protocols !== undefined
        ? new NativeWebSocket(url, protocols)
        : new NativeWebSocket(url);

    ws.addEventListener("message", function (event) {
      try {
        handleWsData(event.data);
      } catch (_) {
        // Jangan ganggu aliran asli halaman
      }
    });

    return ws;
  }

  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
  WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
  WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;

  try {
    Object.defineProperty(window, "WebSocket", {
      value: WrappedWebSocket,
      writable: true,
      configurable: true
    });
  } catch (_) {
    window.WebSocket = WrappedWebSocket;
  }
})();
