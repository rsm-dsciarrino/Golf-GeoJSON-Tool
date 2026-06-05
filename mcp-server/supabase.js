// Uploads a GeoJSON FeatureCollection into the Supabase PostGIS schema.
//
// Schema (public):
//   courses(id text pk, name, city, state, created_at)
//   course_features(id uuid, course_id fk, hole_number int NOT NULL, feature_type,
//                   name, properties jsonb, geometry geometry(GEOMETRY,4326) NOT NULL,
//                   geometry_geojson text GENERATED from st_asgeojson(geometry))
//
// Notes:
// - hole_number is NOT NULL, so features without a hole_number are skipped (server-side).
// - geometry_geojson is a generated column and is never written.
// - No natural unique key on course_features, so re-upload = delete-by-course_id then insert.
import pg from 'pg';

const SLUG = /^[a-z0-9_]+$/;

// Haversine distance in yards between two [lon,lat] points.
function yardsBetween(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(a[0] - b[0]) * -1; // (lon order irrelevant for hav)
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))) * 1.09361; // meters → yards
}
const ptOf = f => f?.geometry?.type === 'Point' ? f.geometry.coordinates : null;

// Build course_holes rows: par/handicap/center-yardage from the scorecard; front/back
// yardages = center ∓ half the green depth (from green_front/green_back markers), matching
// the existing Ridge convention. Returns { rows, holes, skipped }.
function buildHoleRows(courseId, geojson, scorecard) {
  const feats = geojson?.features || [];
  const byHole = new Map();
  for (const f of feats) {
    const h = f.properties?.hole_number;
    if (h == null) continue;
    if (!byHole.has(h)) byHole.set(h, {});
    byHole.get(h)[f.properties.feature_type] = f;
  }
  const rows = [];
  for (const [holeStr, card] of Object.entries(scorecard.holes || {})) {
    const hole = parseInt(holeStr);
    const center = card.yardage;
    const g = byHole.get(hole) || {};
    const front = ptOf(g.green_front), back = ptOf(g.green_back);
    const half = (front && back) ? Math.round(yardsBetween(front, back) / 2) : 15; // nominal 30y green
    rows.push({
      hole, par: card.par, handicap: card.handicap,
      yf: Math.max(0, center - half), yc: center, yb: center + half,
    });
  }
  return rows.sort((a, b) => a.hole - b.hole);
}

export async function uploadCourse({
  connectionString, courseId, courseName, city = null, state = null,
  geojson, replace = true, commit = true, scorecard = null,
}) {
  if (!connectionString) throw new Error('Missing SUPABASE_CONNECTION_STRING');
  if (!SLUG.test(courseId || '')) throw new Error(`course_id must match ${SLUG} (got "${courseId}")`);

  const features = (geojson?.features || []).filter(f => f?.geometry);
  const eligible = features.filter(f => f.properties?.hole_number != null);
  const skipped = features.length - eligible.length;

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');

    await client.query(
      `insert into courses (id, name, city, state) values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name, city = excluded.city, state = excluded.state`,
      [courseId, courseName, city, state]
    );

    let deleted = 0;
    if (replace) {
      const del = await client.query('delete from course_features where course_id = $1', [courseId]);
      deleted = del.rowCount;
    }

    // Single server-side insert; null hole_numbers filtered out in SQL.
    const ins = await client.query(
      `insert into course_features (course_id, hole_number, feature_type, name, geometry)
       select $1,
              (e->'properties'->>'hole_number')::int,
              e->'properties'->>'feature_type',
              e->'properties'->>'name',
              ST_SetSRID(ST_GeomFromGeoJSON(e->'geometry'), 4326)
       from jsonb_array_elements($2::jsonb) e
       where (e->'properties'->>'hole_number') is not null`,
      [courseId, JSON.stringify(eligible.map(f => ({ properties: f.properties, geometry: f.geometry })))]
    );

    // Guarded backfill, requested explicitly: a no-op when geometry_geojson is generated
    // (the UPDATE raises, we catch and skip). courseId is slug-validated above, safe to inline.
    await client.query(`do $$
begin
  update course_features set geometry_geojson = ST_AsGeoJSON(geometry) where course_id = '${courseId}';
exception when others then
  raise notice 'geometry_geojson not writable (likely generated); skipping backfill';
end $$;`);

    // course_holes: par/handicap/center from scorecard, front/back from green geometry.
    let holesUpserted = 0;
    if (scorecard?.holes) {
      const rows = buildHoleRows(courseId, geojson, scorecard);
      for (const r of rows) {
        await client.query(
          `insert into course_holes (course_id, hole_number, par, handicap, yardage_front, yardage_center, yardage_back)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (course_id, hole_number) do update set
             par = excluded.par, handicap = excluded.handicap,
             yardage_front = excluded.yardage_front, yardage_center = excluded.yardage_center,
             yardage_back = excluded.yardage_back`,
          [courseId, r.hole, r.par, r.handicap, r.yf, r.yc, r.yb]
        );
        holesUpserted++;
      }
    }

    if (commit) await client.query('commit');
    else await client.query('rollback');

    return { inserted: ins.rowCount, skipped, deleted, holesUpserted, total: features.length, committed: !!commit };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}
