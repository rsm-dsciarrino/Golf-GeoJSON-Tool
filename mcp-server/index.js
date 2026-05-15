import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
