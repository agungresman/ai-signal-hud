"use strict";

const net = require("net");
const tls = require("tls");

function parseEmailAddress(str) {
  if (!str) return "";
  const match = str.match(/<([^>]+)>/);
  if (match) return match[1].trim();
  return str.trim();
}

/**
 * Kirim email via SMTP murni tanpa dependensi (mendukung Port 465 SSL/TLS dan Port 587 STARTTLS)
 */
function sendEmail(config, { to, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const host = String(config.smtpHost || process.env.SMTP_HOST || "").trim();
    const port = Number(config.smtpPort || process.env.SMTP_PORT || 465);
    const user = String(config.smtpUser || process.env.SMTP_USER || "").trim();
    const pass = String(config.smtpPass || process.env.SMTP_PASS || "").trim();
    const from = String(config.smtpFrom || process.env.SMTP_FROM || user).trim();
    const recipient = String(to || config.smtpTo || process.env.SMTP_TO || "").trim();
    const isDirectTls = config.smtpSecure !== false && port === 465;

    if (!host) return reject(new Error("SMTP Host belum dikonfigurasi."));
    if (!user || !pass) return reject(new Error("SMTP User atau Password belum diisi."));
    if (!recipient) return reject(new Error("Email penerima belum ditentukan."));

    const fromAddress = parseEmailAddress(from);
    const toAddress = parseEmailAddress(recipient);

    let socket;
    let step = 0;
    let buffer = "";
    let isTlsUpgraded = isDirectTls;
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP connection timed out (20 detik)."));
    }, 20000);

    function cleanup() {
      clearTimeout(timeoutTimer);
      if (socket && !socket.destroyed) {
        try { socket.end(); socket.destroy(); } catch (_) {}
      }
    }

    function sendLine(str) {
      if (socket && socket.writable) {
        socket.write(str + "\r\n");
      }
    }

    function handleResponse(code, line) {
      if (step === 0 && code === 220) {
        step = 1;
        sendLine(`EHLO localhost`);
        return;
      }

      if (step === 1 && code === 250) {
        if (!isTlsUpgraded) {
          // Butuh STARTTLS untuk port 587
          step = 2;
          sendLine("STARTTLS");
        } else {
          step = 4;
          sendLine("AUTH LOGIN");
        }
        return;
      }

      if (step === 2 && code === 220) {
        // Upgrade socket ke TLS
        step = 3;
        const secureSocket = tls.connect({
          socket,
          host,
          minVersion: "TLSv1.2",
          rejectUnauthorized: false
        });

        secureSocket.on("error", (err) => {
          cleanup();
          reject(new Error("TLS Handshake error: " + err.message));
        });

        socket = secureSocket;
        isTlsUpgraded = true;
        attachSocketListeners();
        sendLine("EHLO localhost");
        return;
      }

      if (step === 3 && code === 250) {
        step = 4;
        sendLine("AUTH LOGIN");
        return;
      }

      if (step === 4 && code === 334) {
        // Kirim Base64 Username
        step = 5;
        sendLine(Buffer.from(user).toString("base64"));
        return;
      }

      if (step === 5 && code === 334) {
        // Kirim Base64 Password
        step = 6;
        sendLine(Buffer.from(pass).toString("base64"));
        return;
      }

      if (step === 6 && code === 235) {
        // Auth Sukses
        step = 7;
        sendLine(`MAIL FROM:<${fromAddress}>`);
        return;
      }

      if (step === 7 && code === 250) {
        step = 8;
        sendLine(`RCPT TO:<${toAddress}>`);
        return;
      }

      if (step === 8 && code === 250) {
        step = 9;
        sendLine("DATA");
        return;
      }

      if (step === 9 && code === 354) {
        step = 10;
        const boundary = "----=_Part_" + Date.now();
        const msgLines = [
          `From: ${from}`,
          `To: ${recipient}`,
          `Subject: ${subject}`,
          `Date: ${new Date().toUTCString()}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          `Content-Type: text/plain; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          "",
          text || html.replace(/<[^>]+>/g, ""),
          "",
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: 7bit`,
          "",
          html || `<pre>${text}</pre>`,
          "",
          `--${boundary}--`,
          "."
        ];
        sendLine(msgLines.join("\r\n"));
        return;
      }

      if (step === 10 && code === 250) {
        step = 11;
        sendLine("QUIT");
        cleanup();
        return resolve({ ok: true, message: "Email berhasil terkirim." });
      }

      if (code >= 400) {
        cleanup();
        return reject(new Error(`SMTP Error (${code}): ${line}`));
      }
    }

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop(); // simpan sisa baris yang belum selesai

      for (const line of lines) {
        if (!line) continue;
        const match = line.match(/^(\d{3})([ -])(.*)$/);
        if (match) {
          const code = Number(match[1]);
          const isFinal = match[2] === " ";
          if (isFinal) {
            handleResponse(code, match[3]);
          }
        }
      }
    }

    function attachSocketListeners() {
      socket.removeAllListeners("data");
      socket.on("data", onData);
    }

    try {
      if (isDirectTls) {
        socket = tls.connect(
          {
            host,
            port,
            minVersion: "TLSv1.2",
            rejectUnauthorized: false
          },
          () => attachSocketListeners()
        );
      } else {
        socket = net.connect({ host, port }, () => attachSocketListeners());
      }

      socket.on("error", (err) => {
        cleanup();
        reject(new Error("SMTP Connection failed: " + err.message));
      });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Format template email pengiriman PIN
 */
async function sendPinEmail(config, { pin, reason = "Permintaan Reset PIN", recipient = null }) {
  const to = recipient || config.smtpTo || config.smtpUser;
  if (!to) {
    throw new Error("Alamat email penerima belum diisi.");
  }

  const subject = `🔐 [Tokocrypto Bot] PIN Akses Baru Anda: ${pin}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; border: 1px solid #334155;">
      <h2 style="color: #38bdf8; margin-top: 0;">🔐 Tokocrypto AI Bot Security</h2>
      <p style="color: #cbd5e1; font-size: 14px; line-height: 1.5;">
        Berikut adalah PIN akses keamanan untuk masuk ke Web Dashboard Tokocrypto Bot Anda:
      </p>

      <div style="background: #090d16; border: 2px dashed #0284c7; padding: 18px; text-align: center; border-radius: 10px; margin: 20px 0;">
        <span style="font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">PIN Akses Anda</span>
        <div style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #38bdf8; margin-top: 6px; font-family: monospace;">
          ${pin}
        </div>
      </div>

      <div style="font-size: 12.5px; color: #94a3b8; line-height: 1.6; background: rgba(30, 41, 59, 0.5); padding: 12px; border-radius: 8px;">
        <div>📌 <b>Alasan:</b> ${reason}</div>
        <div>⏱️ <b>Waktu:</b> ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB</div>
        <div>🔄 <b>Aturan:</b> PIN ini berlaku untuk <b>10 kali login</b> sebelum berganti otomatis.</div>
      </div>

      <p style="font-size: 11px; color: #64748b; margin-top: 24px; text-align: center;">
        Jika Anda tidak merasa meminta reset PIN ini, segera amankan kredensial server dan API Tokocrypto Anda.
      </p>
    </div>
  `;

  const text = `Tokocrypto AI Bot Security\n\nPIN Akses Baru Anda: ${pin}\nAlasan: ${reason}\nWaktu: ${new Date().toLocaleString("id-ID")} WIB\nPIN ini berlaku untuk 10 kali login.`;

  return sendEmail(config, { to, subject, html, text });
}

module.exports = {
  sendEmail,
  sendPinEmail
};
