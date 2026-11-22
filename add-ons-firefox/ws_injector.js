/**
 * Menyuntikkan ws_hook.js pada document_start khusus di domain Stockity
 * agar aliran harga live WebSocket tertangkap sejak awal koneksi.
 */
(function () {
  "use strict";

  if (!/stockity/i.test(location.hostname)) return;

  try {
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("ws_hook.js");
    script.async = false;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.onload = () => script.remove();
  } catch (_) {
    // Abaikan jika gagal inject
  }
})();
