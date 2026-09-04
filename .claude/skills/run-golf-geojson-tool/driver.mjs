#!/usr/bin/env node
// Driver/smoke harness for the Golf GeoJSON Tool.
//
// Launches its OWN viewer on an isolated port (default 3100, NOT the dev 3000
// so it never clobbers a live editing session), then drives every surface a
// PR here touches:
//   1. Viewer HTTP API   — POST/GET/DELETE /geojson, /midpoints
//   2. SSE broadcast     — /events fires `geojson-updated` on every mutation
//   3. MCP stdio server  — JSON-RPC initialize → tools/list → tools/call
//   4. Rendered map      — Chrome headless screenshot to /tmp (macOS)
//
// Usage:
//   node driver.mjs                 # full smoke on port 3100
//   node driver.mjs --port 3200     # different port
//   node driver.mjs --no-shot       # skip the Chrome screenshot
//   node driver.mjs --keep          # leave the viewer running after the smoke
//
// Exit code is non-zero if any step fails.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..'); // <repo>/.claude/skills/run-* → repo root
const VIEWER = join(REPO, 'viewer', 'server.js');
const MCP = join(REPO, 'mcp-server', 'index.js');

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || (args.includes('--port') ? NaN : 3100);
const NO_SHOT = args.includes('--no-shot');
const KEEP = args.includes('--keep');
const BASE = `http://localhost:${PORT}`;
const SHOT = `/tmp/golf-viewer-${PORT}.png`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// --- load MAPBOX_TOKEN from .env so the map actually renders ---
function readEnv(key) {
  if (process.env[key]) return process.env[key];
  const envPath = join(REPO, '.env');
  if (!existsSync(envPath)) return '';
  const line = readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}
const MAPBOX_TOKEN = readEnv('MAPBOX_TOKEN');

const log = (m) => console.log(`[driver] ${m}`);
const fail = (m) => { console.error(`[driver] FAIL: ${m}`); throw new Error(m); };
const eq = (got, want, label) => { if (got !== want) fail(`${label}: got ${got}, want ${want}`); log(`ok  ${label} = ${got}`); };

const SAMPLE = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    bbox: [-121.072, 38.966, -121.071, 38.967],
    geometry: { type: 'Polygon', coordinates: [[
      [-121.0717, 38.9664], [-121.0714, 38.9662], [-121.0713, 38.9663],
      [-121.0715, 38.9665], [-121.0717, 38.9664],
    ]] },
    properties: { name: 'smoke_green', hole_number: 1, feature_type: 'green', 'feature-color': '#2d6e2d' },
  }],
};

let viewer;
const children = [];
function cleanup() { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } }
process.on('exit', () => { if (!KEEP) cleanup(); });

async function waitFor(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  fail(`server never came up at ${url}`);
}

// --- 1. launch the viewer ---
async function launchViewer() {
  log(`launching viewer on :${PORT} (token ${MAPBOX_TOKEN ? 'present' : 'MISSING — map will be blank'})`);
  viewer = spawn('node', [VIEWER], {
    env: { ...process.env, PORT: String(PORT), MAPBOX_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(viewer);
  viewer.stderr.on('data', d => process.stderr.write(`[viewer] ${d}`));
  await waitFor(`${BASE}/geojson`);
  log('viewer up');
}

// --- 2. HTTP API + SSE smoke ---
async function smokeHttp() {
  // open SSE first so we catch the broadcast from the POST below
  const sseEvents = [];
  const ac = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const m of buf.matchAll(/event: (\S+)/g)) sseEvents.push(m[1]);
      }
    } catch {}
  })();
  await new Promise(r => setTimeout(r, 200)); // let SSE connect

  await fetch(`${BASE}/geojson`, { method: 'DELETE' });
  const post = await (await fetch(`${BASE}/geojson`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE),
  })).json();
  eq(post.featureCount, 1, 'POST /geojson featureCount');

  const got = await (await fetch(`${BASE}/geojson`)).json();
  eq(got.features.length, 1, 'GET /geojson feature count');
  eq(got.features[0].properties.name, 'smoke_green', 'GET /geojson feature name');

  // midpoints
  await fetch(`${BASE}/midpoints`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'anchor1', lat: 38.9663, lng: -121.0715 }),
  });
  const mids = await (await fetch(`${BASE}/midpoints`)).json();
  eq(mids.length, 1, 'GET /midpoints count');

  await new Promise(r => setTimeout(r, 300));
  ac.abort();
  await ssePromise;
  if (!sseEvents.includes('geojson-updated')) fail('SSE never emitted geojson-updated');
  log(`ok  SSE emitted geojson-updated (${sseEvents.length} event(s))`);
}

// --- 3. MCP stdio JSON-RPC ---
// MCP stdio framing is newline-delimited JSON. The mcp-server proxies every
// tool over HTTP to VIEWER_URL, so we point it at our isolated viewer.
async function smokeMcp() {
  log('driving MCP server over stdio');
  const mcp = spawn('node', [MCP], {
    env: { ...process.env, VIEWER_URL: BASE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(mcp);
  mcp.stderr.on('data', d => process.stderr.write(`[mcp] ${d}`));

  let buf = '';
  const pending = new Map();
  mcp.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // dotenv v17 prints a banner to stdout — skip any non-JSON-RPC line.
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (id, method, params) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) =>
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  const init = await rpc(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'driver', version: '1.0' },
  });
  eq(init.result.serverInfo.name, 'golf-geojson', 'MCP serverInfo.name');
  notify('notifications/initialized', {});

  const tools = await rpc(2, 'tools/list', {});
  const names = tools.result.tools.map(t => t.name);
  log(`ok  tools/list → ${names.length} tools: ${names.join(', ')}`);
  for (const need of ['push_geojson', 'get_geojson', 'clear_map', 'import_from_osm', 'upload_to_supabase']) {
    if (!names.includes(need)) fail(`tools/list missing ${need}`);
  }

  // get_geojson should reflect the sample we pushed over HTTP
  const get = await rpc(3, 'tools/call', { name: 'get_geojson', arguments: {} });
  const fc = JSON.parse(get.result.content[0].text);
  eq(fc.features.length, 1, 'MCP get_geojson feature count');

  // push then clear through the tool layer
  const push = await rpc(4, 'tools/call', { name: 'push_geojson', arguments: { geojson: SAMPLE } });
  log(`ok  MCP push_geojson → "${push.result.content[0].text}"`);
  const clear = await rpc(5, 'tools/call', { name: 'clear_map', arguments: {} });
  log(`ok  MCP clear_map → "${clear.result.content[0].text}"`);
  const after = await (await fetch(`${BASE}/geojson`)).json();
  eq(after.features.length, 0, 'map empty after MCP clear_map');

  mcp.kill('SIGKILL');
}

// --- 4. Chrome headless screenshot of the rendered map ---
async function screenshot() {
  if (NO_SHOT) { log('skipping screenshot (--no-shot)'); return; }
  if (!existsSync(CHROME)) { log(`Chrome not at ${CHROME} — skipping screenshot`); return; }
  // repopulate so the shot isn't an empty map
  await fetch(`${BASE}/geojson`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE),
  });
  // Drive Chrome over CDP (not `--screenshot`): Mapbox satellite tiles load
  // from its CDN, and `--virtual-time-budget` freezes real network time so the
  // tiles never arrive (black map). A real-time wait + CDP capture lets them
  // download. SwiftShader supplies the WebGL context Mapbox GL needs (headless
  // Chrome has no GPU; without these flags map-init throws and the
  // feature-loading JS never runs, leaving "no features loaded").
  const dbg = PORT + 6000; // 3100 → 9100
  log(`capturing map screenshot via CDP (Chrome headless on :${dbg}, ~9s for tiles)`);
  const chrome = spawn(CHROME, [
    '--headless=new', '--hide-scrollbars',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${dbg}`, '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  try {
    await waitFor(`http://localhost:${dbg}/json/version`, 8000);
    const tgt = await (await fetch(`http://localhost:${dbg}/json/new?${BASE}`, { method: 'PUT' })).json();
    const ws = new WebSocket(tgt.webSocketDebuggerUrl);
    let id = 0; const pend = new Map();
    const send = (method, params = {}) => new Promise(res => {
      const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    await send('Page.enable');
    await send('Page.navigate', { url: BASE });
    await new Promise(r => setTimeout(r, 9000)); // real time for satellite tiles
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    ws.close();
  } finally {
    chrome.kill('SIGKILL');
  }
  if (existsSync(SHOT)) log(`ok  screenshot saved → ${SHOT}`);
  else fail('CDP did not produce a screenshot');
}

(async () => {
  try {
    await launchViewer();
    await smokeHttp();
    await smokeMcp();
    await screenshot();
    log('ALL CHECKS PASSED ✅');
    if (KEEP) { log(`viewer left running at ${BASE} (--keep). Ctrl-C to stop.`); return; }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
