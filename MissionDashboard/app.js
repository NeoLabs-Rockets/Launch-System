const AUTO_REFRESH_MS = 5 * 60 * 1000;
const RENDER_REFRESH_MS = 60 * 1000;
const PROFILE_STORAGE_KEY = 'neolabs.missionDashboard.rocketProfiles';
const LEGACY_PROFILE_KEY = 'neolabs.missionDashboard.rocketProfile';
const WEATHER_CACHE_KEY = 'neolabs.missionDashboard.weatherCache';
const AIRCRAFT_CACHE_KEY = 'neolabs.missionDashboard.aircraftCache';
const CACHE_LOCATION_TOLERANCE_KM = 12;
const WEATHER_CACHE_MAX_AGE_MS = 45 * 60 * 1000;
const AIRCRAFT_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [250, 700, 1500];

let userLat = null;
let userLon = null;
let weather = null;
let aircraft = [];
let aircraftStatus = 'init';
let aircraftLastUpdate = null;
let weatherStatus = 'init';
let weatherLastUpdate = null;
let fullRefreshTimer = null;
let renderRefreshTimer = null;
const ignoredFactors = new Set();
const feedState = {
  weather: { status: 'init', attempts: 0, lastError: null, source: 'none' },
  aircraft: { status: 'init', attempts: 0, lastError: null, source: 'none' }
};

const MOTOR_CLASS_SPECS = {
  '1/2A': { impulseNs: 0.94, burnTimeS: 0.8 },
  A: { impulseNs: 1.88, burnTimeS: 0.9 },
  B: { impulseNs: 3.75, burnTimeS: 1.0 },
  C: { impulseNs: 7.5, burnTimeS: 1.2 },
  D: { impulseNs: 15, burnTimeS: 1.4 },
  E: { impulseNs: 30, burnTimeS: 1.6 },
  F: { impulseNs: 60, burnTimeS: 1.7 },
  G: { impulseNs: 120, burnTimeS: 1.9 },
  H: { impulseNs: 240, burnTimeS: 2.1 },
  I: { impulseNs: 480, burnTimeS: 2.4 },
  J: { impulseNs: 960, burnTimeS: 2.7 },
  K: { impulseNs: 1920, burnTimeS: 3.0 },
  L: { impulseNs: 3840, burnTimeS: 3.4 },
  M: { impulseNs: 7680, burnTimeS: 3.8 },
  N: { impulseNs: 15360, burnTimeS: 4.3 },
  O: { impulseNs: 30720, burnTimeS: 4.8 }
};

let profileStore = loadProfileStore();
let selectedProfileId = profileStore.selectedProfileId;
let rocketProfile = getSelectedProfile();
let rocketModel = computeRocketModel(rocketProfile);

window.addEventListener('DOMContentLoaded', () => {
  drawTicks();
  startClock();
  setupSettingsUI();
  setupRefreshControls();
  setupNetworkAwareness();
  renderRocketModel();
  renderStatus();
  renderDataLink();
  load('load-txt', 'Acquiring location…');

  navigator.geolocation.getCurrentPosition(
    async pos => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      hydrateCachedLiveData();
      renderAll();
      reverseGeocode();
      await refresh();
      startAutoRefresh();
      hideLoader();
    },
    () => {
      showErr('Location access denied — please allow location and reload.');
      hydrateCachedLiveData(false);
      renderAll();
      startRenderRefreshOnly();
      hideLoader();
    },
    { timeout: 10000, maximumAge: 60000 }
  );
});

function load(id, txt) {
  document.getElementById(id).textContent = txt;
}

function hideLoader() {
  const el = document.getElementById('loader');
  el.classList.add('hide');
  setTimeout(() => { el.style.display = 'none'; }, 500);
}

function showErr(msg) {
  const el = document.getElementById('err-banner');
  el.textContent = msg;
  el.style.display = 'block';
}

function clearErr() {
  const el = document.getElementById('err-banner');
  el.textContent = '';
  el.style.display = 'none';
}

function setupNetworkAwareness() {
  window.addEventListener('online', () => {
    renderDataLink();
    refresh();
  });
  window.addEventListener('offline', renderDataLink);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

function timeoutSignal(ms) {
  if (window.AbortSignal?.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, opts = {}) {
  const retries = opts.retries ?? RETRY_DELAYS_MS.length;
  const timeoutMs = opts.timeoutMs ?? 6500;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        ...opts,
        signal: timeoutSignal(timeoutMs),
        cache: opts.cache || 'no-store'
      });
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return { data: await r.json(), attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
      await sleep(RETRY_DELAYS_MS[attempt] || 1000);
    }
  }

  throw lastError || new Error('request failed');
}

function readCache(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (_) {
    return null;
  }
}

function writeCache(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (_) {}
}

function cacheMatchesLocation(entry, maxAgeMs) {
  if (!entry?.data || !entry.ts) return false;
  if (Date.now() - entry.ts > maxAgeMs) return false;
  if (userLat == null || userLon == null || entry.lat == null || entry.lon == null) return true;
  return haversine(userLat, userLon, entry.lat, entry.lon) <= CACHE_LOCATION_TOLERANCE_KM;
}

function hydrateCachedLiveData(requireLocation = true) {
  if (requireLocation && (userLat == null || userLon == null)) return false;
  let used = false;
  const wx = readCache(WEATHER_CACHE_KEY);
  if (cacheMatchesLocation(wx, WEATHER_CACHE_MAX_AGE_MS)) {
    weather = wx.data;
    weatherLastUpdate = new Date(wx.ts);
    weatherStatus = 'cached';
    feedState.weather = { status: 'cached', attempts: 0, lastError: null, source: 'cache' };
    used = true;
  }
  const ac = readCache(AIRCRAFT_CACHE_KEY);
  if (cacheMatchesLocation(ac, AIRCRAFT_CACHE_MAX_AGE_MS)) {
    aircraft = ac.data || [];
    aircraftLastUpdate = new Date(ac.ts);
    aircraftStatus = 'cached';
    feedState.aircraft = { status: 'cached', attempts: 0, lastError: null, source: 'cache' };
    used = true;
  }
  if (used) renderDataLink();
  return used;
}

function setFeedState(feed, patch) {
  feedState[feed] = { ...feedState[feed], ...patch };
  renderDataLink();
}

function renderDataLink() {
  const banner = document.getElementById('net-banner');
  if (!banner) return;
  const title = document.getElementById('net-title');
  const detail = document.getElementById('net-detail');
  const states = [feedState.weather.status, feedState.aircraft.status];
  const online = navigator.onLine !== false;
  const retrying = states.includes('retrying');
  const cached = states.includes('cached') || states.includes('stale');
  const failed = states.includes('error') || !online;

  banner.className = 'net-banner ' + (failed ? 'bad' : cached || retrying ? 'warn' : 'ok');
  if (!online) title.textContent = 'Offline';
  else if (retrying) title.textContent = 'Retrying feeds';
  else if (cached) title.textContent = 'Using cached data';
  else if (states.every(s => s === 'ok')) title.textContent = 'Live data link';
  else title.textContent = 'Data link starting';

  const parts = [];
  parts.push(describeFeed('Weather', feedState.weather, weatherLastUpdate));
  parts.push(describeFeed('Airspace', feedState.aircraft, aircraftLastUpdate));
  detail.textContent = parts.filter(Boolean).join(' | ');
}

function describeFeed(label, state, ts) {
  if (state.status === 'ok') return `${label} live${state.attempts > 1 ? ` after ${state.attempts} tries` : ''}`;
  if (state.status === 'retrying') return `${label} retrying`;
  if (state.status === 'cached') return `${label} cached ${fmtAge(ts)}`;
  if (state.status === 'ratelimited') return `${label} rate-limited, cached ${fmtAge(ts)}`;
  if (state.status === 'error') return `${label} unavailable${ts ? `, cached ${fmtAge(ts)}` : ''}`;
  return `${label} pending`;
}

function fmtAge(ts) {
  if (!ts) return 'data';
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById('hdr-clock').textContent =
      pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  };
  tick();
  setInterval(tick, 1000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function startAutoRefresh() {
  if (fullRefreshTimer) clearInterval(fullRefreshTimer);
  if (renderRefreshTimer) clearInterval(renderRefreshTimer);
  fullRefreshTimer = setInterval(refresh, AUTO_REFRESH_MS);
  renderRefreshTimer = setInterval(() => renderAll(), RENDER_REFRESH_MS);
}

function startRenderRefreshOnly() {
  if (renderRefreshTimer) clearInterval(renderRefreshTimer);
  renderRefreshTimer = setInterval(() => renderAll(), RENDER_REFRESH_MS);
}

async function reverseGeocode() {
  if (userLat == null || userLon == null) return;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${userLat}&lon=${userLon}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const d = await r.json();
    const city = d.address.city || d.address.town || d.address.village || d.address.county || '';
    const country = d.address.country_code?.toUpperCase() || '';
    const coord = `${Math.abs(userLat).toFixed(4)}°${userLat >= 0 ? 'N' : 'S'} ${Math.abs(userLon).toFixed(4)}°${userLon >= 0 ? 'E' : 'W'}`;
    document.getElementById('hdr-loc').textContent = city ? `${city}, ${country} · ${coord}` : coord;
  } catch (_) {
    document.getElementById('hdr-loc').textContent = `${userLat.toFixed(4)}° ${userLon.toFixed(4)}°`;
  }
}

async function refresh() {
  if (userLat == null || userLon == null) {
    renderAll();
    return;
  }
  await Promise.allSettled([fetchWeather(), fetchAircraft()]);
  renderAll();
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${userLat}&longitude=${userLon}`
    + `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m`
    + `&hourly=uv_index&daily=sunrise,sunset&forecast_days=1&timezone=auto`;
  setFeedState('weather', { status: 'retrying', lastError: null, source: 'network' });
  try {
    const result = await fetchJsonWithRetry(url, { timeoutMs: 5500 });
    weather = result.data;
    weatherStatus = 'ok';
    weatherLastUpdate = new Date();
    setFeedState('weather', { status: 'ok', attempts: result.attempts, lastError: null, source: 'network' });
    writeCache(WEATHER_CACHE_KEY, {
      ts: weatherLastUpdate.getTime(),
      lat: userLat,
      lon: userLon,
      data: weather
    });
    clearErr();
  } catch (err) {
    const cached = readCache(WEATHER_CACHE_KEY);
    if (cacheMatchesLocation(cached, WEATHER_CACHE_MAX_AGE_MS)) {
      weather = cached.data;
      weatherStatus = 'cached';
      weatherLastUpdate = new Date(cached.ts);
      setFeedState('weather', { status: 'cached', attempts: RETRY_DELAYS_MS.length + 1, lastError: err.message, source: 'cache' });
    } else {
      weatherStatus = 'error';
      setFeedState('weather', { status: 'error', attempts: RETRY_DELAYS_MS.length + 1, lastError: err.message, source: 'none' });
      showErr('Weather feed unavailable. Check connection; dashboard will retry automatically.');
    }
  }
}
async function fetchAircraft() {
  if (userLat == null || userLon == null) return;
  const distNm = 44;
  const url = `/api/aircraft?lat=${userLat.toFixed(4)}&lon=${userLon.toFixed(4)}&dist=${distNm}`;
  setFeedState('aircraft', { status: 'retrying', lastError: null, source: 'network' });
  try {
    const result = await fetchJsonWithRetry(url, { timeoutMs: 7000 });
    const data = result.data;
    aircraft = normalizeAircraft(data.ac || []);
    aircraftStatus = data.cached ? 'cached' : 'ok';
    aircraftLastUpdate = data.cachedAt ? new Date(data.cachedAt) : new Date();
    setFeedState('aircraft', { status: aircraftStatus, attempts: result.attempts, lastError: null, source: data.cached ? 'cache' : 'network' });
    writeCache(AIRCRAFT_CACHE_KEY, {
      ts: aircraftLastUpdate.getTime(),
      lat: userLat,
      lon: userLon,
      data: aircraft
    });
  } catch (err) {
    const status = err?.status === 429 ? 'ratelimited' : 'error';
    const cached = readCache(AIRCRAFT_CACHE_KEY);
    if (cacheMatchesLocation(cached, AIRCRAFT_CACHE_MAX_AGE_MS)) {
      aircraft = cached.data || [];
      aircraftStatus = status === 'ratelimited' ? 'ratelimited' : 'cached';
      aircraftLastUpdate = new Date(cached.ts);
      setFeedState('aircraft', { status: aircraftStatus, attempts: RETRY_DELAYS_MS.length + 1, lastError: err.message, source: 'cache' });
    } else {
      aircraftStatus = status;
      setFeedState('aircraft', { status, attempts: RETRY_DELAYS_MS.length + 1, lastError: err.message, source: 'none' });
    }
  }
}

function normalizeAircraft(list) {
  return list
    .filter(a => a.lat != null && a.lon != null && a.alt_baro !== 'ground')
    .map(a => ({
      icao: a.hex,
      call: (a.flight || '').trim() || String(a.hex || '').toUpperCase(),
      country: a.r || '-',
      lon: a.lon,
      lat: a.lat,
      alt: a.alt_baro != null && a.alt_baro !== 'ground' ? a.alt_baro * 0.3048 : null,
      spd: a.gs != null ? a.gs * 0.514444 : null,
      hdg: a.track ?? a.mag_heading,
      dist: haversine(userLat, userLon, a.lat, a.lon)
    }))
    .sort((a, b) => a.dist - b.dist);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function loadProfileStore() {
  const builtinProfiles = getBuiltinProfiles();
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || '{}');
    const legacy = migrateLegacyProfile();
    const combined = mergeProfiles(builtinProfiles, stored.profiles || [], legacy ? [legacy] : []);
    const selected = combined.some(p => p.id === stored.selectedProfileId)
      ? stored.selectedProfileId
      : combined[0].id;
    const result = { profiles: combined, selectedProfileId: selected };
    persistProfileStore(result);
    return result;
  } catch (_) {
    const fallback = { profiles: builtinProfiles, selectedProfileId: builtinProfiles[0].id };
    persistProfileStore(fallback);
    return fallback;
  }
}

function getBuiltinProfiles() {
  return [normalizeProfile({
    id: 'klima-pan-starter-set',
    builtin: true,
    name: 'Klima Pan Starter Set',
    lengthMm: 495,
    launchMassG: 80,
    diameterMm: 35,
    dragCoefficient: 0.72,
    motorClass: 'B',
    totalImpulseNs: 3.75,
    burnTimeS: 1.0,
    railLengthM: 1,
    descentRateMps: 5.5,
    recoveryRadiusM: 300,
    recoveryBufferMin: 10,
    recommendedMotors: 'B4-4, C6-5, D9-7',
    notes: 'Klima PAN starter set. Default motor assumption: B4-4. Source data: 495 mm length, 35 mm diameter, 80 g weight, parachute recovery.',
    publishedApogeeByClass: { B: 90, C: 260, D: 530 },
    publishedMotorCodesByClass: { B: 'B4-4', C: 'C6-5', D: 'D9-7' }
  })];
}

function migrateLegacyProfile() {
  try {
    const legacyRaw = localStorage.getItem(LEGACY_PROFILE_KEY);
    if (!legacyRaw) return null;
    localStorage.removeItem(LEGACY_PROFILE_KEY);
    return normalizeProfile({
      id: `legacy-${Date.now()}`,
      builtin: false,
      ...JSON.parse(legacyRaw),
      name: (JSON.parse(legacyRaw).name || 'Imported Legacy Profile') + ' (Imported)'
    });
  } catch (_) {
    return null;
  }
}

function mergeProfiles(...groups) {
  const merged = new Map();
  groups.flat().forEach(profile => {
    if (!profile) return;
    const normalized = normalizeProfile(profile);
    const existing = merged.get(normalized.id);
    if (existing?.builtin) {
      return;
    }
    if (normalized.builtin) {
      merged.set(normalized.id, normalized);
      return;
    }
    if (!existing) {
      merged.set(normalized.id, normalized);
    }
  });
  return Array.from(merged.values()).sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function persistProfileStore(store = profileStore) {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(store));
}

function getSelectedProfile() {
  return cloneProfile(
    profileStore.profiles.find(profile => profile.id === selectedProfileId) || profileStore.profiles[0]
  );
}

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function normalizeProfile(raw = {}) {
  const baseSpec = MOTOR_CLASS_SPECS[raw.motorClass] || MOTOR_CLASS_SPECS.C;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : makeProfileId(raw.name),
    builtin: Boolean(raw.builtin),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : 'Rocket Profile',
    lengthMm: clampNumber(raw.lengthMm, 100, 4000, 495),
    launchMassG: clampNumber(raw.launchMassG, 20, 50000, 80),
    diameterMm: clampNumber(raw.diameterMm, 10, 300, 35),
    dragCoefficient: clampNumber(raw.dragCoefficient, 0.2, 1.8, 0.72),
    motorClass: MOTOR_CLASS_SPECS[raw.motorClass] ? raw.motorClass : 'C',
    totalImpulseNs: clampNumber(raw.totalImpulseNs, 0.5, 40000, baseSpec.impulseNs),
    burnTimeS: clampNumber(raw.burnTimeS, 0.2, 20, baseSpec.burnTimeS),
    railLengthM: clampNumber(raw.railLengthM, 0.5, 8, 1),
    descentRateMps: clampNumber(raw.descentRateMps, 1, 25, 5.5),
    recoveryRadiusM: clampNumber(raw.recoveryRadiusM, 50, 5000, 300),
    recoveryBufferMin: clampNumber(raw.recoveryBufferMin, 1, 90, 10),
    recommendedMotors: typeof raw.recommendedMotors === 'string' ? raw.recommendedMotors.trim().slice(0, 80) : '',
    notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 240) : '',
    publishedApogeeByClass: normalizePublishedApogeeMap(raw.publishedApogeeByClass),
    publishedMotorCodesByClass: normalizePublishedMotorCodeMap(raw.publishedMotorCodesByClass)
  };
}

function makeProfileId(name = 'rocket-profile') {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rocket-profile';
  return `${slug}-${Date.now().toString(36)}`;
}

function setupSettingsUI() {
  document.getElementById('settings-open').addEventListener('click', openSettings);
  document.getElementById('rocket-badge').addEventListener('click', openSettings);
  document.getElementById('rocket-badge').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSettings();
    }
  });
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-overlay').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveCurrentProfileFromForm);
  document.getElementById('profile-load').addEventListener('click', loadSelectedProfileFromPicker);
  document.getElementById('profile-duplicate').addEventListener('click', duplicateCurrentProfile);
  document.getElementById('profile-delete').addEventListener('click', deleteSelectedProfile);
  document.getElementById('rp-motor-class').addEventListener('change', applyMotorClassDefaults);
  document.querySelectorAll('#settings-panel input, #settings-panel select, #settings-panel textarea').forEach(el => {
    el.addEventListener('input', updateSettingsDerived);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
  });
  refreshProfileSelect();
  syncSettingsForm();
  updateSettingsDerived();
}

function setupRefreshControls() {
  document.getElementById('rocket-refresh').textContent = `${Math.round(AUTO_REFRESH_MS / 60000)} min`;
  document.getElementById('aircraft-refresh').addEventListener('click', async () => {
    await Promise.allSettled([fetchAircraft(), fetchWeather()]);
    renderAll();
  });
  document.getElementById('factors-list').addEventListener('click', event => {
    const factorEl = event.target.closest('.factor');
    if (!factorEl) return;
    toggleIgnoredFactor(factorEl.dataset.factorId);
  });
}

function refreshProfileSelect() {
  const select = document.getElementById('rp-profile-select');
  select.innerHTML = profileStore.profiles.map(profile => `
    <option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}${profile.builtin ? ' · default' : ''}</option>
  `).join('');
  select.value = selectedProfileId;
  updateProfileActionButtons();
}

function updateProfileActionButtons() {
  const selected = profileStore.profiles.find(profile => profile.id === document.getElementById('rp-profile-select').value);
  const deleteBtn = document.getElementById('profile-delete');
  deleteBtn.disabled = !selected || selected.builtin;
  document.getElementById('profile-status').textContent = selected?.builtin
    ? 'Built-in configs cannot be deleted. Save As New to create your own variant.'
    : 'Saved configs are stored locally in this browser and can be loaded at any time.';
}

function openSettings() {
  refreshProfileSelect();
  syncSettingsForm();
  updateSettingsDerived();
  document.getElementById('settings-overlay').classList.add('open');
  document.getElementById('settings-panel').classList.add('open');
  document.getElementById('settings-panel').setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('settings-panel').setAttribute('aria-hidden', 'true');
}

function syncSettingsForm() {
  rocketProfile = getSelectedProfile();
  const p = rocketProfile;
  document.getElementById('rp-name').value = p.name;
  document.getElementById('rp-length-mm').value = p.lengthMm;
  document.getElementById('rp-mass-g').value = p.launchMassG;
  document.getElementById('rp-diameter-mm').value = p.diameterMm;
  document.getElementById('rp-cd').value = p.dragCoefficient.toFixed(2);
  document.getElementById('rp-rail-length').value = p.railLengthM;
  document.getElementById('rp-recommended').value = p.recommendedMotors;
  document.getElementById('rp-motor-class').value = p.motorClass;
  document.getElementById('rp-impulse-ns').value = p.totalImpulseNs;
  document.getElementById('rp-burn-time').value = p.burnTimeS;
  document.getElementById('rp-descent-rate').value = p.descentRateMps;
  document.getElementById('rp-recovery-radius').value = p.recoveryRadiusM;
  document.getElementById('rp-recovery-buffer').value = p.recoveryBufferMin;
  document.getElementById('rp-notes').value = p.notes;
}

function readProfileFromForm() {
  const current = getSelectedProfile();
  return normalizeProfile({
    id: current.id,
    builtin: current.builtin,
    name: document.getElementById('rp-name').value,
    lengthMm: document.getElementById('rp-length-mm').value,
    launchMassG: document.getElementById('rp-mass-g').value,
    diameterMm: document.getElementById('rp-diameter-mm').value,
    dragCoefficient: document.getElementById('rp-cd').value,
    railLengthM: document.getElementById('rp-rail-length').value,
    recommendedMotors: document.getElementById('rp-recommended').value,
    motorClass: document.getElementById('rp-motor-class').value,
    totalImpulseNs: document.getElementById('rp-impulse-ns').value,
    burnTimeS: document.getElementById('rp-burn-time').value,
    descentRateMps: document.getElementById('rp-descent-rate').value,
    recoveryRadiusM: document.getElementById('rp-recovery-radius').value,
    recoveryBufferMin: document.getElementById('rp-recovery-buffer').value,
    notes: document.getElementById('rp-notes').value
  });
}

function applyMotorClassDefaults() {
  const spec = MOTOR_CLASS_SPECS[document.getElementById('rp-motor-class').value];
  if (!spec) return;
  document.getElementById('rp-impulse-ns').value = spec.impulseNs;
  document.getElementById('rp-burn-time').value = spec.burnTimeS;
  updateSettingsDerived();
}

function updateSettingsDerived() {
  updateProfileActionButtons();
  const model = computeRocketModel(readProfileFromForm());
  document.getElementById('sp-thrust').textContent = `${Math.round(model.avgThrustN)} N`;
  document.getElementById('sp-twr').textContent = `${model.thrustToWeight.toFixed(1)}:1`;
  document.getElementById('sp-rail-exit').textContent = `${model.railExitVelocityMps.toFixed(1)} m/s`;
  document.getElementById('sp-apogee').textContent = `${Math.round(model.apogeeM)} m`;
  document.getElementById('sp-mission').textContent = fmtDuration(model.missionDurationS);
  document.getElementById('sp-safe-wind').textContent = `${Math.round(model.safeWindKph)} km/h`;
  document.getElementById('sp-airspace').textContent =
    `${model.airspaceKeepoutKm.toFixed(1)} km / ${Math.round(model.airspaceCeilingM)} m`;
  document.getElementById('sp-drift').textContent = `${model.driftAtSafeWindKm.toFixed(1)} km`;
}

function saveCurrentProfileFromForm() {
  const draft = readProfileFromForm();
  const idx = profileStore.profiles.findIndex(profile => profile.id === draft.id);
  if (idx >= 0) profileStore.profiles[idx] = draft;
  else profileStore.profiles.push(draft);
  selectedProfileId = draft.id;
  profileStore.selectedProfileId = selectedProfileId;
  profileStore.profiles = mergeProfiles(getBuiltinProfiles(), profileStore.profiles);
  persistProfileStore();
  rocketProfile = getSelectedProfile();
  renderAll();
  refreshProfileSelect();
  syncSettingsForm();
  closeSettings();
}

function loadSelectedProfileFromPicker() {
  const profileId = document.getElementById('rp-profile-select').value;
  if (!profileStore.profiles.some(profile => profile.id === profileId)) return;
  selectedProfileId = profileId;
  profileStore.selectedProfileId = selectedProfileId;
  persistProfileStore();
  rocketProfile = getSelectedProfile();
  syncSettingsForm();
  updateSettingsDerived();
  renderAll();
}

function duplicateCurrentProfile() {
  const draft = readProfileFromForm();
  const duplicated = normalizeProfile({
    ...draft,
    id: makeProfileId(draft.name),
    builtin: false
  });
  profileStore.profiles.push(duplicated);
  selectedProfileId = duplicated.id;
  profileStore.selectedProfileId = selectedProfileId;
  profileStore.profiles = mergeProfiles(getBuiltinProfiles(), profileStore.profiles);
  persistProfileStore();
  refreshProfileSelect();
  syncSettingsForm();
  updateSettingsDerived();
  renderAll();
}

function deleteSelectedProfile() {
  const profileId = document.getElementById('rp-profile-select').value;
  const profile = profileStore.profiles.find(item => item.id === profileId);
  if (!profile || profile.builtin) return;
  profileStore.profiles = profileStore.profiles.filter(item => item.id !== profileId);
  selectedProfileId = profileStore.profiles[0].id;
  profileStore.selectedProfileId = selectedProfileId;
  profileStore.profiles = mergeProfiles(getBuiltinProfiles(), profileStore.profiles);
  persistProfileStore();
  refreshProfileSelect();
  syncSettingsForm();
  updateSettingsDerived();
  renderAll();
}

function computeRocketModel(profile = rocketProfile, weatherSnapshot = weather) {
  const p = normalizeProfile(profile);
  const massKg = p.launchMassG / 1000;
  const radiusM = (p.diameterMm / 1000) / 2;
  const areaM2 = Math.PI * radiusM * radiusM;
  const avgThrustN = p.totalImpulseNs / p.burnTimeS;
  const thrustToWeight = avgThrustN / (massKg * 9.80665);
  const flight = simulateVerticalFlight({
    massKg,
    areaM2,
    dragCoefficient: p.dragCoefficient,
    avgThrustN,
    burnTimeS: p.burnTimeS,
    railLengthM: p.railLengthM
  });
  const publishedApogeeM = p.publishedApogeeByClass?.[p.motorClass] ?? null;
  const effectiveApogeeM = publishedApogeeM ?? flight.apogeeM;

  const descentTimeS = effectiveApogeeM / p.descentRateMps;
  const windExposureS = 0.25 * flight.ascentTimeS + 0.9 * descentTimeS;
  const ballisticCoeff = massKg / Math.max(0.0001, p.dragCoefficient * areaM2);
  const stabilityWindLimitMps = flight.railExitVelocityMps * clamp(0.18 + ballisticCoeff / 5000, 0.18, 0.28);
  const recoveryWindLimitMps = p.recoveryRadiusM / Math.max(1, windExposureS);
  const safeWindMps = Math.max(1.5, Math.min(stabilityWindLimitMps || 0, recoveryWindLimitMps || Infinity));
  const currentWindMps = weatherSnapshot?.current?.wind_speed_10m != null
    ? weatherSnapshot.current.wind_speed_10m / 3.6
    : safeWindMps;
  const currentDriftM = currentWindMps * windExposureS;
  const driftAtSafeWindM = safeWindMps * windExposureS;
  const airspaceKeepoutKm = Math.max(1, (p.recoveryRadiusM + Math.max(150, effectiveApogeeM * 0.35)) / 1000);
  const airspaceCeilingM = effectiveApogeeM + 300;
  const missionDurationS = flight.ascentTimeS + descentTimeS;
  const requiredDaylightS = missionDurationS + p.recoveryBufferMin * 60;
  const visibilityNeedKm = Math.max(2, Math.min(12, effectiveApogeeM / 300));
  const stabilityThresholds = getStabilityThresholds(p);

  return {
    profile: p,
    avgThrustN,
    thrustToWeight,
    railExitVelocityMps: flight.railExitVelocityMps,
    burnoutVelocityMps: flight.burnoutVelocityMps,
    apogeeM: effectiveApogeeM,
    simulatedApogeeM: flight.apogeeM,
    publishedApogeeM,
    apogeeSource: publishedApogeeM != null ? 'published' : 'simulated',
    ascentTimeS: flight.ascentTimeS,
    descentTimeS,
    missionDurationS,
    requiredDaylightS,
    safeWindKph: safeWindMps * 3.6,
    gustLimitKph: safeWindMps * 3.6 * 1.25,
    currentDriftM,
    currentDriftKm: currentDriftM / 1000,
    driftAtSafeWindKm: driftAtSafeWindM / 1000,
    airspaceKeepoutKm,
    airspaceCeilingM,
    visibilityNeedKm,
    stabilityThresholds
  };
}

function simulateVerticalFlight({ massKg, areaM2, dragCoefficient, avgThrustN, burnTimeS, railLengthM }) {
  const g = 9.80665;
  const rho = 1.225;
  const dt = 0.02;
  const maxTimeS = 180;
  let t = 0;
  let h = 0;
  let v = 0;
  let apogeeM = 0;
  let railExitVelocityMps = 0;
  let burnoutVelocityMps = 0;
  let ascentTimeS = burnTimeS;

  for (; t <= maxTimeS; t += dt) {
    const thrustN = t < burnTimeS ? avgThrustN : 0;
    const dragN = 0.5 * rho * dragCoefficient * areaM2 * v * Math.abs(v);
    const accel = (thrustN - dragN) / massKg - g;
    v += accel * dt;
    h = Math.max(0, h + v * dt);
    apogeeM = Math.max(apogeeM, h);

    if (!railExitVelocityMps && h >= railLengthM) railExitVelocityMps = Math.max(v, 0);
    if (!burnoutVelocityMps && t + dt >= burnTimeS) burnoutVelocityMps = Math.max(v, 0);
    if (t > burnTimeS && v <= 0) {
      ascentTimeS = t;
      break;
    }
    if (h === 0 && t > 1 && v <= 0 && thrustN === 0) {
      ascentTimeS = t;
      break;
    }
  }

  if (!railExitVelocityMps) railExitVelocityMps = Math.max(v, 0);
  return { railExitVelocityMps, burnoutVelocityMps, apogeeM, ascentTimeS };
}

function renderAll() {
  rocketProfile = getSelectedProfile();
  rocketModel = computeRocketModel(rocketProfile);
  renderRocketModel();
  if (weather) {
    renderWeather();
    renderWind();
    renderAtmosphere();
    renderDaylight();
  } else {
    renderWeatherEmpty();
  }
  renderAircraft();
  renderStatus();
  renderDataLink();
  document.getElementById('footer-ts').textContent =
    `NeoLabs Rockets · Mission Dashboard · Live refresh ${Math.round(AUTO_REFRESH_MS / 60000)} min · Last render ${new Date().toLocaleTimeString()}`;
}

function renderRocketModel() {
  const model = rocketModel || computeRocketModel();
  document.getElementById('rocket-name').textContent = model.profile.name;
  document.getElementById('rocket-motor-class').textContent = model.profile.motorClass;
  document.getElementById('rocket-mass').textContent = `${Math.round(model.profile.launchMassG)} g`;
  document.getElementById('rocket-apogee').textContent = `${Math.round(model.apogeeM)} m`;
  document.getElementById('fm-apogee').textContent = `${Math.round(model.apogeeM)} m`;
  document.getElementById('fm-apogee-sub').textContent =
    model.apogeeSource === 'published'
      ? `${model.profile.publishedMotorCodesByClass?.[model.profile.motorClass] || model.profile.motorClass} manufacturer value · sim ${Math.round(model.simulatedApogeeM)} m`
      : `${Math.round(model.burnoutVelocityMps)} m/s at burnout · ${model.profile.totalImpulseNs} N·s`;
  document.getElementById('fm-rail').textContent = `${model.railExitVelocityMps.toFixed(1)} m/s`;
  document.getElementById('fm-rail-sub').textContent =
    `T/W ${model.thrustToWeight.toFixed(1)}:1 · avg thrust ${Math.round(model.avgThrustN)} N`;
  document.getElementById('fm-wind').textContent = `${Math.round(model.safeWindKph)} km/h`;
  document.getElementById('fm-wind-sub').textContent =
    `gust ceiling ${Math.round(model.gustLimitKph)} km/h · drift ${model.driftAtSafeWindKm.toFixed(1)} km`;
  document.getElementById('fm-airspace').textContent = `${model.airspaceKeepoutKm.toFixed(1)} km`;
  document.getElementById('fm-airspace-sub').textContent =
    `clear below ${Math.round(model.airspaceCeilingM)} m AGL`;
  document.getElementById('fm-duration').textContent = fmtDuration(model.missionDurationS);
  document.getElementById('fm-duration-sub').textContent =
    `needs ${fmtDuration(model.requiredDaylightS)} daylight incl. recovery`;
}

function renderWeather() {
  const c = weather.current;
  const wx = wmoInfo(c.weather_code);
  document.getElementById('wx-icon').textContent = wx.icon;
  document.getElementById('wx-temp').textContent = Math.round(c.temperature_2m);
  document.getElementById('wx-desc').textContent = weatherStatus === 'ok'
    ? wx.label
    : `${wx.label} (cached ${fmtAge(weatherLastUpdate)})`;
  document.getElementById('wx-cloud').textContent = `${c.cloud_cover}%`;
  document.getElementById('wx-precip').textContent = c.precipitation > 0 ? `${c.precipitation} mm` : 'None';
  document.getElementById('wx-vis').textContent = visFromCode(c.weather_code);

  let uv = '—';
  if (weather.hourly?.uv_index) {
    const now = new Date();
    const hrs = weather.hourly.time.map(t => new Date(t));
    let best = 0;
    hrs.forEach((t, i) => {
      if (Math.abs(t - now) < Math.abs(hrs[best] - now)) best = i;
    });
    uv = weather.hourly.uv_index[best].toFixed(1);
  }
  document.getElementById('wx-uv').textContent = uv;
}

function renderWeatherEmpty() {
  const ids = ['wx-icon', 'wx-temp', 'wx-desc', 'wx-cloud', 'wx-precip', 'wx-vis', 'wx-uv',
    'wind-speed', 'wind-gust', 'wind-deg', 'wind-from', 'hum-val', 'dewpoint', 'pres-val',
    'pres-sub', 'sunrise', 'sunset', 'moon-phase', 'daylight-left', 'day-sub'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '—';
  });
  document.getElementById('moon-icon').textContent = '🌑';
  document.getElementById('hum-bar').style.width = '0%';
  document.getElementById('day-bar').style.width = '0%';
}

function renderWind() {
  const c = weather.current;
  document.getElementById('wind-speed').textContent = Math.round(c.wind_speed_10m);
  document.getElementById('wind-gust').textContent = Math.round(c.wind_gusts_10m);
  document.getElementById('wind-deg').textContent = Math.round(c.wind_direction_10m);
  document.getElementById('wind-from').textContent = 'FROM ' + degToCompass(c.wind_direction_10m);
  document.getElementById('wind-arrow').setAttribute('transform', `rotate(${c.wind_direction_10m},65,65)`);
}

function renderAtmosphere() {
  const c = weather.current;
  const hum = c.relative_humidity_2m;
  document.getElementById('hum-val').textContent = hum;
  document.getElementById('hum-bar').style.width = `${hum}%`;
  const T = c.temperature_2m;
  const gamma = Math.log(hum / 100) + (17.62 * T) / (243.12 + T);
  const dp = Math.round((243.12 * gamma) / (17.62 - gamma));
  document.getElementById('dewpoint').textContent = dp;

  const pres = Math.round(c.surface_pressure);
  document.getElementById('pres-val').textContent = pres;
  document.getElementById('pres-sub').textContent =
    pres > 1013 ? 'Above standard' : pres < 1013 ? 'Below standard' : 'Standard (1013 hPa)';
}

function parseApiTimeAsLocal(str) {
  const m = str.match(/T(\d{2}):(\d{2})/);
  if (!m) return new Date(str);
  const d = new Date();
  d.setHours(+m[1], +m[2], 0, 0);
  return d;
}

function getDaylightWindow() {
  if (!weather?.daily?.sunrise?.[0] || !weather?.daily?.sunset?.[0]) return null;
  const sunrise = parseApiTimeAsLocal(weather.daily.sunrise[0]);
  const sunset = parseApiTimeAsLocal(weather.daily.sunset[0]);
  const now = new Date();
  return {
    sunrise,
    sunset,
    now,
    totalMs: sunset - sunrise,
    leftMs: Math.max(0, sunset - now),
    isDaytime: now >= sunrise && now <= sunset
  };
}

function renderDaylight() {
  const daylight = getDaylightWindow();
  if (!daylight) return;
  const { sunrise, sunset, now, totalMs, leftMs, isDaytime } = daylight;
  document.getElementById('sunrise').textContent = fmtTime(sunrise);
  document.getElementById('sunset').textContent = fmtTime(sunset);

  const elapsed = now - sunrise;
  const pct = Math.max(0, Math.min(1, elapsed / totalMs));
  document.getElementById('day-bar').style.width = `${pct * 100}%`;

  if (isDaytime) {
    const leftH = Math.floor(leftMs / 3600000);
    const leftM = Math.floor((leftMs % 3600000) / 60000);
    document.getElementById('daylight-left').textContent = `${leftH}h ${leftM}m`;
    document.getElementById('day-sub').textContent = `of ${Math.round(totalMs / 3600000)}h total daylight`;
  } else {
    const nextSr = now < sunrise ? sunrise : new Date(sunrise.getTime() + 86400000);
    const toSr = nextSr - now;
    const dawnH = Math.floor(toSr / 3600000);
    const dawnM = Math.floor((toSr % 3600000) / 60000);
    document.getElementById('daylight-left').textContent = `Dawn in ${dawnH}h ${dawnM}m`;
    document.getElementById('day-sub').textContent = `${Math.round(totalMs / 3600000)}h daylight today`;
  }

  const moon = moonPhase();
  document.getElementById('moon-icon').textContent = moon.icon;
  document.getElementById('moon-phase').textContent = moon.name;
}

function renderAircraft() {
  const keepoutKm = (rocketModel || computeRocketModel()).airspaceKeepoutKm;
  const count = aircraft.length;
  const nearby = aircraft.filter(a => a.dist < keepoutKm).length;
  const badge = document.getElementById('ac-badge');
  const countEl = document.getElementById('ac-count');
  const wrap = document.getElementById('ac-table-wrap');

  let statusTxt = '';
  if (aircraftStatus === 'ratelimited') statusTxt = 'Airspace feed rate-limited | ';
  else if (aircraftStatus === 'cached') statusTxt = `Airspace cached ${fmtAge(aircraftLastUpdate)} | `;
  else if (aircraftStatus === 'error') statusTxt = 'Airspace data unavailable | ';

  const updTxt = aircraftLastUpdate
    ? `Updated ${aircraftLastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : (aircraftStatus === 'init' ? 'Loading…' : 'No data yet');
  countEl.textContent = statusTxt + (count
    ? `${count} aircraft · closest ${aircraft[0].dist.toFixed(1)} km · corridor ${keepoutKm.toFixed(1)} km`
    : updTxt);

  badge.textContent = nearby > 0 ? `${nearby} IN CORRIDOR` : 'AIRSPACE CLEAR';
  badge.className = 'ac-badge ' + (nearby > 0 ? 'busy' : 'clear');

  if (aircraftStatus === 'error' && !count) {
    wrap.innerHTML = '<div class="empty-state" style="color:var(--amber)">Could not reach the aircraft feed — check connection or tap Refresh</div>';
    return;
  }
  if (!count) {
    wrap.innerHTML = '<div class="empty-state">No airborne aircraft detected in range</div>';
    return;
  }

  const top = aircraft.slice(0, 10);
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>Callsign</th><th>Country</th>
        <th>Distance</th><th>Altitude</th>
        <th>Speed</th><th>Heading</th>
      </tr></thead>
      <tbody>
        ${top.map(a => `<tr>
          <td class="ac-call">${escapeHtml(a.call)}</td>
          <td style="color:var(--muted)">${escapeHtml(a.country)}</td>
          <td class="${a.dist < keepoutKm ? 'ac-dist-close' : 'ac-dist-far'}">${a.dist.toFixed(1)} km</td>
          <td>${a.alt != null ? Math.round(a.alt) + ' m / ' + Math.round(a.alt * 3.28083) + 'ft' : '—'}</td>
          <td>${a.spd != null ? Math.round(a.spd * 3.6) + ' km/h' : '—'}</td>
          <td>${a.hdg != null ? Math.round(a.hdg) + '° ' + degToCompass(a.hdg) : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderStatus() {
  const model = rocketModel || computeRocketModel();
  const stability = evaluateStability(model);
  const factors = [{
    id: 'guide-exit',
    n: 'Guide Exit',
    v: `${model.railExitVelocityMps.toFixed(1)} m/s · T/W ${model.thrustToWeight.toFixed(1)}:1`,
    s: stability.status
  }];

  if (weather) {
    const c = weather.current;
    const feedPenalty = weatherStatus === 'ok' ? 'go' : 'marginal';
    const daylight = getDaylightWindow();
    const wx = evaluateWeatherWindow(c, model);
    factors.push({
      id: 'safe-wind',
      n: 'Safe Wind',
      v: `${Math.round(c.wind_speed_10m)} / ${Math.round(model.safeWindKph)} km/h`,
      s: worseStatus(compareMetric(c.wind_speed_10m, model.safeWindKph, 1.15), feedPenalty)
    });
    factors.push({
      id: 'gust-margin',
      n: 'Gust Margin',
      v: `${Math.round(c.wind_gusts_10m)} / ${Math.round(model.gustLimitKph)} km/h`,
      s: worseStatus(compareMetric(c.wind_gusts_10m, model.gustLimitKph, 1.1), feedPenalty)
    });
    factors.push({
      id: 'recovery-drift',
      n: 'Recovery Drift',
      v: `${model.currentDriftKm.toFixed(1)} / ${(model.profile.recoveryRadiusM / 1000).toFixed(1)} km`,
      s: worseStatus(compareMetric(model.currentDriftM, model.profile.recoveryRadiusM, 1.15), feedPenalty)
    });
    factors.push({
      id: 'weather-window',
      n: 'Weather Window',
      v: wx.value,
      s: worseStatus(wx.status, feedPenalty)
    });
    factors.push({
      id: 'daylight-window',
      n: 'Daylight Window',
      v: daylight?.isDaytime
        ? `${fmtDuration(daylight.leftMs / 1000)} left · need ${fmtDuration(model.requiredDaylightS)}`
        : `Need ${fmtDuration(model.requiredDaylightS)} of daylight`,
      s: worseStatus(!daylight ? 'marginal'
        : !daylight.isDaytime ? 'nogo'
        : daylight.leftMs / 1000 >= model.requiredDaylightS ? 'go'
        : daylight.leftMs / 1000 >= model.missionDurationS ? 'marginal'
        : 'nogo', feedPenalty)
    });
  } else {
    factors.push({ id: 'weather-window', n: 'Weather Window', v: 'Waiting for forecast', s: 'marginal' });
  }

  const airspace = evaluateAirspace(model);
  factors.push({ id: 'airspace-corridor', n: 'Airspace Corridor', v: airspace.value, s: airspace.status });

  const activeFactors = factors.filter(f => !ignoredFactors.has(f.id));
  const worst = activeFactors.reduce((w, f) =>
    f.s === 'nogo' ? 'nogo' : f.s === 'marginal' && w !== 'nogo' ? 'marginal' : w, 'go');

  const badge = document.getElementById('go-badge');
  const label = document.getElementById('go-label');
  badge.className = 'go-badge ' + worst;
  label.textContent = activeFactors.length === 0
    ? 'OVERRIDE'
    : worst === 'go' ? 'GO' : worst === 'marginal' ? 'HOLD' : 'NO-GO';

  document.getElementById('factors-list').innerHTML = factors.map(f => `
    <div class="factor ${ignoredFactors.has(f.id) ? 'ignored' : ''}" data-factor-id="${escapeHtml(f.id)}" title="${ignoredFactors.has(f.id) ? 'Click to restore this factor' : 'Click to ignore this factor temporarily'}">
      <span class="factor-name">${escapeHtml(f.n)}</span>
      <span class="factor-val">${escapeHtml(f.v)}</span>
      <span class="chip ${ignoredFactors.has(f.id) ? 'ignored' : f.s}">${ignoredFactors.has(f.id) ? 'IGNORED' : f.s === 'go' ? 'GO' : f.s === 'marginal' ? 'HOLD' : 'NO-GO'}</span>
    </div>`).join('');
}

function toggleIgnoredFactor(factorId) {
  if (!factorId) return;
  if (ignoredFactors.has(factorId)) ignoredFactors.delete(factorId);
  else ignoredFactors.add(factorId);
  renderStatus();
}

function evaluateAirspace(model) {
  if (aircraftStatus === 'cached' || aircraftStatus === 'ratelimited') {
    return {
      status: 'marginal',
      value: `Using cached airspace ${fmtAge(aircraftLastUpdate)}`
    };
  }
  if (aircraftStatus !== 'ok') {
    return { status: 'marginal', value: `Need fresh ${model.airspaceKeepoutKm.toFixed(1)} km clear corridor` };
  }
  const immediate = aircraft.filter(a =>
    a.dist <= model.airspaceKeepoutKm &&
    (a.alt == null || a.alt <= model.airspaceCeilingM + 300)
  );
  const caution = aircraft.filter(a =>
    a.dist <= model.airspaceKeepoutKm * 1.5 &&
    (a.alt == null || a.alt <= model.airspaceCeilingM + 900)
  );

  if (immediate.length) {
    return {
      status: 'nogo',
      value: `${immediate[0].call} at ${immediate[0].dist.toFixed(1)} km`
    };
  }
  if (caution.length) {
    return {
      status: 'marginal',
      value: `${caution.length} aircraft near ${model.airspaceKeepoutKm.toFixed(1)} km corridor`
    };
  }
  return {
    status: 'go',
    value: `${model.airspaceKeepoutKm.toFixed(1)} km clear below ${Math.round(model.airspaceCeilingM)} m`
  };
}

function evaluateWeatherWindow(current, model) {
  const code = current.weather_code;
  const precip = current.precipitation;
  const cloud = current.cloud_cover;
  const visibilityKm = visibilityKmFromCodeValue(code);
  const wx = wmoInfo(code);
  let status = 'go';

  if (precip > 0) status = 'nogo';
  if ([45,48,61,63,65,71,73,75,77,80,81,82,85,86,95,96,99].includes(code)) status = 'nogo';
  else if (code >= 2) status = worseStatus(status, 'marginal');
  if (visibilityKm < model.visibilityNeedKm) status = 'nogo';
  else if (visibilityKm < model.visibilityNeedKm * 1.25) status = worseStatus(status, 'marginal');
  if (cloud > 90 && model.apogeeM > 700) status = 'nogo';
  else if (cloud > 75 && model.apogeeM > 500) status = worseStatus(status, 'marginal');

  return {
    status,
    value: `${wx.label} · ${visibilityKm.toFixed(1)} km vis · ${cloud}% cloud`
  };
}

function getStabilityThresholds(profile) {
  const mass = profile.launchMassG;
  const diameter = profile.diameterMm;

  if (mass <= 150 && diameter <= 40) {
    return { goSpeedMps: 8.5, holdSpeedMps: 7, goTwr: 4, holdTwr: 3, label: 'micro/light model' };
  }
  if (mass <= 500 && diameter <= 60) {
    return { goSpeedMps: 14, holdSpeedMps: 11, goTwr: 3, holdTwr: 2.5, label: 'small sport rocket' };
  }
  if (mass <= 1500 && diameter <= 90) {
    return { goSpeedMps: 18, holdSpeedMps: 14, goTwr: 3, holdTwr: 2.2, label: 'mid-size rocket' };
  }
  return { goSpeedMps: 24, holdSpeedMps: 18, goTwr: 3, holdTwr: 2, label: 'large rocket' };
}

function evaluateStability(model) {
  const t = model.stabilityThresholds;
  const speed = model.railExitVelocityMps;
  const twr = model.thrustToWeight;

  if (speed >= t.goSpeedMps && twr >= t.goTwr) {
    return { status: 'go', reason: `${t.label} threshold` };
  }
  if (speed >= t.holdSpeedMps && twr >= t.holdTwr) {
    return { status: 'marginal', reason: `${t.label} threshold` };
  }
  return { status: 'nogo', reason: `${t.label} threshold` };
}

function compareMetric(actual, limit, marginalFactor) {
  if (actual <= limit) return 'go';
  if (actual <= limit * marginalFactor) return 'marginal';
  return 'nogo';
}

function worseStatus(a, b) {
  const rank = { go: 0, marginal: 1, nogo: 2 };
  return rank[b] > rank[a] ? b : a;
}

function visibilityKmFromCodeValue(code) {
  if ([45,48].includes(code)) return 0.8;
  if ([95,96,99].includes(code)) return 1.5;
  if ([51,53,55,61,63,65,71,73,75,77,80,81,82,85,86].includes(code)) return 3;
  if (code === 0) return 24;
  if (code === 1) return 18;
  if (code === 2) return 12;
  if (code === 3) return 8;
  return 5;
}

function degToCompass(d) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(d / 22.5) % 16];
}

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(totalSeconds) {
  const secs = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function wmoInfo(code) {
  const m = {
    0: { icon: '☀️', label: 'Clear sky' },
    1: { icon: '🌤️', label: 'Mainly clear' },
    2: { icon: '⛅', label: 'Partly cloudy' },
    3: { icon: '☁️', label: 'Overcast' },
    45: { icon: '🌫️', label: 'Foggy' }, 48: { icon: '🌫️', label: 'Icy fog' },
    51: { icon: '🌦️', label: 'Light drizzle' }, 53: { icon: '🌦️', label: 'Drizzle' }, 55: { icon: '🌧️', label: 'Heavy drizzle' },
    61: { icon: '🌧️', label: 'Light rain' }, 63: { icon: '🌧️', label: 'Rain' }, 65: { icon: '🌧️', label: 'Heavy rain' },
    71: { icon: '🌨️', label: 'Light snow' }, 73: { icon: '❄️', label: 'Snow' }, 75: { icon: '❄️', label: 'Heavy snow' },
    77: { icon: '🌨️', label: 'Snow grains' },
    80: { icon: '🌦️', label: 'Showers' }, 81: { icon: '🌧️', label: 'Heavy showers' }, 82: { icon: '⛈️', label: 'Violent showers' },
    85: { icon: '🌨️', label: 'Snow showers' }, 86: { icon: '❄️', label: 'Heavy snow showers' },
    95: { icon: '⛈️', label: 'Thunderstorm' }, 96: { icon: '⛈️', label: 'Thunderstorm + hail' }, 99: { icon: '⛈️', label: 'Thunderstorm + hail' }
  };
  return m[code] || { icon: '🌡️', label: 'Unknown' };
}

function visFromCode(code) {
  if ([45,48].includes(code)) return '< 1 km';
  if ([51,53,55,61,63,65,71,73,75,80,81,82].includes(code)) return '1–5 km';
  if ([95,96,99].includes(code)) return '< 2 km';
  if (code <= 1) return '> 20 km';
  if (code <= 3) return '5–20 km';
  return '—';
}

function moonPhase() {
  const known = new Date('2000-01-06T18:14:00Z');
  const days = (Date.now() - known) / 86400000;
  const cycle = 29.53058770576;
  const p = ((days % cycle) + cycle) % cycle;
  if (p < 1.85) return { name: 'New Moon', icon: '🌑' };
  if (p < 7.38) return { name: 'Waxing Crescent', icon: '🌒' };
  if (p < 9.22) return { name: 'First Quarter', icon: '🌓' };
  if (p < 14.77) return { name: 'Waxing Gibbous', icon: '🌔' };
  if (p < 16.61) return { name: 'Full Moon', icon: '🌕' };
  if (p < 22.15) return { name: 'Waning Gibbous', icon: '🌖' };
  if (p < 23.99) return { name: 'Last Quarter', icon: '🌗' };
  return { name: 'Waning Crescent', icon: '🌘' };
}

function drawTicks() {
  const g = document.getElementById('ticks');
  for (let i = 0; i < 36; i++) {
    const ang = (i * 10) * Math.PI / 180;
    const major = i % 9 === 0;
    const r1 = major ? 55 : 58;
    const r2 = 62;
    const x1 = 65 + r1 * Math.sin(ang);
    const y1 = 65 - r1 * Math.cos(ang);
    const x2 = 65 + r2 * Math.sin(ang);
    const y2 = 65 - r2 * Math.cos(ang);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', major ? '#2a4060' : '#1b2746');
    line.setAttribute('stroke-width', major ? '1.5' : '0.8');
    g.appendChild(line);
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizePublishedApogeeMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  Object.entries(raw).forEach(([key, value]) => {
    const n = Number(value);
    if (MOTOR_CLASS_SPECS[key] && Number.isFinite(n) && n > 0) out[key] = n;
  });
  return Object.keys(out).length ? out : null;
}

function normalizePublishedMotorCodeMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  Object.entries(raw).forEach(([key, value]) => {
    if (MOTOR_CLASS_SPECS[key] && typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 24);
  });
  return Object.keys(out).length ? out : null;
}
