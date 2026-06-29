/*
  NeoLabs Mission Dashboard — BLE launch controller (single shared link).
  Now that the dashboard, finder, and camera live in one document there is exactly
  one BLE connection for the whole app, driven through the guided Launch Console
  wizard (Connect → Checklist → Arm → Launch).
*/
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
let blePingTimer = null;
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
let bleInitDone = false;

// Launch Console wizard state
let lcStep = 0;
let lcOpen = false;

function initBleController() {
  if (bleInitDone) return;
  bleInitDone = true;
  restoreActiveLaunch();
  bindBleUi();
  publishPublicApi();
  renderLaunch();
  restoreGrantedBle();
  setInterval(checkLaunchLinkHealth, 1000);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initBleController);
} else {
  initBleController();
}

function bindBleUi() {
  on('ble-connect', 'click', connectBle);
  on('ble-disconnect', 'click', disconnectBle);
  on('ble-arm', 'click', armLaunch);
  on('ble-disarm', 'click', disarmLaunch);
  on('ble-launch', 'click', startLaunchCountdown);
  on('ble-abort', 'click', abortLaunchCountdown);
  document.querySelectorAll('.ble-check,#ble-code,#ble-count-seconds').forEach(el => {
    el.addEventListener('input', () => { renderLaunch(); });
    el.addEventListener('change', () => { renderLaunch(); });
  });

  // Wizard navigation
  on('lc-next', 'click', () => goStep(lcStep + 1));
  on('lc-back', 'click', () => goStep(lcStep - 1));
  on('lc-close', 'click', closeLaunchConsole);
  document.querySelectorAll('.lc-pip').forEach(pip => {
    pip.addEventListener('click', () => {
      const n = Number(pip.dataset.step);
      if (canEnter(n)) goStep(n);
    });
  });
  const overlay = el('launch-modal');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeLaunchConsole(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lcOpen) closeLaunchConsole(); });
}

function publishPublicApi() {
  window.NeoLaunch = {
    open: openLaunchConsole,
    close: closeLaunchConsole,
    connected: () => bleConnected,
    countdownActive: () => launchCountdownActive,
    status: () => bleStatusData || {}
  };
}

/* ─────────────────────────── Wizard ─────────────────────────── */
function openLaunchConsole() {
  const overlay = el('launch-modal');
  if (!overlay) return;
  lcOpen = true;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  goStep(firstIncompleteStep());
  renderLaunch();
}

function closeLaunchConsole() {
  const overlay = el('launch-modal');
  if (!overlay) return;
  lcOpen = false;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function stepSatisfied(n) {
  if (n === 0) return bleConnected;
  if (n === 1) return allLaunchChecks();
  if (n === 2) return !!(currentStatus().armed);
  return true;
}

function canEnter(n) {
  if (n <= 0) return true;
  for (let i = 0; i < n; i++) if (!stepSatisfied(i)) return false;
  return true;
}

function firstIncompleteStep() {
  for (let i = 0; i < 3; i++) if (!stepSatisfied(i)) return i;
  return 3;
}

function goStep(n) {
  n = Math.max(0, Math.min(3, n));
  if (!canEnter(n)) n = firstIncompleteStep();
  lcStep = n;
  document.querySelectorAll('.lc-panel').forEach(p => p.classList.toggle('active', Number(p.dataset.panel) === n));
  renderLaunch();
}

/* ─────────────────────────── Connection ─────────────────────────── */
async function restoreGrantedBle() {
  if (!hasBluetooth()) {
    setLaunchState('Web Bluetooth unavailable in this browser', 'bad');
    renderLaunch();
    return; // BLE not available — console can't help
  }
  if (!navigator.bluetooth.getDevices) {
    setLaunchState('Connecting…', 'warn');
    renderLaunch();
    scheduleAutoOpenConsole();
    return;
  }
  try {
    const devices = await navigator.bluetooth.getDevices();
    const candidate = devices.find(d => /^NeoLabs/i.test(d.name || '')) || devices.find(d => d.name === bleLastKnownName);
    if (!candidate) {
      setLaunchState('No paired controller found', 'warn');
      renderLaunch();
      scheduleAutoOpenConsole();
      return;
    }
    bleDevice = candidate;
    attachDisconnectListener(candidate);
    setLaunchState(`Reconnecting to ${candidate.name || 'controller'}…`, 'warn');
    await connectBleDevice(candidate);
    // Successfully reconnected — no need to open console
  } catch (err) {
    setLaunchState('Could not reconnect — open console to retry', 'warn');
    renderLaunch();
    scheduleAutoOpenConsole();
  }
}

function scheduleAutoOpenConsole() {
  // Give the page ~1 s to finish rendering before popping the modal
  setTimeout(() => { if (!bleConnected) openLaunchConsole(); }, 1100);
}

async function connectBle() {
  if (!hasBluetooth()) {
    setLaunchState('Web Bluetooth is not available in this browser', 'bad');
    renderLaunch();
    return;
  }
  setLaunchState('Selecting BLE controller…', 'warn');
  renderLaunch();
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'NeoLabs' }],
      optionalServices: [BLE_SERVICE_UUID]
    });
    await connectBleDevice(device);
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
  setLaunchState(`Linked to ${bleLastKnownName}`, 'ok');
  storeBleState();
  broadcastBleState();
  await sendBle({ cmd: 'status' });
  startBlePing();
  resumeRestoredCountdown();
  if (lcOpen && lcStep === 0) goStep(1);
  renderLaunch();
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
  stopBlePing();
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
  stopBlePing();
  stopLaunchHeartbeat();
  broadcastBleState();
  if (wasControllingCountdown) {
    persistActiveLaunch();
    setLaunchState('BLE dropped during countdown — ESP32 will safe-stop on heartbeat loss', 'bad');
  } else {
    setLaunchState('BLE disconnected. Reconnect before launch.', 'bad');
  }
  storeBleState();
  renderLaunch();
}

/* ─────────────────────────── Commands ─────────────────────────── */
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
  // Gate on dashboard GO state — read the badge and any specific NO-GO factors
  const goBadge = el('go-badge');
  if (goBadge?.classList.contains('nogo') || goBadge?.classList.contains('marginal')) {
    const isNogo = goBadge.classList.contains('nogo');
    const nogoNames = [...document.querySelectorAll('#factors-list .factor:not(.ignored) .chip.nogo, #factors-list .factor:not(.ignored) .chip.marginal')]
      .map(chip => chip.closest('.factor')?.querySelector('.factor-name')?.textContent)
      .filter(Boolean);
    const factorLines = nogoNames.length ? `\n\n${nogoNames.map(n => `• ${n}`).join('\n')}` : '';
    const label = isNogo ? 'NO-GO' : 'HOLD';
    const msg = `⚠️ Dashboard is ${label}${factorLines}\n\n${isNogo ? 'Launch conditions are not met.' : 'Conditions are marginal.'} Arm the controller anyway?`;
    if (!window.confirm(msg)) {
      setLaunchState(`Arming cancelled — ${label} conditions not cleared`, 'warn');
      return;
    }
  }
  try {
    await armWithCode(code);
    setLaunchState('Arm command sent', 'warn');
  } catch (err) {
    clearLaunchCredential();
    setLaunchState(`Arm failed: ${err.message || err}`, 'bad');
  }
  renderLaunch();
}

async function disarmLaunch() {
  try {
    await disarmController();
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
    await startCountdownWithCode(seconds, code);
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

function startBlePing() {
  stopBlePing();
  blePingTimer = setInterval(async () => {
    // Skip during active countdown — the heartbeat (every 700ms) already proves the link
    // is live. Running both concurrently causes GATT write conflicts that throw and
    // falsely trigger onBleDisconnected.
    if (!bleConnected || !bleCommand || launchCountdownActive) return;
    try {
      const body = JSON.stringify({ cmd: 'status', sid: BLE_SESSION, seq: Date.now() });
      await bleCommand.writeValueWithResponse(new TextEncoder().encode(body));
      // Successful write proves the link is still alive — refresh the staleness clock
      // so checkLaunchLinkHealth doesn't falsely declare the connection dead.
      bleLastStatusAt = Date.now();
    } catch (_) {
      onBleDisconnected();
    }
  }, 2000);
}

function stopBlePing() {
  clearInterval(blePingTimer);
  blePingTimer = null;
}

async function abortLaunchCountdown() {
  await abortController();
}

async function armWithCode(code) {
  await sendBle({ cmd: 'arm', code });
  launchCodeMemory = code;
  clearVisibleCode();
  renderLaunch();
}

async function disarmController() {
  await sendBle({ cmd: 'disarm' });
  stopLaunchHeartbeat();
  cancelLaunchSpeech();
  stopLaunchCountdownUi('Disarmed');
  clearLaunchCredential();
  broadcastLaunch({ type: 'abort', reason: 'Disarmed', mode: 'ble' });
  renderLaunch();
}

async function startCountdownWithCode(seconds, code) {
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
  renderLaunch();
}

async function abortController() {
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
  const wasArmed = !!(bleStatusData && bleStatusData.armed);
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
  if (!bleStatusData.armed) launchCodeMemory = launchCountdownActive ? launchCodeMemory : '';
  if (!bleStatusData.countdown && launchCountdownActive) {
    stopLaunchCountdownUi('Device stopped countdown');
    broadcastLaunch({ type: 'abort', reason: 'Device stopped countdown', mode: 'ble' });
    clearPersistedLaunch();
  }
  if (bleStatusData.error) setLaunchState(`Controller: ${bleStatusData.error}`, 'warn');
  if (bleStatusData.armed && !wasArmed && lcOpen && lcStep < 3) goStep(3);
  storeBleState();
  renderLaunch();
}

function currentStatus() {
  return bleStatusData || readStoredBleStatus() || {};
}

/* ─────────────────────────── Rendering ─────────────────────────── */
function renderLaunch() {
  const status = currentStatus();
  const linked = bleConnected;
  const armed = !!status.armed;
  const locked = !!status.locked;
  const checklistReady = allLaunchChecks();
  const credentialReady = hasLaunchCredential();
  const bluetoothSupported = hasBluetooth();

  // Buttons
  const connect = el('ble-connect');
  if (connect) {
    connect.disabled = linked || !bluetoothSupported;
    connect.textContent = bleLastKnownName && !linked ? 'Reconnect BLE' : 'Connect BLE';
  }
  setDisabled('ble-disconnect', !linked);
  setDisabled('ble-arm', !linked || armed || locked || !checklistReady || !isValidCode(getVisibleCode()));
  setDisabled('ble-disarm', !linked || !armed);
  setDisabled('ble-launch', !linked || !armed || locked || launchCountdownActive || !credentialReady);
  setDisabled('ble-abort', !linked || (!armed && !launchCountdownActive));

  // Modal metrics
  setText('ble-armed', armed ? 'Yes' : 'No');
  setText('ble-clients', status.clients ?? 0);
  setText('ble-attempts', locked ? 'Locked' : status.attemptsLeft ?? '-');
  setText('lc-m-link', linked ? (bleLastKnownName || 'Linked') : 'Offline');

  // Modal status badge
  const badge = el('ble-go-badge');
  const label = el('ble-go-label');
  if (badge) badge.className = `go-badge ${!linked ? 'marginal' : locked ? 'nogo' : armed ? 'nogo' : 'go'}`;
  if (label) label.textContent = !linked ? 'LINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  // Dashboard summary card
  setText('ds-link', el('ble-state')?.textContent || (linked ? 'Linked' : 'Not connected'));
  setText('ds-link-state', linked ? (bleLastKnownName || 'Linked') : 'Offline');
  setText('ds-armed', locked ? 'Locked' : armed ? 'Yes' : 'No');
  setText('ds-countdown', launchCountdownActive ? 'Active' : (status.countdown ? 'Active' : 'Idle'));
  setText('ds-countdown-sub', launchCountdownActive ? 'BLE heartbeat live' : 'No active sequence');
  setText('ds-clients', status.clients ?? 0);
  const dsBadge = el('ds-go-badge');
  const dsLabel = el('ds-go-label');
  if (dsBadge) dsBadge.className = `go-badge ${!linked ? 'marginal' : armed ? 'nogo' : 'go'}`;
  if (dsLabel) dsLabel.textContent = !linked ? 'LINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  // Camera link label
  setText('cam-ble-state', linked ? (bleLastKnownName || 'BLE live') : 'Offline');

  // Wizard step gating
  document.querySelectorAll('.lc-pip').forEach(pip => {
    const n = Number(pip.dataset.step);
    pip.classList.toggle('active', n === lcStep);
    pip.classList.toggle('done', stepSatisfied(n) && n < 3);
    pip.classList.toggle('locked', !canEnter(n));
  });
  setDisabled('lc-back', lcStep <= 0);
  const next = el('lc-next');
  if (next) {
    next.disabled = lcStep >= 3 || !canEnter(lcStep + 1);
    next.style.visibility = lcStep >= 3 ? 'hidden' : 'visible';
  }

  // Arm panel: mirror the main dashboard GO state so the user sees it without closing the modal
  const goEl = el('go-badge');
  const lcNogo = el('lc-nogo-warn');
  if (lcNogo) {
    const isNogo = goEl?.classList.contains('nogo');
    const isHold = goEl?.classList.contains('marginal');
    if (isNogo || isHold) {
      lcNogo.textContent = isNogo
        ? '⚠ Dashboard is NO-GO — launch conditions are not met'
        : '⚡ Dashboard is on HOLD — conditions are marginal';
      lcNogo.className = `lc-nogo-warn ${isNogo ? 'nogo' : 'hold'}`;
      lcNogo.style.display = 'block';
    } else {
      lcNogo.style.display = 'none';
    }
  }

  updateLaunchNote(bluetoothSupported, linked, armed, locked);
}

function updateLaunchNote(bluetoothSupported, linked, armed, locked) {
  const note = el('ble-note');
  if (!note) return;
  if (!bluetoothSupported) {
    note.textContent = 'Web Bluetooth needs Chrome or Edge over localhost/HTTPS to reach the controller.';
    return;
  }
  if (locked) { note.textContent = 'Controller locked after too many wrong codes — reboot the ESP32 to reset.'; return; }
  if (lcStep === 0) note.textContent = linked ? 'Linked. Continue to the checklist.' : 'Pair the NeoLabs controller to begin.';
  else if (lcStep === 1) note.textContent = 'Confirm every checklist item to enable arming.';
  else if (lcStep === 2) note.textContent = armed ? 'Armed. Continue to the launch step.' : 'Enter the 6-digit code, then arm.';
  else note.textContent = 'Hold for a clear range and airspace, then start the countdown. Abort is always available.';
}

function checkLaunchLinkHealth() {
  if (bleConnected && bleLastStatusAt) {
    const staleMs = Date.now() - bleLastStatusAt;
    if (staleMs > 8000) {
      // Ping has fired 4+ times with no response — treat as a dead connection
      setLaunchState('BLE link lost (no response for 8 s) — reconnect', 'bad');
      onBleDisconnected();
    } else if (staleMs > 3500) {
      setLaunchState('BLE status stale — waiting for ESP32', 'warn');
    }
  }
  renderLaunch();
}

function setLaunchState(text, state) {
  const color = state === 'bad' ? 'var(--red)' : state === 'ok' ? 'var(--green)' : 'var(--amber)';
  ['ble-state', 'lc-link-state'].forEach(id => {
    const node = el(id);
    if (node) { node.textContent = text; node.style.color = color; }
  });
  const ds = el('ds-link');
  if (ds) { ds.textContent = text; ds.style.color = color; }
  storeBleState({ message: text, state });
}

/* ─────────────────────────── Helpers / state ─────────────────────────── */
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
  startLaunchHeartbeat();
  const left = Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000));
  sendBle({ cmd: 'heartbeat', left }).catch(() => onBleDisconnected());
  clearInterval(launchCountdownTimer);
  launchCountdownTimer = setInterval(runLaunchCountdownTick, 150);
  runLaunchCountdownTick();
  setLaunchState('Countdown restored', 'warn');
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
  speechSynthesis.onvoiceschanged = () => { launchSpeechReady = true; };
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
      utterance.rate = 1.28;
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
  // Same-document delivery: notify the camera view directly too.
  if (typeof window.NeoCameraLaunchEvent === 'function') {
    try { window.NeoCameraLaunchEvent(message); } catch (_) {}
  }
  // Relay to server SSE so devices on the same network receive the event.
  // Fire-and-forget: mission control must not stall waiting for the local server.
  if (payload.type !== 'countdown_tick') {
    relayToServer(message);
  } else if (!payload._relayThrottled) {
    // Throttle ticks to one relay per second (150ms timer fires 6-7x/sec)
    const now = Date.now();
    if (!broadcastLaunch._lastRelay || now - broadcastLaunch._lastRelay >= 950) {
      broadcastLaunch._lastRelay = now;
      relayToServer(message);
    }
  }
}

function relayToServer(message) {
  fetch('/api/launch-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  }).catch(() => {});
}

function broadcastBleState() {
  const message = {
    type: 'ble_state',
    connected: bleConnected,
    deviceName: bleDevice?.name || bleLastKnownName || '',
    source: 'launch-dashboard',
    at: Date.now()
  };
  fetch('/api/launch-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  }).catch(() => {});
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
  if (typeof window.NeoCameraBleState === 'function') {
    try { window.NeoCameraBleState(message); } catch (_) {}
  }
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
