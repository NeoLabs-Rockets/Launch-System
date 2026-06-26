const express = require('express');
const path = require('path');

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

app.use(express.json({ limit: '256kb' }));
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
  way["landuse"~"^(residential|industrial|commercial|retail|construction)$"](${box});
  relation["landuse"~"^(residential|industrial|commercial|retail|construction)$"](${box});
  way["aeroway"](${box});
  relation["aeroway"](${box});
  node["aeroway"~"^(aerodrome|helipad)$"](${box});
  way["natural"~"^(wood|tree_row)$"](${box});
  relation["natural"="wood"](${box});
  node["natural"="tree"](${box});
  way["landuse"~"^(forest|orchard|vineyard)$"](${box});
  relation["landuse"~"^(forest|orchard|vineyard)$"](${box});
  way["landuse"~"^(farmland|meadow|grass|allotments|recreation_ground)$"](${box});
  relation["landuse"~"^(farmland|meadow|grass|allotments|recreation_ground)$"](${box});
  way["leisure"~"^(park|pitch)$"](${box});
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
    osmCache.set(key, { ts: Date.now(), data });
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
    aircraftCache.set(key, { ts: Date.now(), data });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  NeoLabs · Mission Dashboard\n  http://localhost:${PORT}\n`);
});
