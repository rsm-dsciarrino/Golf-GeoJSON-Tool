# Golf GeoJSON Tool

A live Mapbox satellite viewer paired with an MCP server so Claude can push GeoJSON golf course features directly to a browser map.

## How It Works

1. Claude traces satellite imagery and generates a GeoJSON FeatureCollection using the `golf-geojson` skill
2. Claude calls the `push_geojson` MCP tool to POST the GeoJSON to the viewer
3. The viewer receives it via SSE and updates the map live in the browser

## Setup

### Prerequisites
- Node.js 18+
- A Mapbox access token ([mapbox.com](https://mapbox.com))

### Local

```bash
# Install dependencies
cd viewer && npm install
cd ../mcp-server && npm install

# Set your Mapbox token
export MAPBOX_TOKEN=pk.your_token_here

# Start the viewer (terminal 1)
cd viewer && npm run dev

# Start the MCP server (terminal 2)
cd mcp-server && npm run dev

# Open the viewer
open http://localhost:3000
```

### Codespaces

The devcontainer installs everything automatically on launch. Set `MAPBOX_TOKEN` as a Codespaces secret and the forwarded port 3000 will open the viewer.

The MCP server path in `.claude/settings.json` will need to be updated to `/workspaces/golf-geojson-tool/mcp-server/index.js` when running in a Codespace.

## Project Structure

```
golf-geojson-tool/
├── .devcontainer/devcontainer.json   # Codespace config
├── viewer/
│   ├── server.js                     # Express server — receives GeoJSON, serves map
│   ├── public/index.html             # Mapbox map with SSE auto-refresh
│   └── package.json
├── mcp-server/
│   ├── index.js                      # MCP server with push/update/clear tools
│   └── package.json
├── skill/SKILL.md                    # Claude skill for tracing GeoJSON from screenshots
├── .claude/settings.json             # MCP server config for Claude Code
└── .env.example                      # Documents required env vars
```

## MCP Tools

| Tool | Description |
|---|---|
| `push_geojson` | Push a full FeatureCollection to the map |
| `update_feature` | Replace one feature by its `name` property |
| `get_geojson` | Get the current FeatureCollection from the map |
| `clear_map` | Clear all features |

## Viewer API

| Route | Method | Description |
|---|---|---|
| `/` | GET | Serves the Mapbox map |
| `/geojson` | GET | Returns current FeatureCollection |
| `/geojson` | POST | Replaces current FeatureCollection, triggers SSE update |
| `/geojson` | DELETE | Clears the map |
| `/events` | GET | SSE stream — emits `geojson-updated` on every change |

## Smoke Test

With the viewer running, paste this to see a polygon appear on the map:

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
