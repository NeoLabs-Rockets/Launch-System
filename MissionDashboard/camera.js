/*
  NeoLabs Mission Dashboard — Launch Camera.
  Wrapped in an IIFE for the single-page app. Renders a cinematic broadcast HUD
  over the camera feed, follows the shared device countdown, and overlays live
  controller/flight/weather telemetry pulled from the dashboard (same document now).
*/
(function () {
  'use strict';

  let sourceStream = null;
  let audioStream = null;
  let mixedStream = null;
  let greenMixedStream = null;
  let recorder = null;
  let greenRecorder = null;
  let chunks = [];
  let greenChunks = [];
  let mainRecordingFinished = false;
  let greenRecordingFinished = false;
  let recordingCacheId = '';
  let cacheUploadTasks = [];
  let pendingGreenDownload = null;
  let drawFrameId = null;
  let recordStartedAt = 0;
  let durationTimer = null;
  let externalCountdownEndsAt = 0;
  let externalCountdownBaseEndsAt = 0;
  let externalCountdownActive = false;
  let externalCountdownTotalMs = 0;
  let ignitionAt = 0;
  let syncOffsetMs = 0;
  let cameraBleConnected = false;
  let cameraBleShared = false;
  let cameraBleDeviceName = '';
  let cameraControllerStatus = null;
  let countdownAudioCtx = null;
  let countdownAudioDest = null;
  let lastCountdownSpoken = null;
  let showTelemetry = true;
  let countdownFadeStart = 0;
  let countdownOpacity = 0;
  const seenLaunchEventIds = new Set();

  window.CameraApp = { onShow, onHide };
  // Same-document hooks so the BLE controller can push events without relying on
  // BroadcastChannel round-trips.
  window.NeoCameraLaunchEvent = applyLaunchEvent;
  window.NeoCameraBleState = applyBleState;

  document.addEventListener('DOMContentLoaded', () => {
    startStateTimer();
    bindControls();
    bindLaunchEvents();
    drawIdleFrame();
  });

  function onShow() {
    if (sourceStream) { startDrawLoop(); return; }
    // Auto-start the camera when the view is opened (no manual button). The nav
    // click that brought us here counts as the user gesture getUserMedia needs.
    drawIdleFrame();
    openCamera();
  }
  function onHide() {
    if (recorder?.state === 'recording') return; // never stop drawing while recording
    cancelAnimationFrame(drawFrameId);
    drawFrameId = null;
  }

  function bindControls() {
    document.getElementById('cam-record').addEventListener('click', startRecording);
    document.getElementById('cam-stop').addEventListener('click', stopRecording);
    document.getElementById('cam-download-green').addEventListener('click', downloadPendingGreenRecording);
    document.getElementById('cam-download-stats').addEventListener('click', downloadStatsImage);
    // Retry path with no extra button: tap the stage to re-request the camera.
    const stage = document.querySelector('#view-camera .camera-stage');
    if (stage) stage.addEventListener('click', () => { if (!sourceStream) openCamera(); });
    document.getElementById('cam-sync-offset').addEventListener('input', event => {
      syncOffsetMs = clamp(Number(event.target.value), -5000, 5000);
      updateExternalCountdownLabel();
    });
    const tele = document.getElementById('cam-telemetry');
    if (tele) tele.addEventListener('change', () => { showTelemetry = tele.value !== 'off'; });
    ['cam-title', 'cam-site', 'cam-mission'].forEach(id => {
      document.getElementById(id).addEventListener('input', drawIdleFrame);
    });
    ['cam-quality', 'cam-facing', 'cam-audio', 'cam-fps', 'cam-lens'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        if (sourceStream) openCamera();
      });
    });
  }

  function bindLaunchEvents() {
    const lc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('neolabs-launch') : null;
    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('neolabs-ble') : null;
    lc?.addEventListener('message', event => applyLaunchEvent(event.data));
    bc?.addEventListener('message', event => applyBleState(event.data));
    window.addEventListener('storage', event => {
      if (event.key === 'neolabs.launch.lastEvent' && event.newValue) {
        try { applyLaunchEvent(JSON.parse(event.newValue)); } catch (_) {}
      }
      if (event.key === 'neolabs.ble.state' && event.newValue) {
        try { applyBleState(JSON.parse(event.newValue)); } catch (_) {}
      }
    });
    // Restore link authority before any launch transition. Otherwise a stale
    // ignition event can start T+ while the controller is offline.
    try {
      const savedBle = JSON.parse(localStorage.getItem('neolabs.ble.state') || 'null');
      if (savedBle && Date.now() - savedBle.at < 15000) applyBleState(savedBle);
    } catch (_) {}
    try {
      const saved = JSON.parse(localStorage.getItem('neolabs.launch.lastEvent') || 'null');
      if (saved && Date.now() - saved.at < 45000) applyLaunchEvent(saved);
    } catch (_) {}
  }

  function applyLaunchEvent(data) {
    if (!data || !['ble-dashboard', 'launch-dashboard'].includes(data.source)) return;
    const eventId = String(data.eventId || '');
    if (eventId && seenLaunchEventIds.has(eventId)) return;
    if (eventId) {
      seenLaunchEventIds.add(eventId);
      if (seenLaunchEventIds.size > 100) seenLaunchEventIds.delete(seenLaunchEventIds.values().next().value);
    }
    if (data.type === 'countdown_start') {
      lastCountdownSpoken = null;
      ignitionAt = 0;
      const remainingMs = syncedRemainingMs(data);
      externalCountdownTotalMs = Math.max(1000, (data.seconds || 0) * 1000 || remainingMs || 1000);
      externalCountdownBaseEndsAt = Number.isFinite(remainingMs)
        ? Date.now() + Math.max(0, remainingMs)
        : (data.endsAt || (Date.now() + Math.max(0, data.left || data.seconds || 0) * 1000));
      externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
      if (!externalCountdownActive) countdownFadeStart = Date.now();
      externalCountdownActive = true;
      updateExternalCountdownLabel();
    } else if (data.type === 'countdown_tick') {
      const remainingMs = syncedRemainingMs(data);
      externalCountdownBaseEndsAt = Number.isFinite(remainingMs)
        ? Date.now() + Math.max(0, remainingMs)
        : (data.endsAt || (Date.now() + Math.max(0, data.left || 0) * 1000));
      externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
      if (!externalCountdownTotalMs) externalCountdownTotalMs = Math.max(1000, externalCountdownEndsAt - Date.now());
      externalCountdownActive = true;
      updateExternalCountdownLabel();
    } else if (data.type === 'ignition') {
      ignitionAt = Date.now();
      externalCountdownEndsAt = ignitionAt;
      if (!externalCountdownActive) countdownFadeStart = Date.now();
      externalCountdownActive = true; // keep drawing T+ until recording stops
      setText('cam-count-state', 'T+0:00 — Liftoff');
    } else if (data.type === 'abort') {
      externalCountdownActive = false;
      externalCountdownTotalMs = 0;
      ignitionAt = 0;
      lastCountdownSpoken = null;
      countdownFadeStart = 0;
      setText('cam-count-state', 'Aborted');
    } else if (data.type === 'sync_lost') {
      externalCountdownActive = false;
      externalCountdownTotalMs = 0;
      ignitionAt = 0;
      lastCountdownSpoken = null;
      countdownFadeStart = 0;
      setText('cam-count-state', 'Sync lost — outcome pending');
    }
  }

  function applyBleState(data) {
    if (!data) return;
    if (data.type === 'shared_state') data = data.state || {};
    cameraBleConnected = !!data.connected;
    cameraBleShared = cameraBleConnected && !!data.shared;
    cameraBleDeviceName = data.deviceName || '';
    cameraControllerStatus = data.status && typeof data.status === 'object' ? data.status : null;
    setText('cam-ble-state', cameraBleConnected
      ? `${cameraBleShared ? 'Shared BLE' : 'Direct BLE'}${cameraBleDeviceName ? ` · ${cameraBleDeviceName}` : ''}`
      : 'Offline');
    // BLE and launch-stream state never owns the MediaRecorder lifecycle. Every
    // device keeps capturing until its local Stop button is pressed.
  }

  function updateExternalCountdownLabel() {
    if (!externalCountdownActive) return;
    if (externalCountdownBaseEndsAt) externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
    const leftMs = externalCountdownEndsAt - Date.now();
    setText('cam-count-state', leftMs > 0 ? `Live T-${formatCountdown(leftMs)}` : 'Ignition');
    speakCountdownAt(leftMs);
  }

  function startStateTimer() {
    setInterval(() => { if (externalCountdownActive) updateExternalCountdownLabel(); }, 1000);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function quality() {
    const [width, height] = document.getElementById('cam-quality').value.split('x').map(Number);
    const fps = clamp(Number(document.getElementById('cam-fps').value), 24, 60);
    return { width, height, fps };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
  }

  async function openCamera() {
    stopStreams();
    const q = quality();
    const facingMode = document.getElementById('cam-facing').value;
    const lens = Number(document.getElementById('cam-lens')?.value || 0.7);
    const wantsAudio = document.getElementById('cam-audio').value === 'on';
    setStatus('Opening camera', 'Requesting device permissions.', 'warn');
    try {
      const selectedVideo = await openVideoStream(q, facingMode, lens);
      sourceStream = selectedVideo.stream;
      if (wantsAudio) {
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          });
          setText('cam-audio-state', 'Mic on');
        } catch (_) {
          audioStream = null;
          setText('cam-audio-state', 'Mic denied');
        }
      } else {
        setText('cam-audio-state', 'Mic off');
      }
      const video = document.getElementById('cam-source');
      video.srcObject = sourceStream;
      await video.play();
      resizeCanvas();
      startDrawLoop();
      document.getElementById('cam-record').disabled = false;
      setStatus('Camera ready', selectedVideo.detail || 'Preview includes the recorded overlay.', selectedVideo.applied === false ? 'warn' : 'ok');
    } catch (err) {
      setStatus('Camera unavailable', navigator.mediaDevices
        ? 'Allow camera permission or try another browser/device.'
        : 'Camera access needs HTTPS or localhost — this page was opened over plain HTTP.', 'bad');
      setText('cam-audio-state', 'Unavailable');
    }
  }

  function resizeCanvas() {
    const q = quality();
    ['cam-canvas', 'cam-green-canvas'].forEach(id => {
      const canvas = document.getElementById(id);
      canvas.width = q.width;
      canvas.height = q.height;
    });
  }

  function startDrawLoop() {
    cancelAnimationFrame(drawFrameId);
    const draw = () => {
      drawComposite();
      drawFrameId = requestAnimationFrame(draw);
    };
    draw();
  }

  function drawComposite() {
    const canvas = document.getElementById('cam-canvas');
    const ctx = canvas.getContext('2d');
    const greenCanvas = document.getElementById('cam-green-canvas');
    const greenCtx = greenCanvas.getContext('2d');
    const video = document.getElementById('cam-source');
    ctx.fillStyle = '#030713';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (video.readyState >= 2) drawCover(ctx, video, canvas.width, canvas.height);
    try { drawOverlay(ctx, canvas.width, canvas.height); } catch (_) {}

    // Capture the same live HUD against a chroma-key background so editors can
    // key the overlay over other footage without re-creating launch telemetry.
    greenCtx.fillStyle = '#00ff00';
    greenCtx.fillRect(0, 0, greenCanvas.width, greenCanvas.height);
    try { drawOverlay(greenCtx, greenCanvas.width, greenCanvas.height, { greenScreen: true }); } catch (_) {}
  }

  function drawCover(ctx, video, width, height) {
    const vw = video.videoWidth || width;
    const vh = video.videoHeight || height;
    const scale = Math.max(width / vw, height / vh);
    const sw = width / scale, sh = height / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  }

  // ── Cinematic broadcast overlay ──────────────────────────────────────────
  function drawOverlay(ctx, w, h, options = {}) {
    const title = document.getElementById('cam-title').value || 'NeoLabs Launch';
    const site = document.getElementById('cam-site').value || 'Launch Site';
    const mission = document.getElementById('cam-mission').value || 'Flight Test';
    const now = new Date();
    const rec = recorder?.state === 'recording';
    const elapsed = rec ? Math.floor((Date.now() - recordStartedAt) / 1000) : 0;
    if (externalCountdownActive && externalCountdownBaseEndsAt) {
      externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
    }
    const countdownMs = externalCountdownActive ? externalCountdownEndsAt - Date.now() : null;
    const u = w / 1920; // scale unit relative to 1080p design
    const pad = Math.round(60 * u);
    const accent = '#9fd4ff';

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // Preserve a uniform chroma field in the optional green-screen export.
    // The HUD elements remain identical; only the full-width legibility scrims
    // are omitted because they would contaminate most of the key color.
    if (!options.greenScreen) {
      const topGrad = ctx.createLinearGradient(0, 0, 0, h * 0.22);
      topGrad.addColorStop(0, 'rgba(3,7,19,.72)');
      topGrad.addColorStop(1, 'rgba(3,7,19,0)');
      ctx.fillStyle = topGrad;
      ctx.fillRect(0, 0, w, h * 0.22);
      const botGrad = ctx.createLinearGradient(0, h * 0.74, 0, h);
      botGrad.addColorStop(0, 'rgba(3,7,19,0)');
      botGrad.addColorStop(1, 'rgba(3,7,19,.82)');
      ctx.fillStyle = botGrad;
      ctx.fillRect(0, h * 0.74, w, h * 0.26);
    }

    // Corner brackets
    drawCorners(ctx, w, h, pad, accent, u);

    // Top-left brand block
    ctx.textAlign = 'left';
    ctx.fillStyle = '#dbe7ff';
    ctx.font = `800 ${Math.round(34 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillText('NEOLABS ROCKETS', pad, pad + Math.round(26 * u));
    ctx.font = `600 ${Math.round(20 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillStyle = accent;
    ctx.fillText(`${title.toUpperCase()} · ${mission} / ${site}`, pad, pad + Math.round(54 * u));

    // Top-right time + REC
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c9d6ef';
    ctx.font = `700 ${Math.round(24 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillText(now.toLocaleTimeString(), w - pad, pad + Math.round(24 * u));
    const recBlink = rec && (Math.floor(Date.now() / 500) % 2 === 0);
    ctx.font = `800 ${Math.round(22 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillStyle = rec ? '#ff4a3d' : '#9fd4ff';
    const statusTxt = rec ? `REC ${fmtClock(elapsed)}` : 'STANDBY';
    ctx.fillText(statusTxt, w - pad, pad + Math.round(54 * u));
    if (rec) {
      ctx.beginPath();
      ctx.arc(w - pad - ctx.measureText(statusTxt).width - Math.round(16 * u), pad + Math.round(46 * u), Math.round(7 * u), 0, Math.PI * 2);
      ctx.fillStyle = recBlink ? '#ff4a3d' : 'rgba(255,74,61,.25)';
      ctx.fill();
    }

    // Center countdown with progress ring
    if (externalCountdownActive) {
      if (countdownFadeStart) {
        countdownOpacity = Math.min(1, (Date.now() - countdownFadeStart) / 400);
      } else {
        countdownOpacity = 1;
      }
    } else {
      if (countdownOpacity > 0) {
        countdownOpacity = Math.max(0, countdownOpacity - (16 / 400));
      }
    }

    if (countdownOpacity > 0) {
      ctx.globalAlpha = countdownOpacity;
      drawCountdown(ctx, w, h, countdownMs || 0, u);
      ctx.globalAlpha = 1;
    }

    // Bottom telemetry strip
    drawTelemetry(ctx, w, h, pad, u, { rec, elapsed, countdownMs });

    ctx.restore();
  }

  function drawCorners(ctx, w, h, pad, color, u) {
    const len = Math.round(46 * u);
    const off = Math.round(pad * 0.55);
    ctx.strokeStyle = 'rgba(159,212,255,.55)';
    ctx.lineWidth = Math.max(1.5, 2.4 * u);
    const corner = (x, y, dx, dy) => {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * len); ctx.lineTo(x, y); ctx.lineTo(x + dx * len, y);
      ctx.stroke();
    };
    corner(off, off, 1, 1);
    corner(w - off, off, -1, 1);
    corner(off, h - off, 1, -1);
    corner(w - off, h - off, -1, -1);
  }

  function drawCountdown(ctx, w, h, ms, u) {
    const pad = Math.round(60 * u);
    const r = Math.round(130 * u);
    // Bottom-right, sitting above the telemetry strip
    const cx = w - pad - r - Math.round(18 * u);
    const cy = h - pad - Math.round(100 * u) - r;

    const postIgnition = ignitionAt > 0;
    const elapsedMs = postIgnition ? Date.now() - ignitionAt : 0;
    const total = externalCountdownTotalMs || Math.max(1000, ms > 0 ? ms : 10000);
    const frac = postIgnition ? 1 : (ms > 0 ? Math.max(0, Math.min(1, ms / total)) : 0);
    const col = postIgnition ? '#36f0a0' : (ms > 10000 ? '#9fd4ff' : ms > 3000 ? '#ffb347' : '#ff4a3d');

    // Subtle dark backdrop so ring reads against any background
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.round(14 * u), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(3,7,19,.55)';
    ctx.fill();

    // Track + progress arc
    ctx.lineWidth = Math.max(3, 7 * u);
    ctx.strokeStyle = 'rgba(159,212,255,.15)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // Timer text
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = col;
    ctx.shadowBlur = Math.round(20 * u);

    if (postIgnition) {
      ctx.font = `900 ${Math.round(72 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillText(`T+${formatCountdown(elapsedMs)}`, cx, cy + Math.round(22 * u));
      ctx.shadowBlur = 0;
      ctx.font = `700 ${Math.round(17 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillStyle = '#9fd4ff';
      ctx.fillText('ELAPSED', cx, cy + r + Math.round(28 * u));
    } else if (ms > 0) {
      ctx.font = `900 ${Math.round(80 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillText(`T-${formatCountdown(ms)}`, cx, cy + Math.round(22 * u));
      ctx.shadowBlur = 0;
      ctx.font = `700 ${Math.round(17 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillStyle = '#9fd4ff';
      ctx.fillText('LIVE COUNTDOWN', cx, cy + r + Math.round(28 * u));
    } else {
      ctx.font = `900 ${Math.round(56 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillText('IGNITION', cx, cy + Math.round(18 * u));
      ctx.shadowBlur = 0;
    }
    ctx.shadowBlur = 0;
  }

  function drawTelemetry(ctx, w, h, pad, u, ctx2) {
    const tiles = [];
    tiles.push(launchStateTile(ctx2.countdownMs));
    tiles.push(['AUDIO', audioStream ? 'MIC ON' : 'MIC OFF', audioStream ? '#dbe7ff' : '#ffb347']);

    if (showTelemetry) {
      const wx = (typeof weather !== 'undefined' && weather) ? weather.current : null;
      const rm = (typeof rocketModel !== 'undefined' && rocketModel) ? rocketModel : null;
      if (wx) {
        tiles.push(['WIND', `${Math.round(wx.wind_speed_10m)} km/h ${degToCompass(wx.wind_direction_10m)}`, '#9fd4ff']);
        tiles.push(['TEMP', `${Math.round(wx.temperature_2m)}°C`, '#dbe7ff']);
      }
      if (rm) tiles.push(['TARGET APOGEE', `${Math.round(rm.apogeeM)} m`, '#9fd4ff']);
    }
    tiles.push(['SYNC', `${syncOffsetMs} ms`, '#9fd4ff']);

    const baseY = h - pad - Math.round(8 * u);
    const gap = Math.round(34 * u);
    let x = pad;
    ctx.textAlign = 'left';
    tiles.forEach(([k, v, color]) => {
      ctx.font = `700 ${Math.round(15 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillStyle = '#64759c';
      ctx.fillText(k, x, baseY - Math.round(26 * u));
      ctx.font = `900 ${Math.round(24 * u)}px system-ui, Segoe UI, Arial`;
      ctx.fillStyle = color;
      ctx.fillText(v, x, baseY);
      const tileW = Math.max(ctx.measureText(v).width, ctx.measureText(k).width * 1.2);
      x += tileW + gap;
    });
    // (Branding lives in the top-left block; no bottom wordmark so the telemetry
    // tiles always have the full strip width and never get overlapped.)
  }

  function launchStateTile(countdownMs) {
    if (ignitionAt > 0) return ['LAUNCH STATE', 'LIFTOFF', '#36f0a0'];
    if (countdownMs != null && countdownMs <= 0) return ['LAUNCH STATE', 'IGNITION', '#36f0a0'];
    if (countdownMs != null) return ['LAUNCH STATE', 'COUNTDOWN', '#ffb347'];
    if (cameraControllerStatus?.trigger) return ['LAUNCH STATE', 'IGNITION', '#36f0a0'];
    if (cameraControllerStatus?.locked) return ['LAUNCH STATE', 'LOCKED', '#ff4a3d'];
    if (cameraControllerStatus?.countdown) return ['LAUNCH STATE', 'COUNTDOWN', '#ffb347'];
    if (cameraControllerStatus?.armed) return ['LAUNCH STATE', 'ARMED', '#ffb347'];
    if (cameraBleConnected && cameraControllerStatus) return ['LAUNCH STATE', 'SAFE', '#36f0a0'];
    return ['LAUNCH STATE', cameraBleConnected ? 'STATUS PENDING' : 'NO DATA', '#ffb347'];
  }

  function degToCompass(d) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round((d || 0) / 22.5) % 16];
  }

  function drawIdleFrame() {
    resizeCanvas();
    drawComposite();
  }

  async function startRecording() {
    if (!sourceStream) await openCamera();
    if (!sourceStream) return;
    const canvas = document.getElementById('cam-canvas');
    const greenCanvas = document.getElementById('cam-green-canvas');
    const q = quality();
    const videoTrackStream = canvas.captureStream(q.fps);
    const greenVideoTrackStream = greenCanvas.captureStream(q.fps);
    mixedStream = new MediaStream(videoTrackStream.getVideoTracks());
    greenMixedStream = new MediaStream(greenVideoTrackStream.getVideoTracks());
    if (audioStream) audioStream.getAudioTracks().forEach(track => {
      mixedStream.addTrack(track);
      greenMixedStream.addTrack(track);
    });
    ensureCountdownAudio();
    countdownAudioDest?.stream.getAudioTracks().forEach(track => {
      mixedStream.addTrack(track);
      greenMixedStream.addTrack(track);
    });

    chunks = [];
    greenChunks = [];
    clearPendingGreenDownload();
    mainRecordingFinished = false;
    greenRecordingFinished = false;
    recordingCacheId = makeRecordingId();
    cacheUploadTasks = [];
    const mimeType = preferredMimeType();
    recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    greenRecorder = new MediaRecorder(greenMixedStream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
    recorder.ondataavailable = e => {
      if (!e.data?.size) return;
      const index = chunks.length;
      chunks.push(e.data);
      cacheUploadTasks.push(uploadRecordingChunk(recordingCacheId, 'main', index, e.data));
    };
    greenRecorder.ondataavailable = e => {
      if (!e.data?.size) return;
      const index = greenChunks.length;
      greenChunks.push(e.data);
      cacheUploadTasks.push(uploadRecordingChunk(recordingCacheId, 'green', index, e.data));
    };
    recorder.onstop = () => finishRecording('main');
    greenRecorder.onstop = () => finishRecording('green');
    recorder.start(1000);
    greenRecorder.start(1000);
    recordStartedAt = Date.now();
    document.getElementById('cam-record').disabled = true;
    document.getElementById('cam-stop').disabled = false;
    setText('cam-download', 'Recording');
    durationTimer = setInterval(updateDuration, 250);
    setStatus('Recording', audioStream ? 'Video overlay and microphone audio are being recorded.' : 'Video overlay recording. Mic audio unavailable/off.', 'bad');
  }

  function preferredMimeType() {
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  function stopRecording() {
    if (recorder?.state === 'recording') recorder.stop();
    if (greenRecorder?.state === 'recording') greenRecorder.stop();
    clearInterval(durationTimer);
    externalCountdownActive = false;
    externalCountdownTotalMs = 0;
    ignitionAt = 0;
    countdownFadeStart = 0;
    countdownOpacity = 0;
    setText('cam-count-state', 'Idle');
    document.getElementById('cam-record').disabled = false;
    document.getElementById('cam-stop').disabled = true;
    setStatus('Processing download', 'Preparing the recorded WebM file.', 'warn');
  }

  function updateDuration() {
    setText('cam-duration', fmtClock(Math.floor((Date.now() - recordStartedAt) / 1000)));
  }

  async function finishRecording(which) {
    if (which === 'main') mainRecordingFinished = true;
    if (which === 'green') greenRecordingFinished = true;
    if (!mainRecordingFinished || !greenRecordingFinished) return;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    const greenBlob = new Blob(greenChunks, { type: greenRecorder.mimeType || 'video/webm' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    setStatus('Securing recording', 'Uploading any video chunks missed while the connection was unavailable.', 'warn');

    const cached = await finalizeBackendRecording();
    const mainDownload = cached ? await fetchCachedRecording('main') : null;
    const greenDownload = cached ? await fetchCachedRecording('green') : null;
    downloadBlob(mainDownload || blob, `neolabs-launch-${stamp}.webm`);
    if (mainDownload) await acknowledgeCachedRecording('main');
    pendingGreenDownload = {
      blob: greenDownload || greenBlob,
      filename: `neolabs-launch-green-screen-${stamp}.webm`,
      acknowledgeCache: cached,
      cacheId: recordingCacheId
    };
    const greenButton = document.getElementById('cam-download-green');
    greenButton.hidden = false;
    greenButton.disabled = false;
    const statsButton = document.getElementById('cam-download-stats');
    if (statsButton) {
      statsButton.hidden = false;
      statsButton.disabled = false;
    }
    setText('cam-download', `${Math.round(blob.size / 1024 / 1024 * 10) / 10} MB`);
    setStatus('Recording saved', cached
      ? 'Main download started. Use the buttons below for the overlay copy or flight stats photo.'
      : 'Main download started locally. Use the buttons below for the overlay copy or flight stats photo.', cached ? 'ok' : 'warn');
  }

  async function downloadPendingGreenRecording() {
    if (!pendingGreenDownload?.blob) return;
    const pending = pendingGreenDownload;
    const button = document.getElementById('cam-download-green');
    button.disabled = true;
    // This click is a dedicated user gesture, so Chrome does not classify the
    // overlay as a blocked second automatic download.
    downloadBlob(pending.blob, pending.filename);
    if (pending.acknowledgeCache) await acknowledgeCachedRecording('green', pending.cacheId);
    pendingGreenDownload = null;
    button.hidden = true;
    button.disabled = false;
    setStatus('Recordings saved', 'Main recording and green-screen overlay downloaded.', 'ok');
  }

  function clearPendingGreenDownload() {
    const stale = pendingGreenDownload;
    pendingGreenDownload = null;
    if (stale?.acknowledgeCache) acknowledgeCachedRecording('green', stale.cacheId);
    const button = document.getElementById('cam-download-green');
    if (button) {
      button.hidden = true;
      button.disabled = false;
    }
    const statsButton = document.getElementById('cam-download-stats');
    if (statsButton) {
      statsButton.hidden = true;
      statsButton.disabled = false;
    }
  }

  async function openVideoStream(q, facingMode, lens) {
    const videoConstraints = {
      facingMode: { ideal: facingMode },
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: q.fps },
      zoom: { ideal: lens }
    };
    let stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    const track = stream.getVideoTracks()[0];
    if (!track) return { stream, applied: false, detail: 'Camera opened, but no video track was reported.' };

    const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (capabilities.zoom && lens >= capabilities.zoom.min && lens <= capabilities.zoom.max) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: lens }] });
        return { stream, applied: true, detail: `${lens}× lens active. Preview includes the recorded overlay.` };
      } catch (_) {}
    }

    // Mobile browsers often expose the ultrawide camera as a separate device
    // instead of a numeric zoom capability. Labels become available after the
    // first permission grant above, so switch tracks without interrupting UI.
    if (lens === 0.7 && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const ultrawide = devices.find(device => device.kind === 'videoinput' && /ultra|wide.?angle|0[.,][5-8]\s*[xÃ—]?/i.test(device.label));
        const currentId = track.getSettings?.().deviceId;
        if (ultrawide?.deviceId && ultrawide.deviceId !== currentId) {
          const replacement = await navigator.mediaDevices.getUserMedia({
            video: { ...videoConstraints, facingMode: undefined, deviceId: { exact: ultrawide.deviceId } },
            audio: false
          });
          stream.getTracks().forEach(oldTrack => oldTrack.stop());
          stream = replacement;
          return { stream, applied: true, detail: '0.7× ultrawide lens active. Preview includes the recorded overlay.' };
        }
      } catch (_) {}
    }

    return {
      stream,
      applied: lens === 1,
      detail: lens === 0.7
        ? 'This browser did not expose an ultrawide lens; using the standard camera.'
        : '1× standard lens active. Preview includes the recorded overlay.'
    };
  }

  function syncedRemainingMs(data) {
    const exact = Number(data.remainingMs ?? data.leftMs);
    return Number.isFinite(exact) ? exact : NaN;
  }

  function makeRecordingId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `rec-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  async function uploadRecordingChunk(id, variant, index, blob) {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const response = await fetch(`/api/recordings/${encodeURIComponent(id)}/${variant}/chunks/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob
        });
        if (response.ok) return true;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return false;
      } catch (_) {}
      await delay(Math.min(5000, 400 * (2 ** Math.min(attempt, 4))));
    }
    return false;
  }

  async function finalizeBackendRecording() {
    const initialResults = await Promise.all(cacheUploadTasks);
    if (initialResults.some(ok => !ok)) {
      setStatus('Restoring connection', 'Retrying the complete recording cache from this device.', 'warn');
      const retryTasks = [];
      chunks.forEach((chunk, index) => retryTasks.push(uploadRecordingChunk(recordingCacheId, 'main', index, chunk)));
      greenChunks.forEach((chunk, index) => retryTasks.push(uploadRecordingChunk(recordingCacheId, 'green', index, chunk)));
      const retryResults = await Promise.all(retryTasks);
      if (retryResults.some(ok => !ok)) return false;
    }
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(recordingCacheId)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chunks: { main: chunks.length, green: greenChunks.length },
          mimeType: recorder.mimeType || 'video/webm'
        })
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  async function fetchCachedRecording(variant) {
    try {
      const response = await fetch(`/api/recordings/${encodeURIComponent(recordingCacheId)}/${variant}`, { cache: 'no-store' });
      return response.ok ? await response.blob() : null;
    } catch (_) {
      return null;
    }
  }

  async function acknowledgeCachedRecording(variant, id = recordingCacheId) {
    try {
      await fetch(`/api/recordings/${encodeURIComponent(id)}/${variant}`, { method: 'DELETE' });
    } catch (_) {}
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function fmtClock(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${pad(m)}:${pad(s)}`;
  }

  function formatCountdown(ms) {
    const totalTenths = Math.ceil(Math.max(0, ms) / 100);
    const minutes = Math.floor(totalTenths / 600);
    const seconds = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    return `${pad(minutes)}:${pad(seconds)}.${tenths}`;
  }

  function ensureCountdownAudio() {
    try {
      countdownAudioCtx = countdownAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (countdownAudioCtx.state === 'suspended') countdownAudioCtx.resume();
      if (!countdownAudioDest) countdownAudioDest = countdownAudioCtx.createMediaStreamDestination();
      return countdownAudioDest;
    } catch (_) {
      return null;
    }
  }

  function speakCountdownAt(leftMs) {
    if (leftMs == null) return;
    const second = leftMs <= 0 ? 0 : Math.ceil(leftMs / 1000);
    if (second > 10 || second === lastCountdownSpoken) return;
    lastCountdownSpoken = second;
    // This cue is routed only into the recorded overlay audio track. Global
    // audible TTS is owned by bluetooth.js on every dashboard view.
    playRecordedCountdownCue(second);
  }

  function playRecordedCountdownCue(second) {
    try {
      ensureCountdownAudio();
      if (!countdownAudioCtx || !countdownAudioDest) return;
      const osc = countdownAudioCtx.createOscillator();
      const gain = countdownAudioCtx.createGain();
      osc.type = second <= 0 ? 'sawtooth' : 'sine';
      osc.frequency.value = second <= 0 ? 440 : 880;
      gain.gain.value = second <= 0 ? 0.12 : 0.055;
      osc.connect(gain);
      gain.connect(countdownAudioDest);
      const duration = second <= 0 ? 0.42 : 0.12;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, countdownAudioCtx.currentTime + duration);
      osc.stop(countdownAudioCtx.currentTime + duration);
    } catch (_) {}
  }

  function setStatus(title, detail, state) {
    const banner = document.getElementById('cam-banner');
    if (banner) banner.className = `net-banner ${state || 'warn'}`;
    setText('cam-status', title);
    setText('cam-detail', detail);
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function stopStreams() {
    cancelAnimationFrame(drawFrameId);
    [sourceStream, audioStream, mixedStream, greenMixedStream].forEach(stream => {
      stream?.getTracks().forEach(track => track.stop());
    });
    sourceStream = null;
    audioStream = null;
    mixedStream = null;
    greenMixedStream = null;
    countdownAudioDest = null;
    document.getElementById('cam-record').disabled = true;
    document.getElementById('cam-stop').disabled = true;
  }

  function downloadStatsImage() {
    const canvas = document.getElementById('cam-stats-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    renderStatsImage(ctx, canvas.width, canvas.height);
    
    canvas.toBlob(blob => {
      if (!blob) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadBlob(blob, `neolabs-flight-stats-${stamp}.png`);
    }, 'image/png');
  }

  function renderStatsImage(ctx, w, h) {
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, w, h);
    
    const grad = ctx.createRadialGradient(w * 0.2, h * 0.3, 0, w * 0.2, h * 0.3, w * 0.7);
    grad.addColorStop(0, 'rgba(45,111,224, 0.25)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const grad2 = ctx.createRadialGradient(w * 0.8, h * 0.8, 0, w * 0.8, h * 0.8, w * 0.7);
    grad2.addColorStop(0, 'rgba(54,240,160, 0.1)');
    grad2.addColorStop(1, 'transparent');
    ctx.fillStyle = grad2;
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    ctx.fillStyle = '#dbe7ff';
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '8px';
    ctx.font = '800 36px system-ui, Segoe UI, Arial';
    ctx.fillText('NEOLABS ROCKETS', w / 2, 140);
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';

    const title = document.getElementById('cam-title').value || 'NeoLabs Launch';
    const site = document.getElementById('cam-site').value || 'Launch Site';
    const mission = document.getElementById('cam-mission').value || 'Flight Test';
    
    const titleGrad = ctx.createLinearGradient(0, 200, 0, 300);
    titleGrad.addColorStop(0, '#ffffff');
    titleGrad.addColorStop(1, '#a9c6f5');
    ctx.fillStyle = titleGrad;
    
    ctx.font = '900 110px system-ui, Segoe UI, Arial';
    ctx.fillText(title.toUpperCase(), w / 2, 260);
    
    ctx.fillStyle = '#9fd4ff';
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '4px';
    ctx.font = '600 32px system-ui, Segoe UI, Arial';
    ctx.fillText(`${mission.toUpperCase()} · ${site.toUpperCase()}`, w / 2, 360);
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';

    ctx.strokeStyle = 'rgba(159,212,255,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 200, 420);
    ctx.lineTo(w / 2 + 200, 420);
    ctx.stroke();

    const stats = [];
    const wx = (typeof weather !== 'undefined' && weather) ? weather.current : null;
    if (wx) {
      stats.push({ label: 'WEATHER', value: `${Math.round(wx.temperature_2m)} °C` });
      stats.push({ label: 'WIND SPEED', value: `${Math.round(wx.wind_speed_10m)} km/h` });
      stats.push({ label: 'CLOUD COVER', value: `${Math.round(wx.cloud_cover)} %` });
    }

    const rm = (typeof rocketModel !== 'undefined' && rocketModel) ? rocketModel : null;
    if (rm) {
      stats.push({ label: 'TARGET APOGEE', value: `${Math.round(rm.apogeeM)} m` });
    }

    if (cameraControllerStatus && Number.isFinite(cameraControllerStatus.temperatureC)) {
      stats.push({ label: 'SYS TEMPERATURE', value: `${cameraControllerStatus.temperatureC.toFixed(1)} °C` });
    }

    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    stats.push({ label: 'DATE', value: dateStr });
    
    const cols = 3;
    const gapX = 420;
    const gapY = 200;
    const startY = 580;

    stats.forEach((stat, index) => {
      const row = Math.floor(index / cols);
      const itemsInRow = Math.min(cols, stats.length - row * cols);
      const startX = w / 2 - ((itemsInRow - 1) * gapX) / 2;
      const col = index % cols;
      const x = startX + col * gapX;
      const y = startY + row * gapY;
      
      ctx.strokeStyle = 'rgba(77,159,255,0.3)';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(16,24,46,0.5)';
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x - 180, y - 75, 360, 150, 20);
      } else {
        ctx.rect(x - 180, y - 75, 360, 150);
      }
      ctx.fill();
      ctx.stroke();
      
      ctx.fillStyle = '#64759c';
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '3px';
      ctx.font = '700 18px system-ui, Segoe UI, Arial';
      ctx.fillText(stat.label, x, y - 24);
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
      
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 52px system-ui, Segoe UI, Arial';
      ctx.fillText(stat.value, x, y + 28);
    });
    
    ctx.fillStyle = '#64759c';
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '4px';
    ctx.font = '600 20px system-ui, Segoe UI, Arial';
    ctx.fillText('MISSION DASHBOARD · NEOLABS ROCKETS', w / 2, h - 60);
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
  }
})();
