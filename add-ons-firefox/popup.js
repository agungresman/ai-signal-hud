(function () {
  "use strict";

  const msgEl = document.getElementById("msg");

  async function ensureInjected(tabId) {
    await browser.tabs.insertCSS(tabId, { file: "hud.css" });
    await browser.tabs.executeScript(tabId, { file: "lib/indicators.js" });
    await browser.tabs.executeScript(tabId, { file: "content.js" });
  }

  async function sendToActiveTab(payload, closeAfter = false) {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0]) {
        msgEl.textContent = "Tidak ada tab aktif.";
        return;
      }
      const tabId = tabs[0].id;
      let res;
      try {
        res = await browser.tabs.sendMessage(tabId, payload);
      } catch (_) {
        // Content script belum aktif di tab ini (misal tab dibuka sebelum reload add-on) -> inject otomatis!
        await ensureInjected(tabId);
        res = await browser.tabs.sendMessage(tabId, payload);
      }
      msgEl.textContent = res && res.message ? res.message : "Panel aktif.";
      if (closeAfter) {
        window.close();
      }
    } catch (err) {
      msgEl.textContent = `Gagal: ${err && err.message ? err.message : String(err)}`;
    }
  }

  document.getElementById("toggleHudBtn").addEventListener("click", () => {
    sendToActiveTab({ type: "TOGGLE_HUD" }, true);
  });

  document.getElementById("pickBtn").addEventListener("click", () => {
    sendToActiveTab({ type: "START_PICKER" }, true);
  });
})();
