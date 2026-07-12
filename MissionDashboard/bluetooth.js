/*
  NeoLabs Mission Dashboard — launch orchestration.

  Transport and sync are delegated to two dedicated modules:
    · ble-link.js    (NeoBleLink)    — resilient Web Bluetooth link with
                                       auto-reconnect, timeouts, and watchdog
    · launch-sync.js (NeoLaunchSync) — SSE stream, owner lease, remote RPC

  This file owns the Launch Console wizard, countdown/heartbeat logic, speech,
  shared-state rendering, and the camera/HUD bridges.
*/
// sessionStorage normally identifies a browser tab across reloads, but browsers
// clone it into tabs created through window.open/duplicate-tab. Detect that
// collision before starting SSE/BLE so two live dashboards can never share an
// owner identity and both believe they hold the same lease.
const CLIENT_INSTANCE_ID = makeSessionId();
let CLIENT_ID = sessionStorage.getItem('neolabs.clientId') || makeSessionId();
sessionStorage.setItem('neolabs.clientId', CLIENT_ID);
const CLIENT_ID_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-client-identity')
  : null;
const CLIENT_ID_READY = reserveUniqueClientId();
let resolveAuthReady;
window.NeoAuthReady = new Promise(resolve => { resolveAuthReady = resolve; });
const LAUNCH_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-launch')
  : null;
const BLE_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-ble')
  : null;

const bleLink = new NeoBleLink();
let sync = null;

let launchCodeMemory = '';
let launchCountdownTimer = null;
let launchHeartbeatTimer = null;
let launchCountdownEndsAt = 0;
let launchCountdownActive = false;
let launchLastSpokenSecond = null;
let launchAudioCtx = null;
let launchSpeechReady = false;
let lastLaunchEvent = null;
const seenSharedLaunchEvents = new Set();
let launchWakeLock = null;
let wakeLockRequest = null;
let wakeLockRetryTimer = null;
let wakeLockReleaseIntentional = false;
let wakeLockError = '';
let wakeLockPreflight = false;

let bleStatusData = null;
let bleStatusRevision = 0;
let bleInitDone = false;
let sharedState = { connected: false, ownerActive: false, status: null };
let sharedCountdownActive = false;
let sharedCountdownEndsAt = 0;
let sharedStateReceivedAt = 0;
let ownerHeartbeatTimer = null;
let authStatusWaiter = null;
let authVerificationQueue = Promise.resolve();
let remoteCommandQueue = Promise.resolve();
let joinAuthorized = false;
let serverClientCount = 1;

// Launch Console wizard state
let lcStep = 0;
let lcOpen = false;

async function initBleController() {
  if (bleInitDone) return;
  bleInitDone = true;
  await CLIENT_ID_READY;
  sync = new NeoLaunchSync(CLIENT_ID);
  resolveAuthReady(true);
  wireBleLink();
  wireSync();
  sync.start();
  restoreActiveLaunch();
  bindBleUi();
  publishPublicApi();
  renderLaunch();
  restoreGrantedBle();
  setInterval(checkLaunchLinkHealth, 1000);
  // Release the owner lease the moment this page goes away so another device
  // can take over immediately instead of waiting out the server-side TTL.
  window.addEventListener('pagehide', () => {
    releaseLaunchWakeLock();
    if (bleLink.connected || bleLink.state === 'reconnecting') sync?.releaseOwner('pagehide');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncLaunchWakeLock();
    if (bleLink.connected || bleLink.state === 'reconnecting') publishOwnerSnapshot();
    renderLaunch();
  });
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
    connected: () => bleLink.connected || sharedState.ownerActive,
    countdownActive: () => launchCountdownActive || sharedCountdownActive,
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
  if (n === 0) return bleLink.connected || sharedState.ownerActive;
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

/* ─────────────────────────── BLE link wiring ─────────────────────────── */
function wireBleLink() {
  bleLink.on('state', handleLinkState);
  bleLink.on('status', applyBleStatus);
  bleLink.on('health', ({ staleMs }) => {
    if (staleMs > 3500) setLaunchState('BLE status stale — waiting for ESP32', 'warn');
  });
}

function handleLinkState(detail) {
  if (detail.state === 'connecting') {
    setLaunchState(`Connecting to ${bleLink.deviceName || 'controller'}…`, 'warn');
  } else if (detail.state === 'connected') {
    onBleLinkUp();
  } else if (detail.state === 'reconnecting') {
    onBleReconnecting(detail);
  } else if (detail.state === 'idle') {
    onBleLinkDown(detail);
  }
  renderLaunch();
}

async function onBleLinkUp() {
  setLaunchState(`Linked to ${bleLink.deviceName || 'controller'}`, 'ok');
  storeBleState();
  const claim = await sync.claimOwner({ deviceName: bleLink.deviceName || 'NeoLabs controller', status: bleStatusData });
  if (claim.conflict) {
    bleLink.disconnect(); // synchronous state event — message below must win
    if (claim.state) { sharedState = claim.state; sharedStateReceivedAt = Date.now(); }
    setLaunchState('Another device already owns the BLE connection', 'bad');
    renderLaunch();
    return;
  }
  if (!claim.ok) {
    // Local BLE control still works; the dashboard just won't sync to other
    // devices until the server comes back.
    setLaunchState('BLE linked, but dashboard sync is unavailable', 'warn');
  } else if (claim.state) {
    sharedState = claim.state;
    sharedStateReceivedAt = Date.now();
  }
  broadcastBleState();
  startOwnerHeartbeat();
  resumeRestoredCountdown();
  if (lcOpen && lcStep === 0) goStep(1);
  renderLaunch();
}

function onBleReconnecting(detail) {
  // Heartbeat writes would fail while the link is down; the ESP32 safe-stops
  // on its own 3 s heartbeat timeout. If the link returns before the local
  // countdown expires, the tick loop resumes heartbeats automatically.
  stopLaunchHeartbeat();
  const attempt = detail.attempt ? ` (attempt ${detail.attempt})` : '';
  setLaunchState(`BLE dropped — reconnecting${attempt}…`, 'warn');
  storeBleState();
  publishOwnerSnapshot();
}

function onBleLinkDown(detail) {
  stopLaunchHeartbeat();
  stopOwnerHeartbeat();
  bleLink.setPingSuspended(false);
  if (launchCountdownActive) {
    cancelLaunchSpeech();
    stopLaunchCountdownUi('BLE link lost');
    broadcastLaunch({ type: 'abort', reason: 'BLE link lost', mode: 'ble' });
    clearPersistedLaunch();
  }
  bleStatusData = null;
  lastLaunchEvent = null;
  releaseLaunchWakeLock();
  sync.releaseOwner(detail.reason || 'link_down');
  sharedState = { ...sharedState, connected: false, ownerActive: false, ownerName: '', status: null, countdown: null };
  sharedCountdownActive = false;
  sharedCountdownEndsAt = 0;
  broadcastBleState();
  if (detail.reason === 'gave_up') {
    setLaunchState('Reconnect failed — check controller power and range, then reconnect', 'bad');
  } else if (detail.reason === 'user') {
    setLaunchState('BLE disconnected. Reconnect before launch.', 'warn');
  } else if (detail.reason !== 'connect_failed') {
    setLaunchState('BLE disconnected. Reconnect before launch.', 'bad');
  }
  storeBleState();
  renderLaunch();
}

/* ─────────────────────────── Connection ─────────────────────────── */
async function restoreGrantedBle() {
  try {
    const state = await sync.fetchState();
    sharedState = state;
    sharedStateReceivedAt = Date.now();
    // Only a FOREIGN owner blocks local BLE. Our own lease (e.g. after a
    // reload where the release beacon was lost) must never lock us out.
    if (state.ownerActive && !state.youAreOwner) {
      setLaunchState('BLE is connected through another authorized device', 'ok');
      renderLaunch();
      return;
    }
  } catch (_) {}
  if (!NeoBleLink.supported()) {
    setLaunchState('Web Bluetooth unavailable in this browser', 'bad');
    renderLaunch();
    return;
  }
  try {
    setLaunchState('Looking for paired controller…', 'warn');
    renderLaunch();
    const restored = await bleLink.restoreGranted();
    if (!restored) {
      setLaunchState('No paired controller found — open the console to connect', 'warn');
      renderLaunch();
    }
  } catch (_) {
    setLaunchState('Could not reconnect — open console to retry', 'warn');
    renderLaunch();
  }
}

async function connectBle() {
  if (bleLink.state === 'reconnecting') {
    bleLink.retryNow();
    return;
  }
  if (!NeoBleLink.supported()) {
    setLaunchState('Web Bluetooth is not available in this browser', 'bad');
    renderLaunch();
    return;
  }
  setLaunchState('Selecting BLE controller…', 'warn');
  renderLaunch();
  try {
    const state = await sync.fetchState().catch(() => null);
    if (state) {
      sharedState = state;
      sharedStateReceivedAt = Date.now();
      if (state.ownerActive && !state.youAreOwner) throw new Error('Another authorized device already owns the BLE link');
    }
    await bleLink.connectViaChooser();
  } catch (err) {
    setLaunchState(`BLE connect failed: ${err.message || err}`, 'bad');
    storeBleState();
    renderLaunch();
  }
}

async function disconnectBle() {
  if (launchCountdownActive) await abortLaunchCountdown();
  sync.releaseOwner('user_disconnect');
  bleLink.disconnect();
}

/* ─────────────────────────── Commands ─────────────────────────── */
async function armLaunch() {
  if (!allLaunchChecks()) {
    setLaunchState('Complete the safety checklist before arming', 'warn');
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
  // Request while the click still carries user activation. Browsers may deny a
  // later request made only after the BLE round trip has completed.
  wakeLockPreflight = true;
  ensureLaunchWakeLock();
  try {
    await armWithCode('');
    setLaunchState('Arm command sent', 'warn');
  } catch (err) {
    clearLaunchCredential();
    setLaunchState(`Arm failed: ${err.message || err}`, 'bad');
  } finally {
    wakeLockPreflight = false;
    syncLaunchWakeLock();
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
  wakeLockPreflight = true;
  ensureLaunchWakeLock();
  primeLaunchSpeech();
  try {
    await startCountdownWithCode(seconds, '');
    setLaunchState('Live BLE countdown active', 'bad');
  } catch (err) {
    setLaunchState(`Countdown rejected: ${err.message || err}`, 'bad');
  } finally {
    wakeLockPreflight = false;
    syncLaunchWakeLock();
  }
  renderLaunch();
}

async function runLaunchCountdownTick() {
  if (!launchCountdownActive) return;
  // The ESP32 safe-stops 3 s after the last heartbeat. If the BLE link has
  // been gone longer than that, the controller has already aborted — reflect
  // it instead of counting down to a trigger that can never fire.
  if (!bleLink.connected && Date.now() - (bleLink.lastActivityAt || 0) > 4000) {
    cancelLaunchSpeech();
    stopLaunchCountdownUi('Controller safe-stopped (BLE lost)');
    broadcastLaunch({ type: 'abort', reason: 'BLE link lost', mode: 'ble' });
    clearPersistedLaunch();
    setLaunchState('Countdown aborted — BLE link lost, controller safe-stopped', 'bad');
    renderLaunch();
    return;
  }
  const leftMs = launchCountdownEndsAt - Date.now();
  const left = Math.max(0, Math.ceil(leftMs / 1000));
  broadcastLaunch({ type: 'countdown_tick', left, leftMs: Math.max(0, leftMs), endsAt: launchCountdownEndsAt, mode: 'ble' });
  speakLaunchSecond(left);
  setText('ble-countdown', left > 0 ? `T-${left}` : 'Ignition');
  setText('ble-countdown-sub', 'BLE heartbeat active');
  if (left <= 0) {
    stopLaunchHeartbeat();
    bleLink.setPingSuspended(false);
    stopLaunchCountdownUi('Trigger command sent');
    broadcastLaunch({ type: 'ignition', mode: 'ble' });
    try {
      await sendBle({ cmd: 'trigger' });
      clearLaunchCredential();
    } catch (err) {
      setLaunchState(`Trigger rejected: ${err.message || err}`, 'bad');
    }
  }
}

function startLaunchHeartbeat() {
  stopLaunchHeartbeat();
  bleLink.setPingSuspended(true);
  launchHeartbeatTimer = setInterval(() => {
    if (!bleLink.connected) return;
    const left = Math.max(0, Math.ceil((launchCountdownEndsAt - Date.now()) / 1000));
    sendBle({ cmd: 'heartbeat', left }).catch(() => {});
  }, 700);
}

function stopLaunchHeartbeat() {
  clearInterval(launchHeartbeatTimer);
  launchHeartbeatTimer = null;
  bleLink.setPingSuspended(false);
}

async function abortLaunchCountdown() {
  await abortController();
}

async function armWithCode(code) {
  if (!bleLink.connected) return sendRemoteCommand('arm', { code });
  await sendBle({ cmd: 'arm' });
  clearVisibleCode();
  renderLaunch();
}

async function disarmController() {
  if (!bleLink.connected && sharedState.ownerActive) return sendRemoteCommand('disarm');
  await sendBle({ cmd: 'disarm' });
  stopLaunchHeartbeat();
  cancelLaunchSpeech();
  stopLaunchCountdownUi('Disarmed');
  clearLaunchCredential();
  broadcastLaunch({ type: 'abort', reason: 'Disarmed', mode: 'ble' });
  renderLaunch();
}

async function startCountdownWithCode(seconds, code) {
  if (!bleLink.connected) return sendRemoteCommand('countdown_start', { seconds, code });
  await sendBle({ cmd: 'countdown_start', seconds });
  launchCountdownEndsAt = Date.now() + seconds * 1000;
  launchCountdownActive = true;
  launchLastSpokenSecond = null;
  persistActiveLaunch();
  broadcastLaunch({ type: 'countdown_start', seconds, endsAt: launchCountdownEndsAt, mode: 'ble' });
  startLaunchHeartbeat();
  runLaunchCountdownTick();
  clearInterval(launchCountdownTimer);
  launchCountdownTimer = setInterval(runLaunchCountdownTick, 150);
  renderLaunch();
}

async function abortController() {
  if (!bleLink.connected && sharedState.ownerActive) {
    await sendRemoteCommand('abort');
    renderLaunch();
    return;
  }
  const wasActive = launchCountdownActive;
  stopLaunchHeartbeat();
  cancelLaunchSpeech();
  stopLaunchCountdownUi('Aborted');
  broadcastLaunch({ type: 'abort', reason: 'Manual abort', mode: 'ble' });
  clearLaunchCredential();
  clearPersistedLaunch();
  if (bleLink.connected) {
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

function sendBle(payload) {
  return bleLink.send(payload);
}

function applyBleStatus(s) {
  const wasArmed = !!(bleStatusData && bleStatusData.armed);
  bleStatusRevision++;
  bleStatusData = {
    armed: !!s.a,
    trigger: !!s.f,
    countdown: !!s.c,
    locked: !!s.l,
    attemptsLeft: s.left,
    clients: s.n || 0,
    uptime: s.u || 0,
    error: s.e || '',
    firmwareVersion: s.v || ''
  };
  if (authStatusWaiter && (bleStatusData.error === 'auth_ok' || bleStatusData.error === 'auth_failed')) {
    authStatusWaiter(bleStatusData.error === 'auth_ok');
  }
  if (!bleStatusData.armed) launchCodeMemory = launchCountdownActive ? launchCodeMemory : '';
  if (!bleStatusData.countdown && launchCountdownActive) {
    stopLaunchCountdownUi('Device stopped countdown');
    broadcastLaunch({ type: 'abort', reason: 'Device stopped countdown', mode: 'ble' });
    clearPersistedLaunch();
  }
  if (bleStatusData.error && !['auth_ok', 'auth_failed'].includes(bleStatusData.error)) {
    setLaunchState(formatControllerError(bleStatusData.error), 'warn');
  }
  syncLaunchWakeLock();
  if (bleStatusData.armed && !wasArmed && lcOpen && lcStep < 3) goStep(3);
  storeBleState();
  if (bleLink.connected) publishOwnerSnapshot();
  renderLaunch();
}

let ownerConflictAt = 0;
function publishOwnerSnapshot() {
  if (!bleLink.connected && bleLink.state !== 'reconnecting') return;
  const reconnecting = bleLink.state === 'reconnecting';
  const countdownLeftMs = Math.max(0, launchCountdownEndsAt - Date.now());
  sync.relay({
    type: 'owner_heartbeat',
    connected: bleLink.connected,
    reconnecting,
    deviceName: bleLink.deviceName || 'NeoLabs controller',
    status: bleLink.connected ? bleStatusData : null,
    countdown: bleLink.connected && launchCountdownActive
      ? { active: true, endsAt: launchCountdownEndsAt, left: Math.ceil(countdownLeftMs / 1000), leftMs: countdownLeftMs }
      : { active: false, endsAt: null, left: 0 },
    lastEvent: lastLaunchEvent,
    host: {
      visibility: document.visibilityState,
      wakeLockSupported: !!navigator.wakeLock?.request,
      wakeLockActive: !!launchWakeLock && !launchWakeLock.released
    }
  }).then(response => {
    // 409 = the server thinks a different client owns the lease while WE hold
    // the physical BLE link. Try to reclaim once the stale lease allows it —
    // silently swallowing this is how split-brain states linger.
    if (!response || response.status !== 409 || !bleLink.connected) return;
    if (Date.now() - ownerConflictAt < 10000) return;
    ownerConflictAt = Date.now();
    sync.claimOwner({ deviceName: bleLink.deviceName || 'NeoLabs controller', status: bleStatusData }).then(claim => {
      if (claim.ok) {
        ownerConflictAt = 0;
        setLaunchState(`Linked to ${bleLink.deviceName || 'controller'}`, 'ok');
      } else {
        setLaunchState('Sync conflict: another dashboard holds the shared session — local BLE control still works', 'warn');
      }
    });
  });
}

async function requestFreshBleStatus() {
  const revision = bleStatusRevision;
  await sendBle({ cmd: 'status' });
  if (bleStatusRevision !== revision) return;
  await new Promise(resolve => {
    const deadline = Date.now() + 1000;
    const poll = () => bleStatusRevision !== revision || Date.now() >= deadline ? resolve() : setTimeout(poll, 25);
    poll();
  });
}

function currentStatus() {
  return bleStatusData || sharedState.status || readStoredBleStatus() || {};
}

/* ─────────────────────────── Rendering ─────────────────────────── */
function renderLaunch() {
  const status = currentStatus();
  const reconnecting = bleLink.state === 'reconnecting';
  const connecting = bleLink.state === 'connecting';
  const linked = bleLink.connected || sharedState.ownerActive;
  const armed = !!status.armed;
  const locked = !!status.locked;
  const countdownLive = launchCountdownActive || sharedCountdownActive || !!status.countdown;
  const checklistReady = allLaunchChecks();
  const bluetoothSupported = NeoBleLink.supported();

  // Buttons
  const connect = el('ble-connect');
  if (connect) {
    const foreignOwner = sharedState.ownerActive && !sharedState.youAreOwner && !bleLink.connected && !reconnecting;
    connect.disabled = !bluetoothSupported || connecting || bleLink.connected || foreignOwner;
    connect.textContent = reconnecting
      ? 'Retry now'
      : connecting
      ? 'Connecting…'
      : foreignOwner
      ? 'BLE connected on another device'
      : !bleLink.connected && sharedState.youAreOwner
      ? 'Reconnect BLE (this device owns the session)'
      : bleLink.lastKnownName && !linked ? 'Reconnect BLE' : 'Connect BLE';
  }
  // Our own lease with a dead local BLE link: commands have no path to the
  // controller (remote routing would loop back to this browser), so gate the
  // action buttons until the automatic restore has relinked.
  const selfOwnerDown = !!sharedState.youAreOwner && !bleLink.connected;
  setDisabled('ble-disconnect', !bleLink.connected && !reconnecting && !connecting);
  setDisabled('ble-arm', !linked || armed || locked || !checklistReady || reconnecting || selfOwnerDown);
  setDisabled('ble-disarm', !linked || !armed || reconnecting || selfOwnerDown);
  setDisabled('ble-launch', !linked || !armed || locked || countdownLive || reconnecting || selfOwnerDown);
  setDisabled('ble-abort', !linked || (!armed && !countdownLive));

  // Modal metrics
  setText('ble-armed', armed ? 'Yes' : 'No');
  setText('ble-clients', status.clients ?? 0);
  setText('ble-control-mode', bleLink.connected ? 'Direct BLE' : reconnecting ? 'Reconnecting' : linked ? 'Shared' : 'Offline');
  const linkedName = bleLink.connected || reconnecting
    ? (bleLink.deviceName || 'Linked')
    : (sharedState.ownerName || 'Shared BLE link');
  setText('lc-m-link', linked ? linkedName : 'Offline');

  // Modal status badge
  const badge = el('ble-go-badge');
  const label = el('ble-go-label');
  if (badge) badge.className = `go-badge ${!linked || reconnecting ? 'marginal' : locked ? 'nogo' : armed ? 'nogo' : 'go'}`;
  if (label) label.textContent = !linked ? 'LINK' : reconnecting ? 'RELINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  // Dashboard summary card
  setText('ds-link', el('ble-state')?.textContent || (linked ? 'Linked' : 'Not connected'));
  setText('ds-link-state', linked ? linkedName : 'Offline');
  setText('ds-armed', locked ? 'Locked' : armed ? 'Yes' : 'No');
  setText('ds-countdown', countdownLive ? 'Active' : 'Idle');
  setText('ds-countdown-sub', launchCountdownActive ? 'BLE heartbeat live' : sharedCountdownActive ? 'Synchronized from BLE owner' : 'No active sequence');
  setText('ds-clients', serverClientCount);
  const dsBadge = el('ds-go-badge');
  const dsLabel = el('ds-go-label');
  if (dsBadge) dsBadge.className = `go-badge ${!linked || reconnecting ? 'marginal' : armed ? 'nogo' : 'go'}`;
  if (dsLabel) dsLabel.textContent = !linked ? 'LINK' : reconnecting ? 'RELINK' : locked ? 'LOCK' : armed ? 'ARMED' : 'SAFE';

  // camera.js owns its label so direct/shared state cannot be overwritten by a
  // generic launch-console render. Keep a fallback for pages without that hook.
  if (typeof window.NeoCameraBleState !== 'function') setText('cam-ble-state', linked ? linkedName : 'Offline');

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

  updateLaunchNote(bluetoothSupported, linked, armed, locked, reconnecting);
}

function updateLaunchNote(bluetoothSupported, linked, armed, locked, reconnecting) {
  const note = el('ble-note');
  if (!note) return;
  if (!bluetoothSupported) {
    note.textContent = 'Web Bluetooth needs Chrome or Edge over localhost/HTTPS to reach the controller.';
    return;
  }
  if (reconnecting) { note.textContent = 'Link dropped — automatic reconnect in progress. Commands resume once relinked.'; return; }
  if (locked) { note.textContent = 'Controller locked after too many wrong codes — reboot the ESP32 to reset.'; return; }
  const critical = armed || launchCountdownActive || sharedCountdownActive || !!currentStatus().countdown;
  if (critical && bleLink.connected && (!navigator.wakeLock?.request || wakeLockError)) {
    note.textContent = 'Keep this BLE host visible and the screen awake — automatic screen wake lock is unavailable.';
    return;
  }
  if (critical && !bleLink.connected && sharedState.host?.visibility !== 'visible') {
    note.textContent = 'BLE host is backgrounded — keep its tab visible and screen awake for reliable heartbeats.';
    return;
  }
  if (lcStep === 0) note.textContent = linked
    ? `Linked${currentStatus().firmwareVersion ? ` · firmware ${currentStatus().firmwareVersion}` : ''}. Continue to the checklist.`
    : 'Pair the NeoLabs controller to begin.';
  else if (lcStep === 1) note.textContent = 'Confirm every checklist item to enable arming.';
  else if (lcStep === 2) note.textContent = armed ? 'Armed. Continue to the launch step.' : 'Review launch conditions, then arm.';
  else note.textContent = 'Hold for a clear range and airspace, then start the countdown. Abort is always available.';
}

function checkLaunchLinkHealth() {
  // The BLE link watchdog lives in ble-link.js. Here we only expire shared
  // (server-relayed) state when the owner's heartbeats stop arriving.
  if (!bleLink.connected && sharedState.ownerActive && sharedStateReceivedAt && Date.now() - sharedStateReceivedAt > 8000) {
    sharedState = { connected: false, ownerActive: false, ownerName: '', status: null, countdown: null };
    bleStatusData = null;
    applySharedCountdownState(null, true);
    publishCameraSharedState();
    setLaunchState('Shared BLE sync lost — reconnecting', 'warn');
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
  sendBle({ cmd: 'heartbeat', left }).catch(() => {});
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

function formatControllerError(error) {
  const messages = {
    abort: 'Controller safely aborted',
    disarm: 'Controller disarmed',
    heartbeat_lost: 'Countdown stopped: live heartbeat was lost',
    owner_lost: 'Controller disarmed: BLE owner was lost',
    not_owner: 'Controller is armed by a different session — disarm/abort first, then arm again',
    not_armed: 'Command rejected: controller is not armed',
    trigger_active: 'Command rejected: trigger output is already active',
    locked: 'Controller is locked until reboot',
    unknown_cmd: 'Controller received an unsupported command'
  };
  return messages[error] || `Controller reported: ${String(error).replaceAll('_', ' ')}`;
}

function broadcastLaunch(payload) {
  const durable = ['countdown_start', 'abort', 'ignition'].includes(payload.type);
  const message = {
    ...payload,
    ...(durable ? { eventId: payload.eventId || makeSessionId() } : {}),
    source: 'launch-dashboard',
    at: Date.now()
  };
  if (durable) lastLaunchEvent = message;
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
    sync.relay(message);
  } else {
    // Throttle ticks to one relay per second (150ms timer fires 6-7x/sec)
    const now = Date.now();
    if (!broadcastLaunch._lastRelay || now - broadcastLaunch._lastRelay >= 950) {
      broadcastLaunch._lastRelay = now;
      sync.relay(message);
    }
  }
}

function broadcastBleState() {
  sync.relay({
    type: 'ble_state',
    connected: bleLink.connected,
    reconnecting: bleLink.state === 'reconnecting',
    deviceName: bleLink.deviceName || '',
    status: bleStatusData,
    source: 'launch-dashboard',
    at: Date.now()
  });
}

async function ensureLaunchAuthorization() {
  const status = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({ codeRequired: false }));
  if (!status.codeRequired) { joinAuthorized = false; return true; }
  if (status.authenticated) { joinAuthorized = true; return true; }
  const code = await showJoinCodeDialog();
  if (!code) return false;
  joinAuthorized = true;
  return true;
}

function showJoinCodeDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(2,5,14,.94);padding:20px';
    overlay.innerHTML = `<form style="width:min(420px,100%);padding:26px;border:1px solid #26385d;border-radius:16px;background:#0b1224;color:#e7efff">
      <div style="font-size:12px;letter-spacing:.18em;color:#6faeff;text-transform:uppercase">NeoLabs Rockets</div>
      <h2 style="margin:10px 0 8px">Launch code required</h2>
      <p style="color:#9aabc9;line-height:1.5">Another device currently owns the BLE connection. Enter the launch code stored on the ESP32 to share status and control.</p>
      <div data-status style="color:#ff776d;min-height:22px;margin-top:10px"></div>
      <input required autofocus inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" aria-label="Launch code" style="width:100%;margin:8px 0 14px;padding:13px;border:1px solid #334a75;border-radius:9px;background:#070d1b;color:white;font-size:22px;letter-spacing:.3em;text-align:center" placeholder="••••••">
      <button type="submit" style="width:100%;padding:13px;border:0;border-radius:9px;background:#347ee9;color:white;font-weight:700">Authorize</button>
    </form>`;
    document.body.appendChild(overlay);
    overlay.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const input = overlay.querySelector('input');
      const button = overlay.querySelector('button');
      const status = overlay.querySelector('[data-status]');
      const code = input.value.trim();
      if (!isValidCode(code)) return;
      input.disabled = true;
      button.disabled = true;
      button.textContent = 'Checking with ESP32…';
      status.textContent = '';
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          if (response.status === 401) throw new Error(`Invalid launch code${Number.isFinite(body.attemptsLeft) ? ` · ${body.attemptsLeft} attempts left` : ''}.`);
          if (response.status === 429) {
            const seconds = Math.max(1, Math.ceil(Number(body.retryAfterMs || 1000) / 1000));
            throw new Error(seconds <= 2
              ? 'Several code checks are already in progress. Try again in a moment.'
              : `Too many invalid attempts. Try again in ${seconds} seconds.`);
          }
          throw new Error('Code verification is temporarily unavailable.');
        }
        overlay.remove();
        resolve(code);
      } catch (error) {
        status.textContent = error.message || 'Could not reach the BLE owner.';
        input.value = '';
        input.disabled = false;
        button.disabled = false;
        button.textContent = 'Try again';
        input.focus();
      }
    });
  });
}

/* ─────────────────────────── Server sync wiring ─────────────────────────── */
function wireSync() {
  sync.on('shared_state', handleSharedState);

  sync.on('client_count', message => {
    serverClientCount = Math.max(0, Number(message.clients) || 0);
    renderLaunch();
  });

  sync.on('remote_command', message => {
    if (bleLink.connected && message.ownerId === CLIENT_ID) {
      // Treat each relayed command plus its fresh-status confirmation as one
      // transaction. BLE writes alone are serialized by NeoBleLink, but without
      // this queue concurrent remote clients could interleave their follow-up
      // status reads and receive a result belonging to a later command.
      remoteCommandQueue = remoteCommandQueue
        .then(() => executeRemoteCommand(message))
        .catch(error => console.error('[launch] remote command failed:', error));
    }
  });

  sync.on('auth_request', message => {
    if (bleLink.connected && message.ownerId === CLIENT_ID) {
      authVerificationQueue = authVerificationQueue.then(() => verifyJoinCode(message)).catch(() => {});
    }
  });

  sync.on('launch_event', message => {
    if (bleLink.connected) return;
    deliverSharedLaunchEvent(message);
  });

  sync.on('stream', ({ state }) => {
    if (state === 'open') {
      if (bleLink.connected) setLaunchState(`Linked to ${bleLink.deviceName || 'controller'}`, 'ok');
      else if (sharedState.ownerActive) setLaunchState('Connected through shared BLE owner', 'ok');
    } else if (!bleLink.connected) {
      if (sharedState.ownerActive && !joinAuthorized) return;
      setLaunchState('Sync reconnecting…', 'warn');
    }
  });

  sync.on('serverlink', link => {
    window.NeoServerLink = link;
    if (typeof renderStatus === 'function') renderStatus();
  });
}

function handleSharedState(state) {
  sharedState = state || {};
  sharedStateReceivedAt = Date.now();
  serverClientCount = Number(sharedState.viewers) || serverClientCount;
  if (!bleLink.connected) {
    bleStatusData = sharedState.ownerActive ? (sharedState.status || null) : null;
    if (sharedState.lastEvent) {
      const replay = sharedState.lastEvent.type === 'countdown_start' && sharedState.countdown?.active
        ? { ...sharedState.lastEvent, remainingMs: sharedState.countdown.remainingMs }
        : sharedState.lastEvent;
      deliverSharedLaunchEvent(replay);
    }
    // A durable lastEvent carries the exact transition (especially ignition
    // versus abort), so do not synthesize a generic camera abort from the
    // resulting inactive countdown snapshot.
    applySharedCountdownState(sharedState.ownerActive ? sharedState.countdown : null, !sharedState.lastEvent);
    if (sharedState.ownerActive && sharedState.reconnecting && bleLink.state !== 'reconnecting') {
      setLaunchState('BLE owner is relinking to the controller…', 'warn');
    } else if (sharedState.ownerActive && sharedState.connected) {
      setLaunchState('Connected through shared BLE owner', 'ok');
    }
    // The server says the lease is OURS but our BLE link is idle (reload,
    // dropped beacon, crashed link) — reattach automatically.
    if (sharedState.youAreOwner && bleLink.state === 'idle') maybeRestoreOwnBle();
  }
  publishCameraSharedState();
  renderLaunch();
}

function applySharedCountdownState(countdownState, notifyCamera = false) {
  const wasActive = sharedCountdownActive;
  if (!countdownState?.active) {
    sharedCountdownActive = false;
    sharedCountdownEndsAt = 0;
    if (!launchCountdownActive) {
      setText('ble-countdown', 'Idle');
      setText('ble-countdown-sub', 'No active sequence');
    }
    if (notifyCamera && wasActive && typeof window.NeoCameraLaunchEvent === 'function') {
      window.NeoCameraLaunchEvent({ type: 'sync_lost', source: 'launch-dashboard', at: Date.now() });
    }
    return;
  }
  sharedCountdownActive = true;
  const remainingMs = Number(countdownState.remainingMs ?? countdownState.leftMs);
  sharedCountdownEndsAt = Number.isFinite(remainingMs)
    ? Date.now() + Math.max(0, remainingMs)
    : (Number(countdownState.endsAt) || sharedCountdownEndsAt);
  const left = Number.isFinite(Number(countdownState.left))
    ? Math.max(0, Number(countdownState.left))
    : Math.max(0, Math.ceil((sharedCountdownEndsAt - Date.now()) / 1000));
  setText('ble-countdown', left > 0 ? `T-${left}` : 'Ignition');
  setText('ble-countdown-sub', 'Synchronized from BLE owner');
  if (notifyCamera && !wasActive && typeof window.NeoCameraLaunchEvent === 'function') {
    window.NeoCameraLaunchEvent({
      type: 'countdown_start', source: 'launch-dashboard', at: Date.now(),
      seconds: Math.max(1, Math.ceil(Math.max(0, sharedCountdownEndsAt - Date.now()) / 1000)),
      endsAt: sharedCountdownEndsAt,
      remainingMs: Math.max(0, sharedCountdownEndsAt - Date.now())
    });
  }
}

function applySharedLaunchEvent(message) {
  if (message.type === 'countdown_start' || message.type === 'countdown_tick') {
    applySharedCountdownState({
      active: true,
      endsAt: message.endsAt,
      left: message.left,
      leftMs: message.leftMs,
      remainingMs: message.remainingMs
    });
  } else {
    applySharedCountdownState({ active: false });
  }
  renderLaunch();
}

function deliverSharedLaunchEvent(message) {
  const eventId = String(message?.eventId || '');
  if (eventId && seenSharedLaunchEvents.has(eventId)) return false;
  if (eventId) {
    seenSharedLaunchEvents.add(eventId);
    if (seenSharedLaunchEvents.size > 100) seenSharedLaunchEvents.delete(seenSharedLaunchEvents.values().next().value);
  }
  applySharedLaunchEvent(message);
  if (typeof window.NeoCameraLaunchEvent === 'function') window.NeoCameraLaunchEvent(message);
  return true;
}

function publishCameraSharedState() {
  if (typeof window.NeoCameraBleState !== 'function') return;
  // A camera client has no local GATT connection, so explicitly bridge the
  // server's owner heartbeat into the camera HUD. Local BLE always wins on the
  // owner device; remote devices use the server-authoritative owner TTL.
  const sharedConnected = !!sharedState.ownerActive && !!sharedState.connected;
  try {
    window.NeoCameraBleState({
      type: 'ble_state',
      connected: bleLink.connected || sharedConnected,
      shared: !bleLink.connected && sharedConnected,
      deviceName: bleLink.deviceName || sharedState.ownerName || '',
      status: bleLink.connected ? bleStatusData : sharedState.status,
      source: bleLink.connected ? 'local-ble' : 'shared-server',
      at: Number(sharedState.updatedAt) || Date.now()
    });
  } catch (_) {}
}

async function verifyJoinCode(message) {
  let valid = false;
  try {
    valid = await new Promise(async resolve => {
      const timer = setTimeout(() => { authStatusWaiter = null; resolve(false); }, 2500);
      authStatusWaiter = result => { clearTimeout(timer); authStatusWaiter = null; resolve(result); };
      try { await sendBle({ cmd: 'auth', code: message.code }); } catch (_) { clearTimeout(timer); authStatusWaiter = null; resolve(false); }
    });
  } finally {
    fetch('/api/auth/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, requestId: message.requestId, valid })
    }).catch(() => {});
  }
}

function startOwnerHeartbeat() {
  stopOwnerHeartbeat();
  publishOwnerSnapshot();
  ownerHeartbeatTimer = setInterval(publishOwnerSnapshot, 1000);
}

function stopOwnerHeartbeat() {
  clearInterval(ownerHeartbeatTimer);
  ownerHeartbeatTimer = null;
}

function shouldHoldLaunchWakeLock() {
  const status = currentStatus();
  return bleLink.connected && (wakeLockPreflight || !!status.armed || !!status.countdown || launchCountdownActive);
}

async function ensureLaunchWakeLock() {
  if (!shouldHoldLaunchWakeLock() && !bleLink.connected) return false;
  if (!navigator.wakeLock?.request || document.visibilityState !== 'visible') return false;
  if (launchWakeLock && !launchWakeLock.released) return true;
  if (wakeLockRequest) return wakeLockRequest;
  clearTimeout(wakeLockRetryTimer);
  wakeLockRetryTimer = null;
  wakeLockRequest = navigator.wakeLock.request('screen').then(lock => {
    launchWakeLock = lock;
    wakeLockError = '';
    lock.addEventListener('release', () => {
      if (launchWakeLock === lock) launchWakeLock = null;
      if (!wakeLockReleaseIntentional && shouldHoldLaunchWakeLock() && document.visibilityState === 'visible') {
        wakeLockRetryTimer = setTimeout(ensureLaunchWakeLock, 1000);
      }
      renderLaunch();
      publishOwnerSnapshot();
    });
    if (!shouldHoldLaunchWakeLock() || document.visibilityState !== 'visible') {
      releaseLaunchWakeLock();
      return false;
    }
    renderLaunch();
    publishOwnerSnapshot();
    return true;
  }).catch(error => {
    wakeLockError = String(error?.message || error || 'unavailable');
    return false;
  }).finally(() => {
    wakeLockRequest = null;
  });
  return wakeLockRequest;
}

function releaseLaunchWakeLock() {
  clearTimeout(wakeLockRetryTimer);
  wakeLockRetryTimer = null;
  const lock = launchWakeLock;
  launchWakeLock = null;
  if (!lock || lock.released) return;
  wakeLockReleaseIntentional = true;
  Promise.resolve(lock.release()).catch(() => {}).finally(() => {
    wakeLockReleaseIntentional = false;
  });
}

function syncLaunchWakeLock() {
  if (shouldHoldLaunchWakeLock()) ensureLaunchWakeLock();
  else releaseLaunchWakeLock();
}

// Attempt to re-establish our own BLE link without a chooser prompt.
// Throttled so repeated triggers (SSE updates, failed commands) don't stack.
let ownBleRestoreAt = 0;
function maybeRestoreOwnBle() {
  if (bleLink.state !== 'idle' || !NeoBleLink.supported()) return;
  if (Date.now() - ownBleRestoreAt < 15000) return;
  ownBleRestoreAt = Date.now();
  setLaunchState('This device owns the launch session — restoring BLE link…', 'warn');
  bleLink.restoreGranted().catch(() => {
    setLaunchState('Could not restore the BLE link — open the console and reconnect', 'warn');
  });
}

const REMOTE_COMMAND_ERRORS = {
  no_ble_owner: 'No device currently owns the BLE link — connect BLE first',
  owner_unreachable: 'The BLE owner dashboard is not reachable — reopen it or connect BLE on this device',
  ble_owner_is_this_device: 'This device owns the BLE link but the link is down — reconnecting, try again in a moment'
};

async function sendRemoteCommand(command, args = {}) {
  // Never route a command through the server back to ourselves: if we hold
  // the owner lease but BLE is down, the fix is reconnecting BLE, not RPC.
  if (sharedState.youAreOwner) {
    maybeRestoreOwnBle();
    throw new Error(REMOTE_COMMAND_ERRORS.ble_owner_is_this_device);
  }
  setLaunchState('Waiting for BLE controller…', 'warn');
  try {
    return await sync.sendCommand(command, args, ensureLaunchAuthorization);
  } catch (err) {
    const friendly = REMOTE_COMMAND_ERRORS[err.message];
    if (err.message === 'ble_owner_is_this_device') maybeRestoreOwnBle();
    throw friendly ? new Error(friendly) : err;
  }
}

async function executeRemoteCommand(message) {
  try {
    const { command, args = {} } = message;
    if (command === 'arm') await armWithCode('');
    else if (command === 'disarm') await disarmController();
    else if (command === 'countdown_start') await startCountdownWithCode(clamp(Number(args.seconds), 5, 60), '');
    else if (command === 'abort') await abortController();
    await requestFreshBleStatus();
    sync.relay({ type: 'command_result', commandId: message.commandId, ok: true, status: bleStatusData });
  } catch (err) {
    sync.relay({ type: 'command_result', commandId: message.commandId, ok: false, error: String(err.message || err), status: bleStatusData });
  }
}

function storeBleState(extra = {}) {
  const sharedConnected = !bleLink.connected && !!sharedState.ownerActive && !!sharedState.connected;
  const message = {
    connected: bleLink.connected || sharedConnected,
    shared: sharedConnected,
    reconnecting: bleLink.state === 'reconnecting',
    deviceName: bleLink.deviceName || (sharedConnected ? sharedState.ownerName : '') || '',
    status: bleLink.connected ? bleStatusData : (sharedConnected ? sharedState.status : null),
    source: bleLink.connected ? 'local-ble' : sharedConnected ? 'shared-server' : 'local-state',
    lastStatusAt: bleLink.lastActivityAt,
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

function reserveUniqueClientId() {
  if (!CLIENT_ID_CHANNEL) return Promise.resolve();
  const probeId = makeSessionId();
  let occupied = false;
  CLIENT_ID_CHANNEL.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'probe' && message.clientId === CLIENT_ID && message.instanceId !== CLIENT_INSTANCE_ID) {
      CLIENT_ID_CHANNEL.postMessage({
        type: 'occupied',
        clientId: CLIENT_ID,
        instanceId: CLIENT_INSTANCE_ID,
        probeId: message.probeId
      });
    } else if (message.type === 'occupied' && message.probeId === probeId && message.clientId === CLIENT_ID) {
      occupied = true;
    }
  });
  CLIENT_ID_CHANNEL.postMessage({
    type: 'probe',
    clientId: CLIENT_ID,
    instanceId: CLIENT_INSTANCE_ID,
    probeId
  });
  return new Promise(resolve => {
    setTimeout(() => {
      if (occupied) {
        CLIENT_ID = makeSessionId();
        sessionStorage.setItem('neolabs.clientId', CLIENT_ID);
      }
      resolve();
    }, 100);
  });
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
