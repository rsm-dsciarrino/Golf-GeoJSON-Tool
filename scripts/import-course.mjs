#!/usr/bin/env node
// Reusable course importer — step 2 of the new-course workflow (see CLAUDE.md).
//
//   node scripts/import-course.mjs "<Course Name>" <course_id> [--cap 60] [--radius 1500] [--no-push]
//   e.g. node scripts/import-course.mjs "Black Oak Golf Course" black_oak_auburn
//
// Geocodes via Nominatim, queries Overpass for golf features in the course area,
// assigns each playable feature to its nearest golf=hole line of play (OSM rarely
// tags features with a hole ref), derives tee_center + green_front/center/back markers,
// saves data/<course_id>.geojson, and pushes to the live viewer (unless --no-push).
//
// Features beyond --cap meters from any hole line are kept but flagged
// needs_hole_assignment (hole_number=null) for manual numbering in the viewer.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UA = { 'User-Agent': 'GolfGeoJSONTool/1.0' }; // Overpass/Nominatim 406 without this
const VIEWER_URL = process.env.VIEWER_URL || 'http://localhost:3000';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- args ----
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--no-push') flags.noPush = true;
  else if (argv[i] === '--cap') flags.cap = Number(argv[++i]);
  else if (argv[i] === '--radius') flags.radius = Number(argv[++i]);
  else pos.push(argv[i]);
}
const [courseName, courseId] = pos;
if (!courseName || !courseId) {
  console.error('Usage: node scripts/import-course.mjs "<Course Name>" <course_id> [--cap 60] [--radius 1500] [--no-push]');
  process.exit(1);
}
if (!/^[a-z0-9_]+$/.test(courseId)) { console.error(`course_id must match ^[a-z0-9_]+$ (got "${courseId}")`); process.exit(1); }
const CAP_M = flags.cap ?? 60;
const RADIUS = flags.radius ?? 1500;

// ---- geocode ----
const geo = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(courseName)}&format=json&limit=8&countrycodes=us`, { headers: UA }).then(r => r.json());
const hit = geo.find(r => r.class === 'leisure' && r.type === 'golf_course') || geo.find(r => r.class === 'leisure') || geo[0];
if (!hit) { console.error(`Could not geocode "${courseName}".`); process.exit(1); }
const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
console.log(`Geocoded "${courseName}" → ${hit.osm_type} ${hit.osm_id} @ ${lat},${lng}\n  ${hit.display_name}`);

// ---- overpass: golf features within the course area (fallback to radius) ----
async function overpass(q) {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
  });
  const text = await res.text();
  try { return JSON.parse(text).elements || []; }
  catch { console.error('Overpass error:', text.slice(0, 200)); return []; }
}
// map_to_area on the geocoded golf_course way/relation scopes the query to that course
// precisely (no bleeding into adjacent courses); radius is the fallback for nodes/failures.
let elements = [];
if (hit.osm_type === 'way' || hit.osm_type === 'relation') {
  elements = await overpass(`[out:json][timeout:60];${hit.osm_type}(${hit.osm_id});map_to_area->.a;(way[golf](area.a);node[golf](area.a););out body geom;`);
}
if (!elements.length) {
  console.log('Area query empty — falling back to radius query.');
  elements = await overpass(`[out:json][timeout:60];(way[golf](around:${RADIUS},${lat},${lng});node[golf](around:${RADIUS},${lat},${lng}););out body geom;`);
}
if (!elements.length) { console.error('No golf features found.'); process.exit(1); }

// ---- geometry helpers (meters via local equirectangular) ----
const MX = 111320 * Math.cos(lat * Math.PI / 180), MY = 110540;
const centroidLL = (e) => {
  if (e.type === 'node') return [e.lon, e.lat];
  const r = e.geometry.map(p => [p.lon, p.lat]);
  return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
};
function segDist(pt, a, b) {
  const px = pt[0] * MX, py = pt[1] * MY, ax = a[0] * MX, ay = a[1] * MY, bx = b[0] * MX, by = b[1] * MY;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const dline = (pt, ln) => Math.min(...ln.slice(0, -1).map((_, i) => segDist(pt, ln[i], ln[i + 1])));
const holeLines = elements
  .filter(e => e.tags?.golf === 'hole' && /^\d+$/.test(e.tags.ref || ''))
  .map(e => ({ ref: parseInt(e.tags.ref), ln: e.geometry.map(p => [p.lon, p.lat]) }));

const OSM_TYPE_MAP = {
  fairway: 'fairway', green: 'green', tee: 'tee_box', bunker: 'bunker',
  water_hazard: 'water', lateral_water_hazard: 'water', pond: 'water',
  // excluded from exports: cartpath/path, hole(corridor), clubhouse, driving_range
};
const TYPE_COLORS = { fairway: '#4a7c3f', green: '#2d6e2d', tee_box: '#8b7355', bunker: '#d4b483', water: '#2255cc' };
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
function bbox(pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const [lo, la] of pts) { if (lo < a) a = lo; if (la < b) b = la; if (lo > c) c = lo; if (la > d) d = la; } return [a, b, c, d]; }

// ---- build features with nearest-line hole assignment ----
const features = [];
const nameCounts = {};
for (const el of elements) {
  const ft = OSM_TYPE_MAP[el.tags?.golf];
  if (!ft) continue;
  let geometry;
  if (el.type === 'way' && el.geometry?.length) {
    const coords = el.geometry.map(p => [p.lon, p.lat]);
    const f = coords[0], l = coords[coords.length - 1];
    geometry = { type: 'Polygon', coordinates: [(f[0] === l[0] && f[1] === l[1]) ? coords : [...coords, f]] };
  } else if (el.type === 'node' && el.lat != null) {
    geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
  } else continue;
  const c = centroidLL(el);
  const best = holeLines.map(h => ({ ref: h.ref, d: dline(c, h.ln) })).sort((a, b) => a.d - b.d)[0];
  const hole = best && best.d <= CAP_M ? best.ref : null;
  const holeStr = hole != null ? `hole_${hole}` : 'unassigned';
  const base = `${holeStr}_${ft}`;
  nameCounts[base] = (nameCounts[base] || 0) + 1;
  const name = nameCounts[base] > 1 ? `${base}_${nameCounts[base]}` : base;
  const pts = geometry.type === 'Polygon' ? geometry.coordinates[0] : [geometry.coordinates];
  const props = { course_id: courseId, course_name: courseName, hole_number: hole, feature_type: ft, name, 'feature-color': TYPE_COLORS[ft], is_approximate: true, source: 'osm', '@id': uuid(), osm_id: el.id };
  if (hole == null) props.needs_hole_assignment = true;
  features.push({ type: 'Feature', bbox: bbox(pts), geometry, properties: props });
}

// ---- derive tee_center (back tee) + green_front/center/back ----
const assigned = features.filter(f => f.properties.hole_number != null);
const polyPts = assigned.filter(f => f.geometry.type === 'Polygon').flatMap(f => f.geometry.coordinates[0]);
const lon0 = polyPts.reduce((s, p) => s + p[0], 0) / polyPts.length, lat0 = polyPts.reduce((s, p) => s + p[1], 0) / polyPts.length;
const K = Math.cos(lat0 * Math.PI / 180);
const toXY = ([lon, la]) => [(lon - lon0) * K, la - lat0], toLL = ([x, y]) => [x / K + lon0, y + lat0];
function centroidXY(ringLL) { const r = ringLL.map(toXY); if (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) r.push(r[0]); let A = 0, cx = 0, cy = 0; for (let i = 0; i < r.length - 1; i++) { const [x0, y0] = r[i], [x1, y1] = r[i + 1]; const cr = x0 * y1 - x1 * y0; A += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr; } A *= 0.5; if (Math.abs(A) < 1e-18) { const n = r.length - 1; return [r.slice(0, -1).reduce((s, p) => s + p[0], 0) / n, r.slice(0, -1).reduce((s, p) => s + p[1], 0) / n]; } return [cx / (6 * A), cy / (6 * A)]; }
function rayHit(P, u, ringLL) { const r = ringLL.map(toXY); if (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) r.push(r[0]); let bestT = Infinity, hit = null; for (let i = 0; i < r.length - 1; i++) { const A = r[i], B = r[i + 1]; const ex = B[0] - A[0], ey = B[1] - A[1]; const det = ex * u[1] - ey * u[0]; if (Math.abs(det) < 1e-18) continue; const dx = A[0] - P[0], dy = A[1] - P[1]; const t = (ex * dy - ey * dx) / det, s = (u[0] * dy - u[1] * dx) / det; if (t > 1e-12 && s >= -1e-9 && s <= 1 + 1e-9 && t < bestT) { bestT = t; hit = [P[0] + t * u[0], P[1] + t * u[1]]; } } return hit; }
const avg = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
// OSM ways → Polygon (ring in coordinates[0]); OSM nodes → Point (no ring). ringOf returns
// null for points so callers can skip ray-casting; centroidOf falls back to the point itself.
const ringOf = f => f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : null;
const centroidOf = f => { const ring = ringOf(f); return ring ? centroidXY(ring) : toXY(f.geometry.coordinates); };
const MC = { tee_center: '#c8a055', green_front: '#5aae5a', green_center: '#5aae5a', green_back: '#5aae5a' };
const mk = (t, ll, src, name) => ({ type: 'Feature', bbox: [ll[0], ll[1], ll[0], ll[1]], geometry: { type: 'Point', coordinates: ll }, properties: { course_id: src.course_id, course_name: src.course_name, hole_number: src.hole_number, feature_type: t, name, 'feature-color': MC[t], is_approximate: true, source: 'derived', '@id': uuid() } });

const byHole = new Map();
for (const f of assigned) { const h = f.properties.hole_number; if (!byHole.has(h)) byHole.set(h, {}); (byHole.get(h)[f.properties.feature_type] ||= []).push(f); }
const markers = [];
for (const [hole, g] of byHole) {
  let ref = null;
  if (g.fairway?.length) ref = avg(g.fairway.map(centroidOf));
  else if (g.tee_box?.length) ref = avg(g.tee_box.map(centroidOf));
  let teeBoxes = g.tee_box || [];
  if (teeBoxes.length > 1) {
    const anchor = g.green?.length ? centroidOf(g.green[0]) : ref;
    if (anchor) teeBoxes = [teeBoxes.reduce((best, f) => { const c = centroidOf(f); const d = (c[0] - anchor[0]) ** 2 + (c[1] - anchor[1]) ** 2; return d > best.d ? { f, d } : best; }, { f: teeBoxes[0], d: -1 }).f];
    else teeBoxes = [teeBoxes[0]];
  }
  for (const f of teeBoxes) markers.push(mk('tee_center', toLL(centroidOf(f)), f.properties, `hole_${hole}_tee_center`));
  let gi = 0;
  for (const f of g.green || []) {
    gi++; const ring = ringOf(f); const c = ring ? centroidXY(ring) : toXY(f.geometry.coordinates); const sfx = gi === 1 ? '' : `_${gi}`;
    let front = c, back = c;
    if (ref && ring) { const dx = c[0] - ref[0], dy = c[1] - ref[1], L = Math.hypot(dx, dy); if (L > 0) { const u = [dx / L, dy / L]; front = rayHit(c, [-u[0], -u[1]], ring) || c; back = rayHit(c, [u[0], u[1]], ring) || c; } }
    markers.push(mk('green_center', toLL(c), f.properties, `hole_${hole}_green_center${sfx}`));
    markers.push(mk('green_front', toLL(front), f.properties, `hole_${hole}_green_front${sfx}`));
    markers.push(mk('green_back', toLL(back), f.properties, `hole_${hole}_green_back${sfx}`));
  }
}

// ---- save + push + report ----
const all = [...features, ...markers];
const outPath = join(__dirname, '..', 'data', `${courseId}.geojson`);
writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features: all }));
const byType = {}; for (const f of all) byType[f.properties.feature_type] = (byType[f.properties.feature_type] || 0) + 1;
const orphans = features.filter(f => f.properties.needs_hole_assignment);
console.log(`\nHoles: ${[...byHole.keys()].sort((a, b) => a - b).join(', ')}`);
console.log(`By type: ${JSON.stringify(byType)}`);
console.log(`Orphans (needs_hole_assignment): ${orphans.length}`);
console.log(`Saved → data/${courseId}.geojson (${all.length} features)`);
if (!flags.noPush) {
  const res = await fetch(`${VIEWER_URL}/geojson`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'FeatureCollection', features: all }) });
  console.log(`Pushed to viewer: ${JSON.stringify(await res.json())}`);
  console.log('\nNext: review/edit in the viewer, then look up the scorecard.');
} else {
  console.log('(not pushed — --no-push)');
}
