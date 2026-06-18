/**
 * sheets.js — Google Sheets client wrapper
 * Handles auth + all read/write ops against the backing store sheet.
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error(
      `Service account key not found at: ${keyFile}\n` +
      `Set GOOGLE_SERVICE_ACCOUNT_KEY in .env`
    );
  }
  // Load credentials directly + useJWTAccessWithScope bypasses gtoken's
  // node-fetch v2 gzip bug on Node 22+ (ERR_STREAM_PREMATURE_CLOSE)
  const credentials = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    useJWTAccessWithScope: true,
  });
}

export function getSheetsClient() {
  const auth = getAuth();
  // Pass native fetch as fetchImplementation so gaxios doesn't fall back
  // to node-fetch v2's broken Gunzip handling on Node 22+
  const sheets = google.sheets({ version: 'v4', auth });
  sheets.context._options = {
    ...sheets.context._options,
    fetchImplementation: globalThis.fetch.bind(globalThis),
  };
  return sheets;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const TAB       = process.env.GOOGLE_SHEET_TAB ?? 'master';
const HEADERS   = ['slab_id','slot_type','key','content','priority','last_accessed','evictable','notes'];

// ---------------------------------------------------------------------------
// Read — pull all rows from sheet → array of objects
// ---------------------------------------------------------------------------

export async function pullFromSheet() {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:H`,
  });

  const rows = res.data.values ?? [];
  if (rows.length < 2) return [];   // empty or headers only

  const [header, ...data] = rows;
  return data.map(row =>
    Object.fromEntries(header.map((h, i) => [h, row[i] ?? '']))
  );
}
// ---------------------------------------------------------------------------
// Write — push local rows → sheet (full replace of tab)
// ---------------------------------------------------------------------------

export async function pushToSheet(rows) {
  const sheets = getSheetsClient();

  // Build 2D array: headers first, then data rows
  const values = [
    HEADERS,
    ...rows.map(r => HEADERS.map(h => r[h] ?? '')),
  ];

  // Clear existing content then write fresh
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:H`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  console.log(`✅ Pushed ${rows.length} rows to sheet tab "${TAB}"`);
}

// ---------------------------------------------------------------------------
// Upsert — update or insert a single row by key
// ---------------------------------------------------------------------------

export async function upsertRow(newRow) {
  const rows = await pullFromSheet();
  const idx = rows.findIndex(r => r.key === newRow.key && r.slab_id === newRow.slab_id);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...newRow, last_accessed: today() };
  } else {
    rows.push({ ...newRow, last_accessed: today() });
  }
  await pushToSheet(rows);
}

// ---------------------------------------------------------------------------
// Delete — remove rows matching slab_id
// ---------------------------------------------------------------------------

export async function deleteSlabRows(slabId) {
  const rows = await pullFromSheet();
  const filtered = rows.filter(r => r.slab_id !== slabId);
  await pushToSheet(filtered);
  console.log(`🗑  Removed ${rows.length - filtered.length} rows for slab "${slabId}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readLocalCSV(path) {
  const raw = fs.readFileSync(path, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true });
}

export function writeLocalCSV(path, rows) {
  const out = stringify(rows, { header: true, columns: HEADERS });
  fs.writeFileSync(path, out, 'utf8');
}
