#!/usr/bin/env node
// Build (and optionally upload) Looper elevation grids for courses already in data/.
// upload_to_supabase does this automatically for new courses; use this for backfills,
// rebuilds after geometry edits, or to produce a .elev file to bundle in the app.
//
//   node scripts/build-elevation.mjs <course_id> [...] [--upload] [--dry-run] [--out <dir>] [--no-verify]
//   node scripts/build-elevation.mjs --all --upload      # every data/<course_id>.geojson
//
// Reads data/<course_id>.geojson (features with a hole_number, like the upload),
// samples USGS 3DEP (see mcp-server/elevation.js), spot-checks tee/green elevations
// against the USGS point service, and with --upload upserts course_elevation_grids
// over SUPABASE_CONNECTION_STRING from .env. --out writes <dir>/<course_id>_elevation.elev
// (the filename Looper bundles: Looper/Looper/Courses/<course_id>/). Node 20.12+ (process.loadEnvFile).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildElevationGrid } from '../mcp-server/elevation.js';
import { uploadElevationGrid } from '../mcp-server/supabase.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const argv = process.argv.slice(2);
const flags = { upload: false, dryRun: false, verify: true, all: false, out: null };
const ids = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--upload') flags.upload = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--no-verify') flags.verify = false;
  else if (a === '--all') flags.all = true;
  else if (a === '--out') flags.out = argv[++i];
  else ids.push(a);
}
if (flags.all) {
  ids.push(...readdirSync(DATA).filter(f => f.endsWith('.geojson')).map(f => f.replace(/\.geojson$/, '')));
}
if (!ids.length) {
  console.error('Usage: node scripts/build-elevation.mjs <course_id> [...] | --all  [--upload] [--dry-run] [--out <dir>] [--no-verify]');
  process.exit(1);
}

let connectionString = process.env.SUPABASE_CONNECTION_STRING;
if ((flags.upload || flags.dryRun) && !connectionString) {
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  connectionString = process.env.SUPABASE_CONNECTION_STRING;
  if (!connectionString) { console.error('SUPABASE_CONNECTION_STRING is not set (.env)'); process.exit(1); }
}
if (flags.out) mkdirSync(flags.out, { recursive: true });

let failures = 0;
for (const id of [...new Set(ids)].sort()) {
  process.stdout.write(`- ${id}: `);
  try {
    const geojson = JSON.parse(readFileSync(join(DATA, `${id}.geojson`), 'utf8'));
    const features = (geojson.features || []).filter(f => f?.geometry && f.properties?.hole_number != null);
    const built = await buildElevationGrid({ features }, id, { doVerify: flags.verify });
    const s = built.stats;
    console.log(`${s.rows}x${s.cols}, ${Math.round(s.bytes / 1024)} KB, ${s.elevMinM}–${s.elevMaxM}m, ` +
      `1m lidar ${s.oneMeterLidarFraction ?? '?'}` +
      (flags.verify ? `, USGS spot check max Δ ${s.verifyMaxDiffM == null ? 'n/a' : s.verifyMaxDiffM.toFixed(2) + 'm'}` : ''));
    if (flags.out) writeFileSync(join(flags.out, `${id}_elevation.elev`), built.blob);
    if (flags.upload || flags.dryRun) {
      const r = await uploadElevationGrid({ connectionString, courseId: id, built, commit: flags.upload && !flags.dryRun });
      console.log(`    ${r.committed ? '↑ uploaded' : 'dry run (rolled back)'}`);
    }
  } catch (e) {
    failures++;
    console.log(`✗ ${e.message}`);
  }
}
process.exit(failures ? 1 : 0);
