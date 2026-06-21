/**
 * db.js — SQLite backing store for mem-manager
 *
 * Primary local data layer. Google Sheets is an optional backup only.
 * All MCP hot-path operations (upsert, list, load) hit this directly.
 *
 * Uses better-sqlite3 (synchronous API — appropriate for local file I/O).
 */

import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS entries (
    slab_id       TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    content       TEXT    NOT NULL DEFAULT '',
    slot_type     TEXT    NOT NULL DEFAULT 'WORKING',
    priority      INTEGER NOT NULL DEFAULT 2,
    last_accessed TEXT,
    evictable     TEXT    NOT NULL DEFAULT 'YES',
    notes         TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (slab_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_slab ON entries (slab_id);
`;

const UPSERT_SQL = `
  INSERT INTO entries
    (slab_id, key, content, slot_type, priority, last_accessed, evictable, notes)
  VALUES
    (@slab_id, @key, @content, @slot_type, @priority, @last_accessed, @evictable, @notes)
  ON CONFLICT(slab_id, key) DO UPDATE SET
    content       = excluded.content,
    slot_type     = excluded.slot_type,
    priority      = excluded.priority,
    last_accessed = excluded.last_accessed,
    evictable     = excluded.evictable,
    notes         = excluded.notes
`;

// ── Singleton connection ─────────────────────────────────────────────────────

let _db = null;

export function getDb() {
  if (!_db) {
    // Resolved here (not at module load) so tests can override LOCAL_DB_PATH
    const dbPath = process.env.LOCAL_DB_PATH
                ?? path.join(__dirname, '../store/mem.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.exec(SCHEMA);
  }
  return _db;
}

/** Close and discard the singleton. Used in tests for isolation. */
export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

// ── Normalise incoming rows ──────────────────────────────────────────────────

function norm(row) {
  return {
    slab_id:       String(row.slab_id   ?? ''),
    key:           String(row.key       ?? ''),
    content:       String(row.content   ?? ''),
    slot_type:     String(row.slot_type ?? 'WORKING'),
    priority:      Number(row.priority  ?? 2),
    last_accessed: String(row.last_accessed ?? new Date().toISOString().slice(0, 10)),
    evictable:     String(row.evictable ?? 'YES'),
    notes:         String(row.notes     ?? ''),
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function dbAllRows() {
  return getDb()
    .prepare('SELECT * FROM entries ORDER BY slab_id, key')
    .all();
}

export function dbRowsBySlab(slabId) {
  return getDb()
    .prepare('SELECT * FROM entries WHERE slab_id = ? ORDER BY key')
    .all(slabId);
}

export function dbSlabIds() {
  return getDb()
    .prepare('SELECT DISTINCT slab_id FROM entries ORDER BY slab_id')
    .all()
    .map(r => r.slab_id);
}

export function dbRowCount() {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM entries')
    .get().n;
}

// ── Write ────────────────────────────────────────────────────────────────────

export function dbUpsert(row) {
  getDb().prepare(UPSERT_SQL).run(norm(row));
}

export function dbImportRows(rows) {
  const db   = getDb();
  const stmt = db.prepare(UPSERT_SQL);
  const bulk = db.transaction(rs => { for (const r of rs) stmt.run(norm(r)); });
  bulk(rows);
  return rows.length;
}

// ── Startup seed from CSV (one-time migration, no-op if DB already has data) ─

export function seedFromCSV(csvPath) {
  if (dbRowCount() > 0) return 0;   // already populated — skip
  if (!fs.existsSync(csvPath))  return 0;

  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const n    = dbImportRows(rows);
  console.log(`[db] Seeded ${n} rows from ${csvPath}`);
  return n;
}
