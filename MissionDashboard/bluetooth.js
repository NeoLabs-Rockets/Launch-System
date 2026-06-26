const BLE_SERVICE_UUID = '8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_COMMAND_UUID = '8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_STATUS_UUID = '8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_SESSION = makeSessionId();
const LAUNCH_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-launch')
  : null;

let launchMode = localStorage.getItem('neolabs.launch.mode') || 'ble';
let launchCodeMemory = '';
let launchCountdownMode = null;
let launchCountdownTimer = null;
let launchHeartbeatTimer = null;
let launchCountdownEndsAt = 0;
let launchCountdownActive = false;

let bleDevice = null;
let bleServer = null;
let bleCommand = null;
let bleStatus = null;
let bleConnected = false;
let bleStatusData = null;
let bleLastStatusAt = 0;

let wifiBase = localStorage.getItem('neolabs.launch.wifiBase') || 'http://192.168.4.1';
let wifiConnected = false;
let wifiStatusData = null;
let wifiPollTimer = null;
let wifiMisses = 0;
let wifiLastOkAt = 0;

if (!['ble', 'wifi'].includes(launchMode)) launchMode = 'ble';

window.addEventListener('DOMContentLoaded', () => {
  bindLaunchUi();
  renderLaunch();
  setInterval(checkLaunchLinkHealth, 1000);
});

function bindLaunchUi() {
  const wifiHost = document.getElementById('wifi-host');
  wifiHost.value = wifiBase;
  wifiHost.addEventListener('change', () => {
    wifiBase = normaliseWifiBase(wifiHost.value);
    wifiHost.value = wifiBase;
    localStorage.setItem('neolabs.launch.wifiBase', wifiBase);
  });

  document.getElementById('launch-mode-ble').addEventListener('click', () => setLaunchMode('ble'));
  document.getElementById('launch-mode-wifi').addEventListener('click', () => setLaunchMode('wifi'));
  document.getElementById('ble-connect').addEventListener('click', connectBle);
  document.getElementById('wifi-connect').addEventListener('click', connectWifi);
  document.getElementById('ble-disconnect').addEventListener('click', disconnectActiveLink);
  document.getElementById('ble-arm').addEventListener('click', armLaunch);
  document.getElementById('ble-disarm').addEventListener('click', disarmLaunch);
  document.getElementById('ble-launch').addEventListener('click', startLaunchCountdown);
  document.getElementById('ble-abort').addEventListener('click', abortLaunchCountdown);
  document.querySelectorAll('.ble-check,#ble-code').forEach(el => el.addEventListener('input', renderLaunch));
}

function setLaunchMode(mode) {
  if (launchCountdownActive) {
    setLaunchState('Abort the active countdown before switching links', 'warn');
    return;
  }
  launchMode = mode;
  localStorage.setItem('neolabs.launch.mode', launchMode);
  setLaunchState(mode === 'ble' ? 'Bluetooth mode selected' : 'WiFi AP mode selected', 'warn');
  renderLaunch();
}

async function connectBle() {
  if (!hasBluetooth()) {
    setLaunchState('Web Bluetooth is not available in this browser', 'bad');
    return;
  }
  setLaunchState('Selecting BLE device...', 'warn');
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'NeoLabs' }],
      optionalServices: [BLE_SERVICE_UUID]
    });
    bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);
    bleServer = await bleDevice.gatt.connect();
    const service = await bleServer.getPrimaryService(BLE_SERVICE_UUID);
    bleCommand = await service.getCharacteristic(BLE_COMMAND_UUID);
    bleStatus = await service.getCharacteristic(BLE_STATUS_UUID);
    bleStatus.addEventListener('characteristicvaluechanged', event => {
      const text = new TextDecoder().decode(event.target.value);
      try { applyBleStatus(JSON.parse(text)); } catch (_) {}
    });
    await bleStatus.startNotifications();
    bleConnected = true;
    bleLastStatusAt = Date.now();
    await sendBle({ cmd: 'status' });
    setLaunchState(`Connected to ${bleDevice.name || 'ESP32'}`, 'ok');
  } catch (err) {
    setLaunchState(`BLE connect failed: ${err.message || err}`, 'bad');
    bleConnected = false;
  }
  renderLaunch();
}

function disconnectActiveLink() {
  if (launchMode === 'wifi') {
    wifiConnected = false;
    wifiMisses = 0;
    stopWifiPoll();
    clearLaunchCredential();
    setLaunchState('WiFi link forgotten', 'warn');
    renderLaunch();
    return;
  }
  disconnectBle();
}

async function disconnectBle() {
  if (launchCountdownActive) await abortLaunchCountdown();
  try { bleDevice?.gatt?.disconnect(); } catch (_) {}
  onBleDisconnected();
}

function onBleDisconnected() {
  bleConnected = false;
  bleCommand = null;
  bleStatus = null;
  stopLaunchHeartbeat();
  if (launchCountdownMode === 'ble' || launchMode === 'ble') {
    stopLaunchCountdownUi('Disconnected');
    broadcastLaunch({ type: 'abort', reason: 'BLE disconnected', mode: 'ble' });
    clearLaunchCredential();
    setLaunchState('BLE disconnected - ESP32 should abort/disarm', 'bad');
  }
  renderLaunch();
}

async function connectWifi() {
  const input = document.getElementById('wifi-host');
  wifiBase = normaliseWifiBase(input.value);
  input.value = wifiBase;
  localStorage.setItem('neolabs.launch.wifiBase', wifiBase);
  setLaunchState('Checking WiFi AP...', 'warn');
  try {
    const status = await fetchWifi('/api/status', {}, 1200);
    wifiConnected = true;
    wifiMisses = 0;
    wifiLastOkAt = Date.now();
    applyWifiStatus(status);
    startWifiPoll();
    setLaunchState(`WiFi linked at ${wifiBase}`, 'ok');
  } catch (err) {
    wifiConnected = false;
    setLaunchState(`WiFi check failed: ${err.message || err}`, 'bad');
    renderLaunch();
  }
}

async function armLaunch() {
  if (!allLaunchChecks()) {
    setLaunchState('Complete safety checklist before arming', 'warn');
    return;
  }
  const code = getVisibleCode();
  if (!isValidCode(code)) {
    setLaunchState('Enter the 6-digit arming code', 'warn');
    return;
  }
  try {
    if (launchMode === 'ble') {
      await sendBle({ cmd: 'arm', code });
    } else {
      await fetchWifi(`/api/arm?code=${encodeURIComponent(code)}`, { method: 'POST' }, 1800);
      await refreshWifiStatus();
    }
    launchCodeMemory = code;
    document.getElementById('ble-code').value = '';
    setLaunchState('Arm command accepted', 'warn');
  } catch (err) {
    clearLaunchCredential();
    setLaunchState(`Arm failed: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function disarmLaunch() {
  try {
    if (launchMode === 'ble') {
      await sendBle({ cmd: 'disarm' });
    } else {
      await fetchWifi('/api/disarm', { method: 'POST' }, 1600);
      await refreshWifiStatus();
    }
    stopLaunchHeartbeat();
    stopLaunchCountdownUi('Disarmed');
    clearLaunchCredential();
    broadcastLaunch({ type: 'abort', reason: 'Disarmed', mode: launchMode });
    setLaunchState('Controller disarmed', 'ok');
  } catch (err) {
    setLaunchState(`Disarm failed: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function startLaunchCountdown() {
  const seconds = clamp(Number(document.getElementById('ble-count-seconds').value), 5, 60);
  const code = getCommandCode();
  if (!code) {
    setLaunchState('Re-enter the 6-digit code before countdown', 'warn');
    return;
  }
  try {
    if (launchMode === 'ble') {
      await sendBle({ cmd: 'countdown_start', seconds, code });
    } else {
      await fetchWifi('/api/countdown/start', { method: 'POST' }, 1600);
      await refreshWifiStatus();
    }
    launchCountdownMode = launchMode;
    launchCountdownEndsAt = Date.now() + seconds * 1000;
    launchCountdownActive = true;
    launchCodeMemory = code;
    broadcastLaunch({ type: 'countdown_start', seconds, endsAt: launchCountdownEndsAt, mode: launchCountdownMode });
    startLaunchHeartbeat();
    runLaunchCountdownTick();
    clearInterval(launchCountdownTimer);
    launchCountdownTimer = setInterval(runLaunchCountdownTick, 200);
    setLaunchState('Launch countdown active', 'bad');
  } catch (err) {
    setLaunchState(`Countdown rejected: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function runLaunchCountdownTick() {
  if (!launchCountdownActive) return;
  const left = Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000));
  broadcastLaunch({ type: 'countdown_tick', left, endsAt: launchCountdownEndsAt, mode: launchCountdownMode });
  document.getElementById('ble-countdown').textContent = left > 0 ? `T-${left}` : 'Ignition';
  document.getElementById('ble-countdown-sub').textContent = 'Heartbeat active';
  if (left <= 0) {
    const mode = launchCountdownMode;
    stopLaunchHeartbeat();
    stopLaunchCountdownUi('Trigger command sent');
    broadcastLaunch({ type: 'ignition', mode });
    try {
      if (mode === 'ble') {
        await sendBle({ cmd: 'trigger', code: launchCodeMemory });
      } else {
        await fetchWifi('/api/trigger', { method: 'POST' }, 2200);
        await refreshWifiStatus();
      }
      clearLaunchCredential();
    } catch (err) {
      setLaunchState(`Trigger rejected: ${err.message || err}`, 'bad');
    }
  }
}

function startLaunchHeartbeat() {
  stopLaunchHeartbeat();
  launchHeartbeatTimer = setInterval(() => {
    if (launchCountdownMode === 'ble') {
      sendBle({ cmd: 'heartbeat' }).catch(() => onBleDisconnected());
      return;
    }
    fetchWifi('/api/countdown/heartbeat', { method: 'POST' }, 1200)
      .then(() => {
        wifiConnected = true;
        wifiMisses = 0;
        wifiLastOkAt = Date.now();
        renderLaunch();
      })
      .catch(() => onWifiCountdownLinkLost());
  }, 750);
}

function stopLaunchHeartbeat() {
  clearInterval(launchHeartbeatTimer);
  launchHeartbeatTimer = null;
}

async function abortLaunchCountdown() {
  const mode = launchCountdownMode || launchMode;
  stopLaunchHeartbeat();
  stopLaunchCountdownUi('Aborted');
  broadcastLaunch({ type: 'abort', reason: 'Manual abort', mode });
  clearLaunchCredential();
  try {
    if (mode === 'ble' && bleConnected && bleCommand) {
      await sendBle({ cmd: 'abort' });
    } else if (mode === 'wifi' && wifiConnected) {
      await fetchWifi('/api/countdown/abort', { method: 'POST' }, 1500);
      await refreshWifiStatus();
    }
  } catch (_) {}
  renderLaunch();
}

function stopLaunchCountdownUi(reason) {
  clearInterval(launchCountdownTimer);
  launchCountdownTimer = null;
  launchCountdownActive = false;
  launchCountdownMode = null;
  document.getElementById('ble-countdown').textContent = 'Idle';
  document.getElementById('ble-countdown-sub').textContent = reason || 'No active sequence';
}

async function sendBle(payload) {
  if (!bleCommand) throw new Error('BLE not connected');
  const body = JSON.stringify({ ...payload, sid: BLE_SESSION, seq: Date.now() });
  await bleCommand.writeValueWithResponse(new TextEncoder().encode(body));
}

function applyBleStatus(s) {
  bleLastStatusAt = Date.now();
  bleStatusData = {
    armed: !!s.a,
    trigger: !!s.f,
    countdown: !!s.c,
    locked: !!s.l,
    attemptsLeft: s.left,
    clients: s.n || 0,
    uptime: s.u || 0,
    error: s.e || ''
  };
  if (!bleStatusData.armed && launchMode === 'ble') launchCodeMemory = '';
  if (!bleStatusData.countdown && launchCountdownActive && launchCountdownMode === 'ble') {
    stopLaunchCountdownUi('Device stopped countdown');
  }
  if (bleStatusData.error && launchMode === 'ble') setLaunchState(`BLE: ${bleStatusData.error}`, 'warn');
  renderLaunch();
}

async function refreshWifiStatus() {
  if (!wifiConnected) return;
  const status = await fetchWifi('/api/status', {}, 1200);
  wifiMisses = 0;
  wifiLastOkAt = Date.now();
  applyWifiStatus(status);
}

function applyWifiStatus(s) {
  wifiStatusData = {
    armed: !!s.armed,
    trigger: !!s.trigger_active,
    countdown: !!s.countdown_active,
    locked: !!s.locked,
    attemptsLeft: s.attempts_left,
    clients: s.clients ?? 0,
    uptime: s.uptime_ms || 0
  };
  if (!wifiStatusData.armed && launchMode === 'wifi') launchCodeMemory = '';
  if (!wifiStatusData.countdown && launchCountdownActive && launchCountdownMode === 'wifi') {
    stopLaunchCountdownUi('Device stopped countdown');
  }
  renderLaunch();
}

function startWifiPoll() {
  stopWifiPoll();
  wifiPollTimer = setInterval(() => {
    fetchWifi('/api/status', {}, 1200)
      .then(status => {
        wifiConnected = true;
        wifiMisses = 0;
        wifiLastOkAt = Date.now();
        applyWifiStatus(status);
        if (launchMode === 'wifi') setLaunchState(`WiFi linked at ${wifiBase}`, 'ok');
      })
      .catch(() => {
        wifiMisses++;
        if (launchCountdownMode === 'wifi') onWifiCountdownLinkLost();
        if (wifiMisses >= 2 && launchMode === 'wifi') {
          setLaunchState(`WiFi link stale, retrying (${wifiMisses})`, 'warn');
        }
        if (wifiMisses >= 4) wifiConnected = false;
        renderLaunch();
      });
  }, wifiMisses > 0 ? 650 : 1000);
}

function stopWifiPoll() {
  clearInterval(wifiPollTimer);
  wifiPollTimer = null;
}

function onWifiCountdownLinkLost() {
  stopLaunchHeartbeat();
  stopLaunchCountdownUi('Live WiFi link lost');
  broadcastLaunch({ type: 'abort', reason: 'WiFi link lost', mode: 'wifi' });
  clearLaunchCredential();
  setLaunchState('WiFi link lost - ESP32 countdown heartbeat will fail safe', 'bad');
}

async function fetchWifi(path, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${wifiBase}${path}`, {
      ...options,
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      let message = response.statusText || `HTTP ${response.status}`;
      try {
        const body = await response.json();
        message = body.error || message;
      } catch (_) {}
      throw new Error(message);
    }
    try { return await response.json(); } catch (_) { return {}; }
  } finally {
    clearTimeout(timeout);
  }
}

function renderLaunch() {
  const status = currentStatus();
  const linked = currentLinked();
  const armed = !!status.armed;
  const locked = !!status.locked;
  const checklistReady = allLaunchChecks();
  const credentialReady = hasLaunchCredential();
  const bluetoothSupported = hasBluetooth();
  const card = document.getElementById('launch-ble-card');

  card.className = `card launch-ble-card ${linked ? 'linked' : ''} ${armed ? 'armed' : ''}`;
  document.getElementById('launch-mode-ble').classList.toggle('active', launchMode === 'ble');
  document.getElementById('launch-mode-wifi').classList.toggle('active', launchMode === 'wifi');
  document.getElementById('launch-mode-ble').setAttribute('aria-selected', launchMode === 'ble' ? 'true' : 'false');
  document.getElementById('launch-mode-wifi').setAttribute('aria-selected', launchMode === 'wifi' ? 'true' : 'false');
  document.getElementById('launch-mode-ble').disabled = launchCountdownActive;
  document.getElementById('launch-mode-wifi').disabled = launchCountdownActive;

  document.getElementById('wifi-settings').hidden = launchMode !== 'wifi';
  document.getElementById('ble-connect').hidden = launchMode !== 'ble';
  document.getElementById('wifi-connect').hidden = launchMode !== 'wifi';
  document.getElementById('ble-connect').disabled = linked || !bluetoothSupported;
  document.getElementById('wifi-connect').disabled = linked && wifiMisses === 0;
  const disconnect = document.getElementById('ble-disconnect');
  disconnect.textContent = launchMode === 'wifi' ? 'Forget WiFi' : 'Disconnect';
  disconnect.disabled = !linked;

  document.getElementById('ble-arm').disabled = !linked || armed || locked || !checklistReady || !isValidCode(getVisibleCode());
  document.getElementById('ble-disarm').disabled = !linked || !armed;
  document.getElementById('ble-launch').disabled = !linked || !armed || locked || launchCountdownActive || !credentialReady;
  document.getElementById('ble-abort').disabled = !linked || (!armed && !launchCountdownActive);
  document.getElementById('ble-armed').textContent = armed ? 'Yes' : 'No';
  document.getElementById('ble-clients').textContent = status.clients ?? 0;
  document.getElementById('ble-clients-sub').textContent = launchMode === 'ble'
    ? 'Connected BLE centrals reported by ESP32'
    : 'Devices joined to the ESP32 access point';
  document.getElementById('ble-attempts').textContent = locked ? 'Locked' : status.attemptsLeft ?? '-';

  const badge = document.getElementById('ble-go-badge');
  const label = document.getElementById('ble-go-label');
  badge.className = `go-badge ${!linked ? 'marginal' : locked || armed ? 'nogo' : 'go'}`;
  label.textContent = !linked ? 'LINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  updateLaunchNote(bluetoothSupported);
}

function updateLaunchNote(bluetoothSupported) {
  const note = document.getElementById('ble-note');
  if (launchMode === 'ble' && !bluetoothSupported) {
    note.textContent = 'Web Bluetooth is not available here. Switch to WiFi AP mode, or use Chrome/Edge on localhost or HTTPS.';
    return;
  }
  if (launchMode === 'ble') {
    note.textContent = 'BLE commands are session-owned. Arm, countdown, and trigger include the in-memory code; disconnect during active BLE control forces a safe abort.';
    return;
  }
  const age = wifiLastOkAt ? Math.round((Date.now() - wifiLastOkAt) / 1000) : null;
  note.textContent = wifiConnected
    ? `WiFi AP status is live${age != null ? `, last confirmed ${age}s ago` : ''}. Countdown heartbeat stops the ESP32 if this browser loses the link.`
    : 'Connect to the NeoLabs ESP32 WiFi network, then check http://192.168.4.1. The dashboard retries quickly and keeps the last safe status visible.';
}

function checkLaunchLinkHealth() {
  if (launchMode === 'ble' && bleConnected && bleLastStatusAt && Date.now() - bleLastStatusAt > 3500) {
    setLaunchState('BLE status stale - waiting for ESP32 heartbeat', 'warn');
  }
  if (launchMode === 'wifi' && wifiConnected && wifiLastOkAt && Date.now() - wifiLastOkAt > 3500) {
    setLaunchState('WiFi status stale - retrying', 'warn');
  }
  renderLaunch();
}

function currentStatus() {
  return launchMode === 'ble' ? (bleStatusData || {}) : (wifiStatusData || {});
}

function currentLinked() {
  return launchMode === 'ble' ? bleConnected : wifiConnected;
}

function setLaunchState(text, state) {
  const el = document.getElementById('ble-state');
  el.textContent = text;
  el.style.color = state === 'bad' ? 'var(--red)' : state === 'ok' ? 'var(--green)' : 'var(--amber)';
}

function allLaunchChecks() {
  const checks = [...document.querySelectorAll('.ble-check')];
  return checks.length > 0 && checks.every(c => c.checked);
}

function hasLaunchCredential() {
  return !!launchCodeMemory || isValidCode(getVisibleCode());
}

function getCommandCode() {
  const visible = getVisibleCode();
  if (isValidCode(visible)) {
    launchCodeMemory = visible;
    document.getElementById('ble-code').value = '';
    return visible;
  }
  return launchCodeMemory || '';
}

function getVisibleCode() {
  return document.getElementById('ble-code').value.trim();
}

function clearLaunchCredential() {
  launchCodeMemory = '';
  document.getElementById('ble-code').value = '';
}

function isValidCode(code) {
  return /^\d{6}$/.test(code);
}

function broadcastLaunch(payload) {
  const message = { ...payload, source: 'launch-dashboard', at: Date.now() };
  try { LAUNCH_CHANNEL?.postMessage(message); } catch (_) {}
  try { localStorage.setItem('neolabs.launch.lastEvent', JSON.stringify(message)); } catch (_) {}
}

function normaliseWifiBase(value) {
  const trimmed = String(value || '').trim() || '192.168.4.1';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function hasBluetooth() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

function makeSessionId() {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-');
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
}
