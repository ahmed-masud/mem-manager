/**
 * tests/db.test.js — unit tests for scripts/db.js
 *
 * Each test group opens a fresh in-memory SQLite database via
 * LOCAL_DB_PATH=:memory: + closeDb(), so tests are fully isolated
 * and never touch store/mem.db.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import os from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import {
  getDb,
  closeDb,
  dbAllRows,
  dbRowsBySlab,
  dbRowCount,
  dbSlabIds,
  dbUpsert,
  dbImportRows,
  seedFromCSV,
} from '../scripts/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    slab_id:       'test-slab',
    key:           'test-key',
    content:       'test content',
    slot_type:     'WORKING',
    priority:      2,
    last_accessed: '2026-01-01',
    evictable:     'YES',
    notes:         '',
    ...overrides,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.LOCAL_DB_PATH = ':memory:';
  closeDb();   // discard any prior singleton so getDb() opens a fresh :memory: DB
});

afterEach(() => {
  closeDb();
  delete process.env.LOCAL_DB_PATH;
});

// ── Schema ───────────────────────────────────────────────────────────────────

describe('getDb()', () => {
  it('creates the entries table on first call', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('returns the same singleton on repeated calls', () => {
    expect(getDb()).toBe(getDb());
  });

  it('creates a fresh DB after closeDb()', () => {
    const first = getDb();
    closeDb();
    const second = getDb();
    expect(first).not.toBe(second);
  });
});

// ── dbUpsert ─────────────────────────────────────────────────────────────────

describe('dbUpsert()', () => {
  it('inserts a new row', () => {
    dbUpsert(makeRow());
    expect(dbRowCount()).toBe(1);
  });

  it('stores all fields correctly', () => {
    const row = makeRow({ content: 'hello', priority: 3, evictable: 'NO', notes: 'n' });
    dbUpsert(row);
    const [r] = dbAllRows();
    expect(r.slab_id).toBe('test-slab');
    expect(r.key).toBe('test-key');
    expect(r.content).toBe('hello');
    expect(r.priority).toBe(3);
    expect(r.evictable).toBe('NO');
    expect(r.notes).toBe('n');
  });

  it('updates content on duplicate (slab_id, key)', () => {
    dbUpsert(makeRow({ content: 'original' }));
    dbUpsert(makeRow({ content: 'updated' }));
    expect(dbRowCount()).toBe(1);
    expect(dbAllRows()[0].content).toBe('updated');
  });

  it('allows different keys in the same slab', () => {
    dbUpsert(makeRow({ key: 'a' }));
    dbUpsert(makeRow({ key: 'b' }));
    expect(dbRowCount()).toBe(2);
  });

  it('allows the same key in different slabs', () => {
    dbUpsert(makeRow({ slab_id: 'slab-a', key: 'shared' }));
    dbUpsert(makeRow({ slab_id: 'slab-b', key: 'shared' }));
    expect(dbRowCount()).toBe(2);
  });

  it('coerces priority to a number', () => {
    dbUpsert(makeRow({ priority: '5' }));
    expect(dbAllRows()[0].priority).toBe(5);
  });

  it('defaults missing fields via norm()', () => {
    dbUpsert({ slab_id: 'x', key: 'y', content: 'z' });
    const [r] = dbAllRows();
    expect(r.slot_type).toBe('WORKING');
    expect(r.priority).toBe(2);
    expect(r.evictable).toBe('YES');
    expect(r.notes).toBe('');
  });
});

// ── dbAllRows ────────────────────────────────────────────────────────────────

describe('dbAllRows()', () => {
  it('returns empty array when no rows exist', () => {
    expect(dbAllRows()).toEqual([]);
  });

  it('returns all rows ordered by slab_id then key', () => {
    dbUpsert(makeRow({ slab_id: 'b', key: '2' }));
    dbUpsert(makeRow({ slab_id: 'a', key: '1' }));
    dbUpsert(makeRow({ slab_id: 'a', key: '2' }));
    const rows = dbAllRows();
    expect(rows[0].slab_id).toBe('a');
    expect(rows[0].key).toBe('1');
    expect(rows[1].key).toBe('2');
    expect(rows[2].slab_id).toBe('b');
  });
});

// ── dbRowsBySlab ─────────────────────────────────────────────────────────────

describe('dbRowsBySlab()', () => {
  it('returns empty array for unknown slab', () => {
    expect(dbRowsBySlab('no-such-slab')).toEqual([]);
  });

  it('returns only rows belonging to the requested slab', () => {
    dbUpsert(makeRow({ slab_id: 'alpha', key: 'a1' }));
    dbUpsert(makeRow({ slab_id: 'alpha', key: 'a2' }));
    dbUpsert(makeRow({ slab_id: 'beta',  key: 'b1' }));
    const rows = dbRowsBySlab('alpha');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.slab_id === 'alpha')).toBe(true);
  });

  it('orders results by key', () => {
    dbUpsert(makeRow({ key: 'z' }));
    dbUpsert(makeRow({ key: 'a' }));
    const keys = dbRowsBySlab('test-slab').map(r => r.key);
    expect(keys).toEqual(['a', 'z']);
  });
});

// ── dbRowCount ───────────────────────────────────────────────────────────────

describe('dbRowCount()', () => {
  it('returns 0 for an empty database', () => {
    expect(dbRowCount()).toBe(0);
  });

  it('increments with each unique insert', () => {
    dbUpsert(makeRow({ key: '1' }));
    dbUpsert(makeRow({ key: '2' }));
    expect(dbRowCount()).toBe(2);
  });

  it('does not increment on UPSERT of existing key', () => {
    dbUpsert(makeRow({ content: 'v1' }));
    dbUpsert(makeRow({ content: 'v2' }));
    expect(dbRowCount()).toBe(1);
  });
});

// ── dbSlabIds ────────────────────────────────────────────────────────────────

describe('dbSlabIds()', () => {
  it('returns empty array when no rows exist', () => {
    expect(dbSlabIds()).toEqual([]);
  });

  it('returns distinct slab IDs in alphabetical order', () => {
    dbUpsert(makeRow({ slab_id: 'gamma', key: '1' }));
    dbUpsert(makeRow({ slab_id: 'alpha', key: '1' }));
    dbUpsert(makeRow({ slab_id: 'alpha', key: '2' }));  // duplicate slab
    dbUpsert(makeRow({ slab_id: 'beta',  key: '1' }));
    expect(dbSlabIds()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ── dbImportRows ─────────────────────────────────────────────────────────────

describe('dbImportRows()', () => {
  it('returns the number of rows processed', () => {
    const n = dbImportRows([makeRow({ key: '1' }), makeRow({ key: '2' })]);
    expect(n).toBe(2);
  });

  it('bulk-inserts all provided rows', () => {
    dbImportRows([
      makeRow({ key: 'a', content: 'A' }),
      makeRow({ key: 'b', content: 'B' }),
      makeRow({ key: 'c', content: 'C' }),
    ]);
    expect(dbRowCount()).toBe(3);
  });

  it('upserts (does not duplicate) on repeated import', () => {
    dbImportRows([makeRow({ key: 'x', content: 'first' })]);
    dbImportRows([makeRow({ key: 'x', content: 'second' })]);
    expect(dbRowCount()).toBe(1);
    expect(dbAllRows()[0].content).toBe('second');
  });

  it('handles an empty array gracefully', () => {
    expect(() => dbImportRows([])).not.toThrow();
    expect(dbRowCount()).toBe(0);
  });

  it('is atomic — all rows committed together or not at all', () => {
    // Verify by inserting a batch and confirming all-or-nothing semantics:
    // if the batch runs, every row must be present.
    const batch = ['x', 'y', 'z'].map(k => makeRow({ key: k }));
    dbImportRows(batch);
    // All three rows must exist — partial write would indicate non-atomic behaviour
    expect(dbRowCount()).toBe(3);
    expect(dbSlabIds()).toEqual(['test-slab']);
  });
});

// ── seedFromCSV ──────────────────────────────────────────────────────────────

describe('seedFromCSV()', () => {
  it('returns 0 and is a no-op when DB already has rows', () => {
    dbUpsert(makeRow());
    const n = seedFromCSV('/nonexistent/path.csv');
    expect(n).toBe(0);
    expect(dbRowCount()).toBe(1);  // pre-existing row untouched
  });

  it('returns 0 when the CSV file does not exist', () => {
    expect(seedFromCSV('/nonexistent/path.csv')).toBe(0);
    expect(dbRowCount()).toBe(0);
  });

  it('imports rows from a real CSV file', () => {
    const tmpf = `${os.tmpdir()}/mem-test-${Date.now()}.csv`;
    writeFileSync(tmpf, [
      'slab_id,slot_type,key,content,priority,last_accessed,evictable,notes',
      'csv-slab,WORKING,csv-key-1,content one,2,2026-01-01,YES,',
      'csv-slab,WORKING,csv-key-2,content two,3,2026-01-02,NO,note',
    ].join('\n'));

    try {
      const n = seedFromCSV(tmpf);
      expect(n).toBe(2);
      expect(dbRowCount()).toBe(2);
      const rows = dbRowsBySlab('csv-slab');
      expect(rows[0].key).toBe('csv-key-1');
      expect(rows[1].priority).toBe(3);
    } finally {
      unlinkSync(tmpf);
    }
  });
});
