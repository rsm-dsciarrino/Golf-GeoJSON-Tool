---
name: run-golf-geojson-tool
description: Run, launch, build, smoke-test, or screenshot the Golf GeoJSON Tool — the Mapbox viewer (Express :3000), the MCP server (stdio), and the OSM course importer. Use when asked to start the app, drive it, verify a change to the viewer API / MCP tools / import pipeline works, or capture the rendered map.
---

# Run the Golf GeoJSON Tool

Three runtimes share one in-memory GeoJSON `FeatureCollection`:

- **`viewer/server.js`** — Express on :3000, the single source of truth for "what's on the map" (in-memory, lost on restart). Serves the Mapbox UI and a small HTTP API (`/geojson`, `/midpoints`, SSE `/events`). Injects `MAPBOX_TOKEN` into the page at request time.
- **`mcp-server/index.js`** — the stdio MCP tool layer Claude drives. Every tool proxies over HTTP to `VIEWER_URL` (default `http://localhost:3000`) — **the viewer must be running** or no tool works.
- **`scripts/import-course.mjs`** — CLI that geocodes a course, pulls OSM golf features, and POSTs them to the live viewer.

**Paths below are relative to the repo root** (`<repo>/`). The driver lives at `.claude/skills/run-golf-geojson-tool/driver.mjs`.

## Run (agent path) — the driver

`driver.mjs` is the harness. It launches its **own** viewer on an isolated port (default **3100**, never the dev :3000, so it won't clobber a live editing session) and exercises every surface a PR here touches, then verifies — HTTP API, SSE broadcast, the full MCP stdio handshake (`initialize` → `tools/list` → `tools/call`), and a real screenshot of the rendered Mapbox map.

```bash
# from repo root — full smoke + screenshot (~25s; the screenshot step waits ~9s for satellite tiles)
node .claude/skills/run-golf-geojson-tool/driver.mjs
```

Expected tail:

```
[driver] ok  SSE emitted geojson-updated (3 event(s))
[driver] ok  tools/list → 10 tools: push_geojson, update_feature, get_geojson, clear_map, ...
[driver] ok  MCP clear_map → "Map cleared."
[driver] ok  screenshot saved → /tmp/golf-viewer-3100.png
[driver] ALL CHECKS PASSED ✅
```

Flags:

```bash
node .claude/skills/run-golf-geojson-tool/driver.mjs --port 3200   # use a different isolated port
node .claude/skills/run-golf-geojson-tool/driver.mjs --no-shot     # skip Chrome screenshot (fast, ~3s)
node .claude/skills/run-golf-geojson-tool/driver.mjs --keep        # leave the viewer running afterward
```

The screenshot lands at `/tmp/golf-viewer-<port>.png` — **open it and look.** A working shot shows the satellite basemap with the sample green polygon and the right-hand FEATURES panel listing `smoke_green`. A black map or "no features loaded" means the WebGL/tiles step failed (see Gotchas).

## Prerequisites

- **Node.js 18+** (verified on v24). No build step — the servers run source directly.
- **`<repo>/.env`** with `MAPBOX_TOKEN=pk....` — required or the map renders blank. The driver reads it automatically; `.env` is gitignored.
- **Google Chrome** at `/Applications/Google Chrome.app` (macOS) — only for the screenshot step. Without it the driver skips the shot and still runs the rest.
- `SUPABASE_CONNECTION_STRING` in `.env` is only needed for the `upload_to_supabase` tool (not exercised by the driver).

```bash
# one-time deps (both packages)
cd viewer && npm install && cd ../mcp-server && npm install && cd ..
```

## Run (human path)

```bash
cd viewer && MAPBOX_TOKEN=$(grep ^MAPBOX_TOKEN= ../.env | cut -d= -f2-) npm run dev
# → "Viewer running on http://localhost:3000"; open it in a browser. Ctrl-C to stop.
# In a second terminal, the MCP server (only useful wired into an MCP client):
cd mcp-server && npm run dev
```

`npm run dev` is `node --watch`; there is **no test framework, linter, or build** in this repo — don't invent one. The driver above is the closest thing to an integration test.

## Direct invocation (drive a running viewer with curl)

The viewer's HTTP API is the real contract. With any viewer running:

```bash
curl -s http://localhost:3100/geojson | jq '.features | length'        # current feature count
curl -s -X POST http://localhost:3100/geojson -H 'Content-Type: application/json' \
  -d '{"type":"FeatureCollection","features":[]}'                       # replace the whole collection
curl -s -X DELETE http://localhost:3100/geojson                         # clear the map
```

## Gotchas

- **Port 3000 is often already taken** by a live dev session. The driver sidesteps this by launching on 3100. If you point it at a busy port it will silently attach to whatever is listening there — check the `EADDRINUSE` line in viewer output if results look stale.
- **The viewer store is in-memory** — restarting `server.js` wipes the map. Nothing persists except what you export or upload to Supabase.
- **Mapbox map needs WebGL, which headless Chrome lacks a GPU for.** `--disable-gpu` makes the map render **black**; you must force the SwiftShader software rasterizer (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`). The driver does this.
- **`--screenshot` + `--virtual-time-budget` produces a black map.** Virtual time freezes real network, so Mapbox satellite tiles (loaded from its CDN) never download. The driver instead drives Chrome over the **DevTools Protocol** (`--remote-debugging-port`, `Page.navigate`, real ~9s wait, `Page.captureScreenshot`) so tiles arrive.
- **Features only render after the map's `load` event fires** (`map.on('load', …)` in `public/index.html`). If the map fails to load (bad token, WebGL failure), the panel shows "no features loaded" even though `GET /geojson` returns features — the symptom is downstream of a map-init failure, not an API problem.
- **The MCP server's `dotenv` v17 prints a banner to stdout** (`◇ injected env (2) from .env`). MCP stdio framing is newline-delimited JSON, so this non-JSON line corrupts naive parsers — the driver tolerantly skips any line that isn't valid JSON.
- **Every MCP tool requires the viewer to be up** — they hold no state and just POST/GET against `VIEWER_URL`. The driver starts the viewer first and points the MCP server at it via `VIEWER_URL`.

## Troubleshooting

- `EADDRINUSE: address already in use :::3100` in viewer output → a previous driver run's viewer didn't exit. `lsof -ti tcp:3100 | xargs kill -9`, then re-run.
- Screenshot is black / "no features loaded" → confirm `MAPBOX_TOKEN` is a valid `pk.` token in `.env`; confirm the SwiftShader flags are present (they're baked into the driver).
- `SyntaxError: Unexpected token '◇'` when parsing MCP output → the dotenv banner reached your JSON parser; skip non-JSON lines (the driver already does).
- Driver hangs at "capturing map screenshot" → Chrome's remote-debugging port (`<port>+6000`, e.g. 9100) may be taken by a stale Chrome; `pkill -f "Google Chrome.*headless"` and re-run.
