const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

// Minimal .env loader — no extra dependency needed.
// Lines starting with # are comments; existing env vars take precedence.
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (_) {}
}());

const app = express();
const PORT = 3456;
const AIRCRAFT_CACHE_TTL_MS = 30 * 1000;
const AIRCRAFT_STALE_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [200, 600, 1200];
const OVERPASS_CACHE_TTL_MS = 2 * 60 * 1000;
const OVERPASS_STALE_TTL_MS = 60 * 60 * 1000;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

const aircraftCache = new Map();
const osmCache = new Map();
const MAX_CACHE_ENTRIES = 200;

// SSE clients for cross-device launch event relay
const sseClients = new Set();

// Keep the in-memory caches bounded so a long-running controller never leaks
// memory from unique lat/lon/dist combinations. Oldest entries are evicted first
// (Map preserves insertion order).
function cacheSet(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ── Basic Auth ─────────────────────────────────────────────────────────────
// Set DASHBOARD_PASSWORD in .env (or as an env var) to enable.
// Leave it unset for local-only use — auth is skipped when the var is absent.
function requireAuth(req, res, next) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return next();

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="NeoLabs Mission Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const supplied = colon >= 0 ? decoded.slice(colon + 1) : decoded;

  // Constant-time compare to resist timing attacks
  const a = Buffer.from(supplied.padEnd(pw.length));
  const b = Buffer.from(pw.padEnd(supplied.length));
  const match = supplied.length === pw.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="NeoLabs Mission Dashboard"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}

// A mission-control tool must not be taken down by a single bad upstream
// response or a rejected promise — log and keep serving.
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err);
});

app.use(express.json({ limit: '256kb' }));
app.use(requireAuth);
app.use(express.static(path.join(__dirname)));

// Proxy aircraft API — browser can't call adsb.fi directly (CORS)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheKey(lat, lon, dist) {
  return `${Number(lat).toFixed(2)}:${Number(lon).toFixed(2)}:${dist}`;
}

function osmCacheKey(lat, lon, radiusKm) {
  return `${Number(lat).toFixed(2)}:${Number(lon).toFixed(2)}:${Number(radiusKm).toFixed(1)}`;
}

function bboxFor(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos(Number(lat) * Math.PI / 180)));
  return {
    south: Number(lat) - dLat,
    west: Number(lon) - dLon,
    north: Number(lat) + dLat,
    east: Number(lon) + dLon
  };
}

function sendCached(res, entry, reason) {
  res.set('X-NeoLabs-Cache', reason);
  res.json({
    ...entry.data,
    cached: true,
    cacheReason: reason,
    cachedAt: new Date(entry.ts).toISOString()
  });
}

async function fetchAircraftWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'NeoLabs-MissionDashboard/1.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (!upstream.ok) {
        const err = new Error(`upstream ${upstream.status}`);
        err.status = upstream.status;
        throw err;
      }
      return await upstream.json();
    } catch (err) {
      lastError = err;
      if (attempt >= RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function overpassQuery(lat, lon, radiusKm) {
  const b = bboxFor(lat, lon, radiusKm);
  const box = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  return `[out:json][timeout:25];
(
  way["highway"](${box});
  way["power"~"^(line|minor_line)$"](${box});
  node["power"~"^(tower|pole)$"](${box});
  way["building"](${box});
  relation["building"](${box});
  way["landuse"~"^(residential|industrial|commercial|retail|construction|brownfield|garages|cemetery|farmyard)$"](${box});
  relation["landuse"~"^(residential|industrial|commercial|retail|construction|brownfield|garages|cemetery|farmyard)$"](${box});
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter)$"](${box});
  way["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter)$"](${box});
  relation["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter)$"](${box});
  way["amenity"~"^(school|kindergarten|college|university|hospital|clinic|place_of_worship|community_centre)$"](${box});
  relation["amenity"~"^(school|kindergarten|college|university|hospital|clinic|place_of_worship|community_centre)$"](${box});
  way["aeroway"](${box});
  relation["aeroway"](${box});
  node["aeroway"~"^(aerodrome|helipad)$"](${box});
  way["railway"](${box});
  relation["railway"](${box});
  way["natural"~"^(wood|tree_row)$"](${box});
  relation["natural"="wood"](${box});
  node["natural"="tree"](${box});
  way["landuse"~"^(forest|orchard|vineyard|plant_nursery)$"](${box});
  relation["landuse"~"^(forest|orchard|vineyard|plant_nursery)$"](${box});
  way["landuse"~"^(farmland|meadow|grass|allotments)$"](${box});
  relation["landuse"~"^(farmland|meadow|grass|allotments)$"](${box});
  way["natural"~"^(grassland|heath|scrub|bare_rock|sand)$"](${box});
  relation["natural"~"^(grassland|heath|scrub|bare_rock|sand)$"](${box});
  way["leisure"~"^(park|playground|pitch|sports_centre|recreation_ground)$"](${box});
  relation["leisure"~"^(park|playground|pitch|sports_centre|recreation_ground)$"](${box});
  way["natural"="water"](${box});
  relation["natural"="water"](${box});
  way["waterway"~"^(river|stream|canal|drain)$"](${box});
  way["landuse"~"^(reservoir|basin)$"](${box});
  relation["landuse"~"^(reservoir|basin)$"](${box});
);
out body geom center qt;`;
}

async function fetchOverpassWithRetry(query) {
  let lastError;
  for (let endpointIndex = 0; endpointIndex < OVERPASS_ENDPOINTS.length; endpointIndex++) {
    const endpoint = OVERPASS_ENDPOINTS[endpointIndex];
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': 'NeoLabs-MissionDashboard/1.0'
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(28000)
        });
        if (!upstream.ok) {
          const err = new Error(`overpass ${upstream.status}`);
          err.status = upstream.status;
          throw err;
        }
        const data = await upstream.json();
        data.source = endpoint;
        return data;
      } catch (err) {
        lastError = err;
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cache_entries: aircraftCache.size, osm_cache_entries: osmCache.size, now: new Date().toISOString() });
});

app.get('/api/osm-safety', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusKm = Math.min(15, Math.max(1, Number(req.query.radiusKm || 5)));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' });
  }

  const key = osmCacheKey(lat, lon, radiusKm);
  const cached = osmCache.get(key);
  if (cached && Date.now() - cached.ts < OVERPASS_CACHE_TTL_MS) {
    return sendCached(res, cached, 'fresh-local');
  }

  try {
    const data = await fetchOverpassWithRetry(overpassQuery(lat, lon, radiusKm));
    cacheSet(osmCache, key, { ts: Date.now(), data });
    res.set('X-NeoLabs-Cache', 'miss');
    res.json(data);
  } catch (e) {
    if (cached && Date.now() - cached.ts < OVERPASS_STALE_TTL_MS) {
      return sendCached(res, cached, 'overpass-stale');
    }
    res.status(502).json({ error: e.message || 'overpass unavailable' });
  }
});

app.get('/api/aircraft', async (req, res) => {
  const { lat, lon, dist } = req.query;
  if (!lat || !lon || !dist) {
    return res.status(400).json({ error: 'lat, lon, dist required' });
  }
  const key = cacheKey(lat, lon, dist);
  const cached = aircraftCache.get(key);
  if (cached && Date.now() - cached.ts < AIRCRAFT_CACHE_TTL_MS) {
    return sendCached(res, cached, 'fresh-local');
  }

  try {
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}`;
    const data = await fetchAircraftWithRetry(url);
    cacheSet(aircraftCache, key, { ts: Date.now(), data });
    res.set('X-NeoLabs-Cache', 'miss');
    res.json(data);
  } catch (e) {
    if (cached && Date.now() - cached.ts < AIRCRAFT_STALE_TTL_MS) {
      return sendCached(res, cached, e.status === 429 ? 'rate-limit-stale' : 'upstream-stale');
    }
    if (e.status === 429) {
      return res.status(429).json({ error: 'aircraft feed rate-limited' });
    }
    res.status(502).json({ error: e.message });
  }
});

// ── Cross-device SSE relay ──────────────────────────────────────────────────
// The laptop holds the BLE connection; phones/tablets on the same WiFi subscribe
// here and receive countdown events in real time via Server-Sent Events.

app.get('/api/launch-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch (_) {} }, 20000);
  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); clearInterval(keepAlive); });
});

app.post('/api/launch-event', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'bad payload' });
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => { try { client.write(line); } catch (_) {} });
  res.json({ ok: true, clients: sseClients.size });
});

// Unknown API routes get a clean JSON 404 instead of silently returning the
// dashboard HTML (which would break client-side JSON parsing).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'unknown endpoint' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function localNetworkIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = localNetworkIp();
  console.log(`\n  NeoLabs · Mission Dashboard`);
  console.log(`  Local:   http://localhost:${PORT}`);
  if (ip) console.log(`  Network: http://${ip}:${PORT}  ← open this on your phone`);
  console.log();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] Port ${PORT} is already in use. Is the dashboard already running?`);
    process.exit(1);
  }
  console.error('[server error]', err);
});
