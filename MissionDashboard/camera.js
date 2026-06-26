let sourceStream = null;
let audioStream = null;
let mixedStream = null;
let recorder = null;
let chunks = [];
let drawFrameId = null;
let recordStartedAt = 0;
let durationTimer = null;
let countdownTimer = null;
let countdownEndsAt = 0;
let countdownActive = false;
let externalCountdownEndsAt = 0;
let externalCountdownBaseEndsAt = 0;
let externalCountdownActive = false;
let syncOffsetMs = 0;
let cameraBleConnected = false;
let cameraBleDeviceName = '';
const CAMERA_LAUNCH_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-launch')
  : null;
const CAMERA_BLE_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-ble')
  : null;

window.addEventListener('DOMContentLoaded', () => {
  startClock();
  bindControls();
  bindLaunchEvents();
  drawIdleFrame();
});

function bindControls() {
  document.getElementById('cam-start-preview').addEventListener('click', openCamera);
  document.getElementById('cam-record').addEventListener('click', startRecording);
  document.getElementById('cam-stop').addEventListener('click', stopRecording);
  document.getElementById('cam-countdown').addEventListener('click', startCountdown);
  document.getElementById('cam-sync-offset').addEventListener('input', event => {
    syncOffsetMs = clamp(Number(event.target.value), -5000, 5000);
    updateExternalCountdownLabel();
  });
  document.getElementById('cam-sync-reset').addEventListener('click', () => {
    syncOffsetMs = 0;
    document.getElementById('cam-sync-offset').value = '0';
    updateExternalCountdownLabel();
  });
  ['cam-title', 'cam-site', 'cam-mission'].forEach(id => {
    document.getElementById(id).addEventListener('input', drawIdleFrame);
  });
  ['cam-quality', 'cam-facing', 'cam-audio', 'cam-fps'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (sourceStream) openCamera();
    });
  });
}

function bindLaunchEvents() {
  CAMERA_LAUNCH_CHANNEL?.addEventListener('message', event => applyLaunchEvent(event.data));
  CAMERA_BLE_CHANNEL?.addEventListener('message', event => applyBleState(event.data));
  window.addEventListener('storage', event => {
    if (event.key === 'neolabs.launch.lastEvent' && event.newValue) {
      try { applyLaunchEvent(JSON.parse(event.newValue)); } catch (_) {}
    }
    if (event.key === 'neolabs.ble.state' && event.newValue) {
      try { applyBleState(JSON.parse(event.newValue)); } catch (_) {}
    }
  });
  try {
    const saved = JSON.parse(localStorage.getItem('neolabs.launch.lastEvent') || 'null');
    if (saved && Date.now() - saved.at < 45000) applyLaunchEvent(saved);
  } catch (_) {}
  try {
    const savedBle = JSON.parse(localStorage.getItem('neolabs.ble.state') || 'null');
    if (savedBle && Date.now() - savedBle.at < 15000) applyBleState(savedBle);
  } catch (_) {}
}

function applyLaunchEvent(data) {
  if (!data || !['ble-dashboard', 'launch-dashboard'].includes(data.source)) return;
  if (data.type === 'countdown_start' || data.type === 'countdown_tick') {
    externalCountdownBaseEndsAt = data.endsAt || (Date.now() + Math.max(0, data.left || 0) * 1000);
    externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
    externalCountdownActive = true;
    updateExternalCountdownLabel();
  } else if (data.type === 'ignition') {
    externalCountdownEndsAt = Date.now();
    externalCountdownActive = true;
    document.getElementById('cam-count-state').textContent = 'Ignition';
    setTimeout(() => { externalCountdownActive = false; }, 3000);
  } else if (data.type === 'abort') {
    externalCountdownActive = false;
    document.getElementById('cam-count-state').textContent = 'Aborted';
  }
}

function applyBleState(data) {
  if (!data) return;
  cameraBleConnected = !!data.connected;
  cameraBleDeviceName = data.deviceName || '';
  const label = cameraBleConnected ? (cameraBleDeviceName || 'BLE live') : 'Offline';
  document.getElementById('cam-ble-state').textContent = label;
}

function updateExternalCountdownLabel() {
  if (!externalCountdownActive) return;
  if (externalCountdownBaseEndsAt) externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
  const leftMs = externalCountdownEndsAt - Date.now();
  document.getElementById('cam-count-state').textContent = leftMs > 0
    ? `Live T-${formatCountdown(leftMs)}`
    : 'Ignition';
}

function startClock() {
  const tick = () => {
    const d = new Date();
    document.getElementById('cam-clock').textContent =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    refreshCountdownState();
  };
  tick();
  setInterval(tick, 1000);
}

function refreshCountdownState() {
  if (externalCountdownActive) {
    updateExternalCountdownLabel();
    return;
  }
  if (countdownActive) {
    const leftMs = countdownEndsAt - Date.now();
    document.getElementById('cam-count-state').textContent = leftMs > 0
      ? `Local T-${formatCountdown(leftMs)}`
      : 'Ignition';
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

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
  const wantsAudio = document.getElementById('cam-audio').value === 'on';
  setStatus('Opening camera', 'Requesting device permissions.', 'warn');
  try {
    sourceStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: q.width },
        height: { ideal: q.height },
        frameRate: { ideal: q.fps }
      },
      audio: false
    });
    if (wantsAudio) {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        document.getElementById('cam-audio-state').textContent = 'Mic on';
      } catch (_) {
        audioStream = null;
        document.getElementById('cam-audio-state').textContent = 'Mic denied';
      }
    } else {
      document.getElementById('cam-audio-state').textContent = 'Mic off';
    }

    const video = document.getElementById('cam-source');
    video.srcObject = sourceStream;
    await video.play();
    resizeCanvas();
    startDrawLoop();
    document.getElementById('cam-record').disabled = false;
    document.getElementById('cam-countdown').disabled = false;
    setStatus('Camera ready', 'Preview includes the recorded overlay.', 'ok');
  } catch (err) {
    setStatus('Camera unavailable', 'Allow camera permission or try another browser/device.', 'bad');
    document.getElementById('cam-audio-state').textContent = 'Unavailable';
  }
}

function resizeCanvas() {
  const q = quality();
  const canvas = document.getElementById('cam-canvas');
  canvas.width = q.width;
  canvas.height = q.height;
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
  const video = document.getElementById('cam-source');
  ctx.fillStyle = '#030713';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (video.readyState >= 2) drawCover(ctx, video, canvas.width, canvas.height);
  drawOverlay(ctx, canvas.width, canvas.height);
}

function drawCover(ctx, video, width, height) {
  const vw = video.videoWidth || width;
  const vh = video.videoHeight || height;
  const scale = Math.max(width / vw, height / vh);
  const sw = width / scale;
  const sh = height / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
}

function drawOverlay(ctx, w, h) {
  const title = document.getElementById('cam-title').value || 'NeoLabs Launch';
  const site = document.getElementById('cam-site').value || 'Launch Site';
  const mission = document.getElementById('cam-mission').value || 'Flight Test';
  const now = new Date();
  const rec = recorder?.state === 'recording';
  const elapsed = rec ? Math.floor((Date.now() - recordStartedAt) / 1000) : 0;
  if (externalCountdownActive && externalCountdownBaseEndsAt) {
    externalCountdownEndsAt = externalCountdownBaseEndsAt + syncOffsetMs;
  }
  const ownCountdownMs = countdownActive ? countdownEndsAt - Date.now() : null;
  const liveCountdownMs = externalCountdownActive ? externalCountdownEndsAt - Date.now() : null;
  const countdownMs = liveCountdownMs ?? ownCountdownMs;
  const countdownLive = liveCountdownMs != null;

  const padPx = Math.round(w * 0.025);
  const topH = Math.round(h * 0.15);
  const bottomY = Math.round(h * 0.78);
  const bottomH = h - bottomY;
  const accent = countdownMs != null && countdownMs <= 10000 ? '#ffb347' : '#9fd4ff';
  ctx.save();
  ctx.fillStyle = 'rgba(3,7,19,.62)';
  ctx.fillRect(0, 0, w, topH);
  ctx.fillStyle = 'rgba(3,7,19,.72)';
  ctx.fillRect(0, bottomY, w, bottomH);
  ctx.strokeStyle = 'rgba(159,212,255,.38)';
  ctx.lineWidth = Math.max(1, w * 0.0012);
  ctx.beginPath();
  ctx.moveTo(padPx, topH);
  ctx.lineTo(w - padPx, topH);
  ctx.moveTo(padPx, bottomY);
  ctx.lineTo(w - padPx, bottomY);
  ctx.stroke();

  ctx.fillStyle = '#dbe7ff';
  ctx.font = `800 ${Math.round(w * 0.027)}px Segoe UI, Arial`;
  ctx.fillText(title.toUpperCase(), padPx, Math.round(h * 0.055));
  ctx.font = `600 ${Math.round(w * 0.015)}px Segoe UI, Arial`;
  ctx.fillStyle = '#9fd4ff';
  ctx.fillText(`${mission} / ${site}`, padPx, Math.round(h * 0.102));

  ctx.textAlign = 'right';
  ctx.fillStyle = '#c9d6ef';
  ctx.fillText(now.toLocaleTimeString(), w - padPx, Math.round(h * 0.055));
  ctx.fillStyle = rec ? '#ff4a3d' : '#36f0a0';
  ctx.fillText(rec ? `REC ${fmtDuration(elapsed)}` : 'STANDBY', w - padPx, Math.round(h * 0.102));

  if (countdownMs != null) {
    const txt = countdownMs > 0 ? `T-${formatCountdown(countdownMs)}` : 'IGNITION';
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(w * (countdownMs > 0 ? 0.075 : 0.065))}px Segoe UI, Arial`;
    ctx.fillStyle = countdownMs > 10000 ? '#ffffff' : countdownMs > 3000 ? '#ffb347' : '#ff4a3d';
    ctx.shadowColor = 'rgba(255,74,61,.85)';
    ctx.shadowBlur = countdownMs <= 10000 ? 24 : 10;
    ctx.fillText(txt, w / 2, h * 0.52);
    ctx.shadowBlur = 0;
    ctx.font = `700 ${Math.round(w * 0.017)}px Segoe UI, Arial`;
    ctx.fillStyle = countdownLive ? '#36f0a0' : '#ffb347';
    ctx.fillText(countdownLive ? 'LIVE CONTROLLER COUNTDOWN' : 'LOCAL CAMERA COUNTDOWN', w / 2, h * 0.58);
  }

  const arcCX = w / 2;
  const arcY = bottomY + Math.round(bottomH * 0.62);
  const arcR = Math.round(w * 0.24);
  ctx.strokeStyle = 'rgba(159,212,255,.42)';
  ctx.lineWidth = Math.max(2, w * 0.002);
  ctx.beginPath();
  ctx.arc(arcCX, arcY, arcR, Math.PI * 1.08, Math.PI * 1.92);
  ctx.stroke();
  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.moveTo(arcCX - arcR * 0.7, arcY - arcR * 0.18);
  ctx.lineTo(arcCX, arcY - arcR * 0.34);
  ctx.lineTo(arcCX + arcR * 0.7, arcY - arcR * 0.18);
  ctx.stroke();

  ctx.textAlign = 'left';
  drawHudLabel(ctx, padPx, bottomY + bottomH * 0.33, 'LINK', cameraBleConnected ? 'BLE LIVE' : 'OFFLINE', cameraBleConnected ? '#36f0a0' : '#ffb347', w);
  drawHudLabel(ctx, padPx + w * 0.18, bottomY + bottomH * 0.33, 'SYNC', `${syncOffsetMs} ms`, '#9fd4ff', w);
  drawHudLabel(ctx, padPx, bottomY + bottomH * 0.68, 'AUDIO', audioStream ? 'MIC ON' : 'MIC OFF', audioStream ? '#36f0a0' : '#ffb347', w);
  drawHudLabel(ctx, w - padPx - w * 0.18, bottomY + bottomH * 0.33, 'MISSION', mission.toUpperCase(), '#dbe7ff', w);
  drawHudLabel(ctx, w - padPx - w * 0.18, bottomY + bottomH * 0.68, 'TIME', rec ? fmtDuration(elapsed) : '--:--', '#dbe7ff', w);

  ctx.textAlign = 'center';
  ctx.font = `800 ${Math.round(w * 0.018)}px Segoe UI, Arial`;
  ctx.fillStyle = '#dbe7ff';
  ctx.fillText('NEOLABS ROCKETS', w / 2, bottomY + bottomH * 0.82);
  ctx.restore();
}

function drawHudLabel(ctx, x, y, key, value, color, w) {
  ctx.textAlign = 'left';
  ctx.font = `700 ${Math.round(w * 0.012)}px Segoe UI, Arial`;
  ctx.fillStyle = '#5b6a8f';
  ctx.fillText(key, x, y);
  ctx.font = `900 ${Math.round(w * 0.018)}px Segoe UI, Arial`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y + Math.round(w * 0.023));
}

function drawIdleFrame() {
  resizeCanvas();
  drawComposite();
}

async function startRecording() {
  if (!sourceStream) await openCamera();
  if (!sourceStream) return;
  const canvas = document.getElementById('cam-canvas');
  const q = quality();
  const videoTrackStream = canvas.captureStream(q.fps);
  mixedStream = new MediaStream(videoTrackStream.getVideoTracks());
  if (audioStream) audioStream.getAudioTracks().forEach(track => mixedStream.addTrack(track));

  chunks = [];
  const mimeType = preferredMimeType();
  recorder = new MediaRecorder(mixedStream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
  recorder.ondataavailable = e => {
    if (e.data?.size) chunks.push(e.data);
  };
  recorder.onstop = downloadRecording;
  recorder.start(1000);
  recordStartedAt = Date.now();
  document.getElementById('cam-record').disabled = true;
  document.getElementById('cam-stop').disabled = false;
  document.getElementById('cam-countdown').disabled = false;
  document.getElementById('cam-download').textContent = 'Recording';
  durationTimer = setInterval(updateDuration, 250);
  setStatus('Recording', audioStream ? 'Video overlay and microphone audio are being recorded.' : 'Video overlay recording. Mic audio unavailable/off.', 'bad');
}

function preferredMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return types.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop();
  clearInterval(durationTimer);
  clearInterval(countdownTimer);
  countdownActive = false;
  document.getElementById('cam-count-state').textContent = 'Idle';
  document.getElementById('cam-record').disabled = false;
  document.getElementById('cam-stop').disabled = true;
  setStatus('Processing download', 'Preparing the recorded WebM file.', 'warn');
}

function startCountdown() {
  countdownEndsAt = Date.now() + 30000;
  countdownActive = true;
  updateCountdown();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 150);
  beep(880, 0.12);
}

function updateCountdown() {
  const leftMs = countdownEndsAt - Date.now();
  document.getElementById('cam-count-state').textContent = leftMs > 0 ? `Local T-${formatCountdown(leftMs)}` : 'Ignition';
  if (leftMs <= 0) {
    clearInterval(countdownTimer);
    countdownActive = false;
    beep(440, 0.45);
    setTimeout(() => {
      if (document.getElementById('cam-count-state').textContent === 'Ignition') {
        document.getElementById('cam-count-state').textContent = 'Idle';
      }
    }, 3000);
  }
}

function updateDuration() {
  document.getElementById('cam-duration').textContent =
    fmtDuration(Math.floor((Date.now() - recordStartedAt) / 1000));
}

function downloadRecording() {
  const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `neolabs-launch-${stamp}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  document.getElementById('cam-download').textContent = `${Math.round(blob.size / 1024 / 1024 * 10) / 10} MB`;
  setStatus('Recording saved', 'Download started. Keep the file with your launch notes.', 'ok');
}

function fmtDuration(totalSeconds) {
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

function setStatus(title, detail, state) {
  const banner = document.getElementById('cam-banner');
  banner.className = `net-banner ${state || 'warn'}`;
  document.getElementById('cam-status').textContent = title;
  document.getElementById('cam-detail').textContent = detail;
}

function beep(freq, duration) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

function stopStreams() {
  cancelAnimationFrame(drawFrameId);
  [sourceStream, audioStream, mixedStream].forEach(stream => {
    stream?.getTracks().forEach(track => track.stop());
  });
  sourceStream = null;
  audioStream = null;
  mixedStream = null;
  document.getElementById('cam-record').disabled = true;
  document.getElementById('cam-stop').disabled = true;
  document.getElementById('cam-countdown').disabled = true;
}
