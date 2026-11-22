"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUTH_FILE = path.join(DATA_DIR, "pin_auth.json");
const MAX_LOGIN_COUNT = 10;
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

function generateRandomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function loadAuthData() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = fs.readFileSync(AUTH_FILE, "utf8");
      const data = JSON.parse(raw);
      if (data && data.currentPin) {
        if (!data.sessions) data.sessions = {};
        if (typeof data.usedCount !== "number") data.usedCount = 0;
        if (!data.maxUses) data.maxUses = MAX_LOGIN_COUNT;
        return data;
      }
    }
  } catch (err) {
    console.error("[AUTH] Gagal membaca pin_auth.json, membuat konfigurasi baru:", err.message);
  }

  // Jika belum ada file auth, generate PIN awal (default awal 6 digit)
  const initialPin = generateRandomPin();
  const initData = {
    currentPin: initialPin,
    usedCount: 0,
    maxUses: MAX_LOGIN_COUNT,
    createdAt: new Date().toISOString(),
    lastRotatedAt: new Date().toISOString(),
    totalLogins: 0,
    sessions: {},
    history: []
  };
  saveAuthData(initData);
  console.log("========================================================");
  console.log(`🔐 [PIN SECURITY] Inisialisasi Auth PIN Berhasil!`);
  console.log(`   PIN Akses Anda saat ini: ${initialPin}`);
  console.log(`   PIN ini akan berganti otomatis setiap ${MAX_LOGIN_COUNT}x login.`);
  console.log("========================================================");
  return initData;
}

function saveAuthData(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[AUTH] Gagal menyimpan pin_auth.json:", err.message);
  }
}

let authState = loadAuthData();

// Bersihkan session expired secara berkala
function purgeExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, sess] of Object.entries(authState.sessions || {})) {
    if (!sess || sess.expiresAt <= now) {
      delete authState.sessions[token];
      changed = true;
    }
  }
  if (changed) saveAuthData(authState);
}

// Validasi Token Sesi
function isValidSession(token) {
  if (!token || typeof token !== "string") return false;
  purgeExpiredSessions();
  const sess = authState.sessions[token];
  if (!sess) return false;
  if (sess.expiresAt <= Date.now()) {
    delete authState.sessions[token];
    saveAuthData(authState);
    return false;
  }
  return true;
}

// Logout / Hapus token
function revokeSession(token) {
  if (token && authState.sessions[token]) {
    delete authState.sessions[token];
    saveAuthData(authState);
    return true;
  }
  return false;
}

// Dapatkan info status PIN (untuk badge UI)
function getAuthStatus(token) {
  const authenticated = isValidSession(token);
  return {
    authenticated,
    usedCount: authState.usedCount,
    maxUses: authState.maxUses || MAX_LOGIN_COUNT,
    remainingUses: Math.max(0, (authState.maxUses || MAX_LOGIN_COUNT) - authState.usedCount),
    totalLogins: authState.totalLogins || 0,
    lastRotatedAt: authState.lastRotatedAt || authState.createdAt,
    // currentPin hanya diberikan jika sesi valid / sudah login
    currentPin: authenticated ? authState.currentPin : undefined
  };
}

// Verifikasi PIN saat Login
function verifyPinLogin(inputPin, ipAddress = "unknown") {
  if (!inputPin) {
    return { ok: false, message: "PIN harus diisi." };
  }

  const cleanPin = String(inputPin).trim();
  if (cleanPin !== String(authState.currentPin).trim()) {
    return { ok: false, message: "PIN salah. Silakan coba lagi." };
  }

  // PIN Benar: hitung pemakaian
  authState.usedCount = (authState.usedCount || 0) + 1;
  authState.totalLogins = (authState.totalLogins || 0) + 1;

  // Generate session token
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_EXPIRY_MS;
  if (!authState.sessions) authState.sessions = {};
  authState.sessions[token] = {
    createdAt: Date.now(),
    expiresAt,
    ip: ipAddress
  };

  const loginNumber = authState.usedCount;
  const maxUses = authState.maxUses || MAX_LOGIN_COUNT;
  let pinRotated = false;
  let oldPin = authState.currentPin;
  let nextPin = null;

  // Cek apakah mencapai batas 10x pemakaian
  if (authState.usedCount >= maxUses) {
    pinRotated = true;
    nextPin = generateRandomPin();
    authState.currentPin = nextPin;
    authState.usedCount = 0;
    authState.lastRotatedAt = new Date().toISOString();

    if (!authState.history) authState.history = [];
    authState.history.unshift({
      pin: oldPin,
      usedCount: maxUses,
      rotatedAt: authState.lastRotatedAt
    });
    if (authState.history.length > 20) authState.history.pop();

    console.log("========================================================");
    console.log(`🔐 [PIN SECURITY] PIN TELAH DIPAKAI ${maxUses}x!`);
    console.log(`   PIN LAMA (${oldPin}) KADALUARSA.`);
    console.log(`   PIN BARU ANDA: ${nextPin}`);
    console.log(`   Simpan PIN baru ini untuk login berikutnya.`);
    console.log("========================================================");
  }

  saveAuthData(authState);

  return {
    ok: true,
    token,
    loginNumber,
    maxUses,
    pinRotated,
    oldPin: pinRotated ? oldPin : undefined,
    currentPin: authState.currentPin,
    remainingUses: pinRotated ? maxUses : maxUses - loginNumber,
    message: pinRotated
      ? `Login ke-${maxUses} berhasil! PIN Anda sekarang telah berganti ke: ${nextPin}`
      : `Login berhasil! (Penggunaan PIN ke-${loginNumber} dari ${maxUses})`
  };
}

// Reset PIN Manual / Lupa PIN
function resetPin(reason = "Reset Manual") {
  const oldPin = authState.currentPin;
  const nextPin = generateRandomPin();
  authState.currentPin = nextPin;
  authState.usedCount = 0;
  authState.lastRotatedAt = new Date().toISOString();

  if (!authState.history) authState.history = [];
  authState.history.unshift({
    pin: oldPin,
    usedCount: authState.usedCount,
    rotatedAt: authState.lastRotatedAt,
    reason
  });
  if (authState.history.length > 20) authState.history.pop();

  saveAuthData(authState);

  console.log("========================================================");
  console.log(`🔐 [PIN SECURITY] PIN TELAH DI-RESET: ${nextPin}`);
  console.log(`   Alasan: ${reason}`);
  console.log("========================================================");

  return {
    ok: true,
    newPin: nextPin,
    oldPin,
    reason,
    usedCount: 0,
    maxUses: authState.maxUses || MAX_LOGIN_COUNT
  };
}

module.exports = {
  isValidSession,
  revokeSession,
  getAuthStatus,
  verifyPinLogin,
  resetPin,
  getCurrentPin: () => authState.currentPin
};
