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

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { execSync } from 'child_process';
import { readPageDir } from './page-dir.js';
import { pullFromSheet, pushToSheet, readLocalCSV, upsertRow } from './sheets.js';

const PORT = process.env.MCP_PORT ?? 3456;
const DIR  = process.env.LOCAL_STORE_PATH?.replace('/store/master.csv', '') ?? '.';

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
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name:    'mem-manager',
  version: '0.1.0',
});

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
    const rows = readLocalCSV(process.env.LOCAL_STORE_PATH);
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
  'Pull latest data from Google Sheet into local master.csv. Sheet is truth.',
  {},
  async () => {
    const rows = await pullFromSheet();
    const { writeLocalCSV } = await import('./sheets.js');
    writeLocalCSV(process.env.LOCAL_STORE_PATH, rows);
    return { content: [{ type: 'text', text: `✅ Pulled ${rows.length} rows from Google Sheet.` }] };
  }
);

// --- mem_sync_push ----------------------------------------------------------
server.tool('mem_sync_push',
  'Push local master.csv up to Google Sheet.',
  {},
  async () => {
    const { readLocalCSV, pushToSheet } = await import('./sheets.js');
    const rows = readLocalCSV(process.env.LOCAL_STORE_PATH);
    await pushToSheet(rows);
    return { content: [{ type: 'text', text: `✅ Pushed ${rows.length} rows to Google Sheet.` }] };
  }
);

// --- mem_upsert -------------------------------------------------------------
server.tool('mem_upsert',
  'Add or update a single memory entry in the backing store and Google Sheet.',
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
    await upsertRow({ ...row, last_accessed: new Date().toISOString().slice(0, 10) });
    return { content: [{ type: 'text', text: `✅ Upserted [${row.slab_id}/${row.key}] to backing store.` }] };
  }
);

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', server: 'mem-manager', version: '0.1.0' }));

// MCP endpoint
app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
  });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`\n🧠  mem-manager MCP server running`);
  console.log(`    http://gamgee:${PORT}/mcp`);
  console.log(`    http://10.0.0.208:${PORT}/mcp`);
  console.log(`    Health: http://10.0.0.208:${PORT}/health\n`);
});
