# Golf GeoJSON Tool

A live Mapbox satellite viewer for drawing, reviewing, exporting, and receiving GeoJSON golf course features. It includes a browser-based drawing UI plus an MCP server so Claude can push generated FeatureCollections directly to the map.

## How It Works

1. Place midpoint anchors or draw features directly in the browser.
2. Claude can call `get_midpoints`, trace satellite imagery with the `golf-geojson` skill, and push a FeatureCollection with `push_geojson`.
3. The viewer receives GeoJSON through `/geojson`, updates the Mapbox source, and broadcasts live refreshes over SSE.
4. Browser-created features can be exported as GeoJSON or saved back to the viewer server.

## Viewer Features

- Draw polygons, points, and meter-radius circles. Circles are stored as closed GeoJSON `Polygon` features.
- Assign metadata: course name, course ID, and scope (`Course` or `Hole 1` through `Hole 18`).
- Filter by scope and feature type.
- Place named midpoint anchors for AI tracing and delete individual midpoints or map features.
- Export the current FeatureCollection as a `.geojson` file.
- Import GeoJSON files in the static GitHub Pages viewer.

## Feature Types

Hole-scoped features use `properties.hole_number` as a number from `1` to `18`.

| Type | Geometry | Notes |
|---|---|---|
| `tee_box` | Polygon | Tee box outline |
| `fairway` | Polygon | Maintained fairway outline |
| `green` | Polygon | Putting surface outline |
| `bunker` | Polygon | Sand bunker outline |
| `water` | Polygon | Hole-level water feature |
| `rough` | Polygon | Rough or maintained native edge |
| `path` | Polygon | Cart path or walkway |
| `hole_corridor` | Polygon | Broad playable corridor |
| `tee_center` | Point | Tee reference point |
| `green_front` | Point | Front edge of green |
| `green_center` | Point | Center of green |
| `green_back` | Point | Back edge of green |
| `target_point` | Point | Ideal target or landing zone |
| `layup_point` | Point | Conservative layup point |

Course-level features use `properties.hole_number: "course"`.

| Type | Geometry | Notes |
|---|---|---|
| `trees` | Polygon | Tree canopy or tree stand |
| `water_hazard` | Polygon | Course-wide water hazard |
| `hazard` | Polygon | Regular hazard or native area |

## Setup

### Prerequisites
- Node.js 18+
- A Mapbox access token ([mapbox.com](https://mapbox.com))

## GitHub Pages

The static GitHub Pages viewer lives in `docs/index.html`. The root `index.html` redirects GitHub Pages visitors into that viewer.

Expected URL:

```text
https://rsm-dsciarrino.github.io/Golf-GeoJSON-Tool/
```

The Pages version is browser-only:

- GeoJSON and midpoints are stored in `localStorage`.
- Import/export works through local files.
- MCP push/update tools require the local Express server, not GitHub Pages.
- SSE live updates are disabled in static mode.

### Mapbox Token For Pages

The Pages viewer does not ship with a Mapbox token. Each user must paste their own public Mapbox token when the page opens. The token is saved only in that browser's `localStorage`.

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

### MCP Client Setup

Configure your MCP client to run the local server script with Node:

```json
{
  "mcpServers": {
    "golf-geojson": {
      "command": "node",
      "args": ["/absolute/path/to/Golf-GeoJSON-Tool/mcp-server/index.js"]
    }
  }
}
```

## Project Structure

```
golf-geojson-tool/
├── viewer/
│   ├── server.js                     # Express server for GeoJSON, midpoints, static map, and SSE
│   ├── public/index.html             # Mapbox viewer and drawing UI
│   └── package.json
├── index.html                        # GitHub Pages redirect to docs/
├── docs/
│   └── index.html                    # Static GitHub Pages viewer
├── mcp-server/
│   ├── index.js                      # MCP server with push/update/get/clear tools
│   └── package.json
├── skill/SKILL.md                    # Claude skill for tracing GeoJSON from screenshots
├── # Golf GeoJSON Tool — Build Plan.md
└── README.md
```

## MCP Tools

| Tool | Description |
|---|---|
| `push_geojson` | Push a full FeatureCollection to the map |
| `update_feature` | Replace one feature by its `name` property |
| `get_geojson` | Get the current FeatureCollection from the map |
| `clear_map` | Clear all features |
| `get_midpoints` | Get the named midpoint anchors currently placed in the viewer |
| `clear_midpoints` | Clear all midpoint anchors |

## Viewer API

| Route | Method | Description |
|---|---|---|
| `/` | GET | Serves the Mapbox map |
| `/geojson` | GET | Returns current FeatureCollection |
| `/geojson` | POST | Replaces current FeatureCollection, triggers SSE update |
| `/geojson` | DELETE | Clears the map |
| `/midpoints` | GET | Returns named midpoint anchors |
| `/midpoints` | POST | Adds or replaces a named midpoint anchor |
| `/midpoints/:name` | DELETE | Deletes one named midpoint anchor |
| `/midpoints` | DELETE | Clears all midpoint anchors |
| `/events` | GET | SSE stream — emits `geojson-updated` on every change |

## GeoJSON Conventions

Each feature should include:

```json
{
  "type": "Feature",
  "bbox": [-117.1611, 32.7155, -117.1608, 32.7158],
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
    "course_id": "course_id",
    "course_name": "Course Name",
    "hole_number": 1,
    "feature_type": "green",
    "name": "hole_1_green",
    "feature-color": "#2d6e2d",
    "is_approximate": true,
    "source": "ai_trace",
    "@id": "uuid"
  }
}
```

Use `hole_number: "course"` for `trees`, `water_hazard`, and `hazard`.

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
        "hole_number": 1,
        "feature_type": "green",
        "feature-color": "#2d6e2d"
      }
    }]
  }'
```
