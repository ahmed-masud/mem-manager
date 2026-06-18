/**
 * page-dir.js — read/write the TLB (page_directory.json)
 */

import 'dotenv/config';
import fs from 'fs';

const PATH = process.env.PAGE_DIR_PATH;

export function readPageDir() {
  return JSON.parse(fs.readFileSync(PATH, 'utf8'));
}

export function writePageDir(dir) {
  fs.writeFileSync(PATH, JSON.stringify(dir, null, 2), 'utf8');
}

export function getFreeSlots(dir, count) {
  const used = new Set(
    Object.values(dir.slabs).flatMap(s => s.slots)
  );
  const scratch = new Set(dir.scratch_slots);
  const free = [];
  for (let i = 7; i <= 26; i++) {
    if (!used.has(i) && !scratch.has(i)) free.push(i);
    if (free.length === count) break;
  }
  return free;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function isStale(dateStr, days = 30) {
  if (!dateStr) return false;
  const diff = (Date.now() - new Date(dateStr)) / 86400000;
  return diff > days;
}
