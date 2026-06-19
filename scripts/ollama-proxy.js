#!/usr/bin/env node
/**
 * ollama-proxy.js — Memory-aware transparent proxy for Ollama
 *
 * Sits on port 11435, forwards to Ollama on 11434.
 * Intercepts /api/chat and /api/generate to inject
 * active memory slabs as system context automatically.
 *
 * All other routes pass through unchanged.
 *
 * Usage:  node scripts/ollama-proxy.js
 * Client: point any Ollama client at http://gamgee:11435
 */

import './patch.js';
import 'dotenv/config';
import express from 'express';
import { readPageDir } from './page-dir.js';
import { readLocalCSV } from './sheets.js';

const PROXY_PORT  = process.env.OLLAMA_PROXY_PORT ?? 11435;
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://10.0.0.208:11434';
const LOCAL       = process.env.LOCAL_STORE_PATH;

// ---------------------------------------------------------------------------
// Build memory context string from loaded slabs
// ---------------------------------------------------------------------------
function buildMemoryContext() {
  try {
    const dir  = readPageDir();
    const rows = readLocalCSV(LOCAL);

    const loadedSlabs = Object.entries(dir.slabs)
      .filter(([, s]) => s.slots?.length > 0)
      .map(([id]) => id);

    if (loadedSlabs.length === 0) return null;

    const sections = loadedSlabs.map(slabId => {
      const entries = rows.filter(r => r.slab_id === slabId);
      if (entries.length === 0) return null;
      const lines = entries.map(e => `- ${e.key}: ${e.content}`).join('\n');
      return `### ${slabId}\n${lines}`;
    }).filter(Boolean);

    return [
      `## Persistent Memory Context`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Loaded slabs: ${loadedSlabs.join(', ')}`,
      '',
      ...sections,
      '',
      '---',
      'Use the above context to inform your responses where relevant.',
    ].join('\n');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy a request to Ollama, streaming the response back
// ---------------------------------------------------------------------------
async function proxyToOllama(path, body, res) {
  const url = `${OLLAMA_HOST}${path}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  res.status(upstream.status);
  upstream.headers.forEach((v, k) => res.setHeader(k, v));

  // Stream NDJSON back chunk by chunk
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// /api/chat — inject memory as system message
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const body = { ...req.body };
  const memCtx = buildMemoryContext();

  if (memCtx) {
    const messages = body.messages ?? [];
    const hasSystem = messages.some(m => m.role === 'system');

    if (hasSystem) {
      // Append to existing system message
      body.messages = messages.map(m =>
        m.role === 'system'
          ? { ...m, content: `${m.content}\n\n${memCtx}` }
          : m
      );
    } else {
      // Prepend new system message
      body.messages = [{ role: 'system', content: memCtx }, ...messages];
    }
    console.log(`[mem-proxy] /api/chat → ${body.model} | injected ${Object.keys(readPageDir().slabs).filter(id => readPageDir().slabs[id]?.slots?.length > 0).length} slabs`);
  }

  await proxyToOllama('/api/chat', body, res);
});

// ---------------------------------------------------------------------------
// /api/generate — inject memory into system field
// ---------------------------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const body = { ...req.body };
  const memCtx = buildMemoryContext();

  if (memCtx) {
    body.system = body.system
      ? `${body.system}\n\n${memCtx}`
      : memCtx;
    console.log(`[mem-proxy] /api/generate → ${body.model} | memory injected`);
  }

  await proxyToOllama('/api/generate', body, res);
});

// ---------------------------------------------------------------------------
// All other routes — pass through untouched
// ---------------------------------------------------------------------------
app.use(async (req, res) => {
  const url = `${OLLAMA_HOST}${req.path}`;
  const isGet = req.method === 'GET';

  const upstream = await fetch(url, {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    body: isGet ? undefined : JSON.stringify(req.body),
  });

  res.status(upstream.status);
  upstream.headers.forEach((v, k) => res.setHeader(k, v));
  const text = await upstream.text();
  res.send(text);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PROXY_PORT, () => {
  console.log(`\n🧠  Ollama memory proxy`);
  console.log(`    Listening: http://gamgee:${PROXY_PORT}`);
  console.log(`    Upstream:  ${OLLAMA_HOST}`);
  console.log(`    Models:    llama3.2, mistral, tinyllama + any future model`);
  console.log(`    Memory:    auto-injected from loaded slabs\n`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
process.stdin.resume();
