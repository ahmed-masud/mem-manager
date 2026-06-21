#!/usr/bin/env node
/**
 * sync.js — bidirectional sync between local master.csv and Google Sheet
 *
 * Usage:
 *   node scripts/sync.js --pull    Pull sheet → overwrite local CSV
 *   node scripts/sync.js --push    Push local CSV → overwrite sheet
 *   node scripts/sync.js           Two-way: sheet wins on conflict (sheet is truth)
 */

import 'dotenv/config';
import { pullFromSheet, pushToSheet } from './sheets.js';
import { dbAllRows, dbImportRows } from './db.js';

const LOCAL  = process.env.LOCAL_STORE_PATH;
const args   = process.argv.slice(2);
const mode   = args.includes('--push') ? 'push'
             : args.includes('--pull') ? 'pull'
             : 'pull';   // default: sheet is truth

async function main() {
  console.log(`\n🔄  mem-manager sync — mode: ${mode}\n`);

  if (mode === 'pull') {
    console.log('⬇️   Pulling from Google Sheet...');
    const rows = await pullFromSheet();
    if (rows.length === 0) {
      console.log('⚠️   Sheet is empty. Nothing to pull.');
      return;
    }
    dbImportRows(rows);
    console.log(`✅  Imported ${rows.length} rows → SQLite`);
  }

  if (mode === 'push') {
    console.log('⬆️   Pushing SQLite to Google Sheet...');
    const rows = dbAllRows();
    await pushToSheet(rows);
    console.log(`✅  Pushed ${rows.length} rows → Sheet`);
  }
}

main().catch(err => {
  console.error('❌  Sync failed:', err.message);
  process.exit(1);
});
