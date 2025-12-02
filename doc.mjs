#!/usr/bin/env node
// doc.mjs — cek apakah address ada di Google Sheets (public) via CSV export
//
// Dep minimal:
//   npm install dotenv
//
// Node 18+ sudah ada global fetch

import 'dotenv/config';
import fs from 'node:fs';

/* ========= CONFIG DARI ENV ========= */

const DOCS_URL             = process.env.DOCS_URL || "";
const WALLETS_FILE         = process.env.WALLETS_FILE || "wallets.txt";
const WALLET_COLUMN_HEADER = (process.env.WALLET_COLUMN_HEADER || "wallet").toLowerCase();

if (!DOCS_URL) {
  console.error("ERROR: DOCS_URL belum di-set di .env");
  process.exit(1);
}

/* ========= HELPER ========= */

function normalizeAddress(addr) {
  if (!addr) return "";
  let a = addr.trim();
  if (!a) return "";
  // kalau 40 char tanpa 0x → tambahin 0x
  if (!a.startsWith("0x") && a.length === 40) {
    a = "0x" + a;
  }
  return a.toLowerCase();
}

// Ambil sheetId dan gid dari URL (lebih aman, buang #fragment)
function parseSheetUrl(rawUrl) {
  // buang fragment #... dulu
  const noFragment = rawUrl.split("#")[0];

  let u;
  try {
    u = new URL(noFragment);
  } catch (e) {
    throw new Error("DOCS_URL bukan URL valid: " + e.message);
  }

  // path contoh: /spreadsheets/d/<ID>/edit
  const pathParts = u.pathname.split("/");
  const dIndex = pathParts.indexOf("d");
  if (dIndex === -1 || dIndex + 1 >= pathParts.length) {
    throw new Error("Gagal parse sheetId dari DOCS_URL");
  }
  const sheetId = pathParts[dIndex + 1];

  // gid dari query (?gid=0), kalau tidak ada → default 0
  let gid = u.searchParams.get("gid") || "0";
  // kalau masih ada sisa "#..." (safety tambahan)
  gid = gid.split("#")[0];

  return { sheetId, gid };
}

// Download CSV dari Google Sheets (public, tanpa auth) pakai fetch
async function fetchSheetCsv(sheetId, gid) {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  console.log("[info] Download CSV dari:", csvUrl);

  const res = await fetch(csvUrl, {
    method: "GET",
    headers: {
      "accept": "text/csv, */*;q=0.1",
    },
    redirect: "follow", // penting: follow 3xx seperti 307
  });

  if (!res.ok) {
    throw new Error(`Gagal fetch CSV. Status: ${res.status}`);
  }

  const body = await res.text();
  return body;
}

// Parser CSV sederhana (tanpa dukung koma di dalam quotes)
function parseCsvSimple(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  return lines.map(line => {
    return line.split(",").map(cell =>
      cell.replace(/^"|"$/g, "").trim()
    );
  });
}

/* ========= MAIN LOGIC ========= */

async function main() {
  console.log("=== check-sheet-wallets.mjs ===");

  // 1) Baca wallets.txt
  if (!fs.existsSync(WALLETS_FILE)) {
    console.error("ERROR: WALLETS_FILE tidak ditemukan:", WALLETS_FILE);
    process.exit(1);
  }

  const walletsText = fs.readFileSync(WALLETS_FILE, "utf8");
  const wallets = walletsText
    .split(/\r?\n/)
    .map(line => normalizeAddress(line))
    .filter(line => line.length > 0);

  if (wallets.length === 0) {
    console.error("ERROR: Tidak ada address di", WALLETS_FILE);
    process.exit(1);
  }

  console.log(`[info] Total wallet yang dicek: ${wallets.length}`);

  // 2) Parse URL sheet
  let sheetId, gid;
  try {
    ({ sheetId, gid } = parseSheetUrl(DOCS_URL));
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }

  // 3) Fetch CSV
  let csvText;
  try {
    csvText = await fetchSheetCsv(sheetId, gid);
  } catch (err) {
    console.error("ERROR saat fetch CSV:", err.message);
    console.error("Pastikan sheet-nya 'Anyone with the link can view' (public).");
    process.exit(1);
  }

  // 4) Parse CSV
  const rows = parseCsvSimple(csvText);
  if (rows.length === 0) {
    console.error("ERROR: CSV kosong.");
    process.exit(1);
  }

  // 5) Cari index kolom wallet dari header
  const header = rows[0].map(h => h.toLowerCase());
  let walletColIndex = header.findIndex(h => h.includes(WALLET_COLUMN_HEADER));
  if (walletColIndex === -1) {
    console.warn(`[warn] Kolom dengan header mengandung "${WALLET_COLUMN_HEADER}" tidak ditemukan.`);
    console.warn("[warn] Fallback: pakai kolom pertama (index 0).");
    walletColIndex = 0;
  }

  console.log("[info] Pakai kolom index:", walletColIndex, "header aslinya:", rows[0][walletColIndex]);

  // 6) Build set of wallet dari sheet
  const sheetWalletsSet = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (walletColIndex >= row.length) continue;
    const addr = normalizeAddress(row[walletColIndex]);
    if (addr) {
      sheetWalletsSet.add(addr);
    }
  }

  console.log("[info] Total wallet unik di sheet:", sheetWalletsSet.size);

  // 7) Cek tiap wallet input
  console.log("\n=== HASIL CEK ===");
  for (const w of wallets) {
    const ok = sheetWalletsSet.has(w);
    if (ok) {
      console.log(`[FOUND]   ${w}`);
    } else {
      console.log(`[MISSING] ${w}`);
    }
  }

  console.log("\nSelesai.");
}

main().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
