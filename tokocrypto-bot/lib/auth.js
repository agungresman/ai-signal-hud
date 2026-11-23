"use strict";

const crypto = require("crypto");
const { getDb } = require("./db");

const AUTH_COLLECTION = "auth_state";
const AUTH_DOC_ID = "pin_auth";
const MAX_LOGIN_COUNT = 10;
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

function generateRandomPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createDefaultAuthData() {
  const initialPin = generateRandomPin();
  return {
    _id: AUTH_DOC_ID,
    currentPin: initialPin,
    usedCount: 0,
    maxUses: MAX_LOGIN_COUNT,
    createdAt: new Date().toISOString(),
    lastRotatedAt: new Date().toISOString(),
    totalLogins: 0,
    sessions: {},
    history: []
  };
}

let authState = createDefaultAuthData();

async function persistAuthData(data) {
  try {
    const db = getDb();
    const { _id, ...doc } = data;
    await db.collection(AUTH_COLLECTION).updateOne(
      { _id: AUTH_DOC_ID },
      { $set: doc },
      { upsert: true }
    );
  } catch (err) {
    console.error("[AUTH] Gagal menyimpan auth_state ke MongoDB:", err.message);
  }
}

function saveAuthData(data) {
  persistAuthData(data);
}

async function initAuthFromDb() {
  const db = getDb();
  const existing = await db.collection(AUTH_COLLECTION).findOne({ _id: AUTH_DOC_ID });
  if (existing && existing.currentPin) {
    authState = {
      ...createDefaultAuthData(),
      ...existing,
      sessions: existing.sessions || {},
      usedCount: typeof existing.usedCount === "number" ? existing.usedCount : 0,
      maxUses: existing.maxUses || MAX_LOGIN_COUNT
    };
    return authState;
  }

  authState = createDefaultAuthData();
  await persistAuthData(authState);
  console.log("========================================================");
  console.log(`🔐 [PIN SECURITY] Inisialisasi Auth PIN di MongoDB Berhasil!`);
  console.log(`   PIN Akses Anda saat ini: ${authState.currentPin}`);
  console.log(`   PIN ini akan berganti otomatis setiap ${MAX_LOGIN_COUNT}x login.`);
  console.log("========================================================");
  return authState;
}

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
  initAuthFromDb,
  isValidSession,
  revokeSession,
  getAuthStatus,
  verifyPinLogin,
  resetPin,
  getCurrentPin: () => authState.currentPin
};
