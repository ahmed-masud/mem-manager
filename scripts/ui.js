/**
 * ui.js — Express router for the mem-manager web UI
 * Mounted at /ui in mcp-server.js
 * Uses HTMX for dynamic fragments — no build step required.
 *
 * Backing store: SQLite (db.js) only. No Google Sheets dependency.
 * CSV import/export available via the UI for backup/restore.
 */

import './patch.js';
import 'dotenv/config';
import { Router } from 'express';
import { execSync } from 'child_process';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { readPageDir, today } from './page-dir.js';
import { dbAllRows, dbRowsBySlab, dbUpsert, dbImportRows, getDb } from './db.js';

const router = Router();
const DIR = process.env.LOCAL_STORE_PATH?.replace('/store/master.csv', '') ?? '.';

function run(script, args = '') {
  try {
    return execSync(`node ${DIR}/scripts/${script} ${args}`, {
      cwd: DIR, encoding: 'utf8', timeout: 15000,
    });
  } catch (e) { return e.stdout || e.stderr || e.message; }
}

const COLS = ['slab_id','slot_type','key','content','priority','last_accessed','evictable','notes'];

// ---------------------------------------------------------------------------
// Status bar fragment
// ---------------------------------------------------------------------------
function statusBar(msg, type = 'info') {
  const color = type === 'ok' ? '#2ecc71' : type === 'err' ? '#e74c3c' : '#3498db';
  return `<span style="color:${color}">${msg}</span>`;
}

// ---------------------------------------------------------------------------
// GET /ui/api/status
// ---------------------------------------------------------------------------
router.get('/api/status', (req, res) => {
  const dir = readPageDir();
  const rows = dbAllRows();
  res.json({
    slots_used: dir.slots_used,
    slots_free: dir.slots_free,
    row_count:  rows.length,
    last_updated: dir.last_updated,
  });
});

// ---------------------------------------------------------------------------
// GET /ui/api/export.csv  — download entire DB as CSV
// ---------------------------------------------------------------------------
router.get('/api/export.csv', (req, res) => {
  const rows = dbAllRows();
  const csv  = stringify(rows, { header: true, columns: COLS });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="mem-backup-${today()}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// POST /ui/api/import  — paste CSV text → bulk import into SQLite
// ---------------------------------------------------------------------------
router.post('/api/import', (req, res) => {
  try {
    const csv  = req.body?.csv ?? '';
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    const n    = dbImportRows(rows);
    res.send(statusBar(`✅ Imported ${n} rows into SQLite — ${today()}`, 'ok'));
  } catch (e) {
    res.send(statusBar(`❌ Import failed: ${e.message}`, 'err'));
  }
});

export default router;

// ---------------------------------------------------------------------------
// GET /ui/api/slabs  — sidebar slab list (HTMX fragment)
// ---------------------------------------------------------------------------
router.get('/api/slabs', (req, res) => {
  const dir = readPageDir();
  const rows = dbAllRows();
  const slabIds = [...new Set(rows.map(r => r.slab_id))];

  const items = slabIds.map(id => {
    const loaded = (dir.slabs[id]?.slots?.length ?? 0) > 0;
    const pinned = dir.slabs[id]?.evictable === false;
    const count  = rows.filter(r => r.slab_id === id).length;
    const dot    = loaded ? '●' : '○';
    const badge  = pinned ? ' 📌' : '';
    const action = loaded
      ? `<button class="evict-btn" hx-post="/ui/api/slabs/${id}/evict"
           hx-target="#slab-list" hx-swap="innerHTML"
           title="Evict">▼</button>`
      : `<button class="load-btn" hx-post="/ui/api/slabs/${id}/load"
           hx-target="#slab-list" hx-swap="innerHTML"
           title="Load">▶</button>`;

    return `
    <li class="slab-item ${loaded ? 'loaded' : ''}"
        hx-get="/ui/api/slabs/${id}/entries"
        hx-target="#entry-panel" hx-swap="innerHTML" hx-trigger="click">
      <span class="dot">${dot}</span>
      <span class="slab-name">${id}${badge}</span>
      <span class="count">${count}</span>
      ${action}
    </li>`;
  }).join('');

  res.send(`<ul class="slab-list">${items}</ul>
    <button class="new-slab-btn" onclick="showNewSlabForm()">＋ New Slab</button>`);
});

// ---------------------------------------------------------------------------
// GET /ui/api/slabs/:id/entries  — entry table (HTMX fragment)
// ---------------------------------------------------------------------------
router.get('/api/slabs/:id/entries', (req, res) => {
  const { id } = req.params;
  const rows = dbRowsBySlab(id);

  if (rows.length === 0) {
    res.send(`<p class="empty">No entries in <strong>${id}</strong>.</p>
      <button onclick="showAddForm('${id}')" class="add-btn">＋ Add Entry</button>`);
    return;
  }

  const trs = rows.map(r => `
    <tr>
      <td class="key-cell">${r.key}</td>
      <td class="content-cell" title="${r.content.replace(/"/g,"'")}">
        ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}
      </td>
      <td class="meta-cell">${r.priority ?? '—'} / ${r.evictable ?? '—'}</td>
      <td class="action-cell">
        <button onclick="showEditForm('${id}','${r.key}',this)" title="Edit">✏️</button>
        <button hx-delete="/ui/api/entry/${id}/${r.key}"
          hx-target="#entry-panel" hx-swap="innerHTML"
          hx-confirm="Delete ${r.key}?" title="Delete">🗑</button>
      </td>
    </tr>`).join('');

  res.send(`
    <div class="panel-header">
      <h3>${id} <span class="count">${rows.length} entries</span></h3>
      <button onclick="showAddForm('${id}')" class="add-btn">＋ Add Entry</button>
    </div>
    <table class="entry-table">
      <thead><tr><th>Key</th><th>Content</th><th>Pri/Evict</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
    <div id="entry-form"></div>`);
});

// ---------------------------------------------------------------------------
// POST /ui/api/slabs/:id/load
// ---------------------------------------------------------------------------
router.post('/api/slabs/:id/load', (req, res) => {
  run('load.js', req.params.id);
  res.setHeader('HX-Trigger', 'slabsChanged');
  res.redirect(303, '/ui/api/slabs');
});

// ---------------------------------------------------------------------------
// POST /ui/api/slabs/:id/evict
// ---------------------------------------------------------------------------
router.post('/api/slabs/:id/evict', (req, res) => {
  run('evict.js', req.params.id);
  res.redirect(303, '/ui/api/slabs');
});

// ---------------------------------------------------------------------------
// POST /ui/api/upsert  — add or update an entry
// ---------------------------------------------------------------------------
router.post('/api/upsert', (req, res) => {
  const { slab_id, key, content, slot_type, priority, evictable, notes } = req.body;
  try {
    dbUpsert({
      slab_id, key, content,
      slot_type: slot_type || 'WORKING',
      priority:  Number(priority) || 2,
      evictable: evictable || 'YES',
      notes:     notes || '',
      last_accessed: today(),
    });
    res.setHeader('HX-Trigger-After-Swap', 'slabsChanged');
    res.redirect(303, `/ui/api/slabs/${slab_id}/entries`);
  } catch (e) {
    res.status(500).send(statusBar(`❌ Upsert failed: ${e.message}`, 'err'));
  }
});

// ---------------------------------------------------------------------------
// DELETE /ui/api/entry/:slab/:key
// ---------------------------------------------------------------------------
router.delete('/api/entry/:slab/:key', (req, res) => {
  const { slab, key } = req.params;
  try {
    getDb().prepare('DELETE FROM entries WHERE slab_id = ? AND key = ?').run(slab, key);
    res.setHeader('HX-Trigger-After-Swap', 'slabsChanged');
    res.redirect(303, `/ui/api/slabs/${slab}/entries`);
  } catch (e) {
    res.status(500).send(statusBar(`❌ Delete failed: ${e.message}`, 'err'));
  }
});

// ---------------------------------------------------------------------------
// GET /ui  — full HTML page
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const dir = readPageDir();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🧠 mem-manager</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>
    :root {
      --bg:      #0d1117;
      --surface: #161b22;
      --border:  #30363d;
      --text:    #e6edf3;
      --muted:   #8b949e;
      --green:   #2ecc71;
      --blue:    #3498db;
      --red:     #e74c3c;
      --yellow:  #f1c40f;
      --accent:  #58a6ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column; }

    /* Top bar */
    #topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 12px; }
    #topbar h1 { font-size: 15px; color: var(--accent); flex: 1; }
    #topbar button { background: var(--border); border: none; color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    #topbar button:hover { background: var(--accent); color: #000; }
    #sync-status { font-size: 12px; color: var(--muted); min-width: 240px; text-align: right; }

    /* Layout */
    #layout { display: flex; flex: 1; overflow: hidden; }

    /* Sidebar */
    #sidebar { width: 220px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; }
    #sidebar h2 { padding: 10px 14px; font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 1px; border-bottom: 1px solid var(--border); }
    .slab-list { list-style: none; padding: 6px 0; flex: 1; }
    .slab-item { display: flex; align-items: center; gap: 6px; padding: 7px 14px; cursor: pointer; border-radius: 0; transition: background 0.1s; }
    .slab-item:hover { background: rgba(88,166,255,0.08); }
    .slab-item.loaded .dot { color: var(--green); }
    .slab-item:not(.loaded) .dot { color: var(--muted); }
    .slab-name { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { font-size: 10px; color: var(--muted); background: var(--border); border-radius: 10px; padding: 1px 6px; }
    .load-btn, .evict-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; }
    .load-btn:hover { color: var(--green); }
    .evict-btn:hover { color: var(--red); }
    .new-slab-btn { margin: 8px 14px; background: none; border: 1px dashed var(--border); color: var(--muted); padding: 6px; border-radius: 6px; cursor: pointer; width: calc(100% - 28px); }
    .new-slab-btn:hover { border-color: var(--accent); color: var(--accent); }

    /* Slot meter */
    #slot-meter { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
    #slot-meter .bar { height: 4px; background: var(--border); border-radius: 2px; margin-top: 5px; }
    #slot-meter .fill { height: 100%; border-radius: 2px; background: var(--green); }

    /* Main panel */
    #main { flex: 1; overflow-y: auto; padding: 16px 20px; }
    #entry-panel .panel-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    #entry-panel h3 { font-size: 14px; color: var(--accent); flex: 1; }
    .add-btn { background: var(--green); border: none; color: #000; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: bold; }
    .entry-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .entry-table th { text-align: left; padding: 8px 10px; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: normal; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
    .entry-table td { padding: 8px 10px; border-bottom: 1px solid rgba(48,54,61,0.5); vertical-align: top; }
    .entry-table tr:hover td { background: rgba(88,166,255,0.04); }
    .key-cell { color: var(--yellow); font-weight: bold; white-space: nowrap; width: 140px; }
    .content-cell { color: var(--text); max-width: 420px; }
    .meta-cell { color: var(--muted); white-space: nowrap; width: 80px; }
    .action-cell { white-space: nowrap; width: 60px; }
    .action-cell button { background: none; border: none; cursor: pointer; padding: 2px 4px; font-size: 14px; opacity: 0.6; }
    .action-cell button:hover { opacity: 1; }
    .empty { color: var(--muted); padding: 20px 0; }

    /* Welcome */
    #welcome { color: var(--muted); padding: 40px 20px; text-align: center; }
    #welcome h2 { color: var(--accent); margin-bottom: 8px; }

    /* Modal overlay */
    #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
    #modal.show { display: flex; }
    #modal-box { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; width: 520px; max-height: 90vh; overflow-y: auto; }
    #modal-box h3 { color: var(--accent); margin-bottom: 14px; font-size: 14px; }
    #modal-box label { display: block; color: var(--muted); font-size: 11px; margin: 10px 0 3px; text-transform: uppercase; }
    #modal-box input, #modal-box textarea, #modal-box select {
      width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text);
      padding: 7px 10px; border-radius: 6px; font-family: inherit; font-size: 13px;
    }
    #modal-box textarea { height: 100px; resize: vertical; }
    #modal-box input:focus, #modal-box textarea:focus { outline: none; border-color: var(--accent); }
    .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    .btn-save { background: var(--accent); border: none; color: #000; padding: 7px 18px; border-radius: 6px; cursor: pointer; font-weight: bold; }
    .btn-cancel { background: var(--border); border: none; color: var(--text); padding: 7px 18px; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body hx-boost="false">

<!-- Top bar -->
<div id="topbar">
  <h1>🧠 mem-manager</h1>
  <a href="/ui/api/export.csv" download>
    <button type="button">📤 Export CSV</button>
  </a>
  <button type="button" onclick="showImportModal()">📥 Import CSV</button>
  <div id="sync-status">Ready</div>
</div>

<!-- Layout -->
<div id="layout">
  <!-- Sidebar -->
  <div id="sidebar">
    <h2>Slabs</h2>
    <div id="slab-list"
      hx-get="/ui/api/slabs" hx-trigger="load, slabsChanged from:body"
      hx-swap="innerHTML">Loading…</div>
    <div id="slot-meter">
      <span id="slot-label">Slots: ${dir.slots_used}/30</span>
      <div class="bar"><div class="fill" style="width:${Math.round(dir.slots_used/30*100)}%"></div></div>
    </div>
  </div>

  <!-- Main -->
  <div id="main">
    <div id="entry-panel">
      <div id="welcome">
        <h2>Select a slab</h2>
        <p>Click any slab in the sidebar to view its entries.</p>
      </div>
    </div>
  </div>
</div>

<!-- Import CSV Modal -->
<div id="import-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:200;align-items:center;justify-content:center">
  <div id="modal-box" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;width:580px;max-height:90vh;overflow-y:auto">
    <h3 style="color:var(--accent);margin-bottom:14px">📥 Import CSV</h3>
    <p style="color:var(--muted);font-size:11px;margin-bottom:10px">Paste CSV text (with header row: slab_id,slot_type,key,content,priority,last_accessed,evictable,notes). Existing keys are updated.</p>
    <form hx-post="/ui/api/import" hx-target="#sync-status" hx-swap="innerHTML"
          hx-on::after-request="closeImportModal(); refreshSlabs()">
      <textarea name="csv" style="width:100%;height:200px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:6px;font-family:inherit;font-size:12px;resize:vertical" placeholder="slab_id,slot_type,key,content,..."></textarea>
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
        <button type="button" class="btn-cancel" onclick="closeImportModal()">Cancel</button>
        <button type="submit" class="btn-save">Import</button>
      </div>
    </form>
  </div>
</div>

<!-- Edit / Add Modal -->
<div id="modal">
  <div id="modal-box">
    <h3 id="modal-title">Add Entry</h3>
    <form hx-post="/ui/api/upsert" hx-target="#entry-panel" hx-swap="innerHTML"
          hx-on::after-request="closeModal()">
      <label>Slab ID</label>
      <input name="slab_id" id="f-slab" required>
      <label>Key</label>
      <input name="key" id="f-key" required>
      <label>Content</label>
      <textarea name="content" id="f-content" required></textarea>
      <label>Slot Type</label>
      <select name="slot_type" id="f-slot-type">
        <option value="WORKING">WORKING</option>
        <option value="PINNED">PINNED</option>
      </select>
      <label>Priority (1=high, 5=low)</label>
      <input name="priority" id="f-priority" type="number" min="1" max="5" value="2">
      <label>Evictable</label>
      <select name="evictable" id="f-evictable">
        <option value="YES">YES</option>
        <option value="NO">NO</option>
      </select>
      <label>Notes</label>
      <input name="notes" id="f-notes">
      <div class="modal-actions">
        <button type="button" class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-save">Save</button>
      </div>
    </form>
  </div>
</div>

<script>
  function closeModal() { document.getElementById('modal').classList.remove('show'); }
  function showAddForm(slabId) {
    document.getElementById('modal-title').textContent = 'Add Entry';
    document.getElementById('f-slab').value = slabId;
    document.getElementById('f-slab').readOnly = true;
    document.getElementById('f-key').value = '';
    document.getElementById('f-content').value = '';
    document.getElementById('f-notes').value = '';
    document.getElementById('f-priority').value = '2';
    document.getElementById('f-slot-type').value = 'WORKING';
    document.getElementById('f-evictable').value = 'YES';
    document.getElementById('modal').classList.add('show');
  }
  function showEditForm(slabId, key, btn) {
    const row = btn.closest('tr');
    const content = row.querySelector('.content-cell').title;
    document.getElementById('modal-title').textContent = 'Edit Entry';
    document.getElementById('f-slab').value = slabId;
    document.getElementById('f-slab').readOnly = true;
    document.getElementById('f-key').value = key;
    document.getElementById('f-key').readOnly = true;
    document.getElementById('f-content').value = content;
    document.getElementById('modal').classList.add('show');
  }
  function showNewSlabForm() {
    document.getElementById('modal-title').textContent = 'New Slab Entry';
    document.getElementById('f-slab').value = '';
    document.getElementById('f-slab').readOnly = false;
    document.getElementById('f-key').value = '';
    document.getElementById('f-key').readOnly = false;
    document.getElementById('f-content').value = '';
    document.getElementById('modal').classList.add('show');
  }
  function refreshSlabs() {
    htmx.trigger(document.getElementById('slab-list'), 'slabsChanged');
  }
  function showImportModal() {
    const m = document.getElementById('import-modal');
    m.style.display = 'flex';
  }
  function closeImportModal() {
    const m = document.getElementById('import-modal');
    m.style.display = 'none';
  }
  // Close modals on backdrop click
  document.getElementById('modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('import-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeImportModal();
  });
</script>
</body>
</html>`);
});
