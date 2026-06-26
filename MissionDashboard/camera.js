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
let externalCountdownActive = false;
const LAUNCH_CHANNEL = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('neolabs-launch')
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
  LAUNCH_CHANNEL?.addEventListener('message', event => applyLaunchEvent(event.data));
  window.addEventListener('storage', event => {
    if (event.key !== 'neolabs.launch.lastEvent' || !event.newValue) return;
    try { applyLaunchEvent(JSON.parse(event.newValue)); } catch (_) {}
  });
  try {
    const saved = JSON.parse(localStorage.getItem('neolabs.launch.lastEvent') || 'null');
    if (saved && Date.now() - saved.at < 45000) applyLaunchEvent(saved);
  } catch (_) {}
}

function applyLaunchEvent(data) {
  if (!data || !['ble-dashboard', 'launch-dashboard'].includes(data.source)) return;
  if (data.type === 'countdown_start' || data.type === 'countdown_tick') {
    externalCountdownEndsAt = data.endsAt || (Date.now() + Math.max(0, data.left || 0) * 1000);
    externalCountdownActive = true;
    document.getElementById('cam-count-state').textContent =
      Math.max(0, Math.ceil((externalCountdownEndsAt - Date.now()) / 1000)) > 0
        ? 'Live dashboard countdown'
        : 'Ignition';
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

function startClock() {
  const tick = () => {
    const d = new Date();
    document.getElementById('cam-clock').textContent =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
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
  const ownCountdown = countdownActive ? Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000)) : null;
  const liveCountdown = externalCountdownActive ? Math.max(0, Math.ceil((externalCountdownEndsAt - Date.now()) / 1000)) : null;
  const countdown = ownCountdown ?? liveCountdown;

  const padPx = Math.round(w * 0.025);
  ctx.save();
  ctx.fillStyle = 'rgba(3,7,19,.58)';
  ctx.fillRect(0, 0, w, Math.round(h * 0.13));
  ctx.fillRect(0, Math.round(h * 0.84), w, Math.round(h * 0.16));

  ctx.fillStyle = '#dbe7ff';
  ctx.font = `700 ${Math.round(w * 0.03)}px Segoe UI, Arial`;
  ctx.fillText(title, padPx, Math.round(h * 0.055));
  ctx.font = `500 ${Math.round(w * 0.017)}px Segoe UI, Arial`;
  ctx.fillStyle = '#9fd4ff';
  ctx.fillText(`${mission}  |  ${site}`, padPx, Math.round(h * 0.095));

  ctx.textAlign = 'right';
  ctx.fillStyle = '#c9d6ef';
  ctx.fillText(now.toLocaleString(), w - padPx, Math.round(h * 0.055));
  ctx.fillStyle = rec ? '#ff4a3d' : '#36f0a0';
  ctx.fillText(rec ? `REC ${fmtDuration(elapsed)}` : 'STANDBY', w - padPx, Math.round(h * 0.095));

  if (countdown != null) {
    const txt = countdown > 0 ? `T-${countdown}` : 'IGNITION';
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(w * (countdown > 0 ? 0.13 : 0.085))}px Segoe UI, Arial`;
    ctx.fillStyle = countdown > 10 ? '#ffffff' : countdown > 3 ? '#ffb347' : '#ff4a3d';
    ctx.shadowColor = 'rgba(255,74,61,.85)';
    ctx.shadowBlur = 22;
    ctx.fillText(txt, w / 2, h * 0.52);
    ctx.shadowBlur = 0;
  }

  ctx.textAlign = 'left';
  ctx.font = `600 ${Math.round(w * 0.018)}px Segoe UI, Arial`;
  ctx.fillStyle = '#dbe7ff';
  ctx.fillText('NEOLABS ROCKETS', padPx, Math.round(h * 0.91));
  ctx.fillStyle = '#5b6a8f';
  ctx.fillText('Overlay burned into recording - audio from device microphone', padPx, Math.round(h * 0.955));
  ctx.restore();
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
  const left = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
  document.getElementById('cam-count-state').textContent = left > 0 ? `T-${left}s` : 'Ignition';
  if (left <= 0) {
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
