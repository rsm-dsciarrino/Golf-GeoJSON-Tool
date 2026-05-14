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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
