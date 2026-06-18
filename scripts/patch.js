/**
 * patch.js — must be imported FIRST, before any googleapis/gaxios code
 *
 * Problem: gaxios v6 checks `window.fetch` to decide whether to use
 * native fetch or fall back to node-fetch v2. On Node.js there's no
 * `window`, so it always picks node-fetch v2, which has a broken Gunzip
 * stream on Node 22+ (ERR_STREAM_PREMATURE_CLOSE).
 *
 * Fix: shim global.window.fetch with Node 22's native fetch BEFORE gaxios
 * is evaluated. gaxios then uses native fetch for ALL requests — including
 * gtoken's OAuth token exchange — and the Gunzip bug never fires.
 *
 * Usage: import './patch.js' as the very first line in any entrypoint.
 */

if (typeof globalThis.fetch === 'function') {
  if (!globalThis.window) {
    globalThis.window = {};
  }
  if (!globalThis.window.fetch) {
    globalThis.window.fetch = globalThis.fetch.bind(globalThis);
    console.log('🔧  patch.js: shimmed window.fetch → native fetch (Node 22+ gaxios fix)');
  }
} else {
  console.warn('⚠️   patch.js: native fetch not available — gaxios will use node-fetch v2');
}
