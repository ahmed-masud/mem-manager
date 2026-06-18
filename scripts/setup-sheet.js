#!/usr/bin/env node
/**
 * setup-sheet.js — one-time setup: create the master tab + seed from local CSV
 *
 * Run once after creating the Google Sheet and sharing it with the service account.
 * Usage: node scripts/setup-sheet.js
 */

import 'dotenv/config';
import { getSheetsClient, pushToSheet, readLocalCSV } from './sheets.js';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB      = process.env.GOOGLE_SHEET_TAB ?? 'master';
const LOCAL    = process.env.LOCAL_STORE_PATH;

async function ensureTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === TAB);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: TAB } } }],
      },
    });
    console.log(`📋  Created tab "${TAB}"`);
  } else {
    console.log(`📋  Tab "${TAB}" already exists`);
  }
}

async function formatHeaders(sheets) {
  // Bold the header row
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetObj  = sheetMeta.data.sheets.find(s => s.properties.title === TAB);
  const sheetId   = sheetObj.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      }],
    },
  });
  console.log('✅  Header row formatted (bold)');
}

async function main() {
  console.log('\n🚀  mem-manager sheet setup\n');
  if (!SHEET_ID || SHEET_ID === 'YOUR_SHEET_ID_HERE') {
    console.error('❌  Set GOOGLE_SHEET_ID in .env first');
    process.exit(1);
  }

  const sheets = getSheetsClient();
  await ensureTab(sheets);
  await formatHeaders(sheets);

  console.log('⬆️   Seeding sheet from local CSV...');
  const rows = readLocalCSV(LOCAL);
  await pushToSheet(rows);
  console.log(`\n✅  Setup complete. ${rows.length} rows seeded into Sheet → tab "${TAB}"`);
  console.log(`🔗  https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
}

main().catch(err => {
  console.error('❌  Setup failed:', err.message);
  process.exit(1);
});
