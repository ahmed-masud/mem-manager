#!/usr/bin/env node
/**
 * load.js — page-in a slab from the backing store
 *
 * Usage:
 *   node scripts/load.js <slab_id>
 *   node scripts/load.js pipeline-active
 *   node scripts/load.js interview-prep-ncc
 *
 * What it does:
 *   1. Reads slab rows from master.csv (or sheet if --remote)
 *   2. Checks free working slots (7–26)
 *   3. Packs rows into slots (one slot per row, or --pack for dense mode)
 *   4. Writes a load manifest → store/pending-load.json
 *   5. Updates page_directory.json (optimistic — before Claude writes slots)
 *
 * Claude reads the manifest and calls memory_user_edits for each entry.
 */

import 'dotenv/config';
import { pullFromSheet } from './sheets.js';
import { dbAllRows, dbImportRows } from './db.js';
import { readPageDir, writePageDir, getFreeSlots, today } from './page-dir.js';

const LOCAL   = process.env.LOCAL_STORE_PATH;
const args    = process.argv.slice(2);
const slabId  = args.find(a => !a.startsWith('--'));
const remote  = args.includes('--remote');
const pack    = args.includes('--pack');

if (!slabId) {
  console.error('Usage: node scripts/load.js <slab_id> [--remote] [--pack]');
  process.exit(1);
}

async function main() {
  console.log(`\n📥  Loading slab: "${slabId}"\n`);

  // 1. Read backing store
  let rows;
  if (remote) {
    rows = await pullFromSheet();
    dbImportRows(rows);          // keep SQLite in sync when loading from remote
  } else {
    rows = dbAllRows();           // fast local read
  }

  // 2. Filter to requested slab
  const slabRows = rows.filter(r => r.slab_id === slabId);
  if (slabRows.length === 0) {
    console.error(`❌  Slab "${slabId}" not found in backing store.`);
    console.log(`    Available slabs: ${[...new Set(rows.map(r => r.slab_id))].join(', ')}`);
    process.exit(1);
  }

  // 3. Check page directory
  const dir = readPageDir();
  if (dir.slabs[slabId]?.slots?.length > 0) {
    console.log(`⚠️   Slab "${slabId}" already loaded in slots: ${dir.slabs[slabId].slots.join(', ')}`);
    console.log(`    Use evict first, or re-run to refresh.`);
    process.exit(0);
  }

  // 4. Calculate slots needed
  const needed = pack ? 1 : slabRows.length;
  const free   = getFreeSlots(dir, needed);

  if (free.length < needed) {
    console.error(`❌  Not enough free slots. Need ${needed}, have ${free.length}.`);
    console.error(`    Run: node scripts/evict.js <slab_id> to free slots first.`);
    process.exit(1);
  }

  // 5. Build manifest entries
  let manifest = [];

  if (pack) {
    // Dense mode: pack entire slab into one slot
    const packed = slabRows.map(r => `[${r.key}] ${r.content}`).join('\n');
    manifest.push({
      slot:    free[0],
      slab_id: slabId,
      key:     slabId,           // slab name as key for packed slot
      content: packed,
      action:  'add',
    });
  } else {
    // One slot per row
    manifest = slabRows.map((r, i) => ({
      slot:    free[i],
      slab_id: r.slab_id,
      key:     r.key,
      content: r.content,
      action:  'add',
    }));
  }

  // 6. Save pending manifest for Claude to action
  const manifestPath = process.env.LOCAL_STORE_PATH.replace('master.csv', 'pending-load.json');
  const pendingLoad  = {
    generated:    today(),
    slab_id:      slabId,
    entry_count:  manifest.length,
    entries:      manifest,
  };
  import('fs').then(({ default: fs }) => {
    fs.writeFileSync(manifestPath, JSON.stringify(pendingLoad, null, 2));
  });

  // 7. Update page directory (optimistic)
  dir.slabs[slabId] = {
    keys:          manifest.map(e => e.key),
    slots:         manifest.map(e => e.slot),
    evictable:     slabRows[0]?.evictable !== 'NO',
    last_accessed: today(),
  };
  dir.slots_used = Object.values(dir.slabs).flatMap(s => s.slots).length;
  dir.slots_free = 30 - dir.slots_used;
  writePageDir(dir);

  // 8. Print manifest for Claude
  console.log(`✅  Slab "${slabId}" — ${manifest.length} entries mapped to slots:\n`);
  console.log('┌─────┬──────────────────────────────┬────────────────────────────────────────────┐');
  console.log('│ Slot│ Key                          │ Content (preview)                          │');
  console.log('├─────┼──────────────────────────────┼────────────────────────────────────────────┤');
  for (const e of manifest) {
    const key     = e.key.padEnd(28).slice(0, 28);
    const preview = e.content.slice(0, 42).padEnd(42);
    console.log(`│  ${String(e.slot).padStart(2)} │ ${key} │ ${preview} │`);
  }
  console.log('└─────┴──────────────────────────────┴────────────────────────────────────────────┘');
  console.log(`\n📋  Manifest saved → store/pending-load.json`);
  console.log(`🧠  Claude: read manifest and call memory_user_edits for each entry above.\n`);
}

main().catch(err => {
  console.error('❌  Load failed:', err.message);
  process.exit(1);
});
