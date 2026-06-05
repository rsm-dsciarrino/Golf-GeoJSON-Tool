import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import dotenv from 'dotenv';
import { uploadCourse } from './supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Secrets live in the gitignored project-root .env (SUPABASE_CONNECTION_STRING, etc.)
dotenv.config({ path: join(__dirname, '..', '.env') });

const VIEWER_URL = process.env.VIEWER_URL || 'http://localhost:3000';

const server = new Server(
  { name: 'golf-geojson', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'push_geojson',
      description: 'Push a GeoJSON FeatureCollection to the live map viewer',
      inputSchema: {
        type: 'object',
        properties: {
          geojson: { type: 'object', description: 'A valid GeoJSON FeatureCollection' },
        },
        required: ['geojson'],
      },
    },
    {
      name: 'update_feature',
      description: 'Replace a single feature in the current map by its name property',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name property of the feature to replace' },
          feature: { type: 'object', description: 'The replacement GeoJSON Feature' },
        },
        required: ['name', 'feature'],
      },
    },
    {
      name: 'get_geojson',
      description: 'Get the GeoJSON currently displayed on the map',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'clear_map',
      description: 'Clear all features from the map',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_midpoints',
      description: 'Get the midpoints placed by the user on the map — use these as anchor coordinates when tracing GeoJSON features from a satellite image',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'clear_midpoints',
      description: 'Clear all midpoints from the map',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'import_from_osm',
      description: 'Import golf course features from OpenStreetMap and push them to the map. Provide a course name (geocoded via Nominatim) or explicit lat/lng coordinates. Use hole_number to import one hole at a time, and append=true to add to existing map features instead of replacing them.',
      inputSchema: {
        type: 'object',
        properties: {
          course_name: { type: 'string', description: 'Golf course name to geocode and use as the OSM area boundary (e.g. "Torrey Pines North Course")' },
          lat: { type: 'number', description: 'Latitude of the course center (used as fallback if course_name area lookup fails)' },
          lng: { type: 'number', description: 'Longitude of the course center' },
          radius_m: { type: 'number', description: 'Fallback search radius in meters when area lookup is used (default 1500)' },
          course_id: { type: 'string', description: 'Course ID slug for properties (auto-derived from course_name if omitted)' },
          hole_number: { type: 'number', description: 'If provided, only import features for this hole number (1–18). Omit to import all holes.' },
          append: { type: 'boolean', description: 'If true, merge new features with existing map features. If false (default), replace the map.' },
        },
      },
    },
    {
      name: 'generate_tee_green_markers',
      description: 'Automatically derive point markers from the polygons already on the map: tee_center marker(s) for tee_boxes, and green_front / green_center / green_back for every green. Front/back are placed where the hole\'s line of play (fairway→green, or tee→green if no fairway) crosses the green edges. Features must already have hole_number assigned. Existing markers of these types are replaced by default.',
      inputSchema: {
        type: 'object',
        properties: {
          replace_existing: { type: 'boolean', description: 'Remove existing tee_center/green_front/green_center/green_back markers before generating (default true).' },
          tee_centers: {
            type: 'string',
            enum: ['all', 'one_per_hole'],
            description: 'How many tee_center markers to generate per hole. "all" (default) places one for every tee_box. "one_per_hole" places a single tee_center on the back tee (the tee_box farthest from the green) — use this when downstream consumers expect exactly one tee per hole.',
          },
        },
      },
    },
    {
      name: 'spread_hazards_to_holes',
      description: 'Duplicate hazard features (water by default) onto every hole they surround, so a hazard between holes shows up on each of those holes. A hole "surrounds" a hazard when its playing geometry (fairway/green/tee_box) lies within max_distance_m of the hazard. Each copy is tagged with that hole_number and a shared hazard_group id (so the copies are traceable and the operation is idempotent — re-running collapses prior copies first). Requires hole_number to be assigned on the hole footprint features.',
      inputSchema: {
        type: 'object',
        properties: {
          feature_types: { type: 'array', items: { type: 'string' }, description: 'Feature types to treat as hazards (default ["water"]).' },
          max_distance_m: { type: 'number', description: 'Max distance in meters from a hole\'s fairway/green/tee_box to the hazard for that hole to count as surrounding it (default 35).' },
        },
      },
    },
    {
      name: 'upload_to_supabase',
      description: 'Upload the current map\'s GeoJSON to the Supabase PostGIS database (courses + course_features). Upserts the course row and replaces that course\'s features (delete-by-course_id then insert). Features without a hole_number are skipped (the column is NOT NULL). Set dry_run=true to validate inside a rolled-back transaction without persisting. Requires SUPABASE_CONNECTION_STRING in the project .env.',
      inputSchema: {
        type: 'object',
        properties: {
          course_id: { type: 'string', description: 'Course slug / primary key, lowercase [a-z0-9_] (e.g. "darkhorse_auburn"). Auto-derived from course_name if omitted.' },
          course_name: { type: 'string', description: 'Display name stored on the courses row (e.g. "DarkHorse Golf Club").' },
          city: { type: 'string', description: 'City for the courses row (e.g. "Auburn").' },
          state: { type: 'string', description: 'State for the courses row (e.g. "CA").' },
          replace: { type: 'boolean', description: 'Delete existing features for this course_id before inserting (default true). If false, appends.' },
          dry_run: { type: 'boolean', description: 'Run the upload in a transaction and roll it back, reporting what would change without persisting (default false).' },
        },
        required: ['course_name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'push_geojson': {
      const res = await fetch(`${VIEWER_URL}/geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args.geojson),
      });
      const data = await res.json();
      return {
        content: [{ type: 'text', text: `Pushed ${data.featureCount} feature(s) to the map.` }],
      };
    }

    case 'update_feature': {
      const res = await fetch(`${VIEWER_URL}/geojson`);
      const current = await res.json();
      const idx = current.features.findIndex(f => f.properties?.name === args.name);
      if (idx === -1) {
        return { content: [{ type: 'text', text: `Feature "${args.name}" not found on the map.` }] };
      }
      current.features[idx] = args.feature;
      await fetch(`${VIEWER_URL}/geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      });
      return { content: [{ type: 'text', text: `Updated feature "${args.name}".` }] };
    }

    case 'get_geojson': {
      const res = await fetch(`${VIEWER_URL}/geojson`);
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    case 'clear_map': {
      await fetch(`${VIEWER_URL}/geojson`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: 'Map cleared.' }] };
    }

    case 'get_midpoints': {
      const res = await fetch(`${VIEWER_URL}/midpoints`);
      const data = await res.json();
      if (!data.length) {
        return { content: [{ type: 'text', text: 'No midpoints placed yet.' }] };
      }
      const lines = data.map(m => `${m.name}: [${m.lat}, ${m.lng}]`).join('\n');
      return { content: [{ type: 'text', text: lines }] };
    }

    case 'clear_midpoints': {
      await fetch(`${VIEWER_URL}/midpoints`, { method: 'DELETE' });
      return { content: [{ type: 'text', text: 'Midpoints cleared.' }] };
    }

    case 'import_from_osm': {
      let { course_name, lat, lng, radius_m = 1500, course_id, hole_number, append = false } = args;

      // Geocode if no coords provided
      if (lat == null || lng == null) {
        if (!course_name) {
          return { content: [{ type: 'text', text: 'Provide either lat/lng or course_name.' }] };
        }
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(course_name)}&format=json&limit=3&countrycodes=us`,
          { headers: { 'User-Agent': 'GolfGeoJSONTool/1.0' } }
        );
        const geoData = await geoRes.json();
        const courseHit = geoData.find(r => r.class === 'leisure' || r.class === 'sport') || geoData[0];
        if (!courseHit) {
          return { content: [{ type: 'text', text: `Could not geocode "${course_name}".` }] };
        }
        lat = parseFloat(courseHit.lat);
        lng = parseFloat(courseHit.lon);
      }

      if (!course_id) course_id = course_name ? course_name.toLowerCase().replace(/\s+/g, '_') : 'osm_course';
      const courseName = course_name || course_id;

      // Build Overpass query — prefer area-scoped query when course_name is available
      // so we don't bleed into adjacent courses sharing the same radius
      let query;
      if (course_name) {
        const escaped = course_name.replace(/[\\'"]/g, '\\$&');
        query = `[out:json][timeout:30];
way[leisure=golf_course][name~"${escaped}",i](around:${radius_m},${lat},${lng})->.course;
map_to_area(.course)->.area;
(
  way[golf](area.area);
  node[golf](area.area);
);
out body geom;`;
      } else {
        query = `[out:json][timeout:30];
(
  way[golf](around:${radius_m},${lat},${lng});
  node[golf](around:${radius_m},${lat},${lng});
);
out body geom;`;
      }

      const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      const overpassData = await overpassRes.json();

      // If area query returned nothing (course boundary not found), fall back to radius
      let elements = overpassData.elements || [];
      if (course_name && elements.length === 0) {
        const fallback = `[out:json][timeout:30];(way[golf](around:${radius_m},${lat},${lng});node[golf](around:${radius_m},${lat},${lng}););out body geom;`;
        const fbRes = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(fallback)}`,
        });
        const fbData = await fbRes.json();
        elements = fbData.elements || [];
      }

      const OSM_TYPE_MAP = {
        fairway: 'fairway', green: 'green', tee: 'tee_box', bunker: 'bunker',
        water_hazard: 'water', rough: 'rough', path: 'path', cartpath: 'path',
        hole: 'hole_corridor', pin: 'green_center',
      };
      const TYPE_COLORS = {
        fairway: '#4a7c3f', green: '#2d6e2d', tee_box: '#8b7355', bunker: '#d4b483',
        water: '#2255cc', rough: '#6b8c42', path: '#888888',
        hole_corridor: '#4a7c3f', green_center: '#cc0000',
      };

      function osmUuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }
      function osmBbox(pts) {
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const [lo, la] of pts) {
          if (lo < minLon) minLon = lo; if (la < minLat) minLat = la;
          if (lo > maxLon) maxLon = lo; if (la > maxLat) maxLat = la;
        }
        return [minLon, minLat, maxLon, maxLat];
      }

      const newFeatures = [];
      const nameCounts = {};

      for (const el of elements) {
        const golfTag = el.tags?.golf;
        const featureType = OSM_TYPE_MAP[golfTag];
        if (!featureType) continue;

        const ref = el.tags?.ref;
        const elHole = ref ? parseInt(ref) : null;

        // Filter to requested hole if specified
        if (hole_number != null && elHole !== hole_number) continue;

        let geometry;
        if (el.type === 'way' && el.geometry?.length) {
          const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
          const first = coords[0], last = coords[coords.length - 1];
          const closed = first[0] === last[0] && first[1] === last[1];
          geometry = { type: 'Polygon', coordinates: [closed ? coords : [...coords, first]] };
        } else if (el.type === 'node' && el.lat != null) {
          geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
        } else {
          continue;
        }

        const holeStr = elHole != null ? `hole_${elHole}` : 'course';
        const baseName = `${holeStr}_${featureType}`;
        nameCounts[baseName] = (nameCounts[baseName] || 0) + 1;
        const count = nameCounts[baseName];
        const name = count > 1 ? `${baseName}_${count}` : baseName;

        const pts = geometry.type === 'Polygon' ? geometry.coordinates[0] : [geometry.coordinates];
        newFeatures.push({
          type: 'Feature',
          bbox: osmBbox(pts),
          geometry,
          properties: {
            course_id, course_name: courseName, hole_number: elHole,
            feature_type: featureType, name,
            'feature-color': TYPE_COLORS[featureType] || '#00ff88',
            is_approximate: true, source: 'osm', '@id': osmUuid(), osm_id: el.id,
          },
        });
      }

      if (!newFeatures.length) {
        const holeMsg = hole_number != null ? ` for hole ${hole_number}` : '';
        return { content: [{ type: 'text', text: `No golf features found${holeMsg} in "${courseName}".` }] };
      }

      // Merge or replace
      let finalFeatures = newFeatures;
      if (append) {
        const currentRes = await fetch(`${VIEWER_URL}/geojson`);
        const current = await currentRes.json();
        const existing = current.features || [];
        // Remove any existing features with the same osm_id to avoid duplicates
        const newOsmIds = new Set(newFeatures.map(f => f.properties.osm_id));
        const kept = existing.filter(f => !newOsmIds.has(f.properties?.osm_id));
        finalFeatures = [...kept, ...newFeatures];
      }

      await fetch(`${VIEWER_URL}/geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'FeatureCollection', features: finalFeatures }),
      });

      const typeSummary = [...new Set(newFeatures.map(f => f.properties.feature_type))].join(', ');
      const holeLabel = hole_number != null ? ` hole ${hole_number}` : ' all holes';
      const mode = append ? 'appended to map' : 'replaced map';
      return {
        content: [{
          type: 'text',
          text: `Imported ${newFeatures.length} OSM features (${typeSummary}) for "${courseName}"${holeLabel} → ${mode}. Total on map: ${finalFeatures.length}.`,
        }],
      };
    }

    case 'generate_tee_green_markers': {
      const replaceExisting = args.replace_existing !== false;
      const teeMode = args.tee_centers === 'one_per_hole' ? 'one_per_hole' : 'all';
      const res = await fetch(`${VIEWER_URL}/geojson`);
      const fc = await res.json();
      let feats = fc.features || [];
      const MARKERS = new Set(['tee_center', 'green_front', 'green_center', 'green_back']);
      if (replaceExisting) feats = feats.filter(f => !MARKERS.has(f.properties?.feature_type));

      // Local-origin equirectangular projection. Subtracting a reference point keeps
      // coordinate magnitudes small so the shoelace centroid stays numerically stable.
      const polyPts = feats.filter(f => f.geometry?.type === 'Polygon').flatMap(f => f.geometry.coordinates[0]);
      if (!polyPts.length) {
        return { content: [{ type: 'text', text: 'No polygon features on the map to derive markers from.' }] };
      }
      const lon0 = polyPts.reduce((s, p) => s + p[0], 0) / polyPts.length;
      const lat0 = polyPts.reduce((s, p) => s + p[1], 0) / polyPts.length;
      const K = Math.cos(lat0 * Math.PI / 180);
      const toXY = ([lon, lat]) => [(lon - lon0) * K, lat - lat0];
      const toLL = ([x, y]) => [x / K + lon0, y + lat0];

      function centroid(ringLL) {
        const r = ringLL.map(toXY);
        if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]);
        let A = 0, cx = 0, cy = 0;
        for (let i = 0; i < r.length - 1; i++) {
          const [x0, y0] = r[i], [x1, y1] = r[i + 1];
          const cr = x0 * y1 - x1 * y0;
          A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr;
        }
        A *= 0.5;
        if (Math.abs(A) < 1e-18) {
          const n = r.length - 1;
          return [r.slice(0, -1).reduce((s, p) => s + p[0], 0) / n, r.slice(0, -1).reduce((s, p) => s + p[1], 0) / n];
        }
        return [cx / (6 * A), cy / (6 * A)];
      }

      // Cast a ray from P along unit vector u; return nearest boundary crossing (in XY).
      function rayHit(P, u, ringLL) {
        const r = ringLL.map(toXY);
        if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]);
        let bestT = Infinity, hit = null;
        for (let i = 0; i < r.length - 1; i++) {
          const A = r[i], B = r[i + 1];
          const ex = B[0] - A[0], ey = B[1] - A[1];
          const det = ex * u[1] - ey * u[0];
          if (Math.abs(det) < 1e-18) continue;
          const dx = A[0] - P[0], dy = A[1] - P[1];
          const t = (ex * dy - ey * dx) / det;
          const s = (u[0] * dy - u[1] * dx) / det;
          if (t > 1e-12 && s >= -1e-9 && s <= 1 + 1e-9 && t < bestT) {
            bestT = t; hit = [P[0] + t * u[0], P[1] + t * u[1]];
          }
        }
        return hit;
      }

      const avg = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

      const byHole = new Map();
      for (const f of feats) {
        const h = f.properties?.hole_number;
        if (!byHole.has(h)) byHole.set(h, {});
        const g = byHole.get(h);
        (g[f.properties.feature_type] ||= []).push(f);
      }

      const COLORS = { tee_center: '#c8a055', green_front: '#5aae5a', green_center: '#5aae5a', green_back: '#5aae5a' };
      function mkUuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const rr = Math.random() * 16 | 0;
          return (c === 'x' ? rr : (rr & 0x3 | 0x8)).toString(16);
        });
      }
      const mk = (type, ll, src, name) => ({
        type: 'Feature', bbox: [ll[0], ll[1], ll[0], ll[1]],
        geometry: { type: 'Point', coordinates: ll },
        properties: {
          course_id: src.course_id, course_name: src.course_name, hole_number: src.hole_number,
          feature_type: type, name, 'feature-color': COLORS[type],
          is_approximate: true, source: 'derived', '@id': mkUuid(),
        },
      });

      const markers = [];
      const counts = {};
      const tally = key => (counts[key] = (counts[key] || 0) + 1);
      const suffix = n => (n === 1 ? '' : `_${n}`);

      for (const [hole, g] of byHole) {
        let ref = null;
        if (g.fairway?.length) ref = avg(g.fairway.map(f => centroid(f.geometry.coordinates[0])));
        else if (g.tee_box?.length) ref = avg(g.tee_box.map(f => centroid(f.geometry.coordinates[0])));

        let teeBoxes = g.tee_box || [];
        if (teeMode === 'one_per_hole' && teeBoxes.length > 1) {
          // Pick the back tee: the tee_box centroid farthest from the green
          // (or the line-of-play reference if the hole has no green).
          const anchor = g.green?.length ? centroid(g.green[0].geometry.coordinates[0]) : ref;
          if (anchor) {
            teeBoxes = [teeBoxes.reduce((best, f) => {
              const c = centroid(f.geometry.coordinates[0]);
              const d = (c[0] - anchor[0]) ** 2 + (c[1] - anchor[1]) ** 2;
              return d > best.d ? { f, d } : best;
            }, { f: teeBoxes[0], d: -1 }).f];
          } else {
            teeBoxes = [teeBoxes[0]];
          }
        }
        for (const f of teeBoxes) {
          const n = tally(`${hole}_tee_center`);
          markers.push(mk('tee_center', toLL(centroid(f.geometry.coordinates[0])), f.properties, `hole_${hole}_tee_center${suffix(n)}`));
        }

        for (const f of g.green || []) {
          const ring = f.geometry.coordinates[0];
          const c = centroid(ring);
          const n = tally(`${hole}_green`);
          let front = c, back = c;
          if (ref) {
            const dx = c[0] - ref[0], dy = c[1] - ref[1];
            const L = Math.hypot(dx, dy);
            if (L > 0) {
              const u = [dx / L, dy / L];
              front = rayHit(c, [-u[0], -u[1]], ring) || c; // toward the approach
              back = rayHit(c, [u[0], u[1]], ring) || c;     // away from the approach
            }
          }
          markers.push(mk('green_center', toLL(c), f.properties, `hole_${hole}_green_center${suffix(n)}`));
          markers.push(mk('green_front', toLL(front), f.properties, `hole_${hole}_green_front${suffix(n)}`));
          markers.push(mk('green_back', toLL(back), f.properties, `hole_${hole}_green_back${suffix(n)}`));
        }
      }

      await fetch(`${VIEWER_URL}/geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [...feats, ...markers] }),
      });

      const teeCount = markers.filter(m => m.properties.feature_type === 'tee_center').length;
      const greenCount = markers.filter(m => m.properties.feature_type === 'green_center').length;
      return {
        content: [{
          type: 'text',
          text: `Generated ${markers.length} markers: ${teeCount} tee_center, ${greenCount} green_center, and ${greenCount} each of green_front/green_back. Total on map: ${feats.length + markers.length}.`,
        }],
      };
    }

    case 'spread_hazards_to_holes': {
      const types = Array.isArray(args.feature_types) && args.feature_types.length ? args.feature_types : ['water'];
      const maxDist = typeof args.max_distance_m === 'number' ? args.max_distance_m : 35;
      const typeSet = new Set(types);
      const FOOT = new Set(['fairway', 'green', 'tee_box']);

      const res = await fetch(`${VIEWER_URL}/geojson`);
      const fc = await res.json();
      const feats = fc.features || [];

      // Meters-per-degree at the course latitude for distance math.
      const polyPts = feats.filter(f => f.geometry?.type === 'Polygon').flatMap(f => f.geometry.coordinates[0]);
      const latRef = polyPts.length ? polyPts.reduce((s, p) => s + p[1], 0) / polyPts.length : 0;
      const MX = 111320 * Math.cos(latRef * Math.PI / 180), MY = 110540;
      const vertsOf = f => f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : [f.geometry.coordinates];
      function distM(a, b) {
        let best = Infinity;
        for (const p of vertsOf(a)) for (const q of vertsOf(b)) {
          const d = ((p[0] - q[0]) * MX) ** 2 + ((p[1] - q[1]) * MY) ** 2;
          if (d < best) best = d;
        }
        return Math.sqrt(best);
      }

      const holeFoot = new Map();
      for (const f of feats) {
        if (FOOT.has(f.properties?.feature_type)) {
          const h = f.properties.hole_number;
          if (!holeFoot.has(h)) holeFoot.set(h, []);
          holeFoot.get(h).push(f);
        }
      }
      if (!holeFoot.size) {
        return { content: [{ type: 'text', text: 'No fairway/green/tee_box features with hole_number found — assign holes before spreading hazards.' }] };
      }

      const hazards = feats.filter(f => typeSet.has(f.properties?.feature_type));
      const nonHazard = feats.filter(f => !typeSet.has(f.properties?.feature_type));

      // Collapse existing groups to one representative each so re-runs are idempotent.
      const groups = new Map();
      for (const h of hazards) {
        const key = h.properties.hazard_group ?? h.properties.osm_id ?? h.properties['@id'];
        if (!groups.has(key)) groups.set(key, h);
      }

      function mkUuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }

      const counts = {};
      const newHazards = [];
      for (const rep of groups.values()) {
        const perHole = [];
        for (const [hole, hfs] of holeFoot) {
          perHole.push([hole, Math.min(...hfs.map(hf => distM(rep, hf)))]);
        }
        let within = perHole.filter(([, d]) => d <= maxDist).sort((a, b) => a[1] - b[1]).map(([h]) => h);
        if (!within.length) within = [perHole.sort((a, b) => a[1] - b[1])[0][0]];

        const groupId = String(rep.properties.osm_id ?? rep.properties['@id']);
        const ftype = rep.properties.feature_type;
        for (const hole of within) {
          const key = `${hole}_${ftype}`;
          counts[key] = (counts[key] || 0) + 1;
          const n = counts[key];
          const dup = JSON.parse(JSON.stringify(rep));
          dup.properties.hole_number = hole;
          dup.properties.name = `hole_${hole}_${ftype}${n === 1 ? '' : `_${n}`}`;
          dup.properties.hazard_group = groupId;
          dup.properties['@id'] = mkUuid();
          newHazards.push(dup);
        }
      }

      await fetch(`${VIEWER_URL}/geojson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'FeatureCollection', features: [...nonHazard, ...newHazards] }),
      });

      return {
        content: [{
          type: 'text',
          text: `Spread ${groups.size} hazard(s) (${types.join(', ')}) across surrounding holes within ${maxDist}m → ${newHazards.length} hole-assigned copies. Total on map: ${nonHazard.length + newHazards.length}.`,
        }],
      };
    }

    case 'upload_to_supabase': {
      const connectionString = process.env.SUPABASE_CONNECTION_STRING;
      if (!connectionString) {
        return { content: [{ type: 'text', text: 'SUPABASE_CONNECTION_STRING is not set in the project .env.' }] };
      }
      const course_name = args.course_name;
      const course_id = args.course_id || course_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const res = await fetch(`${VIEWER_URL}/geojson`);
      const geojson = await res.json();

      // Optional per-course scorecard (par/handicap/yardage) → populates course_holes.
      let scorecard = null;
      const cardPath = join(__dirname, '..', 'data', 'scorecards', `${course_id}.json`);
      if (existsSync(cardPath)) scorecard = JSON.parse(readFileSync(cardPath, 'utf8'));

      const r = await uploadCourse({
        connectionString, courseId: course_id, courseName: course_name,
        city: args.city ?? null, state: args.state ?? null, geojson,
        replace: args.replace !== false, commit: !args.dry_run, scorecard,
      });

      const mode = r.committed ? 'Uploaded' : 'DRY RUN (rolled back) — would upload';
      const skipMsg = r.skipped ? ` Skipped ${r.skipped} feature(s) with no hole_number.` : '';
      const delMsg = r.deleted ? ` Replaced ${r.deleted} existing feature(s).` : '';
      const holesMsg = r.holesUpserted
        ? ` Populated ${r.holesUpserted} course_holes row(s) from scorecard.`
        : (scorecard ? '' : ` No scorecard at data/scorecards/${course_id}.json — course_holes left untouched.`);
      return {
        content: [{
          type: 'text',
          text: `${mode} ${r.inserted} feature(s) to course "${course_id}".${delMsg}${skipMsg}${holesMsg}`,
        }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
