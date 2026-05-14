# Golf GeoJSON Tool — Build Plan

This document is a step-by-step build plan for Claude Code to execute in the Codespace terminal.
Work through each phase in order. Each phase ends with a working, testable state.

---

## Repo Structure (final target)

```
golf-geojson-tool/
├── .devcontainer/
│   └── devcontainer.json        # Codespace config
├── viewer/
│   ├── server.js                # Express server — receives GeoJSON, serves map
│   ├── public/
│   │   └── index.html           # Mapbox map with auto-refresh
│   └── package.json
├── mcp-server/
│   ├── index.js                 # MCP server with push/update/clear tools
│   └── package.json
├── skill/
│   └── SKILL.md                 # Claude skill for generating GeoJSON from screenshots
├── .env.example                 # Documents required env vars (no secrets)
└── README.md
```

---

## Phase 1: Devcontainer + Scaffold

**Goal:** Codespace auto-installs dependencies on launch.

### Tasks

1. Create `.devcontainer/devcontainer.json`:
   - Base image: `mcr.microsoft.com/devcontainers/javascript-node:24`
   - `postCreateCommand`: `cd viewer && npm install && cd ../mcp-server && npm install`
   - Forward ports: `3000` (viewer), `3001` (MCP server)
   - Port 3000 label: `"Golf Viewer"`
   - Port 3001 label: `"MCP Server"`

2. Create `.env.example`:
```
MAPBOX_TOKEN=pk.your_token_here
```

3. Create `README.md` with a one-paragraph description and setup instructions.

**Checkpoint:** `.devcontainer/devcontainer.json` exists and is valid JSON.

---

## Phase 2: Viewer Server

**Goal:** A running Express server that accepts GeoJSON and serves a Mapbox map.

### Tasks

1. Create `viewer/package.json`:
   - dependencies: `express`, `cors`
   - scripts: `"start": "node server.js"`, `"dev": "node --watch server.js"`

2. Create `viewer/server.js` with these routes:
   - `GET /` — serves `public/index.html`
   - `POST /geojson` — accepts a GeoJSON FeatureCollection body, stores it in memory, broadcasts an update event via SSE
   - `GET /geojson` — returns the current GeoJSON in memory (or an empty FeatureCollection if none)
   - `GET /events` — SSE endpoint; clients connect here to receive live `geojson-updated` events
   - `DELETE /geojson` — clears the current GeoJSON back to an empty FeatureCollection
   - Listen on `process.env.PORT || 3000`

3. Create `viewer/public/index.html`:
   - Full-screen Mapbox GL JS map (use CDN: `https://api.mapbox.com/mapbox-gl-js/v3.3.0/`)
   - Satellite basemap: `mapbox://styles/mapbox/satellite-streets-v12`
   - Mapbox token read from a `<meta name="mapbox-token">` tag whose content is injected by the server from `process.env.MAPBOX_TOKEN`
   - On load: fetch `GET /geojson` and add it as a GeoJSON source named `"golf-features"`
   - Connect to `GET /events` via `EventSource`; on `geojson-updated` event, re-fetch and update the source
   - Layer styling:
     - Polygons (`fill` layer): semi-transparent fills, color driven by a `feature-color` property (fallback `#00ff88`)
     - Polygon outlines (`line` layer): solid, 2px, same color property
     - Points (`circle` layer): 8px radius, same color property
   - A small floating legend panel (top-right) that lists feature names from the current GeoJSON
   - A "Clear Map" button (bottom-right) that calls `DELETE /geojson`
   - Design direction: dark/utilitarian — think satellite imagery tool, not consumer app. Use monospace font, muted UI chrome, high-contrast accents on a near-black overlay panel.

**Checkpoint:** `cd viewer && npm install && node server.js` starts without errors. Opening the forwarded port 3000 URL shows a full-screen satellite map.

---

## Phase 3: MCP Server

**Goal:** An MCP server Claude can use to push GeoJSON to the viewer.

### Tasks

1. Create `mcp-server/package.json`:
   - dependencies: `@modelcontextprotocol/sdk`, `node-fetch`
   - scripts: `"start": "node index.js"`, `"dev": "node --watch index.js"`
   - `"type": "module"`

2. Create `mcp-server/index.js` using the MCP SDK (`@modelcontextprotocol/sdk/server/stdio.js`).

   Implement these tools:

   **`push_geojson`**
   - Description: "Push a GeoJSON FeatureCollection to the live map viewer"
   - Input: `{ geojson: object }` — a valid GeoJSON FeatureCollection
   - Action: POST to `http://localhost:3000/geojson` with the FeatureCollection
   - Returns: confirmation message with feature count

   **`update_feature`**
   - Description: "Replace a single feature in the current map by its name property"
   - Input: `{ name: string, feature: object }` — GeoJSON Feature
   - Action: GET current GeoJSON, find feature where `properties.name === name`, replace it, POST back
   - Returns: confirmation or "feature not found" message

   **`get_geojson`**
   - Description: "Get the GeoJSON currently displayed on the map"
   - Action: GET from `http://localhost:3000/geojson`
   - Returns: the current FeatureCollection as a string

   **`clear_map`**
   - Description: "Clear all features from the map"
   - Action: DELETE to `http://localhost:3000/geojson`
   - Returns: confirmation message

   Viewer base URL should read from `process.env.VIEWER_URL || 'http://localhost:3000'`.

**Checkpoint:** `cd mcp-server && npm install && node index.js` starts and the MCP server is listening on stdio without errors.

---

## Phase 4: Claude Skill

**Goal:** A SKILL.md that tells Claude how to generate GeoJSON from a screenshot + midpoints.

### Tasks

Create `skill/SKILL.md` with the following content and structure:

```markdown
---
name: golf-geojson
description: Generate approximate GeoJSON feature geometries for golf course holes
  from a satellite screenshot, a list of feature names, and provided midpoint
  coordinates. Use this skill whenever the user provides a golf course image and
  wants GeoJSON output, or asks Claude to map golf course features, trace hole
  geometry, or push features to the golf viewer map.
---

# Golf GeoJSON Skill

## Purpose
Generate an 80%-accurate GeoJSON FeatureCollection for golf course features by
visually tracing a satellite image and anchoring shapes to provided midpoint coordinates.

## Inputs Required
1. **Satellite image** — aerial/overhead view of the hole or course
2. **Feature list** — names and types of features to trace, e.g.:
   - hole_1_fairway (polygon)
   - hole_1_green (polygon)
   - hole_1_bunker_left (polygon)
   - hole_1_tee_blue (polygon)
   - hole_1_water (polygon)
3. **Midpoints** — lat/lng for each feature, e.g.:
   - hole_1_fairway: [32.7157, -117.1611]
   - hole_1_green: [32.7163, -117.1608]

## Scale Calibration
Before tracing shapes, establish pixel-to-meter scale:
- Use the two midpoints that are furthest apart
- Calculate their real-world distance (Haversine formula mentally estimated)
- Measure the pixel distance between their approximate image locations
- Derive meters-per-pixel ratio
- Use this ratio to size all features

If only one midpoint is provided, use these default feature dimensions:
| Feature type | Typical width | Typical length |
|---|---|---|
| Fairway | 35m | 150–400m |
| Green | 25m | 30m |
| Tee box | 8m | 12m |
| Bunker | 12m | 18m |
| Water hazard | varies | varies |

## Tracing Process
For each feature:
1. Locate it visually in the image
2. Trace its approximate outline as a polygon (6–12 points is enough)
3. Convert pixel offsets from the midpoint into lat/lng deltas
   - 1 degree latitude ≈ 111,000m
   - 1 degree longitude ≈ 111,000m × cos(latitude)
4. Offset each polygon vertex from the provided midpoint

## Output Format
Return a GeoJSON FeatureCollection. Each feature must have:
- `type`: "Feature"
- `geometry.type`: "Polygon" (or "Point" for single markers)
- `geometry.coordinates`: closed ring (first and last point identical)
- `properties.name`: feature name from the input list
- `properties.feature_type`: one of: fairway, green, tee, bunker, water, rough, path
- `properties.feature-color`: use this color map:
  - fairway: `#4a7c3f`
  - green: `#2d6e2d`
  - tee: `#8b6914`
  - bunker: `#c8b560`
  - water: `#1a6b9e`
  - rough: `#3a5e2a`
  - path: `#888888`

## Quality Notes
- Accuracy goal is 80% — shapes should be recognizable and correctly positioned,
  not survey-grade
- Prefer simpler polygons (fewer points) over complex ones
- If a feature is not clearly visible in the image, generate a plausible shape
  based on typical dimensions centered on the midpoint
- Always close polygons (repeat first coordinate at end)

## MCP Integration
If the `push_geojson` MCP tool is available, after generating the FeatureCollection
automatically call `push_geojson` to send it to the live viewer. Confirm to the user
how many features were pushed and the viewer URL.
```

**Checkpoint:** `skill/SKILL.md` exists and is readable.

---

## Phase 5: Wire It Together & Smoke Test

**Goal:** End-to-end test — generate GeoJSON from a sample and see it on the map.

### Tasks

1. Start the viewer: `cd viewer && npm run dev`
2. Start the MCP server: `cd mcp-server && npm run dev`
3. Confirm both are running and port 3000 is accessible
4. Send a test POST to the viewer directly to confirm the map updates:

```bash
curl -X POST http://localhost:3000/geojson \
  -H "Content-Type: application/json" \
  -d '{
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [-117.1611, 32.7157],
          [-117.1609, 32.7158],
          [-117.1608, 32.7156],
          [-117.1610, 32.7155],
          [-117.1611, 32.7157]
        ]]
      },
      "properties": {
        "name": "test_green",
        "feature_type": "green",
        "feature-color": "#2d6e2d"
      }
    }]
  }'
```

5. Open port 3000 in the browser — the green polygon should appear on the satellite map
6. Test `DELETE /geojson` via the Clear Map button — map should reset

**Checkpoint:** The full loop works. Curl → map updates live in browser.

---

## Phase 6: Configure MCP in Claude Code

**Goal:** Claude Code can call the MCP tools directly from the terminal session.

### Tasks

1. Create `.claude/mcp_settings.json` (Claude Code's MCP config location) OR add to the user-level config:

```json
{
  "mcpServers": {
    "golf-geojson": {
      "command": "node",
      "args": ["/workspaces/golf-geojson-tool/mcp-server/index.js"],
      "env": {
        "VIEWER_URL": "http://localhost:3000"
      }
    }
  }
}
```

2. Restart Claude Code (`/restart` in terminal or reopen)
3. Verify tools are available: ask Claude "what MCP tools do you have?"
4. Test: ask Claude to push a simple test FeatureCollection to the map

**Checkpoint:** Claude Code can call `push_geojson` and the map updates.

---

## Done 🏌️

At this point you have:
- A live Mapbox satellite viewer at port 3000
- An MCP server Claude Code can use to push/update/clear features
- A skill that tells Claude how to trace GeoJSON from a screenshot + midpoints
- The full loop: screenshot in → Claude traces → GeoJSON pushed → map updates live

Next steps (not in scope for this build):
- Add click-to-edit feature on the map (edit polygon vertices in browser)
- Export final GeoJSON as a downloadable file from the viewer
- Add hole number / course name metadata to features
- Support multiple holes as separate layers
