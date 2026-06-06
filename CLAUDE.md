# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Viewer (terminal 1) — Express + live map on http://localhost:3000
cd viewer && npm install && npm run dev
export MAPBOX_TOKEN=pk.your_token_here   # required for the map to render

# MCP server (terminal 2) — stdio, Claude-facing tool layer
cd mcp-server && npm install && npm run dev

# Import a course from OSM → live viewer (step 2 of the workflow below)
node scripts/import-course.mjs "<Course Name>" <course_id> [--cap 60] [--radius 1500] [--no-push]

# psql for Supabase introspection/verification (no client preinstalled)
brew install libpq            # provides psql at $(brew --prefix)/opt/libpq/bin/psql
export PATH="$(brew --prefix)/opt/libpq/bin:$PATH"
CONN="$(grep '^SUPABASE_CONNECTION_STRING=' .env | cut -d= -f2-)"; psql "$CONN" -c '\dt'
```

There is **no test framework, linter, or build step** — `npm run dev` runs the source directly (`node --watch`). The closest thing to a test is the smoke test in `README.md` and the upload **dry-run** (see below). Don't invent test commands.

## Architecture

Three runtimes share one data model (a GeoJSON `FeatureCollection`):

- **`viewer/server.js`** — Express on :3000 holding the current map in an **in-memory** store (lost on restart). It's the single source of truth for "what's on the map." Every mutation broadcasts an SSE `geojson-updated` event so the browser re-renders live. Routes: `GET/POST/DELETE /geojson`, `/midpoints`, `GET /events`. The Mapbox token is injected into `public/index.html` at request time (`__MAPBOX_TOKEN__`).
- **`mcp-server/index.js`** — the MCP (stdio) tool layer Claude drives. **Every tool operates over HTTP against `VIEWER_URL`** (default `http://localhost:3000`) — it has no state of its own. So the viewer must be running for any tool to work, and tools mutate the live map by POSTing the whole collection back.
- **`docs/index.html`** — static GitHub Pages viewer; same UI but `localStorage` instead of the server, no SSE, no MCP. Keep it in sync with `viewer/public/index.html` when changing UI.

`mcp-server/supabase.js` is the only piece that touches a real database (Supabase Postgres/PostGIS) — everything else is ephemeral.

### New-course workflow (authoritative — follow these steps and STOP at the gates)

When the user asks to add a course, run this exact sequence. The two **review gates** are hard stops — do not proceed past them until the user says so.

1. **Geometry** — run `node scripts/import-course.mjs "<Course Name>" <course_id>`. It geocodes, pulls OSM golf features, assigns holes by nearest line of play, derives markers, saves `data/<course_id>.geojson`, and pushes to the live viewer. Report counts, holes covered, and any orphans (`needs_hole_assignment`).
2. **🛑 GATE — user reviews & edits** the geometry in the viewer (numbers missing holes, fixes mis-assignments, draws missing fairways). Wait for them.
3. **Scorecard** — look up the real scorecard (par + handicap + back-tee yardage per hole) and write `data/scorecards/<course_id>.json`. Do **not** estimate par or invent handicap — those come from the card (see scorecard-source notes below). Present the table.
4. **🛑 GATE — user reviews the scorecard.** Wait for confirmation.
5. **Upload** — re-fetch the (possibly edited) map and run `uploadCourse` (or the `upload_to_supabase` tool) with `commit:false` first (dry-run), then `commit:true`. This updates **all three tables**: `courses`, `course_features`, `course_holes`. Then **verify with psql** and report.

### Data pipeline internals

1. **Import** geocodes via Nominatim, queries Overpass (`map_to_area` on the geocoded golf_course way/relation) for `golf=*` features, maps OSM tags to feature types, assigns holes by nearest line, and POSTs to the viewer.
2. **Derive markers**: `tee_center` (back tee), `green_front/center/back` placed where the line of play crosses the green edge.
3. **Upload** (`uploadCourse`): one transaction that upserts the `courses` row, **replaces** that course's `course_features` (delete-by-`course_id` then insert), and upserts `course_holes` from the scorecard.

### Supabase schema (target of uploads)

- `courses(id text PK, name, city, state)`
- `course_features(id uuid, course_id FK, hole_number int **NOT NULL**, feature_type, name, properties jsonb, geometry geometry(GEOMETRY,4326) **NOT NULL**, geometry_geojson text **GENERATED** from `st_asgeojson(geometry)`)
- `course_holes(course_id, hole_number, par, handicap, yardage_front/center/back — all NOT NULL; UNIQUE(course_id, hole_number))`

Upload constraints that drive the code:
- `hole_number` is NOT NULL → features without a hole are **skipped** (filtered in SQL).
- `geometry_geojson` is generated → **never write it**; geometry goes in via `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`. A guarded `DO` block backfills it only on environments where it isn't generated.
- No natural unique key on `course_features` → re-upload is delete+insert, not upsert.
- The DB only stores core columns; the rich GeoJSON `properties` (feature-color, source, @id, osm_id, needs_hole_assignment) are **not** persisted (`properties` is left null, matching existing courses).

Always **dry-run first** (`commit:false` / `dry_run:true`) — it runs the real inserts in a transaction and rolls back, reporting counts. Then verify with psql.

## Conventions & gotchas

- **`course_id`** is a slug `<name>_<locale>`: `the_ridge_auburn`, `darkhorse_auburn`, `black_oak_auburn`. Must match `^[a-z0-9_]+$`.
- **OSM hole assignment**: `golf=hole` features are *lines of play* carrying the `ref` (hole number); the playable polygons (greens, tees, bunkers…) frequently carry **no `ref`**. When refs are missing, assign each feature to its **nearest hole line** (a ~40–60 m distance cap; tighter when some holes are missing from OSM, to avoid mis-snapping orphans). Greens snapping to ~0–2 m is the signal it's working.
- Map OSM `lateral_water_hazard` (and `pond`) → `water`; the stock `import_from_osm` only knows `water_hazard`, so those would otherwise be dropped. Exclude `cartpath`/`hole` corridors/`clubhouse`/`driving_range` from final exports (matches existing courses).
- **Scorecards** live in `data/scorecards/<course_id>.json` (par + handicap + back-tee `yardage` per hole). `course_holes` takes par/handicap/center-yardage from there; `yardage_front`/`back` = center ∓ half the green depth (from the `green_front`/`green_back` markers). 9-hole courses use odd stroke indexes (1–17). When looking scorecards up online, aimy.golf and greenskeeper.org parse cleanly; bluegolf.com returns garbled content.
- Finished course exports are saved to `data/<course_id>.geojson` (filename = the DB `course_id`, e.g. `darkhorse_auburn.geojson`). Keep the committed file in sync with what's in Supabase.
- `scripts/import-course.mjs` is the reusable importer (replaces the old one-off `_import_*.mjs` scratch scripts). Its marker-derivation logic mirrors the MCP `generate_tee_green_markers` tool — keep them consistent if you change one.
- Secrets live in the gitignored `.env` (`MAPBOX_TOKEN`, `SUPABASE_CONNECTION_STRING`). The MCP server loads `../.env` via dotenv. Scan staged changes for the DB host before committing.
- **MCP tool reload**: newly added MCP tools aren't callable through Claude until the `golf-geojson` server is reloaded in the client. Until then, run the equivalent logic via a `node -e` one-liner against `supabase.js`.
- Scratch import scripts (`data/_import_*.mjs`) are one-offs; delete them before committing.
