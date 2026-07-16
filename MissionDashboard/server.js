const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const finderEngine = require('./finder-engine');

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
const SERVER_INSTANCE_ID = crypto.randomUUID();
const PORT = Math.min(65535, Math.max(1, Number(process.env.PORT) || 3456));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'upstream-cache.json');
const RECORDING_CACHE_DIR = path.join(DATA_DIR, 'recording-cache');
const AIRCRAFT_CACHE_TTL_MS = 30 * 1000;
const AIRCRAFT_STALE_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [200, 600, 1200];
const FIRMWARE_GITHUB_REPOSITORY = process.env.FIRMWARE_GITHUB_REPOSITORY || 'NeoLabs-Rockets/Launch-System';
const FIRMWARE_RELEASE_TAG = process.env.FIRMWARE_RELEASE_TAG || 'firmware-latest';
const FIRMWARE_RELEASE_CACHE_TTL_MS = 60 * 1000;
const FIRMWARE_BINARY_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_FIRMWARE_BYTES = 0x140000;
const OVERPASS_CACHE_TTL_MS = 15 * 60 * 1000;
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
let firmwareReleaseCache = null;
let firmwareBinaryCache = null;

// SSE clients for cross-device launch event relay
const sseClients = new Map();
// The ESP32 enforces the tight physical safety timeout. This longer lease only
// prevents remote-server latency from making the web owner flap unnecessarily.
const OWNER_TTL_MS = 15000;
const pendingCommands = new Map();
const pendingAuth = new Map();
let sharedLaunch = { ownerId: null, ownerName: '', connected: false, reconnecting: false, status: null, countdown: null, lastEvent: null, host: null, updatedAt: Date.now() };

const DURABLE_LAUNCH_EVENT_TYPES = new Set(['countdown_start', 'abort', 'ignition']);

function publicLaunchEvent(value) {
  if (!value || typeof value !== 'object' || !DURABLE_LAUNCH_EVENT_TYPES.has(value.type)) return null;
  const { clientId, ownerId, ...event } = value;
  event.eventId = String(event.eventId || '').slice(0, 100);
  event.at = Number.isFinite(Number(event.at)) ? Number(event.at) : Date.now();
  return event;
}

function newerLaunchEvent(current, candidate) {
  const event = publicLaunchEvent(candidate);
  if (!event) return current || null;
  if (!current || event.at >= Number(current.at || 0)) return event;
  return current;
}

function ownerLossEvent(reason) {
  return {
    type: 'abort',
    eventId: crypto.randomUUID(),
    source: 'launch-dashboard',
    reason,
    at: Date.now()
  };
}

function lastEventAfterOwnerLoss(state, reason) {
  if (state.countdown?.active || state.status?.armed || state.lastEvent?.type === 'countdown_start') {
    return ownerLossEvent(reason);
  }
  return state.lastEvent?.type === 'abort' || state.lastEvent?.type === 'ignition' ? state.lastEvent : null;
}

function publicHostState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    visibility: value.visibility === 'visible' ? 'visible' : 'hidden',
    wakeLockSupported: value.wakeLockSupported === true,
    wakeLockActive: value.wakeLockActive === true
  };
}

function ownerAlive() {
  return !!sharedLaunch.ownerId && Date.now() - sharedLaunch.updatedAt < OWNER_TTL_MS;
}

function emitLaunch(payload, targetClientId = null) {
  const stamped = { ...payload, serverAt: Date.now(), serverInstanceId: SERVER_INSTANCE_ID };
  const line = `data: ${JSON.stringify(stamped)}\n\n`;
  // The public state hides ownerId, so each client must be told explicitly
  // whether the active lease is its own — otherwise the owner device treats
  // its own lease as "another device" and locks itself out.
  const ownerLine = payload.type === 'shared_state' && payload.state?.ownerActive
    ? `data: ${JSON.stringify({ ...stamped, state: { ...payload.state, youAreOwner: true } })}\n\n`
    : null;
  for (const [client, meta] of sseClients) {
    if (targetClientId && meta.clientId !== targetClientId) continue;
    const out = ownerLine && meta.clientId === sharedLaunch.ownerId ? ownerLine : line;
    try { client.write(out); } catch (_) { sseClients.delete(client); }
  }
}

function publicLaunchState() {
  if (!ownerAlive() && (sharedLaunch.connected || sharedLaunch.ownerId)) {
    const lastEvent = lastEventAfterOwnerLoss(sharedLaunch, 'BLE owner lease expired');
    sharedLaunch = {
      ...sharedLaunch,
      ownerId: null,
      ownerName: '',
      connected: false,
      reconnecting: false,
      status: null,
      countdown: null,
      lastEvent,
      host: null,
      updatedAt: Date.now()
    };
  }
  const countdown = sharedLaunch.countdown?.active
    ? {
        ...sharedLaunch.countdown,
        remainingMs: Math.max(0, Number(sharedLaunch.countdown.endsAtServer || 0) - Date.now())
      }
    : sharedLaunch.countdown;
  return { ...sharedLaunch, countdown, ownerId: undefined, ownerActive: ownerAlive(), viewers: sseClients.size, serverAt: Date.now(), serverInstanceId: SERVER_INSTANCE_ID };
}

function publicLaunchStateFor(clientId) {
  const state = publicLaunchState();
  if (state.ownerActive && clientId && clientId === sharedLaunch.ownerId) state.youAreOwner = true;
  return state;
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

function validateFirmwareManifest(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('unsupported_manifest_schema');
  if (typeof value.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,62}$/.test(value.version)) {
    throw new Error('invalid_firmware_version');
  }
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) throw new Error('invalid_firmware_commit');
  if (value.environment !== 'esp32dev') throw new Error('wrong_firmware_environment');
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_FIRMWARE_BYTES) {
    throw new Error('invalid_firmware_size');
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('invalid_firmware_sha256');
  if (value.asset !== 'firmware.bin') throw new Error('invalid_firmware_asset');
  if (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('invalid_firmware_timestamp');
  }
  return {
    schemaVersion: 1,
    version: value.version,
    commit: value.commit,
    environment: value.environment,
    size: value.size,
    sha256: value.sha256,
    asset: value.asset,
    publishedAt: value.publishedAt
  };
}

async function githubFirmwareFetch(url, responseType = 'json') {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'NeoLabs-Mission-Dashboard',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`github_${response.status}`);
  return responseType === 'buffer' ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function latestFirmwareRelease(force = false) {
  if (!force && firmwareReleaseCache?.expiresAt > Date.now()) return firmwareReleaseCache;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(FIRMWARE_GITHUB_REPOSITORY)) {
    throw new Error('invalid_firmware_repository_configuration');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(FIRMWARE_RELEASE_TAG)) throw new Error('invalid_firmware_tag_configuration');
  const releaseUrl = `https://api.github.com/repos/${FIRMWARE_GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(FIRMWARE_RELEASE_TAG)}`;
  const release = await githubFirmwareFetch(releaseUrl);
  const manifestAsset = release.assets?.find(asset => asset.name === 'manifest.json');
  const binaryAsset = release.assets?.find(asset => asset.name === 'firmware.bin');
  if (!manifestAsset?.browser_download_url || !binaryAsset?.browser_download_url) throw new Error('firmware_release_assets_missing');
  const manifest = validateFirmwareManifest(await githubFirmwareFetch(manifestAsset.browser_download_url));
  if (Number(binaryAsset.size) !== manifest.size) throw new Error('firmware_release_size_mismatch');
  firmwareReleaseCache = {
    manifest,
    binaryUrl: binaryAsset.browser_download_url,
    expiresAt: Date.now() + FIRMWARE_RELEASE_CACHE_TTL_MS
  };
  if (firmwareBinaryCache?.sha256 !== manifest.sha256) firmwareBinaryCache = null;
  return firmwareReleaseCache;
}

async function latestFirmwareBinary(expectedSha) {
  const release = await latestFirmwareRelease();
  if (expectedSha && expectedSha !== release.manifest.sha256) throw new Error('firmware_release_changed');
  if (firmwareBinaryCache?.sha256 === release.manifest.sha256 && firmwareBinaryCache.expiresAt > Date.now()) {
    return { manifest: release.manifest, buffer: firmwareBinaryCache.buffer };
  }
  const buffer = await githubFirmwareFetch(release.binaryUrl, 'buffer');
  if (buffer.length !== release.manifest.size || buffer.length > MAX_FIRMWARE_BYTES) throw new Error('firmware_binary_size_mismatch');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== release.manifest.sha256) throw new Error('firmware_binary_sha_mismatch');
  firmwareBinaryCache = { sha256, buffer, expiresAt: Date.now() + FIRMWARE_BINARY_CACHE_TTL_MS };
  return { manifest: release.manifest, buffer };
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
  // Live launch state is read-only and must remain available to camera devices.
  // Mutating command and recording routes below still require authorization.
  if (['/health', '/auth/status', '/auth/login', '/auth/owner', '/auth/owner/release', '/auth/result', '/launch-state', '/launch-stream', '/launch-event'].includes(req.path)) return next();
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
// The data directory (recording cache, upstream cache) lives under the web
// root by default — never expose it through the static file server, since
// recordings are only served through the authorized /api/recordings routes.
app.use('/data', (req, res) => res.status(404).json({ error: 'not found' }));
app.use(express.static(path.join(__dirname)));

app.get('/api/auth/status', (req, res) => res.json({ authenticated: !!sessionFor(req), codeRequired: ownerAlive() }));
app.post('/api/auth/login', async (req, res) => {
  if (!ownerAlive()) return res.json({ ok: true, codeRequired: false });
  const authKey = req.ip || req.socket.remoteAddress || 'unknown';
  const code = String(req.body?.code || '');
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_launch_code_format' });
  const now = Date.now();
  let failure = authFailures.get(authKey);
  if (!failure || failure.until <= now) failure = { count: 0, pending: 0, until: now + 60000 };
  if (failure.count + failure.pending >= 5) {
    const retryAfterMs = failure.count >= 5 ? failure.until - now : 1000;
    return res.status(429).json({ error: 'too_many_attempts', retryAfterMs });
  }
  // Reserve the attempt before waiting for the ESP32. Without this, a burst of
  // concurrent invalid codes all observes the same old count and bypasses the
  // limit when their replies arrive together.
  failure.pending++;
  authFailures.set(authKey, failure);
  const requestId = crypto.randomUUID();
  const valid = await new Promise(resolve => {
    const timer = setTimeout(() => { pendingAuth.delete(requestId); resolve(false); }, 6000);
    pendingAuth.set(requestId, result => { clearTimeout(timer); pendingAuth.delete(requestId); resolve(result); });
    emitLaunch({ type: 'auth_request', requestId, code, ownerId: sharedLaunch.ownerId }, sharedLaunch.ownerId);
  });
  failure.pending = Math.max(0, failure.pending - 1);
  if (!valid) {
    failure.count++;
    authFailures.set(authKey, failure);
    return res.status(401).json({ error: 'invalid_launch_code', attemptsLeft: Math.max(0, 5 - failure.count - failure.pending) });
  }
  failure.count = 0;
  if (failure.pending === 0) authFailures.delete(authKey);
  else authFailures.set(authKey, failure);
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
  const clientId = String(req.body?.clientId || '');
  if (!clientId) return res.status(400).json({ error: 'client_id_required' });
  if (ownerAlive() && sharedLaunch.ownerId !== clientId) {
    return res.status(409).json({ error: 'ble_owner_exists', state: publicLaunchState() });
  }
  const renewingOwnLease = ownerAlive() && sharedLaunch.ownerId === clientId;
  sharedLaunch = {
    ...sharedLaunch,
    ownerId: clientId,
    ownerName: String(req.body?.deviceName || sharedLaunch.ownerName || 'NeoLabs controller'),
    connected: true,
    reconnecting: false,
    status: req.body?.status || sharedLaunch.status,
    // A reconnect from the same dashboard renews its lease; it must not look
    // like an abort to camera/remote clients while the local countdown resumes.
    countdown: renewingOwnLease ? sharedLaunch.countdown : { active: false, endsAtServer: null, left: 0 },
    lastEvent: renewingOwnLease ? sharedLaunch.lastEvent : null,
    host: publicHostState(req.body?.host) || (renewingOwnLease ? sharedLaunch.host : null),
    updatedAt: Date.now()
  };
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { id: crypto.randomUUID(), ownerId: clientId, expiresAt: Date.now() + AUTH_TTL_MS });
  res.setHeader('Set-Cookie', `neolabs_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${AUTH_TTL_MS / 1000}`);
  emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  // The response can arrive after the personalized SSE update. Return the same
  // ownership marker so the caller cannot overwrite true with an anonymous
  // public snapshot and briefly lock itself out.
  res.json({ ok: true, state: publicLaunchStateFor(clientId) });
});
// Explicit lease release (fetch keepalive or sendBeacon on pagehide) so other
// devices can take over immediately instead of waiting out the owner TTL.
app.post('/api/auth/owner/release', (req, res) => {
  const clientId = String(req.body?.clientId || '');
  if (!clientId || sharedLaunch.ownerId !== clientId) return res.json({ ok: true, ignored: true });
  const lastEvent = lastEventAfterOwnerLoss(sharedLaunch, 'BLE owner released the session');
  sharedLaunch = {
    ...sharedLaunch,
    ownerId: null,
    ownerName: '',
    connected: false,
    reconnecting: false,
    status: null,
    countdown: null,
    lastEvent,
    host: null,
    updatedAt: Date.now()
  };
  emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  res.json({ ok: true });
});

app.get('/api/firmware/latest', async (req, res) => {
  try {
    const { manifest } = await latestFirmwareRelease();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...manifest, downloadUrl: '/api/firmware/latest.bin' });
  } catch (error) {
    console.warn('[firmware] release lookup failed:', error.message);
    const unavailable = /^github_(404|403)$/.test(error.message);
    res.status(unavailable ? 503 : 502).json({ error: error.message });
  }
});

app.get('/api/firmware/latest.bin', async (req, res) => {
  const expectedSha = String(req.query.sha256 || '');
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) return res.status(400).json({ error: 'valid_sha256_required' });
  try {
    const { manifest, buffer } = await latestFirmwareBinary(expectedSha);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Firmware-Version', manifest.version);
    res.setHeader('X-Firmware-SHA256', manifest.sha256);
    res.send(buffer);
  } catch (error) {
    console.warn('[firmware] binary download failed:', error.message);
    const changed = error.message === 'firmware_release_changed';
    res.status(changed ? 409 : 502).json({ error: error.message });
  }
});
app.use('/api', requireAuth);

// ── Resilient camera recording cache ──────────────────────────────────────
// Every authorized dashboard (BLE owner or client) can spool MediaRecorder
// chunks here. Files are intentionally removed only after the browser has
// fetched every byte of each completed variant and explicitly acknowledges it.
function safeRecordingId(value) {
  const id = String(value || '');
  return /^[a-zA-Z0-9_-]{12,100}$/.test(id) ? id : null;
}

function recordingPaths(id, variant) {
  const dir = path.join(RECORDING_CACHE_DIR, id, variant);
  return { dir, manifest: path.join(RECORDING_CACHE_DIR, id, 'manifest.json') };
}

app.put('/api/recordings/:id/:variant/chunks/:index', express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  const id = safeRecordingId(req.params.id);
  const variant = ['main', 'green'].includes(req.params.variant) ? req.params.variant : null;
  const index = Number(req.params.index);
  if (!id || !variant || !Number.isSafeInteger(index) || index < 0 || index > 100000) {
    return res.status(400).json({ error: 'invalid_recording_chunk' });
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty_chunk' });
  try {
    const { dir } = recordingPaths(id, variant);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${String(index).padStart(6, '0')}.part`);
    const temp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, req.body);
    fs.renameSync(temp, target);
    res.json({ ok: true, index, bytes: req.body.length });
  } catch (error) {
    console.error('[recording-cache] chunk write failed:', error);
    res.status(500).json({ error: 'chunk_write_failed' });
  }
});

app.post('/api/recordings/:id/complete', (req, res) => {
  const id = safeRecordingId(req.params.id);
  const counts = req.body?.chunks || {};
  if (!id || !Number.isSafeInteger(counts.main) || !Number.isSafeInteger(counts.green) || counts.main < 1 || counts.green < 1) {
    return res.status(400).json({ error: 'invalid_recording_manifest' });
  }
  try {
    const variants = {};
    for (const variant of ['main', 'green']) {
      const { dir } = recordingPaths(id, variant);
      const files = Array.from({ length: counts[variant] }, (_, i) => path.join(dir, `${String(i).padStart(6, '0')}.part`));
      const missing = files.find(file => !fs.existsSync(file));
      if (missing) return res.status(409).json({ error: 'chunks_missing', variant });
      variants[variant] = {
        chunks: counts[variant],
        bytes: files.reduce((total, file) => total + fs.statSync(file).size, 0),
        acknowledged: false
      };
    }
    const manifest = {
      id,
      completedAt: new Date().toISOString(),
      mimeType: String(req.body?.mimeType || 'video/webm').slice(0, 100),
      variants
    };
    const { manifest: manifestFile } = recordingPaths(id, 'main');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    res.json({ ok: true, recording: manifest });
  } catch (error) {
    console.error('[recording-cache] finalize failed:', error);
    res.status(500).json({ error: 'recording_finalize_failed' });
  }
});

app.get('/api/recordings/:id/:variant', async (req, res) => {
  const id = safeRecordingId(req.params.id);
  const variant = ['main', 'green'].includes(req.params.variant) ? req.params.variant : null;
  if (!id || !variant) return res.status(400).json({ error: 'invalid_recording' });
  try {
    const paths = recordingPaths(id, variant);
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    const info = manifest.variants?.[variant];
    if (!info) return res.status(404).json({ error: 'recording_not_complete' });
    res.setHeader('Content-Type', manifest.mimeType || 'video/webm');
    res.setHeader('Content-Length', info.bytes);
    res.setHeader('Cache-Control', 'no-store');
    for (let i = 0; i < info.chunks; i++) {
      const file = path.join(paths.dir, `${String(i).padStart(6, '0')}.part`);
      for await (const chunk of fs.createReadStream(file)) {
        if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'recording_read_failed' });
    else res.destroy(error);
  }
});

app.delete('/api/recordings/:id/:variant', (req, res) => {
  const id = safeRecordingId(req.params.id);
  const variant = ['main', 'green'].includes(req.params.variant) ? req.params.variant : null;
  if (!id || !variant) return res.status(400).json({ error: 'invalid_recording' });
  try {
    const paths = recordingPaths(id, variant);
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    if (!manifest.variants?.[variant]) return res.status(409).json({ error: 'recording_not_complete' });
    fs.rmSync(paths.dir, { recursive: true, force: true });
    manifest.variants[variant].acknowledged = true;
    const allAcknowledged = Object.values(manifest.variants).every(item => item.acknowledged);
    if (allAcknowledged) fs.rmSync(path.join(RECORDING_CACHE_DIR, id), { recursive: true, force: true });
    else fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
    res.json({ ok: true, cacheDeleted: variant, recordingDeleted: allAcknowledged });
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'recording_cleanup_failed' });
  }
});

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
  res.json({ ok: true, instanceId: SERVER_INSTANCE_ID, cache_entries: aircraftCache.size, osm_cache_entries: osmCache.size, now: new Date().toISOString() });
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
  const clientId = String(req.query.clientId || '');
  if (!clientId) return res.status(400).json({ error: 'client_id_required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const keepAlive = setInterval(() => { try { res.write(':ping\n\n'); } catch (_) {} }, 20000);
  sseClients.set(res, { clientId });
  const initialState = publicLaunchStateFor(clientId);
  res.write(`data: ${JSON.stringify({ type: 'shared_state', state: initialState, serverAt: Date.now(), serverInstanceId: SERVER_INSTANCE_ID })}\n\n`);
  emitLaunch({ type: 'client_count', clients: sseClients.size });
  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(keepAlive);
    emitLaunch({ type: 'client_count', clients: sseClients.size });
  });
});

app.post('/api/finder-analysis', async (req, res) => {
  const raw = req.body || {};
  const lat = Number(raw.lat), lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'lat and lon required' });
  const radiusKm = Math.min(15, Math.max(1, Number(raw.radiusKm) || 5));
  const cfg = {
    lat, lon, radiusKm,
    spacingM: Math.min(1000, Math.max(120, Number(raw.spacingM) || 300)),
    minScore: Math.min(100, Math.max(0, Number(raw.minScore) || 0)),
    results: Math.min(60, Math.max(5, Number(raw.results) || 15)),
    sort: ['score', 'distance', 'field'].includes(raw.sort) ? raw.sort : 'score',
    fieldPref: ['prefer', 'require', 'ignore'].includes(raw.fieldPref) ? raw.fieldPref : 'prefer',
    enabled: {}, buffers: {}
  };
  const keys = ['road', 'highway', 'power', 'housing', 'settlement', 'rail', 'airport', 'trees', 'public', 'water'];
  for (const key of keys) {
    cfg.enabled[key] = raw.enabled?.[key] !== false;
    cfg.buffers[key] = Math.min(12000, Math.max(10, Number(raw.buffers?.[key]) || 10));
  }
  const cacheKey = osmCacheKey(lat, lon, radiusKm);
  let entry = osmCache.get(cacheKey), cached = false;
  try {
    if (!entry || Date.now() - entry.ts >= OVERPASS_CACHE_TTL_MS) {
      const data = await fetchOverpassWithRetry(overpassQuery(lat, lon, radiusKm));
      entry = { ts: Date.now(), data };
      cacheSet(osmCache, cacheKey, entry);
    } else cached = true;
  } catch (error) {
    if (!entry || Date.now() - entry.ts >= OVERPASS_STALE_TTL_MS) return res.status(502).json({ error: error.message || 'overpass unavailable' });
    cached = true;
  }
  try {
    res.json({ ...finderEngine.analyze(cfg, entry.data.elements || []), cached });
  } catch (error) {
    console.error('[finder]', error);
    res.status(500).json({ error: 'finder analysis failed' });
  }
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
    // While the owner browser is auto-reconnecting to the controller it keeps
    // its lease (heartbeats keep arriving with reconnecting: true) so a brief
    // BLE blip doesn't bounce ownership between devices.
    const keepLease = !payload.connected && payload.reconnecting === true && sharedLaunch.ownerId === clientId;
    const losingOwner = !payload.connected && !keepLease && sharedLaunch.ownerId === clientId;
    const reportedLastEvent = losingOwner
      ? lastEventAfterOwnerLoss(sharedLaunch, 'BLE controller link lost')
      : newerLaunchEvent(sharedLaunch.lastEvent, payload.lastEvent);
    sharedLaunch = {
      ...sharedLaunch,
      ownerId: payload.connected || keepLease ? clientId : (sharedLaunch.ownerId === clientId ? null : sharedLaunch.ownerId),
      ownerName: payload.connected || keepLease ? String(payload.deviceName || sharedLaunch.ownerName || 'NeoLabs controller') : '',
      connected: !!payload.connected,
      reconnecting: keepLease,
      status: payload.connected ? (payload.status || sharedLaunch.status) : null,
      countdown: !payload.connected
        ? null
        : payload.countdown?.active
        ? {
            ...payload.countdown,
            endsAtServer: Date.now() + Math.max(0, Number(payload.countdown.leftMs) || Number(payload.countdown.left) * 1000 || Math.max(0, Number(payload.countdown.endsAt) - Date.now()))
          }
        : (payload.countdown ?? sharedLaunch.countdown),
      lastEvent: reportedLastEvent,
      host: payload.connected || keepLease ? (publicHostState(payload.host) || sharedLaunch.host) : null,
      updatedAt: Date.now()
    };
    emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  } else if (payload.type === 'command_result') {
    if (!fromOwner) return res.status(403).json({ error: 'owner_event_required' });
    pendingCommands.delete(String(payload.commandId || ''));
    if (payload.status) sharedLaunch.status = payload.status;
    sharedLaunch.updatedAt = Date.now();
    emitLaunch(payload);
    emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  } else {
    if (ownerAlive() && !fromOwner) return res.status(403).json({ error: 'owner_event_required' });
    if (payload.type === 'countdown_start' || payload.type === 'countdown_tick') {
      const remainingMs = Number.isFinite(Number(payload.leftMs))
        ? Math.max(0, Number(payload.leftMs))
        : Math.max(0, Number(payload.left || payload.seconds || 0) * 1000);
      sharedLaunch.countdown = {
        active: true,
        endsAtServer: Date.now() + remainingMs,
        left: Number.isFinite(Number(payload.left)) ? Number(payload.left) : null,
        remainingMs
      };
    } else if (payload.type === 'abort' || payload.type === 'ignition') {
      sharedLaunch.countdown = { active: false, endsAt: null, left: 0 };
    }
    sharedLaunch.updatedAt = Date.now();
    const outgoing = sharedLaunch.countdown?.active
      ? { ...payload, remainingMs: Math.max(0, sharedLaunch.countdown.endsAtServer - Date.now()) }
      : payload;
    if (DURABLE_LAUNCH_EVENT_TYPES.has(payload.type)) {
      sharedLaunch.lastEvent = newerLaunchEvent(sharedLaunch.lastEvent, outgoing);
    }
    emitLaunch(outgoing);
    emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  }
  res.json({ ok: true, clients: sseClients.size });
});

app.get('/api/launch-state', (req, res) => {
  const clientId = String(req.query.clientId || '');
  res.json(publicLaunchStateFor(clientId));
});

app.post('/api/launch-command', (req, res) => {
  if (!ownerAlive()) return res.status(503).json({ error: 'no_ble_owner' });
  // A command from the owner itself means its BLE link is down — routing it
  // through the relay would just come straight back to the same browser.
  const requesterId = String(req.body?.clientId || '');
  if (requesterId && requesterId === sharedLaunch.ownerId) {
    return res.status(409).json({ error: 'ble_owner_is_this_device' });
  }
  // Fail fast when the owner's dashboard has no live stream (closed tab,
  // mid-reload) instead of letting the caller wait out an 8 s timeout.
  const ownerOnline = [...sseClients.values()].some(meta => meta.clientId === sharedLaunch.ownerId);
  if (!ownerOnline) return res.status(503).json({ error: 'owner_unreachable' });
  const allowed = new Set(['arm', 'disarm', 'countdown_start', 'abort']);
  const command = String(req.body?.command || '');
  if (!allowed.has(command)) return res.status(400).json({ error: 'invalid_command' });
  const commandId = String(req.body?.commandId || crypto.randomUUID()).slice(0, 100);
  pendingCommands.set(commandId, Date.now());
  emitLaunch({ type: 'remote_command', commandId, command, args: req.body?.args || {}, ownerId: sharedLaunch.ownerId });
  res.status(202).json({ ok: true, commandId });
});

setInterval(() => {
  if (!ownerAlive() && (sharedLaunch.connected || sharedLaunch.ownerId)) emitLaunch({ type: 'shared_state', state: publicLaunchState() });
  for (const [id, at] of pendingCommands) if (Date.now() - at > 15000) pendingCommands.delete(id);
  for (const [token, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(token);
}, 2000).unref();

// Application-level SSE heartbeat: clients use it as a liveness signal to
// detect half-dead streams (the ':ping' comment lines are invisible to
// EventSource, so they can't serve that purpose).
setInterval(() => emitLaunch({ type: 'heartbeat' }), 10000).unref();

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

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[shutdown] ${signal} received`);
  if (cachePersistTimer) clearTimeout(cachePersistTimer);
  persistCaches();
  // Long-lived SSE responses otherwise keep server.close() waiting until the
  // forced-exit timeout. Ending them explicitly makes browsers reconnect to a
  // replacement instance immediately during deploys and container restarts.
  for (const client of sseClients.keys()) {
    try { client.end(); } catch (_) {}
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
