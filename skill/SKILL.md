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
