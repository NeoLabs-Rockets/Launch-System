const BLE_SERVICE_UUID = '8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_COMMAND_UUID = '8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_STATUS_UUID = '8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000';
const BLE_SESSION = makeSessionId();
const LAUNCH_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-launch')
  : null;
const BLE_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-ble')
  : null;

let launchCodeMemory = '';
let launchCountdownTimer = null;
let launchHeartbeatTimer = null;
let launchCountdownEndsAt = 0;
let launchCountdownActive = false;
let launchLastSpokenSecond = null;
let launchAudioCtx = null;
let launchSpeechReady = false;

let bleDevice = null;
let bleServer = null;
let bleCommand = null;
let bleStatus = null;
let bleConnected = false;
let bleStatusData = null;
let bleLastStatusAt = 0;
let bleLastKnownName = localStorage.getItem('neolabs.ble.deviceName') || '';
let restoringCountdown = false;

window.addEventListener('DOMContentLoaded', () => {
  restoreActiveLaunch();
  bindBleUi();
  publishPublicApi();
  renderLaunch();
  restoreGrantedBle();
  setInterval(checkLaunchLinkHealth, 1000);
});

function bindBleUi() {
  on('ble-connect', 'click', connectBle);
  on('ble-disconnect', 'click', disconnectBle);
  on('ble-arm', 'click', armLaunch);
  on('ble-disarm', 'click', disarmLaunch);
  on('ble-launch', 'click', startLaunchCountdown);
  on('ble-abort', 'click', abortLaunchCountdown);
  document.querySelectorAll('.ble-check,#ble-code,#ble-count-seconds').forEach(el => {
    el.addEventListener('input', renderLaunch);
  });
}

function publishPublicApi() {
  window.NeoLabsBLE = {
    connect: connectBle,
    disconnect: disconnectBle,
    send: sendBle,
    status: () => bleStatusData || {},
    connected: () => bleConnected,
    deviceName: () => bleDevice?.name || bleLastKnownName || ''
  };
}

async function restoreGrantedBle() {
  if (!hasBluetooth()) {
    setLaunchState('Web Bluetooth unavailable in this browser', 'bad');
    renderLaunch();
    return;
  }
  if (!navigator.bluetooth.getDevices) {
    setLaunchState('Tap Connect BLE to pair the controller', 'warn');
    renderLaunch();
    return;
  }
  try {
    const devices = await navigator.bluetooth.getDevices();
    const candidate = devices.find(d => /^NeoLabs/i.test(d.name || '')) || devices.find(d => d.name === bleLastKnownName);
    if (!candidate) {
      setLaunchState('Tap Connect BLE to pair the controller', 'warn');
      renderLaunch();
      return;
    }
    bleDevice = candidate;
    attachDisconnectListener(candidate);
    setLaunchState(`Previously paired: ${candidate.name || 'ESP32'}. Reconnecting...`, 'warn');
    await connectBleDevice(candidate, { restored: true });
  } catch (err) {
    setLaunchState('Previously paired BLE device not reachable; tap Connect BLE', 'warn');
    renderLaunch();
  }
}

async function connectBle() {
  if (!hasBluetooth()) {
    setLaunchState('Web Bluetooth is not available in this browser', 'bad');
    renderLaunch();
    return;
  }
  setLaunchState('Selecting BLE controller...', 'warn');
  renderLaunch();
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'NeoLabs' }],
      optionalServices: [BLE_SERVICE_UUID]
    });
    await connectBleDevice(device, { restored: false });
  } catch (err) {
    setLaunchState(`BLE connect failed: ${err.message || err}`, 'bad');
    bleConnected = false;
    storeBleState();
    renderLaunch();
  }
}

async function connectBleDevice(device) {
  bleDevice = device;
  bleLastKnownName = device.name || bleLastKnownName || 'NeoLabs ESP32';
  localStorage.setItem('neolabs.ble.deviceName', bleLastKnownName);
  attachDisconnectListener(device);

  bleServer = await device.gatt.connect();
  const service = await bleServer.getPrimaryService(BLE_SERVICE_UUID);
  bleCommand = await service.getCharacteristic(BLE_COMMAND_UUID);
  bleStatus = await service.getCharacteristic(BLE_STATUS_UUID);
  bleStatus.addEventListener('characteristicvaluechanged', onBleStatusChanged);
  await bleStatus.startNotifications();
  bleConnected = true;
  bleLastStatusAt = Date.now();
  setLaunchState(`BLE linked to ${bleLastKnownName}`, 'ok');
  storeBleState();
  renderLaunch();
  await sendBle({ cmd: 'status' });
  resumeRestoredCountdown();
}

function attachDisconnectListener(device) {
  try {
    device.removeEventListener('gattserverdisconnected', onBleDisconnected);
    device.addEventListener('gattserverdisconnected', onBleDisconnected);
  } catch (_) {}
}

function onBleStatusChanged(event) {
  const text = new TextDecoder().decode(event.target.value);
  try { applyBleStatus(JSON.parse(text)); } catch (_) {}
}

async function disconnectBle() {
  if (launchCountdownActive) await abortLaunchCountdown();
  try { bleDevice?.gatt?.disconnect(); } catch (_) {}
  onBleDisconnected();
}

function onBleDisconnected() {
  const wasControllingCountdown = launchCountdownActive;
  bleConnected = false;
  bleServer = null;
  bleCommand = null;
  bleStatus = null;
  stopLaunchHeartbeat();
  if (wasControllingCountdown) {
    persistActiveLaunch();
    setLaunchState('BLE disconnected - trying to hand off countdown', 'warn');
  }
  if (!wasControllingCountdown) setLaunchState('BLE disconnected. Reconnect before launch.', 'bad');
  storeBleState();
  renderLaunch();
}

async function armLaunch() {
  if (!allLaunchChecks()) {
    setLaunchState('Complete the safety checklist before arming', 'warn');
    return;
  }
  const code = getVisibleCode();
  if (!isValidCode(code)) {
    setLaunchState('Enter the 6-digit arming code', 'warn');
    return;
  }
  try {
    await sendBle({ cmd: 'arm', code });
    launchCodeMemory = code;
    clearVisibleCode();
    setLaunchState('Arm command sent', 'warn');
  } catch (err) {
    clearLaunchCredential();
    setLaunchState(`Arm failed: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function disarmLaunch() {
  try {
    await sendBle({ cmd: 'disarm' });
    stopLaunchHeartbeat();
    cancelLaunchSpeech();
    stopLaunchCountdownUi('Disarmed');
    clearLaunchCredential();
    broadcastLaunch({ type: 'abort', reason: 'Disarmed', mode: 'ble' });
    setLaunchState('Controller disarmed', 'ok');
  } catch (err) {
    setLaunchState(`Disarm failed: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function startLaunchCountdown() {
  const seconds = clamp(Number(el('ble-count-seconds')?.value), 5, 60);
  const code = getCommandCode();
  if (!code) {
    setLaunchState('Re-enter the 6-digit code before countdown', 'warn');
    return;
  }
  primeLaunchSpeech();
  try {
    await sendBle({ cmd: 'countdown_start', seconds, code });
    launchCountdownEndsAt = Date.now() + seconds * 1000;
    launchCountdownActive = true;
    launchLastSpokenSecond = null;
    launchCodeMemory = code;
    persistActiveLaunch();
    broadcastLaunch({ type: 'countdown_start', seconds, endsAt: launchCountdownEndsAt, mode: 'ble' });
    startLaunchHeartbeat();
    runLaunchCountdownTick();
    clearInterval(launchCountdownTimer);
    launchCountdownTimer = setInterval(runLaunchCountdownTick, 150);
    setLaunchState('Live BLE countdown active', 'bad');
  } catch (err) {
    setLaunchState(`Countdown rejected: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function runLaunchCountdownTick() {
  if (!launchCountdownActive) return;
  const leftMs = launchCountdownEndsAt - Date.now();
  const left = Math.max(0, Math.ceil(leftMs / 1000));
  broadcastLaunch({ type: 'countdown_tick', left, leftMs: Math.max(0, leftMs), endsAt: launchCountdownEndsAt, mode: 'ble' });
  speakLaunchSecond(left);
  setText('ble-countdown', left > 0 ? `T-${left}` : 'Ignition');
  setText('ble-countdown-sub', 'BLE heartbeat active');
  if (left <= 0) {
    stopLaunchHeartbeat();
    stopLaunchCountdownUi('Trigger command sent');
    broadcastLaunch({ type: 'ignition', mode: 'ble' });
    try {
      await sendBle({ cmd: 'trigger', code: launchCodeMemory });
      clearLaunchCredential();
    } catch (err) {
      setLaunchState(`Trigger rejected: ${err.message || err}`, 'bad');
    }
  }
}

function startLaunchHeartbeat() {
  stopLaunchHeartbeat();
  launchHeartbeatTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000));
    sendBle({ cmd: 'heartbeat', left }).catch(() => onBleDisconnected());
  }, 700);
}

function stopLaunchHeartbeat() {
  clearInterval(launchHeartbeatTimer);
  launchHeartbeatTimer = null;
}

async function abortLaunchCountdown() {
  const wasActive = launchCountdownActive;
  stopLaunchHeartbeat();
  cancelLaunchSpeech();
  stopLaunchCountdownUi('Aborted');
  broadcastLaunch({ type: 'abort', reason: 'Manual abort', mode: 'ble' });
  clearLaunchCredential();
  clearPersistedLaunch();
  if (bleConnected && bleCommand) {
    try { await sendBle({ cmd: 'abort' }); } catch (_) {}
  }
  if (wasActive) setLaunchState('Countdown aborted', 'warn');
  renderLaunch();
}

function stopLaunchCountdownUi(reason) {
  clearInterval(launchCountdownTimer);
  launchCountdownTimer = null;
  launchCountdownActive = false;
  launchLastSpokenSecond = null;
  setText('ble-countdown', 'Idle');
  setText('ble-countdown-sub', reason || 'No active sequence');
}

async function sendBle(payload) {
  if (!bleCommand || !bleConnected) throw new Error('BLE not connected');
  const body = JSON.stringify({ ...payload, sid: BLE_SESSION, seq: Date.now() });
  try {
    await bleCommand.writeValueWithResponse(new TextEncoder().encode(body));
  } catch (err) {
    if (launchCountdownActive) onBleDisconnected();
    throw err;
  }
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
  if (!bleStatusData.armed) launchCodeMemory = '';
  if (!bleStatusData.countdown && launchCountdownActive) {
    stopLaunchCountdownUi('Device stopped countdown');
    broadcastLaunch({ type: 'abort', reason: 'Device stopped countdown', mode: 'ble' });
    clearPersistedLaunch();
  }
  if (bleStatusData.error) setLaunchState(`BLE: ${bleStatusData.error}`, 'warn');
  storeBleState();
  renderLaunch();
}

function renderLaunch() {
  const status = bleStatusData || readStoredBleStatus() || {};
  const linked = bleConnected;
  const armed = !!status.armed;
  const locked = !!status.locked;
  const checklistReady = allLaunchChecks();
  const credentialReady = hasLaunchCredential();
  const bluetoothSupported = hasBluetooth();
  const card = el('launch-ble-card');
  if (card) card.className = `card launch-ble-card ${linked ? 'linked' : ''} ${armed ? 'armed' : ''}`;

  const connect = el('ble-connect');
  if (connect) {
    connect.disabled = linked || !bluetoothSupported;
    connect.textContent = bleLastKnownName && !linked ? 'Reconnect BLE' : 'Connect BLE';
  }
  const disconnect = el('ble-disconnect');
  if (disconnect) disconnect.disabled = !linked;

  setDisabled('ble-arm', !linked || armed || locked || !checklistReady || !isValidCode(getVisibleCode()));
  setDisabled('ble-disarm', !linked || !armed);
  setDisabled('ble-launch', !linked || !armed || locked || launchCountdownActive || !credentialReady);
  setDisabled('ble-abort', !linked || (!armed && !launchCountdownActive));
  setText('ble-armed', armed ? 'Yes' : 'No');
  setText('ble-clients', status.clients ?? 0);
  setText('ble-clients-sub', linked
    ? 'ESP32-reported BLE central count'
    : 'Connect from this page; other tabs can reconnect to remembered device');
  setText('ble-attempts', locked ? 'Locked' : status.attemptsLeft ?? '-');

  const badge = el('ble-go-badge');
  const label = el('ble-go-label');
  if (badge) badge.className = `go-badge ${!linked ? 'marginal' : locked || armed ? 'nogo' : 'go'}`;
  if (label) label.textContent = !linked ? 'LINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  updateLaunchNote(bluetoothSupported);
}

function updateLaunchNote(bluetoothSupported) {
  const note = el('ble-note');
  if (!note) return;
  if (!bluetoothSupported) {
    note.textContent = 'Web Bluetooth needs Chrome or Edge on localhost/HTTPS. Use the ESP32 AP page only as a fallback controller.';
    return;
  }
  if (bleConnected) {
    note.textContent = 'BLE is live. Arm, countdown, and trigger commands require the passcode; countdown uses heartbeat fail-safe if the browser link drops.';
    return;
  }
  if (bleLastKnownName) {
    note.textContent = `Previously paired with ${bleLastKnownName}. Browser navigation may drop GATT, so reconnect here before launch.`;
    return;
  }
  note.textContent = 'Connect the ESP32 over BLE. The controller is passcode-gated and camera/dashboard pages share the latest link state.';
}

function checkLaunchLinkHealth() {
  if (bleConnected && bleLastStatusAt && Date.now() - bleLastStatusAt > 3500) {
    setLaunchState('BLE status stale - waiting for ESP32 heartbeat', 'warn');
  }
  renderLaunch();
}

function setLaunchState(text, state) {
  const node = el('ble-state');
  if (node) {
    node.textContent = text;
    node.style.color = state === 'bad' ? 'var(--red)' : state === 'ok' ? 'var(--green)' : 'var(--amber)';
  }
  storeBleState({ message: text, state });
}

function allLaunchChecks() {
  const checks = [...document.querySelectorAll('.ble-check')];
  return checks.length === 0 || checks.every(c => c.checked);
}

function hasLaunchCredential() {
  return !!launchCodeMemory || isValidCode(getVisibleCode());
}

function getCommandCode() {
  const visible = getVisibleCode();
  if (isValidCode(visible)) {
    launchCodeMemory = visible;
    clearVisibleCode();
    return visible;
  }
  return launchCodeMemory || '';
}

function getVisibleCode() {
  return (el('ble-code')?.value || '').trim();
}

function clearVisibleCode() {
  const input = el('ble-code');
  if (input) input.value = '';
}

function clearLaunchCredential() {
  launchCodeMemory = '';
  clearVisibleCode();
}

function persistActiveLaunch() {
  if (!launchCountdownActive || !launchCountdownEndsAt) return;
  const payload = {
    endsAt: launchCountdownEndsAt,
    code: launchCodeMemory || getVisibleCode(),
    at: Date.now()
  };
  try { sessionStorage.setItem('neolabs.launch.active', JSON.stringify(payload)); } catch (_) {}
}

function restoreActiveLaunch() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('neolabs.launch.active') || 'null');
    if (!saved || !saved.endsAt || saved.endsAt <= Date.now()) {
      clearPersistedLaunch();
      return;
    }
    launchCountdownEndsAt = saved.endsAt;
    launchCodeMemory = saved.code || '';
    launchCountdownActive = true;
    restoringCountdown = true;
    broadcastLaunch({
      type: 'countdown_tick',
      left: Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000)),
      endsAt: launchCountdownEndsAt,
      mode: 'ble'
    });
  } catch (_) {
    clearPersistedLaunch();
  }
}

function resumeRestoredCountdown() {
  if (!launchCountdownActive || !launchCountdownEndsAt) return;
  restoringCountdown = false;
  startLaunchHeartbeat();
  const left = Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000));
  sendBle({ cmd: 'heartbeat', left }).catch(() => onBleDisconnected());
  clearInterval(launchCountdownTimer);
  launchCountdownTimer = setInterval(runLaunchCountdownTick, 150);
  runLaunchCountdownTick();
  setLaunchState('Countdown restored after page switch', 'warn');
}

function clearPersistedLaunch() {
  try { sessionStorage.removeItem('neolabs.launch.active'); } catch (_) {}
}

function primeLaunchSpeech() {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return false;
  try {
    speechSynthesis.cancel();
    speechSynthesis.getVoices();
    launchSpeechReady = true;
    return true;
  } catch (_) {
    return false;
  }
}

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => {
    launchSpeechReady = true;
  };
}

function speakLaunchSecond(second) {
  if (!launchCountdownActive || second === launchLastSpokenSecond) return;
  launchLastSpokenSecond = second;
  const text = second <= 0 ? 'Ignition' : String(second);
  if (primeLaunchSpeech() || launchSpeechReady) {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const voice = voices.find(v => /^en[-_]/i.test(v.lang)) || voices[0];
      if (voice) utterance.voice = voice;
      utterance.lang = (voice && voice.lang) || 'en-US';
      utterance.rate = 1;
      utterance.pitch = second <= 3 ? 1.18 : 1;
      utterance.volume = 1;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
      return;
    } catch (_) {}
  }
  beepLaunch(second <= 0 ? 440 : 880, second <= 0 ? 0.35 : 0.1);
}

function beepLaunch(freq, duration) {
  try {
    launchAudioCtx = launchAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = launchAudioCtx.createOscillator();
    const gain = launchAudioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(launchAudioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, launchAudioCtx.currentTime + duration);
    osc.stop(launchAudioCtx.currentTime + duration);
  } catch (_) {}
}

function cancelLaunchSpeech() {
  try {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } catch (_) {}
}

function isValidCode(code) {
  return /^\d{6}$/.test(code);
}

function broadcastLaunch(payload) {
  const message = { ...payload, source: 'launch-dashboard', at: Date.now() };
  try { LAUNCH_CHANNEL?.postMessage(message); } catch (_) {}
  try { localStorage.setItem('neolabs.launch.lastEvent', JSON.stringify(message)); } catch (_) {}
  if (payload.type === 'countdown_tick' || payload.type === 'countdown_start') persistActiveLaunch();
  if (payload.type === 'abort' || payload.type === 'ignition') clearPersistedLaunch();
}

function storeBleState(extra = {}) {
  const message = {
    connected: bleConnected,
    deviceName: bleDevice?.name || bleLastKnownName || '',
    status: bleStatusData,
    lastStatusAt: bleLastStatusAt,
    at: Date.now(),
    ...extra
  };
  try { BLE_CHANNEL?.postMessage(message); } catch (_) {}
  try { localStorage.setItem('neolabs.ble.state', JSON.stringify(message)); } catch (_) {}
}

function readStoredBleStatus() {
  try {
    const saved = JSON.parse(localStorage.getItem('neolabs.ble.state') || 'null');
    if (!saved || Date.now() - saved.at > 15000) return null;
    return saved.status || null;
  } catch (_) {
    return null;
  }
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

function el(id) {
  return document.getElementById(id);
}

function on(id, event, fn) {
  const node = el(id);
  if (node) node.addEventListener(event, fn);
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function setDisabled(id, value) {
  const node = el(id);
  if (node) node.disabled = value;
}
