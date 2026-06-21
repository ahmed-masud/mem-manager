# mem-manager

A software-managed virtual memory system for Claude's 30-slot persistent memory.
Backed by a local **SQLite database** — no cloud dependency, no CSV parsing in the hot path.

## Concept

Claude's memory has 30 slots × 100K chars each = 3 MB of "RAM".
This project treats that RAM like a CPU cache:

```
store/mem.db          →  "disk"  (SQLite, unlimited rows, instant reads/writes)
30 memory slots       →  "RAM"   (working set in Claude's context)
Slabs (categories)    →  "pages" (evicted/loaded as units)
page_directory.json   →  "TLB"   (what's currently loaded & where)
```

## Architecture

```
Claude / daily-triage-web
        │
        ▼
  MCP server :3456  (mcp-server.js)
        │
        ├─── scripts/db.js  →  store/mem.db  (SQLite — primary store)
        │
        └─── scripts/ui.js  →  /ui  (web interface)
                                   ├── view slabs & entries
                                   ├── add / edit / delete entries
                                   ├── 📤 Export CSV  (backup)
                                   └── 📥 Import CSV  (restore)
```

**All reads and writes hit SQLite directly.** No network call on `mem_upsert` — it
returns immediately after the local write. CSV and Google Sheets are no longer in
the critical path.

## Running

```bash
npm install
node scripts/mcp-server.js
# MCP:    http://10.0.0.208:3456/mcp
# UI:     http://10.0.0.208:3456/ui
# Health: http://10.0.0.208:3456/health
```

On first start the server seeds `store/mem.db` from `store/master.csv` if the DB is
empty (one-time migration). Subsequent starts skip the seed automatically.

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_DB_PATH` | `store/mem.db` | SQLite database path |
| `BACKUP_CSV` | `store/backup.csv` | CSV file used by `mem_sync_push` / `mem_sync_pull` |
| `LOCAL_STORE_PATH` | `store/master.csv` | Legacy CSV — used only for initial seed |
| `PAGE_DIR_PATH` | `page_directory.json` | TLB state file |
| `MCP_PORT` | `3456` | HTTP port |

## MCP Tools

| Tool | What it does |
|---|---|
| `mem_upsert` | Add/update an entry in SQLite (instant, local only) |
| `mem_list_slabs` | List all slabs with slot status and row counts |
| `mem_status` | Pretty-print the TLB (page directory) |
| `mem_load` | Page-in a slab from SQLite into working memory slots |
| `mem_evict` | Page-out a slab, free its slots |
| `mem_evict_lru` | Auto-evict the least-recently-used evictable slab |
| `mem_sync_push` | Save SQLite → `BACKUP_CSV` (local file backup) |
| `mem_sync_pull` | Restore `BACKUP_CSV` → SQLite |

## Web UI

Access at **http://10.0.0.208:3456/ui**

- **Sidebar** — all slabs with loaded/unloaded state, row counts, load/evict buttons
- **Entry panel** — click a slab to view its entries; edit ✏️ or delete 🗑 any row
- **＋ New Slab / Add Entry** — modal form, writes directly to SQLite
- **📤 Export CSV** — downloads the full database as a timestamped CSV file
- **📥 Import CSV** — paste CSV text to bulk-import (upserts, safe to re-import)

## Backup & Restore

**Export (backup):**
```bash
# Via web UI — click 📤 Export CSV in the top bar
# Via MCP tool:
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mem_sync_push","arguments":{}}}''
```

**Restore (import):**
```bash
# Via web UI — click 📥 Import CSV, paste CSV text
# Via MCP tool (reads BACKUP_CSV from .env):
curl -X POST http://localhost:3456/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mem_sync_pull","arguments":{}}}'
```

## Slot Layout

| Slots | Type | Contents |
|---|---|---|
| 1–5 | PINNED | Personal info, resume rules, experience anchors |
| 6 | PAGE DIR | Slab manifest — what's loaded & where |
| 7–26 | WORKING | Active pipeline, context, interview prep |
| 27–30 | SCRATCH | Temp during tasks — evict when done |

## File Layout

```
mem-manager/
├── README.md
├── page_directory.json       # TLB — live slot state (runtime)
├── store/
│   ├── mem.db                # SQLite — primary store (gitignored)
│   ├── backup.csv            # Last CSV export (gitignored)
│   └── master.csv            # Legacy CSV — used for initial seed only
├── scripts/
│   ├── db.js                 # SQLite wrapper (better-sqlite3)
│   ├── mcp-server.js         # MCP HTTP server + Express
│   ├── ui.js                 # Web UI router (HTMX)
│   ├── load.js               # Page-in a slab
│   ├── evict.js              # Page-out a slab
│   ├── status.js             # Print TLB state
│   ├── sync.js               # CSV ↔ SQLite sync (backup/restore)
│   ├── sheets.js             # Google Sheets client (optional, not in hot path)
│   └── page-dir.js           # Read/write page_directory.json
└── credentials/              # Service account key (gitignored)
```
