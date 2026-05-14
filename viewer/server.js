import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let currentGeoJSON = { type: 'FeatureCollection', features: [] };
let midpoints = [];
const sseClients = new Set();

function broadcast() {
  for (const client of sseClients) {
    client.write('event: geojson-updated\ndata: {}\n\n');
  }
}

app.get('/', (req, res) => {
  let html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');
  html = html.replace('__MAPBOX_TOKEN__', process.env.MAPBOX_TOKEN || '');
  res.type('html').send(html);
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/geojson', (req, res) => {
  res.json(currentGeoJSON);
});

app.post('/geojson', (req, res) => {
  currentGeoJSON = req.body;
  broadcast();
  res.json({ ok: true, featureCount: currentGeoJSON.features?.length ?? 0 });
});

app.delete('/geojson', (req, res) => {
  currentGeoJSON = { type: 'FeatureCollection', features: [] };
  broadcast();
  res.json({ ok: true });
});

app.get('/midpoints', (req, res) => {
  res.json(midpoints);
});

app.post('/midpoints', (req, res) => {
  const { name, lat, lng } = req.body;
  midpoints = midpoints.filter(m => m.name !== name);
  midpoints.push({ name, lat, lng });
  res.json({ ok: true, count: midpoints.length });
});

app.delete('/midpoints/:name', (req, res) => {
  midpoints = midpoints.filter(m => m.name !== req.params.name);
  res.json({ ok: true, count: midpoints.length });
});

app.delete('/midpoints', (req, res) => {
  midpoints = [];
  res.json({ ok: true });
});

app.use(express.static(join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Viewer running on http://localhost:${PORT}`));
