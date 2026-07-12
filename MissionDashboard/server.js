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
const PORT = Math.min(65535, Math.max(1, Number(process.env.PORT) || 3456));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'upstream-cache.json');
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
const AUTH_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const authFailures = new Map();
let cachePersistTimer = null;

// SSE clients for cross-device launch event relay
const sseClients = new Map();
const OWNER_TTL_MS = 7000;
const pendingCommands = new Map();
const pendingAuth = new Map();
let sharedLaunch = { ownerId: null, ownerName: '', connected: false, status: null, countdown: null, updatedAt: Date.now() };

function ownerAlive() {
  return !!sharedLaunch.ownerId && Date.now() - sharedLaunch.updatedAt < OWNER_TTL_MS;
}

function emitLaunch(payload, targetClientId = null) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [client, meta] of sseClients) {
    if (targetClientId && meta.clientId !== targetClientId) continue;
    try { client.write(line); } catch (_) { sseClients.delete(client); }
  }
}

function publicLaunchState() {
  if (!ownerAlive() && sharedLaunch.connected) {
    sharedLaunch = { ...sharedLaunch, ownerId: null, connected: false, updatedAt: Date.now() };
  }
  return { ...sharedLaunch, ownerId: undefined, ownerActive: ownerAlive(), viewers: sseClients.size };
}

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
  scheduleCachePersist();
}

function loadPersistentCaches() {
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, value] of saved.aircraft || []) aircraftCache.set(key, value);
    for (const [key, value] of saved.osm || []) osmCache.set(key, value);
    console.log(`[cache] restored ${aircraftCache.size} aircraft and ${osmCache.size} OSM entries`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[cache] could not restore persistent cache:', err.message);
  }
}

function persistCaches() {
  cachePersistTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ aircraft: [...aircraftCache], osm: [...osmCache] }));
    fs.renameSync(temp, CACHE_FILE);
  } catch (err) {
    console.warn('[cache] could not persist cache:', err.message);
  }
}

function scheduleCachePersist() {
  if (cachePersistTimer) return;
  cachePersistTimer = setTimeout(persistCaches, 1000);
  cachePersistTimer.unref();
}

loadPersistentCaches();

// Join sessions are granted only after the connected ESP32 validates the code.
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function sessionFor(req) {
  const token = parseCookies(req).neolabs_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now() || (ownerAlive() && session.ownerId !== sharedLaunch.ownerId)) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + AUTH_TTL_MS;
  return session;
}

function requireAuth(req, res, next) {
  if (!ownerAlive()) return next();
  if (['/health', '/auth/status', '/auth/login', '/auth/owner', '/auth/result', '/launch-state', '/launch-event'].includes(req.path)) return next();
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error: 'launch_code_required' });
  req.launchSession = session;
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
app.use(express.static(path.join(__dirname)));

app.get('/api/auth/status', (req, res) => res.json({ authenticated: !!sessionFor(req), codeRequired: ownerAlive() }));
app.post('/api/auth/login', async (req, res) => {
  if (!ownerAlive()) return res.json({ ok: true, codeRequired: false });
  const authKey = req.ip || req.socket.remoteAddress || 'unknown';
  const failure = authFailures.get(authKey);
  if (failure && failure.until > Date.now() && failure.count >= 5) {
    return res.status(429).json({ error: 'too_many_attempts', retryAfterMs: failure.until - Date.now() });
  }
  const code = String(req.body?.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_launch_code_format' });
  const requestId = crypto.randomUUID();
  const valid = await new Promise(resolve => {
    const timer = setTimeout(() => { pendingAuth.delete(requestId); resolve(false); }, 6000);
    pendingAuth.set(requestId, result => { clearTimeout(timer); pendingAuth.delete(requestId); resolve(result); });
    emitLaunch({ type: 'auth_request', requestId, code, ownerId: sharedLaunch.ownerId }, sharedLaunch.ownerId);
  });
  if (!valid) {
    const current = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 60000 };
    current.count++;
    authFailures.set(authKey, current);
    return res.status(401).json({ error: 'invalid_launch_code', attemptsLeft: Math.max(0, 5 - current.count) });
  }
  authFailures.delete(authKey);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { id: crypto.randomUUID(), ownerId: sharedLaunch.ownerId, expiresAt: Date.now() + AUTH_TTL_MS });
  res.setHeader('Set-Cookie', `neolabs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL_MS / 1000}`);
  res.json({ ok: true });
});
app.post('/api/auth/result', (req, res) => {
  if (!ownerAlive() || req.body?.clientId !== sharedLaunch.ownerId) return res.status(403).json({ error: 'not_ble_owner' });
  const complete = pendingAuth.get(String(req.body?.requestId || ''));
  if (!complete) return res.status(404).json({ error: 'auth_request_expired' });
  complete(req.body?.valid === true);
  res.json({ ok: true });
});
app.post('/api/auth/owner', (req, res) => {
  if (!ownerAlive() || req.body?.clientId !== sharedLaunch.ownerId) return res.status(403).json({ error: 'not_ble_owner' });
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { id: crypto.randomUUID(), ownerId: sharedLaunch.ownerId, expiresAt: Date.now() + AUTH_TTL_MS });
  res.setHeader('Set-Cookie', `neolabs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL_MS / 1000}`);
  res.json({ ok: true });
});
app.use('/api', requireAuth);

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
// One browser owns BLE; every authorized browser receives state and can route
// commands through that owner in real time via Server-Sent Events.

app.get('/api/launch-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch (_) {} }, 20000);
  const clientId = String(req.query.clientId || '');
  if (!clientId) return res.end();
  sseClients.set(res, { clientId, authorized: !!sessionFor(req) });
  res.write(`data: ${JSON.stringify({ type: 'shared_state', state: publicLaunchState() })}\n\n`);
  emitLaunch({ type: 'client_count', clients: sseClients.size });
  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(keepAlive);
    emitLaunch({ type: 'client_count', clients: sseClients.size });
  });
});

app.post('/api/launch-event', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'bad payload' });
  const ownershipEvent = payload.type === 'owner_heartbeat' || payload.type === 'ble_state';
  const fromOwner = ownerAlive() && payload.clientId === sharedLaunch.ownerId;
  if (!ownershipEvent && ownerAlive() && !fromOwner && !sessionFor(req)) {
    return res.status(401).json({ error: 'launch_code_required' });
  }
  if (ownershipEvent) {
    const clientId = String(payload.clientId || '');
    if (!clientId) return res.status(400).json({ error: 'client_id_required' });
    if (!payload.connected && sharedLaunch.ownerId && sharedLaunch.ownerId !== clientId) {
      return res.json({ ok: true, ignored: true, clients: sseClients.size });
    }
    if (payload.connected && ownerAlive() && sharedLaunch.ownerId !== clientId) {
      return res.status(409).json({ error: 'ble_owner_exists', state: publicLaunchState() });
    }
    const ownerWasAlive = ownerAlive();
    sharedLaunch = {
      ...sharedLaunch,
      ownerId: payload.connected ? clientId : (sharedLaunch.ownerId === clientId ? null : sharedLaunch.ownerId),
      ownerName: payload.connected ? String(payload.deviceName || 'NeoLabs controller') : '',
      connected: !!payload.connected,
      status: payload.status || sharedLaunch.status,
      countdown: payload.countdown ?? sharedLaunch.countdown,
      updatedAt: Date.now()
    };
    emitLaunch({ type: 'shared_state', state: publicLaunchState() });
    if (!ownerWasAlive && payload.connected) {
      setTimeout(() => {
        for (const [client, meta] of sseClients) {
          if (!meta.authorized && meta.clientId !== clientId) {
            try { client.end(); } catch (_) {}
            sseClients.delete(client);
          }
        }
      }, 100);
    }
  } else if (payload.type === 'command_result') {
    pendingCommands.delete(String(payload.commandId || ''));
    if (payload.status) sharedLaunch.status = payload.status;
    sharedLaunch.updatedAt = Date.now();
    emitLaunch(payload);
    emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  } else {
    emitLaunch(payload);
  }
  res.json({ ok: true, clients: sseClients.size });
});

app.get('/api/launch-state', (req, res) => res.json(publicLaunchState()));

app.post('/api/launch-command', (req, res) => {
  if (!ownerAlive()) return res.status(503).json({ error: 'no_ble_owner' });
  const allowed = new Set(['arm', 'disarm', 'countdown_start', 'abort']);
  const command = String(req.body?.command || '');
  if (!allowed.has(command)) return res.status(400).json({ error: 'invalid_command' });
  const commandId = String(req.body?.commandId || crypto.randomUUID()).slice(0, 100);
  pendingCommands.set(commandId, Date.now());
  emitLaunch({ type: 'remote_command', commandId, command, args: req.body?.args || {}, ownerId: sharedLaunch.ownerId });
  res.status(202).json({ ok: true, commandId });
});

setInterval(() => {
  if (!ownerAlive() && sharedLaunch.connected) emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  for (const [id, at] of pendingCommands) if (Date.now() - at > 15000) pendingCommands.delete(id);
  for (const [token, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(token);
}, 2000).unref();

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

function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  if (cachePersistTimer) clearTimeout(cachePersistTimer);
  persistCaches();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
