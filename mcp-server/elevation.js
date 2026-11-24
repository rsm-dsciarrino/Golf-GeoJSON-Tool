// Per-course elevation grids for the Looper app's plays-like elevation.
//
// Samples the USGS 3DEP bare-earth DEM (lidar, 1m where available) on a ~3m grid over the
// course's features and encodes a compact `.elev` file, which uploadCourse stores in
// `course_elevation_grids`. The app interpolates player/pin elevation from it on device.
//
// This is a port of Looper's tools/elevation/build_elevation_grids.py; the `.elev` format
// must stay byte-compatible with it and with Looper's ElevationGrid.swift reader:
//
//   "LELV" | u16 version | u32 header_len | header JSON (utf-8) | raw-DEFLATE payload
//
// Payload: rows x cols little-endian int16 elevations in decimeters, row 0 = north edge,
// column 0 = west edge, cells are areas (centers at west + (c + 0.5) * dlon). Each row is
// delta-encoded left to right with wrapping int16 arithmetic (first cell raw).
// NODATA = -32768 before delta encoding.
//
// No dependencies: Node 18+ fetch and zlib.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const IMAGE_SERVER = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const INDEX_SERVER = 'https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer';
const ONE_METER_LAYER = 1;
const EPQS = 'https://epqs.nationalmap.gov/v1/json';
const UA = { 'User-Agent': 'GolfGeoJSONTool/1.0 (elevation grids)' };

const MAGIC = Buffer.from('LELV');
export const FORMAT_VERSION = 1;
const NODATA = -32768;
const SCALE_M = 0.1;
const SCALE_F32 = Math.fround(SCALE_M);
const METERS_PER_DEG_LAT = 111320.0;
const MAX_TILE_PX = 4000; // server limit is 8000

const sleep = ms => new Promise(r => setTimeout(r, ms));

// USGS services throw sporadic 5xx/502s; back off and retry.
async function get(url, params, { retries = 4, timeoutMs = 90000, as = 'json' } = {}) {
  const full = params ? `${url}?${new URLSearchParams(params)}` : url;
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(full, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`GET failed after ${retries} tries: ${full.slice(0, 160)} (${last?.message})`);
}

function flattenCoords(c, out = []) {
  if (!Array.isArray(c)) return out;
  if (typeof c[0] === 'number') out.push([c[0], c[1]]);
  else for (const x of c) flattenCoords(x, out);
  return out;
}

// numpy.round semantics (half to even), so values match the Python builder exactly.
function roundHalfEven(x) {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

export function gridSpec(points, cellM = 3, padM = 40) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  const midLat = (minLat + maxLat) / 2;
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180);
  // Cells are square in *degrees*: the ImageServer silently stretches the requested extent
  // to make pixels square in the image SR, which misaligns a meter-square grid on hills.
  const dlat = cellM / METERS_PER_DEG_LAT, dlon = dlat;
  const west = minLon - padM / mPerDegLon, east = maxLon + padM / mPerDegLon;
  const south = minLat - padM / METERS_PER_DEG_LAT, north = maxLat + padM / METERS_PER_DEG_LAT;
  const cols = Math.ceil((east - west) / dlon), rows = Math.ceil((north - south) / dlat);
  return { west, east: west + cols * dlon, north, south: north - rows * dlat, cols, rows, dlon, dlat };
}

// Float32Array of meters (NaN = no data), row-major, row 0 = north.
async function fetchRaster(spec) {
  const out = new Float32Array(spec.rows * spec.cols).fill(NaN);
  for (let r0 = 0; r0 < spec.rows; r0 += MAX_TILE_PX) {
    for (let c0 = 0; c0 < spec.cols; c0 += MAX_TILE_PX) {
      const h = Math.min(MAX_TILE_PX, spec.rows - r0), w = Math.min(MAX_TILE_PX, spec.cols - c0);
      const west = spec.west + c0 * spec.dlon, north = spec.north - r0 * spec.dlat;
      const bbox = [west, north - h * spec.dlat, west + w * spec.dlon, north];
      const params = {
        bbox: bbox.map(v => v.toFixed(9)).join(','), bboxSR: 4326, imageSR: 4326,
        size: `${w},${h}`, format: 'bip', pixelType: 'F32', noData: -9999,
        interpolation: 'RSP_BilinearInterpolation',
      };
      // Guard against the server adjusting the extent.
      const { extent } = await get(`${IMAGE_SERVER}/exportImage`, { ...params, f: 'json' });
      const tol = 0.01 * spec.dlat;
      if (Math.max(Math.abs(extent.xmin - bbox[0]), Math.abs(extent.ymin - bbox[1]),
                   Math.abs(extent.xmax - bbox[2]), Math.abs(extent.ymax - bbox[3])) > tol) {
        throw new Error(`3DEP changed the requested extent: asked ${bbox}, got ${JSON.stringify(extent)}`);
      }
      const raw = await get(`${IMAGE_SERVER}/exportImage`, { ...params, f: 'image' }, { as: 'buffer' });
      if (raw.length < w * h * 4) throw new Error(`short raster: ${raw.length}B < ${w * h * 4}B`);
      // Raw float32 pixels, then a validity bitmask we don't need (NoData is explicit).
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = raw.readFloatLE(4 * (y * w + x));
          out[(r0 + y) * spec.cols + c0 + x] = (v <= -9998 || !Number.isFinite(v)) ? NaN : v;
        }
      }
    }
  }
  return out;
}

async function servicePublished() {
  const meta = await get(IMAGE_SERVER, { f: 'json' });
  return meta.serviceDescription?.match(/published as of ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ?? null;
}

// Share of the grid covered by 1m lidar DEM projects (vs the 10m 1/3 arc-second fallback).
async function oneMeterFraction(spec, samples = 40) {
  const body = await get(`${INDEX_SERVER}/${ONE_METER_LAYER}/query`, {
    geometry: `${spec.west},${spec.south},${spec.east},${spec.north}`,
    geometryType: 'esriGeometryEnvelope', inSR: 4326, outSR: 4326,
    spatialRel: 'esriSpatialRelIntersects', returnGeometry: 'true',
    maxAllowableOffset: 0.00005, outFields: 'OBJECTID', f: 'json',
  });
  const feats = body.features || [];
  if (!feats.length) return 0;
  let covered = 0;
  for (let i = 0; i < samples; i++) {
    const py = spec.south + (spec.north - spec.south) * i / (samples - 1);
    for (let j = 0; j < samples; j++) {
      const px = spec.west + (spec.east - spec.west) * j / (samples - 1);
      // Inside any one project; each project's rings use even-odd for holes.
      const hit = feats.some(f => {
        let inside = false;
        for (const ring of f.geometry?.rings || []) {
          for (let k = 0; k + 1 < ring.length; k++) {
            const [a, b] = ring[k], [c, d] = ring[k + 1];
            if (b === d) continue;
            if ((b > py) !== (d > py) && px < (c - a) * (py - b) / (d - b) + a) inside = !inside;
          }
        }
        return inside;
      });
      if (hit) covered++;
    }
  }
  return covered / (samples * samples);
}

export function encode(grid, header) {
  const n = header.rows * header.cols;
  const dm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    // float32 division then half-even rounding, exactly like numpy on the float32 raster.
    dm[i] = Number.isNaN(grid[i]) ? NODATA : roundHalfEven(Math.fround(grid[i] / SCALE_F32));
  }
  const delta = new Int16Array(n); // assignments wrap to int16
  for (let r = 0; r < header.rows; r++) {
    const o = r * header.cols;
    delta[o] = dm[o];
    for (let c = 1; c < header.cols; c++) delta[o + c] = dm[o + c] - dm[o + c - 1];
  }
  const le = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) le.writeInt16LE(delta[i], 2 * i);
  const payload = deflateRawSync(le, { level: 9 }); // raw DEFLATE == Apple's COMPRESSION_ZLIB
  const hdr = Buffer.from(JSON.stringify(header), 'utf8');
  const fixed = Buffer.alloc(6);
  fixed.writeUInt16LE(FORMAT_VERSION, 0);
  fixed.writeUInt32LE(hdr.length, 2);
  return { blob: Buffer.concat([MAGIC, fixed, hdr, payload]), dm };
}

export function decode(blob) {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('bad magic');
  const version = blob.readUInt16LE(4);
  if (version !== FORMAT_VERSION) throw new Error(`unsupported version ${version}`);
  const hlen = blob.readUInt32LE(6);
  const header = JSON.parse(blob.subarray(10, 10 + hlen).toString('utf8'));
  const raw = inflateRawSync(blob.subarray(10 + hlen));
  const n = header.rows * header.cols;
  if (raw.length !== n * 2) throw new Error(`payload ${raw.length}B, expected ${n * 2}B`);
  const dm = new Int16Array(n);
  for (let r = 0; r < header.rows; r++) {
    let acc = 0;
    for (let c = 0; c < header.cols; c++) {
      const i = r * header.cols + c;
      acc = c === 0 ? raw.readInt16LE(2 * i) : (acc + raw.readInt16LE(2 * i)) << 16 >> 16;
      dm[i] = acc;
    }
  }
  return { header, dm };
}

// Bilinear elevation (m) — mirrors the Python sample() and ElevationGrid.swift.
export function sample(header, dm, lon, lat) {
  const x = (lon - header.west) / header.dlon - 0.5, y = (header.north - lat) / header.dlat - 0.5;
  const x0 = Math.min(Math.max(Math.floor(x), 0), header.cols - 2);
  const y0 = Math.min(Math.max(Math.floor(y), 0), header.rows - 2);
  const fx = Math.min(Math.max(x - x0, 0), 1), fy = Math.min(Math.max(y - y0, 0), 1);
  const i = y0 * header.cols + x0;
  const q = [dm[i], dm[i + 1], dm[i + header.cols], dm[i + header.cols + 1]];
  if (q.includes(NODATA)) return null;
  return (q[0] * (1 - fx) * (1 - fy) + q[1] * fx * (1 - fy) + q[2] * (1 - fx) * fy + q[3] * fx * fy) * SCALE_M;
}

// Spot-check tee/green centers of a few holes against the USGS point service.
async function verify(header, dm, features) {
  const pts = features
    .filter(f => ['tee_center', 'green_center'].includes(f.properties?.feature_type)
              && [1, 10, 11].includes(Number(f.properties?.hole_number))
              && f.geometry?.type === 'Point')
    .map(f => ({ label: `${f.properties.hole_number}:${f.properties.feature_type}`, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  const checks = [];
  for (const p of pts) {
    const grid = sample(header, dm, p.lon, p.lat);
    try {
      const r = await get(EPQS, { x: p.lon, y: p.lat, wkid: 4326, units: 'Meters', includeDate: 'false' }, { retries: 3, timeoutMs: 30000 });
      const ref = Number(r.value);
      checks.push({ ...p, grid, ref, diff: grid == null ? Infinity : Math.abs(grid - ref) });
    } catch (e) {
      checks.push({ ...p, grid, ref: null, diff: null, error: e.message });
    }
  }
  const diffs = checks.map(c => c.diff).filter(d => d != null);
  return { checks, maxDiffM: diffs.length ? Math.max(...diffs) : null };
}

/**
 * Builds a course's elevation grid from its GeoJSON features.
 * Returns { blob, header, stats } where blob is the .elev file (Buffer).
 * Throws when the area has no 3DEP data (outside the US) — callers decide whether that's fatal.
 */
export async function buildElevationGrid(geojson, courseId, { cellM = 3, padM = 40, maxNodata = 0.02, doVerify = true } = {}) {
  const features = (geojson?.features || []).filter(f => f?.geometry);
  const points = features.flatMap(f => flattenCoords(f.geometry.coordinates));
  if (!points.length) throw new Error('no feature geometry');
  const spec = gridSpec(points, cellM, padM);
  if (Math.max(spec.rows, spec.cols) > 8000) throw new Error(`grid too large: ${spec.rows}x${spec.cols}`);

  const [grid, published] = await Promise.all([fetchRaster(spec), servicePublished().catch(() => null)]);
  let nodata = 0, min = Infinity, max = -Infinity;
  for (const v of grid) {
    if (Number.isNaN(v)) nodata++;
    else { min = Math.min(min, v); max = Math.max(max, v); }
  }
  const nodataFrac = nodata / grid.length;
  if (nodataFrac > maxNodata) throw new Error(`${(nodataFrac * 100).toFixed(1)}% of cells have no 3DEP data (outside the US?)`);
  let lidar = null;
  try { lidar = Math.round(await oneMeterFraction(spec) * 1000) / 1000; } catch { /* informational only */ }

  const r9 = v => Math.round(v * 1e9) / 1e9;
  const header = {
    version: FORMAT_VERSION, course_id: courseId,
    west: r9(spec.west), south: r9(spec.south), east: r9(spec.east), north: r9(spec.north),
    dlon: r9(spec.dlon), dlat: r9(spec.dlat),
    rows: spec.rows, cols: spec.cols, cell_m: cellM,
    scale_m: SCALE_M, nodata: NODATA, encoding: 'int16le-rowdelta-rawdeflate',
    source: 'USGS 3DEP bare-earth DEM (3DEPElevation ImageServer, bilinear)',
    source_published: published, one_meter_lidar_fraction: lidar,
    nodata_fraction: Math.round(nodataFrac * 1e4) / 1e4,
    elev_min_m: Math.round(min * 10) / 10, elev_max_m: Math.round(max * 10) / 10,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const { blob, dm } = encode(grid, header);
  const back = decode(blob); // round-trip check
  if (JSON.stringify(back.header) !== JSON.stringify(header) || back.dm.some((v, i) => v !== dm[i])) {
    throw new Error('encode/decode round trip failed');
  }
  const verification = doVerify ? await verify(header, dm, features) : null;
  return {
    blob, header,
    stats: { rows: spec.rows, cols: spec.cols, bytes: blob.length, oneMeterLidarFraction: lidar,
             elevMinM: header.elev_min_m, elevMaxM: header.elev_max_m, nodataFraction: header.nodata_fraction,
             verifyMaxDiffM: verification?.maxDiffM ?? null, checks: verification?.checks ?? [] },
  };
}

/** Row for course_elevation_grids (minus course_id). */
export function gridRow({ blob, header }) {
  return {
    grid_b64: blob.toString('base64'), format_version: header.version, byte_size: blob.length,
    cell_m: header.cell_m, source: header.source,
    one_meter_lidar_fraction: header.one_meter_lidar_fraction, generated_at: header.generated_at,
  };
}
