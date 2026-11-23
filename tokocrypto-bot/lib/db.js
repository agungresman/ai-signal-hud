"use strict";

const { MongoClient } = require("mongodb");

let client = null;
let db = null;

function buildMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  const base = String(process.env.DB_BASE_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const user = String(process.env.DB_USER || "").trim().replace(/^['"]|['"]$/g, "");
  const pass = String(process.env.DB_PASSWORD || "").trim().replace(/^['"]|['"]$/g, "");
  if (!base) {
    throw new Error("MONGODB_URI atau DB_BASE_URL belum dikonfigurasi di .env");
  }
  if (/^mongodb(\+srv)?:\/\/[^@]+@/.test(base)) {
    return base;
  }
  const protoMatch = base.match(/^(mongodb(?:\+srv)?:\/\/)(.+)$/i);
  if (!protoMatch) {
    throw new Error("Format DB_BASE_URL tidak valid (harus diawali mongodb:// atau mongodb+srv://)");
  }
  const hostPart = protoMatch[2].replace(/\/+$/, "");
  const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  return `${protoMatch[1]}${authPart}${hostPart}/?retryWrites=true&w=majority`;
}

function getDbName() {
  return String(process.env.DB_NAME || process.env.MONGODB_DB || "_ai_signal")
    .trim()
    .replace(/^['"]|['"]$/g, "") || "_ai_signal";
}

async function connectDb() {
  if (db) return db;
  const uri = buildMongoUri();
  const dbName = getDbName();
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  await client.connect();
  db = client.db(dbName);
  return db;
}

function getDb() {
  if (!db) {
    throw new Error("MongoDB belum terhubung. Panggil connectDb() terlebih dahulu.");
  }
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = {
  connectDb,
  getDb,
  closeDb,
  getDbName
};
