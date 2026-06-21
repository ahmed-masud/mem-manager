#!/usr/bin/env node
/**
 * mcp-server.js — MCP server for mem-manager
 *
 * Exposes Claude's memory management operations as MCP tools.
 * Runs on gamgee (10.0.0.208), reachable via HTTP SSE transport.
 *
 * Usage:
 *   node scripts/mcp-server.js
 *
 * Tools exposed:
 *   mem_status     → TLB view (what's loaded, free slots)
 *   mem_load       → page-in a slab from backing store
 *   mem_evict      → page-out a slab, free slots
 *   mem_evict_lru  → auto-evict least recently used slab
 *   mem_sync_pull  → pull Google Sheet → local CSV
 *   mem_sync_push  → push local CSV → Google Sheet
 *   mem_upsert     → add/update a single row in backing store
 *   mem_list_slabs → list all available slabs + their status
 */

import './patch.js';
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { execSync } from 'child_process';
import { readPageDir } from './page-dir.js';
import { dbAllRows, dbUpsert, dbImportRows, seedFromCSV } from './db.js';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';
import uiRouter from './ui.js';

const PORT       = process.env.MCP_PORT ?? 3456;
const DIR        = process.env.LOCAL_STORE_PATH?.replace('/store/master.csv', '') ?? '.';
const CSV_PATH   = process.env.LOCAL_STORE_PATH ?? null;
const BACKUP_CSV = process.env.BACKUP_CSV ?? null;
const COLS       = ['slab_id','slot_type','key','content','priority','last_accessed','evictable','notes'];

// Seed SQLite from master.csv on first start (one-time migration)
if (CSV_PATH) seedFromCSV(CSV_PATH);

// ---------------------------------------------------------------------------
// Helper — run a local script and return stdout
// ---------------------------------------------------------------------------
function run(script, args = '') {
  try {
    return execSync(`node ${DIR}/scripts/${script} ${args}`, {
      cwd: DIR, encoding: 'utf8', timeout: 15000,
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

// ---------------------------------------------------------------------------
// MCP Server factory — fresh instance per request (SDK requirement)
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({ name: 'mem-manager', version: '0.1.0' });

// --- mem_status -------------------------------------------------------------
server.tool('mem_status',
  'Show current TLB state: which slabs are loaded, slot usage, stale flags.',
  {},
  async () => ({
    content: [{ type: 'text', text: run('status.js') }],
  })
);

// --- mem_list_slabs ---------------------------------------------------------
server.tool('mem_list_slabs',
  'List all slabs in the backing store with their loaded/unloaded status.',
  {},
  async () => {
    const rows = dbAllRows();
    const dir  = readPageDir();
    const slabs = [...new Set(rows.map(r => r.slab_id))].map(id => ({
      slab_id:       id,
      loaded:        (dir.slabs[id]?.slots?.length ?? 0) > 0,
      slots:         dir.slabs[id]?.slots ?? [],
      evictable:     dir.slabs[id]?.evictable ?? true,
      last_accessed: dir.slabs[id]?.last_accessed ?? null,
      row_count:     rows.filter(r => r.slab_id === id).length,
    }));
    return { content: [{ type: 'text', text: JSON.stringify(slabs, null, 2) }] };
  }
);

// --- mem_load ---------------------------------------------------------------
server.tool('mem_load',
  'Page-in a slab from the backing store into working memory slots.',
  { slab_id: z.string().describe('The slab ID to load, e.g. interview-prep-ncc') },
  async ({ slab_id }) => ({
    content: [{ type: 'text', text: run('load.js', slab_id) }],
  })
);

// --- mem_evict --------------------------------------------------------------
server.tool('mem_evict',
  'Page-out a slab from working memory, freeing its slots.',
  { slab_id: z.string().describe('The slab ID to evict, e.g. pipeline-closed') },
  async ({ slab_id }) => ({
    content: [{ type: 'text', text: run('evict.js', slab_id) }],
  })
);

// --- mem_evict_lru ----------------------------------------------------------
server.tool('mem_evict_lru',
  'Auto-evict the least recently used evictable slab.',
  {},
  async () => ({
    content: [{ type: 'text', text: run('evict.js', '--lru') }],
  })
);

// --- mem_sync_pull ----------------------------------------------------------
server.tool('mem_sync_pull',
  'Restore SQLite from the local CSV backup file (BACKUP_CSV path).',
  {},
  async () => {
    if (!BACKUP_CSV || !fs.existsSync(BACKUP_CSV)) {
      return { content: [{ type: 'text', text: '⚠️ No backup CSV found. Set BACKUP_CSV in .env or use the web UI to import.' }] };
    }
    const raw  = fs.readFileSync(BACKUP_CSV, 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true });
    dbImportRows(rows);
    return { content: [{ type: 'text', text: `✅ Restored ${rows.length} rows from ${BACKUP_CSV} into SQLite.` }] };
  }
);

// --- mem_sync_push ----------------------------------------------------------
server.tool('mem_sync_push',
  'Save SQLite contents to the local CSV backup file (BACKUP_CSV path).',
  {},
  async () => {
    if (!BACKUP_CSV) {
      return { content: [{ type: 'text', text: '⚠️ BACKUP_CSV not set in .env. Use the web UI Export button instead.' }] };
    }
    const rows = dbAllRows();
    const csv  = stringify(rows, { header: true, columns: COLS });
    fs.writeFileSync(BACKUP_CSV, csv, 'utf8');
    return { content: [{ type: 'text', text: `✅ Saved ${rows.length} rows to ${BACKUP_CSV}.` }] };
  }
);

// --- mem_upsert -------------------------------------------------------------
server.tool('mem_upsert',
  'Add or update a single memory entry in the local SQLite store.',
  {
    slab_id:    z.string().describe('Slab category, e.g. contacts, interview-prep-ncc'),
    key:        z.string().describe('Unique key within the slab, e.g. rafi-ncc'),
    content:    z.string().describe('The memory content to store'),
    slot_type:  z.enum(['PINNED','WORKING']).default('WORKING'),
    priority:   z.number().min(1).max(5).default(2),
    evictable:  z.enum(['YES','NO']).default('YES'),
    notes:      z.string().default(''),
  },
  async (row) => {
    dbUpsert({ ...row, last_accessed: new Date().toISOString().slice(0, 10) });
    return { content: [{ type: 'text', text: `✅ Upserted [${row.slab_id}/${row.key}] to backing store.` }] };
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// Express + HTTP transport
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Web UI
app.use('/ui', uiRouter);

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', server: 'mem-manager', version: '0.1.0' }));

// MCP endpoint — fresh server instance per request
app.all('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const httpServer = app.listen(PORT, () => {
  console.log(`\n🧠  mem-manager running on port ${PORT}`);
  console.log(`    MCP:    http://10.0.0.208:${PORT}/mcp`);
  console.log(`    UI:     http://10.0.0.208:${PORT}/ui`);
  console.log(`    Health: http://10.0.0.208:${PORT}/health\n`);
});

// Graceful shutdown — keeps process alive under systemd
process.on('SIGTERM', () => { console.log('SIGTERM received, shutting down'); httpServer.close(); });
process.on('SIGINT',  () => { console.log('SIGINT received, shutting down');  httpServer.close(); });
// Keep process alive under systemd (stdin may be /dev/null under nohup)
try { process.stdin.resume(); } catch { /* non-tty env, ignore */ }
process.stdin.on('error', () => { /* suppress EBADF from nohup/redirect */ });
