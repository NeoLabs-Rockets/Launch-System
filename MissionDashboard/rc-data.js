/*
  Flight Viewer — load a flight recording pulled straight off the microSD card
  (zipped, or the folder itself) and render video + telemetry + events together,
  entirely in this browser. No network calls, nothing leaves this machine.

  Replaces the old BLE-download panel: downloading a multi-ten-MB video.mjpg
  over BLE (even at a healthy ATT MTU) is slow enough that pulling the card and
  loading a local file is the faster path in practice.

  File formats below are reverse-engineered from the firmware source
  (NL-1-Pioneer/electronics/firmware) and verified against a real captured
  flight — see storage.cpp (writeVideoFrame/writeMetadataJson), main.cpp
  (TelemetryRecord fields), crc16.cpp (CRC-16/CCITT-FALSE), and types.h
  (MissionState/RecordingState/FlightPhase/EventType enums).
*/
(function () {
  'use strict';

  // ── Shared enums (must match firmware include/types.h exactly) ───────────
  const MISSION_STATES = ['BOOT', 'SELF_TEST', 'IDLE', 'CONNECTED', 'ARMED', 'RECORDING',
    'COUNTDOWN', 'IGNITION_EXPECTED', 'ASCENT', 'COAST', 'APOGEE', 'DESCENT', 'LANDED', 'ABORTED', 'ERROR'];
  const RECORDING_STATES = ['IDLE', 'PREPARING', 'ACTIVE', 'POST_LANDING', 'STOPPING', 'STOPPED', 'FAILED'];
  const FLIGHT_PHASES = ['PRELAUNCH', 'LIFTOFF', 'POWERED_ASCENT', 'COAST', 'APOGEE', 'DESCENT', 'IMPACT', 'LANDED'];
  const PHASE_COLOR = {
    PRELAUNCH: '#9fd4ff', LIFTOFF: '#ff4a3d', POWERED_ASCENT: '#ff4a3d',
    COAST: '#ffb347', APOGEE: '#ffb347', DESCENT: '#ffb347', IMPACT: '#ff4a3d', LANDED: '#36f0a0'
  };
  const NOTABLE_EVENT_TYPES = ['LIFTOFF', 'APOGEE', 'LANDING', 'ABORT', 'STORAGE_FAULT', 'CAMERA_FAULT', 'SENSOR_FAULT'];
  const WANTED_FILES = ['video.mjpg', 'telemetry.bin', 'events.jsonl', 'metadata.json'];
  const TELEM_MAGIC = 0x4E4C3154; // 'NL1T'
  const TELEM_RECORD_SIZE = 106;
  const VIDEO_HEADER_SIZE = 16; // u64 mono_us + u32 frame_index + u32 len

  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
  function arrMin(arr, fn) { let m = Infinity; for (const x of arr) { const v = fn ? fn(x) : x; if (v < m) m = v; } return m; }
  function arrMax(arr, fn) { let m = -Infinity; for (const x of arr) { const v = fn ? fn(x) : x; if (v > m) m = v; } return m; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }
  // ── Derived telemetry: speed and orientation ──────────────────────────────
  // No GPS or magnetometer on this board (BMP580 + LSM6DSO32 only — see
  // board_pins.h), so neither "speed" nor "orientation" can be measured
  // directly. Both are honest best-effort estimates from what we do have.

  // Vertical speed from the barometric-altitude derivative (vertVelMs, computed
  // onboard) is the only velocity component this sensor suite actually measures
  // — there is no horizontal velocity sensing. Displayed as |vertVelMs| in
  // km/h with direction shown separately, not implied to be true 3D airspeed.
  function computeSpeedKmh(rec) {
    if (!rec) return null;
    return Math.abs(rec.vertVelMs) * 3.6;
  }

  const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const vScale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  const vDot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const vCross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const vNorm = a => { const m = Math.hypot(a.x, a.y, a.z) || 1e-9; return { x: a.x / m, y: a.y / m, z: a.z / m }; };

  // Same principle as flight_detect.cpp's "axial heuristic" (largest-magnitude
  // accel axis at rest ≈ up) but generalized to a full 3D reference vector
  // instead of picking one dominant axis — the mount orientation is never
  // assumed, only measured from the vehicle actually sitting still.
  function computeOrientationRef(s) {
    const n = Math.min(10, s.telem.records.length);
    if (!n) return null;
    let sum = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const r = s.telem.records[i];
      sum = vAdd(sum, { x: r.ax, y: r.ay, z: r.az });
    }
    const ref = vNorm(vScale(sum, 1 / n));
    // Perpendicular basis (Gram-Schmidt) so lean direction can be plotted in 2D.
    const helper = Math.abs(ref.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const U = vNorm(vCross(helper, ref));
    const V = vCross(ref, U);
    return { ref, U, V };
  }

  // Angle between the current accel vector and the at-rest reference vector.
  // Near 0° at rest, growing as the vehicle tips relative to its own starting
  // orientation. Under thrust this is biased by thrust acceleration, same
  // caveat the firmware's own liftoff heuristic has — not a full AHRS.
  function computeTilt(rec, orientationRef) {
    if (!rec || !orientationRef) return null;
    const A = { x: rec.ax, y: rec.ay, z: rec.az };
    const amag = Math.hypot(A.x, A.y, A.z) || 1e-9;
    const axial = vDot(A, orientationRef.ref);
    const cosTilt = Math.min(1, Math.max(-1, axial / amag));
    const tiltDeg = Math.acos(cosTilt) * (180 / Math.PI);
    const lateral = { x: A.x - orientationRef.ref.x * axial, y: A.y - orientationRef.ref.y * axial, z: A.z - orientationRef.ref.z * axial };
    const dirRad = Math.atan2(vDot(lateral, orientationRef.V), vDot(lateral, orientationRef.U));
    return { tiltDeg, dirRad };
  }

  function fmtClock(ms) {
    if (!Number.isFinite(ms)) return '0:00.00';
    const cs = Math.max(0, Math.round(ms / 10));
    const m = Math.floor(cs / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }

  // ── CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — matches firmware crc16.cpp,
  //    verified byte-for-byte against a real telemetry.bin before wiring this in. ──
  function crc16Ccitt(bytes) {
    let crc = 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc ^ (bytes[i] << 8)) & 0xFFFF;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc;
  }

  // ── Parsers ────────────────────────────────────────────────────────────

  function parseMetadata(buf) {
    if (!buf) return null;
    try { return JSON.parse(new TextDecoder().decode(buf)); }
    catch (e) { return { __parseError: String(e && e.message || e) }; }
  }

  function parseEvents(buf) {
    if (!buf) return { events: [], badLines: 0 };
    const text = new TextDecoder().decode(buf);
    const events = [];
    let badLines = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { events.push(JSON.parse(t)); }
      catch (e) { badLines++; }
    }
    events.sort((a, b) => (a.mono_us || 0) - (b.mono_us || 0));
    return { events, badLines };
  }

  // Packed little-endian record, #pragma pack(push,1) in types.h. Layout verified
  // against a real telemetry.bin: self-reported `size` field = 106, matching this
  // byte table exactly, and every CRC in that file validated against this poly.
  function parseTelemetry(buf) {
    if (!buf) return { records: [], crcErrors: 0, magicErrors: 0, truncatedTail: 0 };
    const n = buf.byteLength;
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const records = [];
    let crcErrors = 0, magicErrors = 0, off = 0;

    while (off + 8 <= n) {
      const magic = view.getUint32(off, true);
      if (magic !== TELEM_MAGIC) {
        let next = -1;
        for (let s = off + 1; s + 4 <= n; s++) {
          if (view.getUint32(s, true) === TELEM_MAGIC) { next = s; break; }
        }
        magicErrors++;
        if (next === -1) break;
        off = next;
        continue;
      }
      const size = view.getUint16(off + 6, true);
      // Forward-compatible stride: trust the record's own declared size (a future
      // firmware that appends fields still parses without desyncing), but only
      // decode the fields we know about from the fixed 106-byte prefix.
      const stride = (size >= TELEM_RECORD_SIZE && size <= 512) ? size : TELEM_RECORD_SIZE;
      if (off + stride > n) break; // truncated tail — session cut short mid-write
      if (off + TELEM_RECORD_SIZE <= n) {
        const crcStored = view.getUint16(off + 104, true);
        const crcOk = crc16Ccitt(bytes.subarray(off, off + 104)) === crcStored;
        if (!crcOk) crcErrors++;
        records.push({
          monoUs: Number(view.getBigUint64(off + 8, true)),
          ax: view.getFloat32(off + 32, true), ay: view.getFloat32(off + 36, true), az: view.getFloat32(off + 40, true),
          gx: view.getFloat32(off + 44, true), gy: view.getFloat32(off + 48, true), gz: view.getFloat32(off + 52, true),
          accelMag: view.getFloat32(off + 56, true),
          pressurePa: view.getFloat32(off + 60, true),
          altitudeM: view.getFloat32(off + 64, true),
          vertVelMs: view.getFloat32(off + 68, true),
          tempBmpC: view.getFloat32(off + 72, true),
          tempImuC: view.getFloat32(off + 76, true),
          tempMcuC: view.getFloat32(off + 80, true),
          missionState: view.getUint8(off + 84),
          recordingState: view.getUint8(off + 85),
          flightPhase: view.getUint8(off + 86),
          flags: view.getUint8(off + 87),
          frameCount: view.getUint32(off + 88, true),
          actualFpsX10: view.getUint16(off + 92, true),
          droppedFrames: view.getUint16(off + 94, true),
          freeSdKb: view.getUint32(off + 96, true),
          seq: view.getUint32(off + 100, true),
          crcOk,
        });
      }
      off += stride;
    }
    return { records, crcErrors, magicErrors, truncatedTail: n - off };
  }

  // Length-prefixed MJPEG sequence: [u64 mono_us][u32 frame_index][u32 len][jpeg].
  // See storage.cpp writeVideoFrame() — verified against a real video.mjpg where
  // every frame's SOI/EOI markers and monotonic index checked out.
  function parseVideo(buf) {
    if (!buf) return { frames: [], truncated: false, corrupt: 0 };
    const n = buf.byteLength;
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const frames = [];
    let off = 0, corrupt = 0, truncated = false;

    while (off + VIDEO_HEADER_SIZE <= n) {
      const monoUs = Number(view.getBigUint64(off, true));
      const frameIndex = view.getUint32(off + 8, true);
      const len = view.getUint32(off + 12, true);
      const dataStart = off + VIDEO_HEADER_SIZE;
      if (len === 0 || len > 5_000_000 || dataStart + len > n) { truncated = dataStart < n; break; }
      const jpeg = bytes.subarray(dataStart, dataStart + len);
      const ok = jpeg.length >= 4 && jpeg[0] === 0xFF && jpeg[1] === 0xD8
        && jpeg[jpeg.length - 2] === 0xFF && jpeg[jpeg.length - 1] === 0xD9;
      if (!ok) corrupt++;
      frames.push({ monoUs, index: frameIndex, blob: new Blob([jpeg], { type: 'image/jpeg' }) });
      off = dataStart + len;
    }
    return { frames, truncated, corrupt, trailingBytes: n - off };
  }

  // T-/T+ zero reference: the moment the overlay clock should flip from
  // counting down to counting up. Checked in order of authority:
  //   1. An actual LIFTOFF event (mono_us — same units as everything else here).
  //   2. The first telemetry sample whose flightPhase already reads LIFTOFF+
  //      (covers flights where events.jsonl is missing/truncated).
  //   3. The most recent countdown_start/countdown_update command's target
  //      ignition time — this is a firmware *mono_ms* value (milliseconds,
  //      TimeManager::monoMs()), so it's converted ×1000 to match the mono_us
  //      timeline used everywhere else. This is a scheduled/expected time, not
  //      a confirmed liftoff — used so the clock still flips at the countdown's
  //      real zero even on a bench test or an abort where liftoff never fires.
  // Returns null if none of the above is available (no countdown ever ran).
  // A ground-station countdown command can express its ignition target as
  // either ignition_mono_ms (firmware's own monotonic clock, milliseconds) or
  // ignition_unix_ms (wall-clock) — see command_handler.cpp's START_COUNTDOWN
  // handler, which accepts either. Real captured commands from the dashboard
  // send ignition_unix_ms, not ignition_mono_ms — converting requires a
  // mono_us/unix_ms pairing, which any TIME_SYNC (or synced) event carries.
  function unixMsToMonoUs(s, targetUnixMs) {
    const ref = s.events.find(e => Number(e.unix_ms) > 0 && Number.isFinite(e.mono_us));
    if (!ref) return null;
    const offsetUs = ref.mono_us - Number(ref.unix_ms) * 1000;
    return targetUnixMs * 1000 + offsetUs;
  }

  function findZeroReferenceUs(s) {
    const liftoffEvent = s.events.find(e => e.type === 'LIFTOFF' && Number.isFinite(e.mono_us));
    if (liftoffEvent) return liftoffEvent.mono_us;

    const idx = s.telem.records.findIndex(r => r.flightPhase >= 1); // 1 = LIFTOFF in FLIGHT_PHASES
    if (idx >= 0) return s.telem.records[idx].monoUs;

    let best = null;
    for (const e of s.events) {
      if (e.type !== 'COMMAND' || !e.payload) continue;
      if (e.payload.cmd !== 'countdown_start' && e.payload.cmd !== 'countdown_update') continue;
      const ignMs = Number(e.payload.ignition_mono_ms);
      if (Number.isFinite(ignMs) && ignMs > 0) { best = ignMs * 1000; continue; } // last one wins — most up to date
      const ignUnixMs = Number(e.payload.ignition_unix_ms);
      if (Number.isFinite(ignUnixMs) && ignUnixMs > 0) {
        const converted = unixMsToMonoUs(s, ignUnixMs);
        if (converted != null) best = converted;
      }
    }
    return best;
  }

  function nearestByMonoUs(sortedArr, targetUs, key) {
    if (!sortedArr.length) return undefined;
    let lo = 0, hi = sortedArr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((key ? sortedArr[mid][key] : sortedArr[mid]) <= targetUs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return sortedArr[ans];
  }
  function nearestIndexByMonoUs(sortedArr, targetUs, key) {
    if (!sortedArr.length) return -1;
    let lo = 0, hi = sortedArr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((key ? sortedArr[mid][key] : sortedArr[mid]) <= targetUs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  // ── File collection: ZIP, directory picker, or drag-and-drop ──────────────

  async function entriesFromZip(fileOrBuffer) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load — check network/CDN');
    const zip = await JSZip.loadAsync(fileOrBuffer);
    const out = [];
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      out.push({ relPath, get: () => entry.async('arraybuffer') });
    });
    return out;
  }

  function entriesFromFileList(fileList) {
    return Array.from(fileList).map(f => ({
      relPath: f.webkitRelativePath || f.name,
      get: () => f.arrayBuffer(),
    }));
  }

  function readEntryAsFile(entry) { return new Promise((res, rej) => entry.file(res, rej)); }
  function readDirBatch(reader) { return new Promise((res, rej) => reader.readEntries(res, rej)); }
  async function walkFsEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await readEntryAsFile(entry);
      out.push({ relPath: prefix + entry.name, get: () => file.arrayBuffer() });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await readDirBatch(reader);
        for (const child of batch) await walkFsEntry(child, prefix + entry.name + '/', out);
      } while (batch.length > 0);
    }
  }
  async function entriesFromDataTransfer(dt) {
    const items = dt.items ? Array.from(dt.items) : [];
    if (items.length && items[0].webkitGetAsEntry) {
      const out = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) await walkFsEntry(entry, '', out);
      }
      return out;
    }
    return Array.from(dt.files || []).map(f => ({ relPath: f.name, get: () => f.arrayBuffer() }));
  }

  // Group by immediate parent directory so both "select one flight folder" and
  // "select the whole /flights folder with many sessions in it" work the same way.
  function groupEntries(entries) {
    const groups = new Map();
    for (const e of entries) {
      const parts = e.relPath.split('/').filter(Boolean);
      if (!parts.length) continue;
      const fname = parts[parts.length - 1].toLowerCase();
      if (!WANTED_FILES.includes(fname)) continue;
      const key = parts.length >= 2 ? parts[parts.length - 2] : '(selected files)';
      if (!groups.has(key)) groups.set(key, {});
      groups.get(key)[fname] = e;
    }
    return groups;
  }

  async function materialize(filesMap) {
    const out = {};
    for (const k of WANTED_FILES) if (filesMap[k]) out[k] = await filesMap[k].get();
    return out;
  }

  // ── App state ──────────────────────────────────────────────────────────

  let state = null;
  let exportCancelled = false;
  let exporting = false;
  let chartTooltip = null;

  function setDropStatus(msg, tone) {
    const n = el('fv-drop-status');
    n.textContent = msg || '';
    n.className = 'fv-drop-status' + (tone ? ' ' + tone : '');
  }

  async function loadFromEntries(entries) {
    const groups = groupEntries(entries);
    if (groups.size === 0) {
      setDropStatus('No video.mjpg / telemetry.bin / events.jsonl / metadata.json found in that selection', 'bad');
      return;
    }
    if (groups.size === 1) {
      const [name, filesMap] = [...groups.entries()][0];
      setDropStatus(`Loading ${name}…`, '');
      await loadFlight(name, await materialize(filesMap));
      return;
    }
    showFlightChooser(groups);
  }

  function showFlightChooser(groups) {
    const box = el('fv-choose-list');
    box.hidden = false;
    box.innerHTML = `<div class="fv-choose-title">${groups.size} flights found — choose one:</div>` +
      [...groups.entries()].map(([name, filesMap]) => {
        const have = Object.keys(filesMap);
        return `<button type="button" class="fv-choose-item" data-name="${escapeAttr(name)}">
          <strong>${escapeHtml(name)}</strong>
          <span>${have.length ? have.map(escapeHtml).join(' · ') : 'no matching files'}</span>
        </button>`;
      }).join('');
    box.querySelectorAll('.fv-choose-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        box.hidden = true;
        setDropStatus(`Loading ${name}…`, '');
        await loadFlight(name, await materialize(groups.get(name)));
      });
    });
    setDropStatus('', '');
  }

  async function loadFlight(name, filesMap) {
    if (state) {
      state.playing = false;
      state.bitmapCache.forEach(b => { try { b.close(); } catch (_) {} });
    }
    try {
      const metadata = parseMetadata(filesMap['metadata.json']);
      const { events, badLines: eventsBad } = parseEvents(filesMap['events.jsonl']);
      const telem = parseTelemetry(filesMap['telemetry.bin']);
      const video = parseVideo(filesMap['video.mjpg']);

      if (!filesMap['video.mjpg'] && !filesMap['telemetry.bin']) {
        setDropStatus(`${name}: neither video.mjpg nor telemetry.bin found — nothing to show`, 'bad');
        return;
      }

      // Timeline is anchored to video/telemetry only, not events. The BLE link
      // (and its keepalive "ping" traffic) commonly stays connected long before
      // and after the actual recording window — on the sample flight this used
      // for testing, events span 15+ minutes around a 52s recording. Letting
      // events drive the timeline would make the scrubber ~95% dead space.
      // Events keep their true mono_us-relative time in the sidebar list (which
      // can be negative or beyond duration) — they just don't stretch the clock.
      const starts = [], ends = [];
      if (video.frames.length) { starts.push(video.frames[0].monoUs); ends.push(video.frames[video.frames.length - 1].monoUs); }
      if (telem.records.length) { starts.push(telem.records[0].monoUs); ends.push(telem.records[telem.records.length - 1].monoUs); }
      let t0, durationMs;
      if (starts.length) {
        t0 = arrMin(starts);
        durationMs = (arrMax(ends) - t0) / 1000;
      } else if (events.length) {
        // No video or telemetry at all — fall back to the events span so the
        // viewer still shows the event timeline rather than nothing.
        t0 = arrMin(events, e => e.mono_us || Infinity);
        durationMs = (arrMax(events, e => e.mono_us || -Infinity) - t0) / 1000;
      } else {
        t0 = 0; durationMs = 0;
      }

      state = {
        name, metadata, events, eventsBad, telem, video, t0, durationMs,
        clockMs: 0, playing: false, rate: 1, lastRafTs: null, lastDrawnFrameIdx: -1,
        bitmapCache: new Map(),
      };
      state.zeroRefUs = findZeroReferenceUs(state);
      state.orientationRef = computeOrientationRef(state);

      // Gauge scaling — sized to what this specific flight actually reached,
      // with a sane floor so a bench test (near-zero everything) doesn't
      // produce a degenerate zero-range gauge.
      if (state.telem.records.length) {
        state.altBaseline = state.telem.records[0].altitudeM;
        state.maxAltitudeM = Math.max(10, arrMax(state.telem.records, r => r.altitudeM - state.altBaseline));
        state.maxSpeedKmh = Math.max(10, arrMax(state.telem.records, r => Math.abs(r.vertVelMs) * 3.6));
      } else {
        state.altBaseline = 0; state.maxAltitudeM = 100; state.maxSpeedKmh = 50;
      }

      await renderSummary();
      renderEvents();
      renderCharts();
      setupScrubEvents();
      updatePlayButton();
      seekTo(0);

      el('fv-drop-status').textContent = '';
      el('fv-choose-list').hidden = true;
      el('fv-app').hidden = false;
    } catch (err) {
      console.error(err);
      setDropStatus(`Failed to parse ${name}: ${err.message || err}`, 'bad');
    }
  }

  // ── Summary panel ──────────────────────────────────────────────────────

  function pair(k, v, tone) {
    const cls = tone === 'bad' ? 'fv-sum-bad' : tone === 'warn' ? 'fv-sum-warn' : '';
    return `<div><span style="color:var(--muted)">${escapeHtml(k)}</span><br><strong class="${cls}">${escapeHtml(String(v))}</strong></div>`;
  }

  async function renderSummary() {
    const s = state, m = s.metadata || {};
    const rows = [];
    rows.push(pair('Flight', s.name));
    if (m.__parseError) rows.push(pair('metadata.json', 'Failed to parse', 'bad'));
    if (m.incomplete) rows.push(pair('Session', 'Incomplete — not cleanly closed', 'warn'));
    if (m.firmware_version) rows.push(pair('Firmware', m.firmware_version));
    if (m.board) rows.push(pair('Board', m.board));
    rows.push(pair('Duration', fmtClock(s.durationMs)));

    if (s.video.frames.length) {
      rows.push(pair('Video frames', String(s.video.frames.length)));
      if (m.frames_written != null && Number(m.frames_written) !== s.video.frames.length) {
        rows.push(pair('metadata frames_written', `${m.frames_written} — stale (written at session open, before the final count was known)`, 'warn'));
      }
      if (s.video.corrupt) rows.push(pair('Corrupt frames', String(s.video.corrupt), 'bad'));
      if (s.video.truncated) rows.push(pair('Video file', 'Truncated tail — recording cut off mid-frame', 'warn'));
      const measuredFps = s.video.frames.length > 1
        ? (s.video.frames.length - 1) / ((s.video.frames[s.video.frames.length - 1].monoUs - s.video.frames[0].monoUs) / 1e6)
        : 0;
      rows.push(pair('Measured avg FPS', measuredFps.toFixed(1)));
    } else {
      rows.push(pair('Video', 'Not present in this flight', 'warn'));
    }

    if (s.telem.records.length) {
      rows.push(pair('Telemetry records', String(s.telem.records.length)));
      if (s.telem.crcErrors) rows.push(pair('CRC failures', String(s.telem.crcErrors), 'bad'));
      if (s.telem.magicErrors) rows.push(pair('Corrupt/resynced records', String(s.telem.magicErrors), 'bad'));
    } else {
      rows.push(pair('Telemetry', 'Not present in this flight', 'warn'));
    }
    if (s.eventsBad) rows.push(pair('events.jsonl', `${s.eventsBad} unparseable line(s)`, 'warn'));
    if (s.events.length && s.durationMs) {
      const beforeStart = s.events.filter(e => ((e.mono_us || 0) - s.t0) / 1000 < -1).length;
      const afterEnd = s.events.filter(e => ((e.mono_us || 0) - s.t0) / 1000 > s.durationMs + 1000).length;
      if (afterEnd > 0) {
        const lastMs = arrMax(s.events, e => e.mono_us || 0) - s.t0;
        rows.push(pair('Events beyond recording', `${afterEnd} event(s), last at ${fmtClock(lastMs)} — likely BLE link staying connected after the recording ended`, 'warn'));
      }
      if (beforeStart > 0) {
        rows.push(pair('Events before recording', `${beforeStart} event(s) at boot/pre-arm — shown in the list, not on the scrub bar`, ''));
      }
    }

    el('fv-summary').innerHTML = rows.join('');

    // Ground-truth check: decode the actual first frame and compare against what
    // metadata claims the camera was configured for. This is exactly the manual
    // check that caught a real SVGA-vs-VGA firmware mismatch — now automatic.
    if (s.video.frames.length && m.camera_settings) {
      try {
        const bmp = await createImageBitmap(s.video.frames[0].blob);
        const cs = m.camera_settings;
        if (bmp.width !== cs.w || bmp.height !== cs.h) {
          el('fv-summary').insertAdjacentHTML('beforeend',
            pair('Camera resolution', `${bmp.width}×${bmp.height} actual vs ${cs.w}×${cs.h} configured — sensor/driver mismatch`, 'bad'));
        } else {
          el('fv-summary').insertAdjacentHTML('beforeend', pair('Camera resolution', `${bmp.width}×${bmp.height} (matches config)`));
        }
        bmp.close();
      } catch (_) { /* non-fatal */ }
    }
  }

  // ── Events list + scrub markers ────────────────────────────────────────

  function renderEvents() {
    const list = el('fv-event-list'), s = state;
    if (!s.events.length) {
      list.innerHTML = '<div class="fv-event-empty">No events.jsonl in this flight</div>';
      renderScrubMarkers();
      return;
    }
    // COMMAND events (arm, ping, countdown_update, ...) dominate the log by
    // count and add little value to a flight review — hidden from the list.
    // Still parsed and kept in s.events itself: countdown_start/update payloads
    // are the source for the T-/T+ zero reference in the broadcast overlay.
    const visible = s.events.filter(e => e.type !== 'COMMAND');
    if (!visible.length) {
      list.innerHTML = '<div class="fv-event-empty">No non-command events in this flight</div>';
      renderScrubMarkers();
      return;
    }
    list.innerHTML = visible.map(e => {
      const cls = String(e.type || '').toLowerCase().replace(/_/g, '-');
      const tMs = ((e.mono_us || 0) - s.t0) / 1000;
      const detail = (e.msg && e.msg !== e.type) ? e.msg : (e.detail || e.cause || '');
      return `<div class="fv-event ${cls}" data-t="${tMs}">
        <span class="fv-ev-t">${fmtClock(Math.max(0, tMs))}</span><span class="fv-ev-type">${escapeHtml(e.type || 'EVENT')}</span>
        ${detail ? `<div class="fv-ev-detail">${escapeHtml(String(detail))}</div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.fv-event').forEach(node => {
      node.addEventListener('click', () => seekTo(parseFloat(node.dataset.t)));
    });
    renderScrubMarkers();
  }

  function renderScrubMarkers() {
    const wrap = el('fv-scrub-events'), s = state;
    wrap.innerHTML = '';
    if (!s.durationMs) return;
    for (const e of s.events) {
      if (!NOTABLE_EVENT_TYPES.includes(e.type)) continue;
      const tMs = ((e.mono_us || 0) - s.t0) / 1000;
      if (tMs < 0 || tMs > s.durationMs) continue; // outside the video/telemetry window — listed in the sidebar, not on the scrub bar
      const pct = (tMs / s.durationMs) * 100;
      const div = document.createElement('div');
      div.className = 'fv-scrub-event' + (e.type === 'LIFTOFF' ? ' liftoff' : e.type === 'LANDING' ? ' landed' : '');
      div.style.left = pct + '%';
      div.title = `${e.type} @ ${fmtClock(tMs)}`;
      div.addEventListener('click', ev => { ev.stopPropagation(); seekTo(tMs); });
      wrap.appendChild(div);
    }
  }

  // ── Charts ─────────────────────────────────────────────────────────────

  const CHART_DEFS = [
    { key: 'accelMag', label: 'Acceleration magnitude', unit: 'm/s²', series: [{ key: 'accelMag', color: '#ff9b92' }] },
    { key: 'altitude', label: 'Altitude, relative to start', unit: 'm', series: [{ key: 'altitudeM', color: '#4d9fff', relative: true }] },
    { key: 'vertVel', label: 'Vertical velocity', unit: 'm/s', series: [{ key: 'vertVelMs', color: '#36f0a0' }] },
    { key: 'gyro', label: 'Gyro magnitude', unit: 'deg/s', series: [{ key: 'gyroMag', color: '#c99dff' }] },
    { key: 'pressure', label: 'Barometric pressure', unit: 'Pa', series: [{ key: 'pressurePa', color: '#9fd4ff' }] },
    {
      key: 'temps', label: 'Temperatures — baro / imu / mcu', unit: '°C', series: [
        { key: 'tempBmpC', color: '#4d9fff', name: 'baro' },
        { key: 'tempImuC', color: '#ff9b92', name: 'imu' },
        { key: 'tempMcuC', color: '#ffb347', name: 'mcu' },
      ]
    },
  ];

  function chartValue(rec, key, baseline) {
    if (key === 'gyroMag') return Math.hypot(rec.gx, rec.gy, rec.gz);
    const v = rec[key];
    return baseline != null ? v - baseline : v;
  }

  function renderCharts() {
    const wrap = el('fv-charts'), s = state;
    if (!s.telem.records.length) {
      wrap.innerHTML = '<div class="fv-event-empty">No telemetry.bin in this flight</div>';
      return;
    }
    const altBaseline = s.telem.records[0].altitudeM;

    wrap.innerHTML = CHART_DEFS.map(def => `
      <div class="fv-chart" data-key="${def.key}">
        <div class="fv-chart-head"><span>${escapeHtml(def.label)} (${escapeHtml(def.unit)})</span></div>
        <div style="position:relative">
          <canvas></canvas>
          <div class="fv-chart-playhead"></div>
        </div>
      </div>
    `).join('');

    CHART_DEFS.forEach(def => {
      const canvas = wrap.querySelector(`.fv-chart[data-key="${def.key}"] canvas`);
      const seriesArray = def.series.map(sr => ({
        color: sr.color,
        name: sr.name,
        points: s.telem.records.map(r => ({
          x: (r.monoUs - s.t0) / 1000,
          y: chartValue(r, sr.key, sr.relative ? altBaseline : null),
        })),
      }));
      drawChart(canvas, seriesArray);
      canvas.addEventListener('click', e => seekFromChart(canvas, e));
      canvas.addEventListener('mousemove', e => showChartTooltip(canvas, e, seriesArray, def));
      canvas.addEventListener('mouseleave', hideChartTooltip);
    });
  }

  function drawChart(canvas, seriesArray) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const xMin = 0, xMax = Math.max(1, state.durationMs);
    const allY = [];
    for (const sr of seriesArray) for (const p of sr.points) if (Number.isFinite(p.y) && p.y > -900) allY.push(p.y);
    if (!allY.length) { canvas._fvScale = { xMin, xMax }; return; }
    let yMin = arrMin(allY), yMax = arrMax(allY);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const padY = (yMax - yMin) * 0.1;
    yMin -= padY; yMax += padY;

    const X = x => ((x - xMin) / (xMax - xMin)) * w;
    const Y = y => h - ((y - yMin) / (yMax - yMin)) * h;

    if (yMin < 0 && yMax > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
    }

    for (const sr of seriesArray) {
      const pts = sr.points.filter(p => Number.isFinite(p.y) && p.y > -900);
      if (!pts.length) continue;
      ctx.strokeStyle = sr.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      pts.forEach((p, i) => { const px = X(p.x), py = Y(p.y); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
    }
    canvas._fvScale = { xMin, xMax, yMin, yMax };
  }

  function seekFromChart(canvas, evt) {
    const scale = canvas._fvScale;
    if (!scale) return;
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const ms = scale.xMin + (x / rect.width) * (scale.xMax - scale.xMin);
    seekTo(ms);
  }

  function ensureTooltip() {
    if (chartTooltip) return chartTooltip;
    chartTooltip = document.createElement('div');
    chartTooltip.className = 'fv-chart-tooltip';
    chartTooltip.hidden = true;
    document.body.appendChild(chartTooltip);
    return chartTooltip;
  }

  function showChartTooltip(canvas, evt, seriesArray, def) {
    const scale = canvas._fvScale;
    if (!scale || !state.telem.records.length) return;
    const rect = canvas.getBoundingClientRect();
    const xFrac = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
    const tMs = scale.xMin + xFrac * (scale.xMax - scale.xMin);
    const targetUs = state.t0 + tMs * 1000;
    const rec = nearestByMonoUs(state.telem.records, targetUs, 'monoUs');
    if (!rec) return;
    const altBaseline = state.telem.records[0].altitudeM;
    const lines = def.series.map(sr => {
      const v = chartValue(rec, sr.key, sr.relative ? altBaseline : null);
      const label = sr.name ? sr.name.toUpperCase() + ' ' : '';
      return `${label}<b>${Number.isFinite(v) && v > -900 ? v.toFixed(2) : '—'}</b>`;
    }).join(' · ');
    const tip = ensureTooltip();
    tip.innerHTML = `${fmtClock(tMs)} — ${lines}`;
    tip.style.left = evt.clientX + 'px';
    tip.style.top = rect.top + 'px';
    tip.hidden = false;
  }
  function hideChartTooltip() { if (chartTooltip) chartTooltip.hidden = true; }

  // ── Playback engine ────────────────────────────────────────────────────

  function seekTo(ms) {
    const s = state;
    s.clockMs = Math.max(0, Math.min(s.durationMs, ms));
    updateFrameForClock();
    updateHud();
    updatePlayheads();
    updateTimeLabel();
  }

  function updateFrameForClock() {
    const s = state;
    if (!s.video.frames.length) return;
    const targetUs = s.t0 + s.clockMs * 1000;
    const idx = nearestIndexByMonoUs(s.video.frames, targetUs, 'monoUs');
    if (idx !== s.lastDrawnFrameIdx) {
      s.lastDrawnFrameIdx = idx;
      drawFrame(idx);
    }
  }

  async function drawFrame(idx) {
    const s = state;
    const frame = s.video.frames[idx];
    if (!frame) return;
    let bmp = s.bitmapCache.get(idx);
    if (!bmp) {
      try { bmp = await createImageBitmap(frame.blob); }
      catch (e) { return; }
      s.bitmapCache.set(idx, bmp);
      if (s.bitmapCache.size > 24) {
        const oldestKey = s.bitmapCache.keys().next().value;
        const oldestBmp = s.bitmapCache.get(oldestKey);
        try { oldestBmp.close(); } catch (_) {}
        s.bitmapCache.delete(oldestKey);
      }
    }
    if (state !== s || s.lastDrawnFrameIdx !== idx) return; // stale by the time decode finished
    const canvas = el('fv-canvas');
    const ctx = canvas.getContext('2d');
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
    ctx.drawImage(bmp, 0, 0);
    el('fv-canvas-empty').hidden = true;

    if (el('fv-overlay-toggle').checked) {
      const rec = s.telem.records.length ? nearestByMonoUs(s.telem.records, frame.monoUs, 'monoUs') : null;
      drawFlightOverlay(ctx, canvas.width, canvas.height, rec, {
        name: s.name, tMs: s.clockMs, durationMs: s.durationMs,
        zeroRefUs: s.zeroRefUs, frameMonoUs: frame.monoUs,
        altBaseline: s.altBaseline, maxAltitudeM: s.maxAltitudeM, maxSpeedKmh: s.maxSpeedKmh,
        orientationRef: s.orientationRef,
      });
    }
  }

  function nearestTelemetryAtClock() {
    const s = state;
    if (!s.telem.records.length) return null;
    return nearestByMonoUs(s.telem.records, s.t0 + s.clockMs * 1000, 'monoUs');
  }

  function updateHud() {
    const hud = el('fv-hud');
    const overlayOn = el('fv-overlay-toggle').checked;
    if (overlayOn || !el('fv-hud-toggle').checked) { hud.hidden = true; return; }
    const rec = nearestTelemetryAtClock();
    if (!rec) { hud.hidden = true; return; }
    hud.hidden = false;
    const mission = MISSION_STATES[rec.missionState] || `#${rec.missionState}`;
    const phase = FLIGHT_PHASES[rec.flightPhase] || `#${rec.flightPhase}`;
    const speedKmh = computeSpeedKmh(rec);
    hud.innerHTML = `
      <span>MISSION <b>${escapeHtml(mission)}</b></span>
      <span>PHASE <b>${escapeHtml(phase)}</b></span>
      <span>SPEED (vert.) <b>${speedKmh.toFixed(1)} km/h</b></span>
      <span>ALT <b>${rec.altitudeM.toFixed(1)} m</b></span>
      <span>VZ <b>${rec.vertVelMs.toFixed(2)} m/s</b></span>
      <span>ACCEL <b>${rec.accelMag.toFixed(2)} m/s²</b></span>
      <span>BARO <b>${rec.tempBmpC > -900 ? rec.tempBmpC.toFixed(1) + '°C' : '—'}</b></span>`;
  }

  function updatePlayheads() {
    const s = state;
    const pct = s.durationMs ? (s.clockMs / s.durationMs) * 100 : 0;
    el('fv-scrub-fill').style.width = pct + '%';
    el('fv-scrub-playhead').style.left = pct + '%';
    document.querySelectorAll('.fv-chart-playhead').forEach(p => { p.style.left = pct + '%'; });
  }

  function updateTimeLabel() { el('fv-time').textContent = `${fmtClock(state.clockMs)} / ${fmtClock(state.durationMs)}`; }

  function updatePlayButton() { el('fv-play').textContent = (state && state.playing) ? '⏸' : '▶'; }

  function play() {
    if (!state || exporting) return;
    if (state.clockMs >= state.durationMs) state.clockMs = 0;
    state.playing = true;
    state.lastRafTs = null;
    updatePlayButton();
  }
  function pause() { if (!state) return; state.playing = false; updatePlayButton(); }
  function stepFrame(dir) {
    if (!state || !state.video.frames.length) return;
    pause();
    const idx = Math.max(0, Math.min(state.video.frames.length - 1, state.lastDrawnFrameIdx + dir));
    seekTo((state.video.frames[idx].monoUs - state.t0) / 1000);
  }

  function tick(ts) {
    if (state && state.playing) {
      if (state.lastRafTs != null) {
        // Backgrounding the tab suspends rAF entirely; on return, ts can jump by
        // however long it was hidden. Cap dt so that doesn't fling the playhead
        // to the end (or past it) the instant the tab regains focus.
        const dt = Math.min(250, ts - state.lastRafTs);
        state.clockMs += dt * state.rate;
        if (state.clockMs >= state.durationMs) { state.clockMs = state.durationMs; state.playing = false; updatePlayButton(); }
      }
      state.lastRafTs = ts;
      updateFrameForClock();
      updateHud();
      updatePlayheads();
      updateTimeLabel();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  // Same discontinuity, opposite trigger: reset the reference timestamp on
  // visibility change so the very next tick after returning doesn't compute a
  // multi-second (or multi-minute) dt from the gap while hidden.
  document.addEventListener('visibilitychange', () => { if (state) state.lastRafTs = null; });

  function setupScrubEvents() {
    const track = el('fv-scrub');
    if (track._fvWired) return;
    track._fvWired = true;
    let dragging = false;
    function seekFromEvent(e) {
      const rect = track.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekTo(pct * state.durationMs);
    }
    track.addEventListener('pointerdown', e => { dragging = true; pause(); seekFromEvent(e); try { track.setPointerCapture(e.pointerId); } catch (_) {} });
    track.addEventListener('pointermove', e => { if (dragging) seekFromEvent(e); });
    track.addEventListener('pointerup', () => { dragging = false; });
  }

  // ── Broadcast-style telemetry overlay ──────────────────────────────────
  // Same visual language as the camera page's cinematic overlay (camera.js
  // drawOverlay): scaled to a 1920px design width, gradient scrims, corner
  // brackets, top-left brand block, bottom telemetry tile strip. Used both for
  // the live "Broadcast overlay" preview toggle and for MP4/WebM export, so
  // what you preview is exactly what gets baked into the exported file.

  function drawCorners(ctx, w, h, pad, u) {
    const len = Math.round(46 * u), off = Math.round(pad * 0.55);
    ctx.strokeStyle = 'rgba(159,212,255,.55)';
    ctx.lineWidth = Math.max(1.5, 2.4 * u);
    const corner = (x, y, dx, dy) => { ctx.beginPath(); ctx.moveTo(x, y + dy * len); ctx.lineTo(x, y); ctx.lineTo(x + dx * len, y); ctx.stroke(); };
    corner(off, off, 1, 1); corner(w - off, off, -1, 1); corner(off, h - off, 1, -1); corner(w - off, h - off, -1, -1);
  }

  // Round speedometer-style gauge: track arc, filled value arc, needle-tip dot,
  // big value + unit centered, label below. `value`/`max` in the same units as
  // `unit`. `subGlyph` draws a small colored marker (e.g. an up/down arrow) —
  // used for vertical speed's direction, which the arc itself can't show.
  function drawRoundGauge(ctx, cx, cy, r, opts) {
    const { value, max, unit, label, color, valueText, subGlyph, subColor } = opts;
    const startA = Math.PI * 0.72, endA = Math.PI * 2.28; // ~275° sweep, gap at bottom
    const frac = value == null ? 0 : Math.max(0, Math.min(1, value / max));
    const valueA = startA + frac * (endA - startA);

    ctx.beginPath(); ctx.arc(cx, cy, r + r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(3,7,19,.6)'; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.02); ctx.strokeStyle = 'rgba(159,212,255,.25)'; ctx.stroke();

    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.5, r * 0.11);
    ctx.strokeStyle = 'rgba(159,212,255,.16)';
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, endA); ctx.stroke();

    if (value != null) {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.arc(cx, cy, r, startA, valueA); ctx.stroke();
      const tipX = cx + Math.cos(valueA) * r, tipY = cy + Math.sin(valueA) * r;
      ctx.beginPath(); ctx.arc(tipX, tipY, Math.max(2, r * 0.06), 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    ctx.lineCap = 'butt';

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(r * 0.42)}px system-ui, Segoe UI, Arial`;
    ctx.fillText(valueText != null ? valueText : (value != null ? value.toFixed(0) : '—'), cx, cy + r * 0.14);
    if (subGlyph) {
      ctx.fillStyle = subColor || color;
      ctx.font = `800 ${Math.round(r * 0.32)}px system-ui, Segoe UI, Arial`;
      ctx.fillText(subGlyph, cx + r * 0.58, cy - r * 0.18);
    }
    ctx.fillStyle = '#9fd4ff';
    ctx.font = `700 ${Math.round(r * 0.19)}px system-ui, Segoe UI, Arial`;
    ctx.fillText(unit, cx, cy + r * 0.42);
    ctx.fillStyle = '#64759c';
    ctx.font = `700 ${Math.round(r * 0.18)}px system-ui, Segoe UI, Arial`;
    ctx.fillText(label, cx, cy + r + Math.round(r * 0.34));
  }

  // Polar attitude dial: rings + crosshair, with a marker plotted at
  // (direction, magnitude) of tilt from the at-rest reference orientation.
  // See computeOrientationRef()/computeTilt() for what this can and can't mean.
  function drawOrientationGauge(ctx, cx, cy, r, tilt) {
    ctx.beginPath(); ctx.arc(cx, cy, r + r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(3,7,19,.6)'; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.02); ctx.strokeStyle = 'rgba(159,212,255,.25)'; ctx.stroke();

    ctx.strokeStyle = 'rgba(159,212,255,.16)'; ctx.lineWidth = Math.max(1, r * 0.02);
    [0.34, 0.67, 1].forEach(f => { ctx.beginPath(); ctx.arc(cx, cy, r * f, 0, Math.PI * 2); ctx.stroke(); });
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    let color = '#64759c', tiltDeg = null, dirRad = 0;
    if (tilt) {
      tiltDeg = tilt.tiltDeg; dirRad = tilt.dirRad;
      color = tiltDeg > 30 ? '#ff4a3d' : tiltDeg > 12 ? '#ffb347' : '#36f0a0';
      const maxTilt = 45;
      const frac = Math.min(1, tiltDeg / maxTilt);
      const mx = cx + Math.cos(dirRad) * r * frac, my = cy + Math.sin(dirRad) * r * frac;
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, r * 0.045);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(mx, my); ctx.stroke();
      ctx.beginPath(); ctx.arc(mx, my, Math.max(2.5, r * 0.08), 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.round(r * 0.34)}px system-ui, Segoe UI, Arial`;
    ctx.fillText(tiltDeg != null ? `${tiltDeg.toFixed(0)}°` : '—', cx, cy + r * 0.14);
    ctx.fillStyle = '#64759c';
    ctx.font = `700 ${Math.round(r * 0.18)}px system-ui, Segoe UI, Arial`;
    ctx.fillText('TILT', cx, cy + r + Math.round(r * 0.34));
  }

  function drawFlightOverlay(ctx, w, h, rec, opts) {
    const u = w / 1920;
    const pad = Math.round(60 * u);
    const accent = '#9fd4ff';
    const phase = rec ? (FLIGHT_PHASES[rec.flightPhase] || 'UNKNOWN') : 'NO DATA';
    const mission = rec ? (MISSION_STATES[rec.missionState] || 'UNKNOWN') : 'NO DATA';
    const phaseColor = PHASE_COLOR[phase] || accent;

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    const topGrad = ctx.createLinearGradient(0, 0, 0, h * 0.22);
    topGrad.addColorStop(0, 'rgba(3,7,19,.72)'); topGrad.addColorStop(1, 'rgba(3,7,19,0)');
    ctx.fillStyle = topGrad; ctx.fillRect(0, 0, w, h * 0.22);
    const botGrad = ctx.createLinearGradient(0, h * 0.74, 0, h);
    botGrad.addColorStop(0, 'rgba(3,7,19,0)'); botGrad.addColorStop(1, 'rgba(3,7,19,.82)');
    ctx.fillStyle = botGrad; ctx.fillRect(0, h * 0.74, w, h * 0.26);

    drawCorners(ctx, w, h, pad, u);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#dbe7ff';
    ctx.font = `800 ${Math.round(34 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillText('NEOLABS ROCKETS', pad, pad + Math.round(26 * u));
    ctx.font = `600 ${Math.round(20 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillStyle = accent;
    ctx.fillText(`${(opts.name || 'FLIGHT').toUpperCase()} · REPLAY`, pad, pad + Math.round(54 * u));

    ctx.textAlign = 'right';
    ctx.fillStyle = '#c9d6ef';
    ctx.font = `700 ${Math.round(24 * u)}px system-ui, Segoe UI, Arial`;
    // Countdown before liftoff (T-), elapsed after (T+) — flips at the real
    // liftoff/ignition zero, not at recording start. See findZeroReferenceUs().
    let clockLabel;
    if (opts.zeroRefUs != null && opts.frameMonoUs != null) {
      const relMs = (opts.frameMonoUs - opts.zeroRefUs) / 1000;
      clockLabel = relMs < 0 ? `T-${fmtClock(-relMs)}` : `T+${fmtClock(relMs)}`;
    } else {
      clockLabel = `T+${fmtClock(opts.tMs || 0)}`;
    }
    ctx.fillText(clockLabel, w - pad, pad + Math.round(24 * u));
    ctx.font = `800 ${Math.round(22 * u)}px system-ui, Segoe UI, Arial`;
    ctx.fillStyle = phaseColor;
    ctx.fillText(phase, w - pad, pad + Math.round(54 * u));

    // Slim text row: MISSION / ACCEL / BARO. ALT and VZ moved to the round
    // gauges below (SPEED shows |vertVelMs|, ALTITUDE shows relative altitude).
    const tiles = [['MISSION', mission, phaseColor]];
    if (rec) {
      tiles.push(['ACCEL', `${rec.accelMag.toFixed(2)} m/s²`, '#ff9b92']);
      if (rec.tempBmpC > -900) tiles.push(['BARO', `${rec.tempBmpC.toFixed(1)}°C`, '#dbe7ff']);
    }
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

    // Round gauges: SPEED (vertical), ALTITUDE (relative to start), ORIENTATION.
    // Clustered bottom-right (not center-screen) so they sit over the scrim
    // and stay out of the way of the actual video subject.
    const gaugeR = h * 0.075;
    const gaugeY = h - pad - gaugeR * 1.7;
    const rightEdge = w - pad - gaugeR;
    const gaugeStep = gaugeR * 2.3;
    const gaugeXs = [rightEdge - gaugeStep * 2, rightEdge - gaugeStep, rightEdge];

    const speedKmh = rec ? computeSpeedKmh(rec) : null;
    const ascending = rec ? rec.vertVelMs > 0.5 : null;
    drawRoundGauge(ctx, gaugeXs[0], gaugeY, gaugeR, {
      value: speedKmh, max: opts.maxSpeedKmh || 50, unit: 'KM/H', label: 'SPEED (VERT)',
      color: '#9fd4ff', valueText: speedKmh != null ? speedKmh.toFixed(1) : null,
      subGlyph: rec ? (ascending ? '▲' : '▼') : null,
      subColor: rec ? (ascending ? '#36f0a0' : '#ffb347') : null,
    });

    const altRel = rec && opts.altBaseline != null ? rec.altitudeM - opts.altBaseline : null;
    drawRoundGauge(ctx, gaugeXs[1], gaugeY, gaugeR, {
      value: altRel, max: opts.maxAltitudeM || 100, unit: 'M', label: 'ALTITUDE',
      color: '#36f0a0', valueText: altRel != null ? altRel.toFixed(1) : null,
    });

    const tilt = rec && opts.orientationRef ? computeTilt(rec, opts.orientationRef) : null;
    drawOrientationGauge(ctx, gaugeXs[2], gaugeY, gaugeR, tilt);

    ctx.restore();
  }

  // ── Export: renders the flight to a downloadable video file using
  //    Canvas + MediaRecorder — no server, no new dependency (no ffmpeg.wasm).
  //    Trade-off, stated plainly: exact MP4 muxing depends on browser support
  //    (Safari / recent Chrome support it; Firefox generally doesn't), so this
  //    falls back to WebM and labels the file honestly rather than lying about
  //    the extension. Because MediaRecorder captures in real time, rendering
  //    takes roughly (flight duration / render speed) wall-clock time. ──

  function pickExportMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    if (!window.MediaRecorder) return null;
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) || null;
  }

  function setExportStatus(msg, tone) {
    const n = el('fv-export-status');
    n.textContent = msg;
    n.classList.remove('ok', 'warn', 'bad');
    if (tone) n.classList.add(tone);
  }
  function setExportProgress(pct, label) {
    const wrap = el('fv-export-progress-wrap');
    wrap.hidden = false;
    el('fv-export-progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    el('fv-export-progress-text').textContent = label || '';
  }

  // Cleaned JSON export: same telemetry/events/metadata already parsed above,
  // with enum bytes resolved to names and the derived speed/tilt fields added,
  // so it's usable directly (Python/Excel/whatever) without re-implementing
  // this file's byte-level parsing. Video frames are listed by index+timestamp
  // only — embedding JPEG bytes in JSON would bloat the file for no benefit.
  function buildCleanFlightData() {
    const s = state;
    const altBaseline = s.telem.records.length ? s.telem.records[0].altitudeM : 0;
    return {
      flight: s.name,
      generatedBy: 'NeoLabs Flight Viewer',
      metadata: s.metadata,
      summary: {
        durationMs: s.durationMs,
        zeroReferenceUs: s.zeroRefUs,
        videoFrameCount: s.video.frames.length,
        videoCorruptFrames: s.video.corrupt,
        videoTruncated: s.video.truncated,
        telemetryRecordCount: s.telem.records.length,
        telemetryCrcErrors: s.telem.crcErrors,
        telemetryMagicErrors: s.telem.magicErrors,
        eventCount: s.events.length,
        eventsUnparseableLines: s.eventsBad,
      },
      telemetry: s.telem.records.map(r => {
        const tilt = computeTilt(r, s.orientationRef);
        return {
          tMs: (r.monoUs - s.t0) / 1000,
          monoUs: r.monoUs,
          ax: r.ax, ay: r.ay, az: r.az,
          gx: r.gx, gy: r.gy, gz: r.gz,
          accelMagMs2: r.accelMag,
          pressurePa: r.pressurePa,
          altitudeM: r.altitudeM,
          altitudeRelM: r.altitudeM - altBaseline,
          vertVelMs: r.vertVelMs,
          speedKmh: computeSpeedKmh(r),
          tiltDeg: tilt ? tilt.tiltDeg : null,
          tempBmpC: r.tempBmpC > -900 ? r.tempBmpC : null,
          tempImuC: r.tempImuC > -900 ? r.tempImuC : null,
          tempMcuC: r.tempMcuC > -900 ? r.tempMcuC : null,
          missionState: MISSION_STATES[r.missionState] || null,
          recordingState: RECORDING_STATES[r.recordingState] || null,
          flightPhase: FLIGHT_PHASES[r.flightPhase] || null,
          frameCount: r.frameCount,
          actualFps: r.actualFpsX10 / 10,
          droppedFrames: r.droppedFrames,
          freeSdKb: r.freeSdKb,
          seq: r.seq,
          crcOk: r.crcOk,
        };
      }),
      events: s.events.map(e => ({ ...e, tMs: ((e.mono_us || 0) - s.t0) / 1000 })),
      videoFrames: s.video.frames.map(f => ({ index: f.index, tMs: (f.monoUs - s.t0) / 1000 })),
    };
  }

  function exportJson() {
    if (!state) { setExportStatus('No flight loaded', 'bad'); return; }
    const data = buildCleanFlightData();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name}_clean.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setExportStatus(`Exported ${a.download} (${fmtBytes(blob.size)})`, 'ok');
  }

  async function exportVideo() {
    if (!state || !state.video.frames.length || exporting) {
      setExportStatus('No video in this flight to export', 'bad');
      return;
    }
    const mimeType = pickExportMime();
    if (!mimeType) {
      setExportStatus('This browser does not support MediaRecorder — cannot export video locally', 'bad');
      return;
    }
    const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    if (ext !== 'mp4') {
      setExportStatus('This browser cannot mux MP4 in MediaRecorder — exporting WebM instead (same content, different container)', 'warn');
    }

    const burnOverlay = el('fv-export-overlay').value === 'on';
    const rate = parseFloat(el('fv-export-rate').value) || 1;
    const wasPlaying = state.playing;
    pause();

    exporting = true;
    exportCancelled = false;
    el('fv-export-start').disabled = true;
    el('fv-export-cancel').hidden = false;

    const frames = state.video.frames;
    const exportCanvas = document.createElement('canvas');
    let firstBmp;
    try { firstBmp = await createImageBitmap(frames[0].blob); }
    catch (e) { setExportStatus('Failed to decode first frame', 'bad'); exporting = false; el('fv-export-start').disabled = false; el('fv-export-cancel').hidden = true; return; }
    exportCanvas.width = firstBmp.width;
    exportCanvas.height = firstBmp.height;
    firstBmp.close();
    const ctx = exportCanvas.getContext('2d');

    const stream = exportCanvas.captureStream(30); // fixed sampling rate; broadly supported, no requestFrame() dependency
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    } catch (e) {
      setExportStatus(`Failed to start recorder: ${e.message || e}`, 'bad');
      exporting = false; el('fv-export-start').disabled = false; el('fv-export-cancel').hidden = true;
      return;
    }
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();

    const t0 = frames[0].monoUs;
    try {
      for (let i = 0; i < frames.length; i++) {
        if (exportCancelled) break;
        const frame = frames[i];
        let bmp;
        try { bmp = await createImageBitmap(frame.blob); }
        catch (e) { continue; }
        ctx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);
        ctx.drawImage(bmp, 0, 0, exportCanvas.width, exportCanvas.height);
        bmp.close();
        if (burnOverlay) {
          const rec = state.telem.records.length ? nearestByMonoUs(state.telem.records, frame.monoUs, 'monoUs') : null;
          drawFlightOverlay(ctx, exportCanvas.width, exportCanvas.height, rec, {
            name: state.name, tMs: (frame.monoUs - t0) / 1000, durationMs: state.durationMs,
            zeroRefUs: state.zeroRefUs, frameMonoUs: frame.monoUs,
            altBaseline: state.altBaseline, maxAltitudeM: state.maxAltitudeM, maxSpeedKmh: state.maxSpeedKmh,
            orientationRef: state.orientationRef,
          });
        }
        setExportProgress(((i + 1) / frames.length) * 100, `Rendering frame ${i + 1} / ${frames.length}`);
        if (i < frames.length - 1) {
          const gapMs = (frames[i + 1].monoUs - frame.monoUs) / 1000 / rate;
          await sleep(Math.max(1, gapMs));
        }
      }
    } finally {
      recorder.stop();
      await stopped;
    }

    exporting = false;
    el('fv-export-start').disabled = false;
    el('fv-export-cancel').hidden = true;

    if (exportCancelled) {
      setExportStatus('Export cancelled', 'warn');
      setExportProgress(0, '');
      if (wasPlaying) play();
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name}_${burnOverlay ? 'overlay' : 'plain'}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setExportProgress(100, 'Done');
    setExportStatus(`Exported ${a.download} (${fmtBytes(blob.size)}, ${ext.toUpperCase()})`, ext === 'mp4' ? 'ok' : 'warn');
    if (wasPlaying) play();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  function wire() {
    const dropZone = el('fv-drop');

    dropZone.addEventListener('click', e => { if (!e.target.closest('button')) el('fv-file-zip').click(); });
    dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('fv-file-zip').click(); } });
    el('fv-pick-zip').addEventListener('click', e => { e.stopPropagation(); el('fv-file-zip').click(); });
    el('fv-pick-dir').addEventListener('click', e => { e.stopPropagation(); el('fv-file-dir').click(); });

    el('fv-file-zip').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      setDropStatus(`Reading ${f.name}…`, '');
      try { await loadFromEntries(await entriesFromZip(f)); }
      catch (err) { setDropStatus(`Failed to read ZIP: ${err.message || err}`, 'bad'); }
    });
    el('fv-file-dir').addEventListener('change', async e => {
      const files = e.target.files; e.target.value = '';
      if (!files || !files.length) return;
      setDropStatus(`Reading ${files.length} file(s)…`, '');
      try { await loadFromEntries(entriesFromFileList(files)); }
      catch (err) { setDropStatus(`Failed to read folder: ${err.message || err}`, 'bad'); }
    });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      setDropStatus('Reading dropped files…', '');
      try {
        const dt = e.dataTransfer;
        if (dt.files && dt.files.length === 1 && dt.files[0].name.toLowerCase().endsWith('.zip')) {
          await loadFromEntries(await entriesFromZip(dt.files[0]));
          return;
        }
        await loadFromEntries(await entriesFromDataTransfer(dt));
      } catch (err) {
        setDropStatus(`Failed to load: ${err.message || err}`, 'bad');
      }
    });

    el('fv-play').addEventListener('click', () => { if (state && state.playing) pause(); else play(); });
    el('fv-step-back').addEventListener('click', () => stepFrame(-1));
    el('fv-step-fwd').addEventListener('click', () => stepFrame(1));
    el('fv-rate').addEventListener('change', e => { if (state) state.rate = parseFloat(e.target.value); });
    el('fv-hud-toggle').addEventListener('change', updateHud);
    el('fv-overlay-toggle').addEventListener('change', () => { updateHud(); updateFrameForClockForced(); });

    el('fv-export-start').addEventListener('click', exportVideo);
    el('fv-export-cancel').addEventListener('click', () => { exportCancelled = true; });
    el('fv-export-json').addEventListener('click', exportJson);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (!state) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { renderCharts(); updatePlayheads(); }, 150);
    });
  }

  // Force a redraw of the current frame (e.g. after toggling the overlay) even
  // though the target video frame index hasn't changed.
  function updateFrameForClockForced() {
    if (state) { state.lastDrawnFrameIdx = -1; updateFrameForClock(); }
  }

  window.NeoRcData = {
    onShow() { if (state) { renderCharts(); updatePlayheads(); } },
    // Read-only introspection for debugging in the console — not used by the app itself.
    debugState() { return state; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
