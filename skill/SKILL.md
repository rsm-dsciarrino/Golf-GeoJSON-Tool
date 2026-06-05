---
name: golf-geojson
description: Generate a GeoJSON FeatureCollection for golf course holes from a
  satellite screenshot and midpoint coordinates. Use this skill whenever the user
  provides a golf course image and wants GeoJSON output, asks Claude to map golf
  course features, trace hole geometry, or push features to the golf viewer map.
---

# Golf GeoJSON Skill

## Purpose
Generate a production-quality GeoJSON FeatureCollection for a golf hole by visually
tracing a satellite image and anchoring shapes to provided midpoint coordinates.

## Inputs Required
1. **Satellite image** — aerial/overhead view of the hole
2. **Midpoints** — call `get_midpoints` to retrieve coordinates the user has placed,
   e.g. `hole_1_fairway: [32.7157, -117.1611]`
3. **Course metadata** — course name and ID if known; ask if not provided

## Scale Calibration
Use the two furthest-apart midpoints to establish pixel-to-meter scale:
1. Calculate their real-world distance (Haversine, mentally estimated)
   - 1° lat ≈ 111,000m; 1° lng ≈ 111,000m × cos(latitude)
2. Measure their pixel separation in the image
3. Derive meters-per-pixel; use this ratio to size all polygon outlines

If only one midpoint is given, use these defaults:
| Feature       | Typical width | Typical length |
|---|---|---|
| Fairway       | 35m           | 150–400m       |
| Green         | 25m           | 30m            |
| Tee box       | 8m            | 14m            |
| Bunker        | 12m           | 18m            |
| Water hazard  | varies        | varies         |

## Features to Generate Per Hole
Generate ALL of the following for every hole:

| Feature type     | Geometry | Description |
|---|---|---|
| `tee_box`        | Polygon  | Traced tee markers/box boundary |
| `tee_center`     | Point    | Back-center of tee box |
| `fairway`        | Polygon  | Maintained fairway corridor, 15–25 pts |
| `green`          | Polygon  | Putting surface outline, 12–20 pts |
| `green_front`    | Point    | Forward edge of green (closest to fairway) |
| `green_center`   | Point    | Center of putting surface |
| `green_back`     | Point    | Back edge of green |
| `bunker`         | Polygon  | One feature per bunker, 12–30 pts each |
| `target_point`   | Point    | Ideal tee shot landing zone (avoid hazards) |
| `layup_point`    | Point    | Conservative layup option if applicable |

Add `water` or `rough` polygons if clearly visible in the image.

### Excluded feature types
Do **not** generate `path`/cartpath or `hole_corridor` features. When importing
from OSM, drop elements tagged `golf=cartpath`/`golf=path` and `golf=hole`. These
clutter the map and are not wanted in the output.

## Course-Level Features
Use `hole_number: "course"` for course-wide features:

| Feature type     | Geometry | Description |
|---|---|---|
| `trees`          | Polygon  | Tree canopy/stands across the course |
| `water_hazard`   | Polygon  | Water hazards outside a single-hole trace |
| `hazard`         | Polygon  | Regular hazard/native areas across the course |

## Tracing Process
For each polygon feature:
1. Locate it visually in the image
2. Trace its outline with enough points to capture the shape:
   - Simple rectangles (tee box): 4–5 pts
   - Smooth ovals (green, round bunkers): 12–18 pts
   - Irregular shapes (fairway, kidney bunkers): 15–30 pts
3. Convert pixel offsets from the midpoint into lat/lng deltas:
   - lat_delta = pixel_offset_north × meters_per_pixel / 111000
   - lng_delta = pixel_offset_east  × meters_per_pixel / (111000 × cos(lat))
4. Offset each polygon vertex from its provided midpoint coordinate
5. Always close polygons (first coordinate == last coordinate)

For Point features (tee_center, green markers, target_point, layup_point):
- Derive from visual position or compute from polygon bounds
- `green_front` = southernmost green polygon point
- `green_back`  = northernmost green polygon point
- `green_center` = centroid of green polygon

## Output Format
Return a GeoJSON FeatureCollection. Every feature must include `bbox`.

### Required properties on every feature
```json
{
  "course_id":     "torrey_pines_north",
  "course_name":   "Torrey Pines North Course",
  "hole_number":   1,
  "feature_type":  "<type from table above>",
  "name":          "Hole 1 Green",
  "is_approximate": true,
  "source":        "ai_trace",
  "notes":         "Brief description of trace method",
  "@id":           "<uuid4>"
}
```

For course-wide features such as trees, water hazards, and regular hazards, set
`hole_number` to `"course"` and use names like `course_trees_1`,
`course_water_hazard_1`, or `course_hazard_1`.

### Additional properties by feature type
| Feature type    | Extra properties |
|---|---|
| `tee_box`       | `tee` (color: blue/white/red/gold), `par`, `handicap_index`, `yardage` |
| `tee_center`    | `tee` |
| `green`         | `area_sqft` (estimate), `slope` (e.g. "back-to-front") |
| `bunker`        | `subtype` (fairway/greenside), `side` (left/right/front), `carry_yardage` (if fairway bunker) |
| `target_point`  | `yardage_from_tee`, `side` |
| `layup_point`   | `yardage_from_tee`, `yardage_to_pin` |
| `hole_corridor` | no extras |

### Color map (include `feature-color` property on every feature)
| Feature type     | Color     |
|---|---|
| fairway          | `#4a7c3f` |
| green            | `#2d6e2d` |
| tee_box          | `#8b6914` |
| bunker           | `#c8b560` |
| trees            | `#1f5b37` |
| water            | `#1a6b9e` |
| water_hazard     | `#1579b8` |
| hazard           | `#9b6a2e` |
| rough            | `#3a5e2a` |
| path             | `#888888` |
| hole_corridor    | `#3a6a3a` |
| tee_center       | `#c8a055` |
| target_point     | `#00d4ff` |
| layup_point      | `#ff8800` |
| green_front/center/back | `#5aae5a` |

### bbox
Include a `bbox` array on every feature: `[min_lng, min_lat, max_lng, max_lat]`

### @id
Generate a UUID4 for every feature. Format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`

## Quality Notes
- Fairway and green polygons should have 12–25 points — capture actual shape, not just bounding boxes
- Bunkers are the highest-detail features; trace every indent and lobe (15–30 pts)
- If a feature isn't visible, generate a plausible shape from typical dimensions and set `is_approximate: true`
- All AI-generated features should have `is_approximate: true` and `source: "ai_trace"`

## MCP Integration
After generating the FeatureCollection:
1. Call `push_geojson` to send it to the live viewer
2. Confirm to the user: number of features pushed, feature types included, and viewer URL
