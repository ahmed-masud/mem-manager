#!/usr/bin/env node
/**
 * evict.js — page-out a slab, free its working slots
 *
 * Usage:
 *   node scripts/evict.js <slab_id>
 *   node scripts/evict.js pipeline-closed
 *   node scripts/evict.js --lru          (auto-evict least recently used)
 *   node scripts/evict.js --stale        (auto-evict all slabs > 30 days old)
 *
 * What it does:
 *   1. Reads page_directory.json
 *   2. Validates slab is loaded + evictable
 *   3. Writes evict manifest → store/pending-evict.json
 *   4. Updates page_directory.json (frees slots)
 *
 * Claude reads the manifest and calls memory_user_edits remove for each slot.
 */

import 'dotenv/config';
import { readPageDir, writePageDir, today, isStale } from './page-dir.js';
import fs from 'fs';

const PINNED  = new Set(['pinned', 'resume-rules', 'experience-anchors', 'page-directory']);
const args    = process.argv.slice(2);
const lru     = args.includes('--lru');
const stale   = args.includes('--stale');
const slabId  = args.find(a => !a.startsWith('--'));

if (!slabId && !lru && !stale) {
  console.error('Usage: node scripts/evict.js <slab_id|--lru|--stale>');
  process.exit(1);
}

function pickLRU(dir) {
  return Object.entries(dir.slabs)
    .filter(([id, s]) => !PINNED.has(id) && s.evictable && s.slots?.length > 0)
    .sort(([, a], [, b]) => new Date(a.last_accessed) - new Date(b.last_accessed))
    [0]?.[0];
}

function pickStale(dir) {
  return Object.entries(dir.slabs)
    .filter(([id, s]) => !PINNED.has(id) && s.evictable && s.slots?.length > 0 && isStale(s.last_accessed))
    .map(([id]) => id);
}

async function evictSlab(id, dir) {
  if (PINNED.has(id)) {
    console.error(`❌  Slab "${id}" is PINNED — cannot evict.`);
    return null;
  }
  const slab = dir.slabs[id];
  if (!slab || slab.slots?.length === 0) {
    console.log(`⚠️   Slab "${id}" is not currently loaded.`);
    return null;
  }
  if (!slab.evictable) {
    console.error(`❌  Slab "${id}" is marked non-evictable.`);
    return null;
  }
  return { slab_id: id, slots: slab.slots, keys: slab.keys };
}

async function main() {
  const dir = readPageDir();

  // Resolve which slabs to evict
  let targets = [];
  if (lru)        targets = [pickLRU(dir)].filter(Boolean);
  else if (stale) targets = pickStale(dir);
  else            targets = [slabId];

  if (targets.length === 0) {
    console.log('✅  Nothing to evict.');
    return;
  }

  console.log(`\n📤  Evicting slab(s): ${targets.join(', ')}\n`);

  const manifests = [];
  for (const id of targets) {
    const result = await evictSlab(id, dir);
    if (!result) continue;
    manifests.push(result);

    // Free slots in page directory
    dir.slabs[id].slots         = [];
    dir.slabs[id].keys          = [];
    dir.slabs[id].last_accessed = today();
  }

  if (manifests.length === 0) {
    console.log('Nothing was evicted.');
    return;
  }

  // Update slot counts
  dir.slots_used = Object.values(dir.slabs).flatMap(s => s.slots).length;
  dir.slots_free = 30 - dir.slots_used;
  writePageDir(dir);

  // Save evict manifest
  const manifestPath = process.env.LOCAL_STORE_PATH.replace('master.csv', 'pending-evict.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ generated: today(), evictions: manifests }, null, 2));

  // Print summary
  const totalSlots = manifests.flatMap(m => m.slots);
  console.log('┌───────────────────────────┬────────────────────────┐');
  console.log('│ Slab                      │ Slots freed            │');
  console.log('├───────────────────────────┼────────────────────────┤');
  for (const m of manifests) {
    console.log(`│ ${m.slab_id.padEnd(25)} │ ${m.slots.join(', ').padEnd(22)} │`);
  }
  console.log('└───────────────────────────┴────────────────────────┘');
  console.log(`\n🆓  ${totalSlots.length} slot(s) freed → slots_free now: ${dir.slots_free}`);
  console.log(`📋  Manifest saved → store/pending-evict.json`);
  console.log(`🧠  Claude: call memory_user_edits remove for each slot listed above.\n`);
}

main().catch(err => {
  console.error('❌  Evict failed:', err.message);
  process.exit(1);
});
