/*
  Rocket computer dashboard integration.

  Independent of NeoBleLink (launch controller). Renders the Mission Control
  rocket card, Launch Console dual-connect panel, header pills, and mirrors
  arm/countdown/abort from the launch flow when the rocket link is up.
*/
(function () {
  'use strict';

  const rocketLink = new RocketBleLink();
  let status = null;
  let telemetry = null;
  let expectedDisconnect = false;
  let lastErrorText = '';

  function el(id) { return document.getElementById(id); }
  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value == null || value === '' ? '—' : String(value);
  }
  function setDisabled(id, disabled) {
    const node = el(id);
    if (node) node.disabled = !!disabled;
  }
  function on(id, event, fn) {
    const node = el(id);
    if (node) node.addEventListener(event, fn);
  }

  function phaseLooksInFlight(s) {
    if (!s) return false;
    const m = s.m || '';
    const ph = s.ph || '';
    return ['ASCENT', 'COAST', 'APOGEE', 'DESCENT'].includes(m)
      || ['LIFTOFF', 'POWERED_ASCENT', 'COAST', 'APOGEE', 'DESCENT', 'IMPACT'].includes(ph)
      || (s.lo != null && Number(s.lo) >= 0);
  }

  function isRecording(s) {
    if (!s) return false;
    if (s.rec === 1 || s.rec === true) return true;
    const r = Number(s.r);
    // RecordingState: ACTIVE=2, POST_LANDING=3
    return r === 2 || r === 3;
  }

  function linkLabel() {
    if (rocketLink.state === 'connected') return 'Connected';
    if (rocketLink.state === 'connecting') return 'Connecting…';
    if (rocketLink.state === 'reconnecting') {
      return expectedDisconnect ? 'RF loss (expected)' : 'Reconnecting…';
    }
    return 'Not connected';
  }

  function shortLinkLabel() {
    if (rocketLink.state === 'connected') return 'Linked';
    if (rocketLink.state === 'connecting') return '…';
    if (rocketLink.state === 'reconnecting') return expectedDisconnect ? 'RF loss' : 'Retry';
    return 'Skip OK';
  }

  function healthSummary(s) {
    if (!rocketLink.connected) return 'Not linked';
    const parts = [];
    parts.push(sdLabel(s.sd));
    parts.push(camLabel(s.cam));
    const imu = s.imu === 0 ? 'IMU ok' : s.imu == null ? 'IMU ?' : 'IMU fault';
    const baro = s.baro === 0 ? 'Baro ok' : s.baro == null ? 'Baro ?' : 'Baro fault';
    parts.push(imu, baro);
    return parts.join(' · ');
  }

  function recorderReady(s) {
    if (!rocketLink.connected || !s) return false;
    const sdOk = s.sd === 2 || s.sd === 5; // MOUNTED / WRITING
    const camOk = s.cam === 1 || s.cam === 2 || s.cam === 4; // READY / RECORDING / FALLBACK
    return sdOk && camOk;
  }

  function fmt(v, suffix = '') {
    if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
    return `${Number(v).toFixed(2)}${suffix}`;
  }

  function tempLabel(v) {
    if (v == null || Number(v) <= -900) return '—';
    return `${Number(v).toFixed(1)}°`;
  }

  function sdLabel(code) {
    const map = { 0: 'Unknown', 1: 'Missing', 2: 'Mounted', 3: 'Full', 4: 'Error', 5: 'Writing' };
    return map[code] ?? (code == null ? '—' : String(code));
  }

  function camLabel(code) {
    const map = { 0: 'Uninit', 1: 'Ready', 2: 'Recording', 3: 'Failed', 4: 'Fallback' };
    return map[code] ?? (code == null ? '—' : String(code));
  }

  function setBadge(mode) {
    // mode: offline | link | ready | rec | flight | rf | error
    const badge = el('rc-go-badge');
    const label = el('rc-go-label');
    if (!badge || !label) return;
    badge.classList.remove('go', 'nogo', 'marginal');
    const map = {
      offline: ['marginal', 'RC'],
      link: ['marginal', 'LINK'],
      ready: ['go', 'READY'],
      rec: ['nogo', 'REC'],
      flight: ['nogo', 'FLIGHT'],
      rf: ['marginal', 'RF'],
      error: ['nogo', 'ERR']
    };
    const [cls, text] = map[mode] || map.offline;
    badge.classList.add(cls);
    label.textContent = text;
  }

  function updatePills() {
    const pill = el('pill-rc');
    const dot = el('pill-rc-dot');
    setText('pill-rc-val', shortLinkLabel());
    if (!pill) return;
    pill.classList.toggle('online', rocketLink.connected);
    pill.classList.toggle('warn', rocketLink.state === 'reconnecting' || rocketLink.state === 'connecting');
    pill.classList.toggle('flight', expectedDisconnect && !rocketLink.connected);
    if (dot) {
      dot.classList.toggle('on', rocketLink.connected);
      dot.classList.toggle('pulse', isRecording(status));
    }
  }

  function updateLaunchConsole() {
    const s = status || {};
    const rec = isRecording(s);
    setText('lc-rc-link', rocketLink.connected
      ? (rocketLink.deviceName || 'Linked')
      : rocketLink.state === 'reconnecting'
        ? (expectedDisconnect ? 'RF loss (expected)' : 'Reconnecting…')
        : 'Offline');
    setText('lc-rc-recording', !rocketLink.connected ? '—' : rec ? 'Recording' : (s.m || 'Idle'));
    setText('lc-rc-health', healthSummary(s));
    setText('lc-rc-armed-rec', !rocketLink.connected ? 'Not linked (OK)' : rec ? 'Active' : (s.m || 'Idle'));
    setText('lc-rc-armed-sub', !rocketLink.connected
      ? 'Not required · skip for rockets without onboard compute'
      : rec
        ? 'Video + telemetry writing to microSD'
        : 'Will start when you arm the controller');

    const card = el('lc-device-rocket');
    if (card) {
      card.classList.toggle('linked', rocketLink.connected);
      card.classList.toggle('recording', rec);
      card.classList.toggle('expected-rf', expectedDisconnect && !rocketLink.connected);
      card.classList.toggle('skipped', !rocketLink.connected && !expectedDisconnect);
    }
    const badge = el('lc-rc-badge');
    if (badge) {
      badge.textContent = rocketLink.connected
        ? (rec ? 'Recording' : 'Linked')
        : expectedDisconnect ? 'Autonomous' : 'Highly recommended';
      badge.classList.toggle('ok', rocketLink.connected && !expectedDisconnect);
      badge.classList.toggle('rec', rec);
      badge.classList.toggle('optional', !rocketLink.connected);
    }

    // Checklist rocket readiness row — advisory only, never blocks arming
    const check = el('lc-rocket-check');
    if (check) {
      check.classList.toggle('continuity-ok', rocketLink.connected && recorderReady(s));
      check.classList.toggle('continuity-bypassed', !rocketLink.connected);
      check.classList.toggle('continuity-unknown', false);
      check.classList.toggle('continuity-bad', rocketLink.connected && !recorderReady(s));
    }
    setText('lc-rocket-title', !rocketLink.connected
      ? 'Rocket computer not linked — not required'
      : recorderReady(s)
        ? 'Rocket computer ready'
        : 'Rocket computer linked — check SD / camera');
    setText('lc-rocket-detail', !rocketLink.connected
      ? 'Highly recommended when the rocket has onboard compute. Safe to skip for bare airframes. Does not block arming or countdown.'
      : recorderReady(s)
        ? 'microSD and camera ready. Arming the controller will start recording.'
        : healthSummary(s));

    // Countdown step dual status
    setText('lc-cd-rc', !rocketLink.connected
      ? (expectedDisconnect ? 'Autonomous (RF lost)' : 'Not linked · OK without onboard PC')
      : rec
        ? `Recording · ${s.ph || s.m || 'active'}`
        : (s.m || 'Linked'));

    setDisabled('lc-rc-connect', rocketLink.state === 'connected' || rocketLink.state === 'connecting');
    setDisabled('lc-rc-disconnect', rocketLink.state === 'idle' && !rocketLink.device);
    const lcConnect = el('lc-rc-connect');
    if (lcConnect) {
      lcConnect.textContent = rocketLink.state === 'reconnecting'
        ? 'Retry rocket link'
        : rocketLink.state === 'connecting'
          ? 'Connecting…'
          : rocketLink.connected
            ? 'Rocket linked'
            : 'Connect rocket computer';
    }
  }

  function render() {
    const s = status || {};
    const t = telemetry || {};
    const rec = isRecording(s);
    const inFlight = phaseLooksInFlight(s);
    if (inFlight) expectedDisconnect = true;

    setText('rc-link', linkLabel());
    setText('rc-link-state', rocketLink.connected ? 'Online' : rocketLink.state === 'reconnecting' ? 'Reconnecting' : 'Offline');
    setText('rc-device', rocketLink.deviceName || 'XIAO ESP32-S3 Sense');
    setText('rc-last-contact', rocketLink.lastActivityAt
      ? `${Math.max(0, Math.round((Date.now() - rocketLink.lastActivityAt) / 1000))} s ago`
      : '—');
    setText('rc-rf-note', expectedDisconnect && !rocketLink.connected
      ? 'Autonomous recording continues'
      : 'RF loss after liftoff expected');

    setText('rc-mission', s.m || '—');
    setText('rc-phase', s.ph || '—');
    setText('rc-recording', rec ? (Number(s.r) === 3 ? 'Post-landing' : 'Recording') : 'Idle');
    setText('rc-sd', sdLabel(s.sd));
    setText('rc-camera', camLabel(s.cam));
    setText('rc-fps', s.fps != null ? Number(s.fps).toFixed(1) : (t.fps != null ? Number(t.fps).toFixed(1) : '—'));
    setText('rc-frames', s.fw != null ? String(s.fw) : '0');
    setText('rc-dropped', s.fd != null ? String(s.fd) : '0');
    setText('rc-free', s.free_kb != null ? `${s.free_kb} KB` : '—');

    const ax = t.ax ?? s.ax;
    const ay = t.ay ?? s.ay;
    const az = t.az ?? s.az;
    const amag = t.g ?? s.amag;
    setText('rc-ax', fmt(ax));
    setText('rc-ay', fmt(ay));
    setText('rc-az', fmt(az));
    setText('rc-amag', fmt(amag));
    setText('rc-alt', fmt(t.h ?? s.alt, ' m'));
    setText('rc-vz', fmt(t.vz ?? s.vz, ' m/s'));
    setText('rc-pressure', fmt(t.p ?? s.p, ''));
    setText('rc-temp-bmp', tempLabel(s.tb));
    setText('rc-temp-imu', tempLabel(s.ti));
    setText('rc-temp-mcu', tempLabel(s.tm));

    setText('rc-liftoff', s.lo != null && Number(s.lo) >= 0 ? `T+ mono` : '—');
    if (s.lo != null && Number(s.lo) >= 0) setText('rc-liftoff', `mono ${s.lo}`);
    setText('rc-countdown', s.left != null && Number(s.left) >= 0
      ? `T-${Math.ceil(Number(s.left) / 1000)}`
      : 'Idle');

    const err = (s.e && String(s.e).trim()) || lastErrorText || '—';
    const warn = (s.w && String(s.w).trim()) || '—';
    setText('rc-error', err);
    setText('rc-warning', warn);

    // Show live chips when linked
    const telemRow = el('rc-telem-row');
    const axes = el('rc-axes');
    if (telemRow) telemRow.hidden = !rocketLink.connected && !expectedDisconnect;
    if (axes) axes.hidden = !rocketLink.connected && !expectedDisconnect;

    // Card chrome
    const card = el('rocket-computer-card');
    if (card) {
      card.classList.toggle('linked', rocketLink.connected);
      card.classList.toggle('recording', rec);
      card.classList.toggle('in-flight', inFlight || (expectedDisconnect && !rocketLink.connected));
      card.classList.toggle('expected-rf', expectedDisconnect && rocketLink.state !== 'connected');
    }
    const recItem = el('rc-recording-item');
    if (recItem) recItem.classList.toggle('is-recording', rec);

    if (s.e && String(s.e).trim()) setBadge('error');
    else if (expectedDisconnect && !rocketLink.connected) setBadge('rf');
    else if (inFlight) setBadge('flight');
    else if (rec) setBadge('rec');
    else if (rocketLink.connected && recorderReady(s)) setBadge('ready');
    else if (rocketLink.connected) setBadge('link');
    else if (rocketLink.state === 'connecting' || rocketLink.state === 'reconnecting') setBadge('link');
    else setBadge('offline');

    const note = el('rc-note');
    if (note) {
      note.classList.remove('ok', 'warn');
      if (expectedDisconnect && !rocketLink.connected) {
        note.textContent = 'Rocket RF loss after liftoff is normal. Onboard recording continues until landing + 30 s.';
        note.classList.add('ok');
      } else if (rocketLink.connected && rec) {
        note.textContent = 'Recording to microSD. Launch Console arm/countdown is mirrored automatically.';
        note.classList.add('ok');
      } else if (rocketLink.connected) {
        note.textContent = 'Rocket computer linked. Arming from the Launch Console starts video + telemetry.';
        note.classList.add('ok');
      } else {
        note.textContent = 'Highly recommended for rockets with onboard compute. Not required for airframes without a computer — launch controller alone is enough to fly.';
        note.classList.add('warn');
      }
    }

    const connected = rocketLink.connected;
    setDisabled('rc-connect', rocketLink.state === 'connected' || rocketLink.state === 'connecting');
    setDisabled('rc-disconnect', rocketLink.state === 'idle' && !rocketLink.device);
    setDisabled('rc-arm', !connected);
    setDisabled('rc-disarm', !connected || inFlight);
    setDisabled('rc-start-rec', !connected);
    setDisabled('rc-stop-rec', !connected || inFlight);
    setDisabled('rc-abort', !connected);
    setDisabled('rc-ground-test', !connected || inFlight || rec);

    const connectBtn = el('rc-connect');
    if (connectBtn) {
      connectBtn.textContent = rocketLink.state === 'reconnecting'
        ? 'Retry connection'
        : rocketLink.state === 'connecting'
          ? 'Connecting…'
          : connected
            ? 'Connected'
            : 'Connect rocket computer';
    }

    updatePills();
    updateLaunchConsole();
  }

  async function connect() {
    try {
      if (rocketLink.state === 'reconnecting') {
        rocketLink.retryNow();
        return;
      }
      lastErrorText = '';
      await rocketLink.connectViaChooser();
    } catch (err) {
      lastErrorText = err.message || String(err);
      setText('rc-error', lastErrorText);
    }
    render();
  }

  function disconnect() {
    expectedDisconnect = false;
    rocketLink.disconnect();
    render();
  }

  async function sendCmd(payload) {
    if (!rocketLink.connected) throw new Error('Rocket computer not connected');
    if (payload.cmd === 'stop_recording' && phaseLooksInFlight(status)) {
      throw new Error('Cannot stop recording during flight');
    }
    if (payload.cmd === 'reset' && phaseLooksInFlight(status)) {
      throw new Error('Cannot reset during flight');
    }
    await rocketLink.send(payload);
  }

  async function safe(label, fn) {
    try {
      await fn();
    } catch (err) {
      lastErrorText = err.message || String(err);
      console.warn(`[rocket] ${label}:`, err);
      setText('rc-error', lastErrorText);
    }
    render();
  }

  window.NeoRocketComputer = {
    link: rocketLink,
    connected: () => rocketLink.connected,
    status: () => status,
    expectedRfLoss: () => expectedDisconnect,
    isRecording: () => isRecording(status),
    render,

    async onArm() {
      if (!rocketLink.connected) return;
      await rocketLink.send({ cmd: 'sync_time', unix_ms: Date.now(), rtt_ms: 20 });
      await rocketLink.send({ cmd: 'arm' });
    },
    async onDisarm() {
      if (!rocketLink.connected) return;
      if (phaseLooksInFlight(status)) return;
      await rocketLink.send({ cmd: 'disarm' });
    },
    async onCountdownStart(seconds) {
      if (!rocketLink.connected) return;
      const ignition_unix_ms = Date.now() + seconds * 1000;
      await rocketLink.send({ cmd: 'sync_time', unix_ms: Date.now(), rtt_ms: 20 });
      await rocketLink.send({ cmd: 'countdown_start', seconds, ignition_unix_ms });
    },
    async onCountdownUpdate(leftSeconds) {
      if (!rocketLink.connected) return;
      await rocketLink.send({
        cmd: 'countdown_update',
        left: leftSeconds,
        ignition_unix_ms: Date.now() + leftSeconds * 1000
      });
    },
    async onAbort(reason) {
      if (!rocketLink.connected) return;
      await rocketLink.send({ cmd: 'abort', reason: reason || 'dashboard_abort' });
    },
    async onIgnition() {
      if (!rocketLink.connected) return;
      // Expected ignition already stored from countdown; mark expected disconnect UX.
      expectedDisconnect = true;
      render();
    }
  };

  function wire() {
    on('rc-connect', 'click', connect);
    on('rc-disconnect', 'click', disconnect);
    on('lc-rc-connect', 'click', connect);
    on('lc-rc-disconnect', 'click', disconnect);

    on('rc-arm', 'click', () => safe('arm', () => sendCmd({ cmd: 'arm' })));
    on('rc-disarm', 'click', () => safe('disarm', () => sendCmd({ cmd: 'disarm' })));
    on('rc-start-rec', 'click', () => safe('start_recording', () => sendCmd({ cmd: 'start_recording' })));
    on('rc-stop-rec', 'click', () => safe('stop_recording', () => sendCmd({ cmd: 'stop_recording' })));
    on('rc-abort', 'click', () => safe('abort', () => sendCmd({ cmd: 'abort', reason: 'ui' })));
    on('rc-ground-test', 'click', () => safe('ground_test', () => sendCmd({ cmd: 'ground_test', scenario: 'full_flight' })));

    rocketLink.on('state', () => render());
    rocketLink.on('status', s => { status = s; lastErrorText = ''; render(); });
    rocketLink.on('telemetry', t => { telemetry = t; render(); });
    rocketLink.on('event', () => render());
    rocketLink.on('health', () => render());

    if (RocketBleLink.supported()) {
      rocketLink.restoreGranted().catch(() => {});
    }
    render();
    setInterval(render, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
