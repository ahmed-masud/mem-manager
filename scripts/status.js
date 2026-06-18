#!/usr/bin/env node
/**
 * status.js — pretty-print the current TLB / page directory state
 *
 * Usage: node scripts/status.js
 */

import 'dotenv/config';
import { readPageDir, isStale } from './page-dir.js';

const dir = readPageDir();

console.log('\n🧠  mem-manager — TLB Status\n');
console.log(`  Total slots : 30`);
console.log(`  Used        : ${dir.slots_used}`);
console.log(`  Free        : ${dir.slots_free}`);
console.log(`  Scratch     : ${dir.scratch_slots.join(', ')}`);
console.log(`  Updated     : ${dir.last_updated}\n`);

console.log('┌────────────────────────────┬──────────────┬────────────┬──────────┬────────────┬────────┐');
console.log('│ Slab                       │ Slots        │ Keys       │ Evict?   │ Accessed   │ Stale? │');
console.log('├────────────────────────────┼──────────────┼────────────┼──────────┼────────────┼────────┤');

for (const [id, slab] of Object.entries(dir.slabs)) {
  const slots    = slab.slots?.length > 0 ? slab.slots.join(',') : '—';
  const keys     = (slab.keys?.length ?? 0).toString();
  const evict    = slab.evictable ? 'YES' : 'PINNED';
  const accessed = slab.last_accessed ?? '—';
  const stale    = isStale(slab.last_accessed) ? '⚠️ YES' : 'no';
  const loaded   = slab.slots?.length > 0 ? '●' : '○';

  console.log(
    `│ ${loaded} ${id.padEnd(26)}│ ${slots.padEnd(12)} │ ${keys.padEnd(10)} │ ${evict.padEnd(8)} │ ${accessed.padEnd(10)} │ ${stale.padEnd(6)} │`
  );
}

console.log('└────────────────────────────┴──────────────┴────────────┴──────────┴────────────┴────────┘');
console.log('\n  ● = loaded   ○ = in backing store, not loaded\n');
