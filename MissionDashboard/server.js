const express = require('express');
const path = require('path');

const app = express();
const PORT = 3456;
const AIRCRAFT_CACHE_TTL_MS = 30 * 1000;
const AIRCRAFT_STALE_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [200, 600, 1200];

const aircraftCache = new Map();

app.use(express.static(path.join(__dirname)));

// Proxy aircraft API — browser can't call adsb.fi directly (CORS)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheKey(lat, lon, dist) {
  return `${Number(lat).toFixed(2)}:${Number(lon).toFixed(2)}:${dist}`;
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

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cache_entries: aircraftCache.size, now: new Date().toISOString() });
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
