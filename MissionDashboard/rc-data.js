/*
  RC Data — download flight telemetry + video from the rocket computer over BLE,
  pack into a ZIP in the browser, then optionally delete the flight on-device.
*/
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function setText(id, v) { const n = el(id); if (n) n.textContent = v == null ? '—' : String(v); }

  let flights = [];
  let selectedFlight = null;
  let busy = false;

  function link() {
    return window.NeoRocketComputer?.link || null;
  }

  function connected() {
    return !!window.NeoRocketComputer?.connected?.();
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function setStatus(msg, tone) {
    const bar = el('rcd-status');
    if (!bar) return;
    bar.textContent = msg;
    bar.classList.remove('ok', 'warn', 'bad');
    if (tone) bar.classList.add(tone);
  }

  function setProgress(pct, label) {
    const fill = el('rcd-progress-fill');
    const text = el('rcd-progress-text');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (text) text.textContent = label || `${Math.round(pct)}%`;
  }

  function renderConnection() {
    const on = connected();
    const lnk = link();
    setText('rcd-link', on ? (lnk?.deviceName || 'Connected') : (lnk?.state === 'reconnecting' ? 'Reconnecting…' : 'Not connected'));
    setText('rcd-xfer', on
      ? (lnk?.fileTransferSupported ? 'Supported' : 'Firmware lacks file transfer')
      : '—');
    el('rcd-connect') && (el('rcd-connect').disabled = on || lnk?.state === 'connecting');
    el('rcd-disconnect') && (el('rcd-disconnect').disabled = !on && lnk?.state === 'idle');
    el('rcd-refresh') && (el('rcd-refresh').disabled = !on || busy);
    el('rcd-download') && (el('rcd-download').disabled = !on || busy || !selectedFlight);
  }

  function renderFlights() {
    const list = el('rcd-flight-list');
    if (!list) return;
    if (!flights.length) {
      list.innerHTML = '<div class="rcd-empty">No flights on card. Record a session first, or connect the rocket computer.</div>';
      return;
    }
    list.innerHTML = flights.map(f => {
      const active = selectedFlight === f.name;
      const tags = [
        f.active ? '<span class="rcd-tag hot">Recording</span>' : '',
        f.incomplete ? '<span class="rcd-tag warn">Incomplete</span>' : '',
        `<span class="rcd-tag">${f.files || 0} files</span>`,
        `<span class="rcd-tag">${fmtBytes(f.bytes)}</span>`
      ].join('');
      return `<button type="button" class="rcd-flight${active ? ' active' : ''}${f.active ? ' disabled' : ''}" data-flight="${escapeAttr(f.name)}" ${f.active ? 'disabled' : ''}>
        <div class="rcd-flight-name">${escapeHtml(f.name)}</div>
        <div class="rcd-flight-meta">${tags}</div>
      </button>`;
    }).join('');
    list.querySelectorAll('.rcd-flight').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        selectedFlight = btn.dataset.flight;
        renderFlights();
        renderConnection();
        setStatus(`Selected ${selectedFlight}`, 'ok');
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  async function connect() {
    const lnk = link();
    if (!lnk) {
      setStatus('Rocket computer module not loaded', 'bad');
      return;
    }
    try {
      setStatus('Select NeoLabs Rocket Computer…', 'warn');
      if (lnk.state === 'reconnecting') lnk.retryNow();
      else await lnk.connectViaChooser();
      setStatus('Connected', 'ok');
      await refreshFlights();
    } catch (err) {
      setStatus(err.message || String(err), 'bad');
    }
    renderConnection();
  }

  function disconnect() {
    link()?.disconnect();
    flights = [];
    selectedFlight = null;
    renderFlights();
    renderConnection();
    setStatus('Disconnected', 'warn');
  }

  async function refreshFlights() {
    if (!connected()) {
      setStatus('Connect the rocket computer first', 'warn');
      return;
    }
    busy = true;
    renderConnection();
    try {
      setStatus('Listing flights on microSD…', 'warn');
      flights = await link().listFlights();
      selectedFlight = null;
      renderFlights();
      setStatus(flights.length ? `${flights.length} flight(s) found` : 'No flights on card', 'ok');
    } catch (err) {
      setStatus(`List failed: ${err.message || err}`, 'bad');
    } finally {
      busy = false;
      renderConnection();
    }
  }

  async function downloadSelected() {
    if (!selectedFlight || !connected() || busy) return;
    const flight = selectedFlight;
    const meta = flights.find(f => f.name === flight);
    if (meta?.active) {
      setStatus('Cannot download an active recording — stop recording first', 'bad');
      return;
    }
    if (typeof JSZip === 'undefined') {
      setStatus('JSZip failed to load — check network/CDN', 'bad');
      return;
    }

    busy = true;
    renderConnection();
    setProgress(0, 'Preparing…');
    try {
      setStatus(`Listing files in ${flight}…`, 'warn');
      const files = await link().listFiles(flight);
      if (!files.length) throw new Error('No files in this flight folder');

      const zip = new JSZip();
      const folder = zip.folder(flight);
      const totalBytes = files.reduce((s, f) => s + (Number(f.size) || 0), 0) || 1;
      let doneBytes = 0;

      for (const file of files) {
        setStatus(`Downloading ${file.name}…`, 'warn');
        const data = await link().downloadFile(flight, file.name, ({ offset, total }) => {
          const filePct = total ? offset / total : 0;
          const overall = ((doneBytes + filePct * (Number(file.size) || 0)) / totalBytes) * 100;
          setProgress(overall, `${file.name} · ${fmtBytes(offset)} / ${fmtBytes(total)}`);
        });
        folder.file(file.name, data);
        doneBytes += Number(file.size) || data.byteLength;
        setProgress((doneBytes / totalBytes) * 100, `${file.name} done`);
      }

      setStatus('Building ZIP…', 'warn');
      setProgress(99, 'Compressing…');
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const zipName = `${flight}_${stamp}.zip`;
      triggerDownload(blob, zipName);
      setProgress(100, 'Download complete');
      setStatus(`Saved ${zipName} (${fmtBytes(blob.size)})`, 'ok');

      // Ask whether to delete on rocket computer
      const del = window.confirm(
        `ZIP downloaded: ${zipName}\n\n`
        + `Delete flight "${flight}" from the rocket computer microSD?\n\n`
        + 'This cannot be undone.'
      );
      if (del) {
        setStatus(`Deleting ${flight} on device…`, 'warn');
        try {
          await link().deleteFlight(flight);
          setStatus(`Deleted ${flight} on rocket computer`, 'ok');
        } catch (err) {
          setStatus(`ZIP saved, but delete failed: ${err.message || err}`, 'warn');
        }
        await refreshFlights();
      }
    } catch (err) {
      setStatus(`Download failed: ${err.message || err}`, 'bad');
      setProgress(0, 'Failed');
    } finally {
      busy = false;
      renderConnection();
    }
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  function wire() {
    el('rcd-connect')?.addEventListener('click', connect);
    el('rcd-disconnect')?.addEventListener('click', disconnect);
    el('rcd-refresh')?.addEventListener('click', refreshFlights);
    el('rcd-download')?.addEventListener('click', downloadSelected);

    // Keep link state in sync with shared rocket connection
    const lnk = link();
    if (lnk) {
      lnk.on('state', () => { renderConnection(); });
      lnk.on('status', () => { renderConnection(); });
    }
    // Poll lightly in case NeoRocketComputer attaches later
    setInterval(() => {
      renderConnection();
      const l = link();
      if (l && !l._rcdWired) {
        l._rcdWired = true;
        l.on('state', () => renderConnection());
      }
    }, 1500);

    renderConnection();
    renderFlights();
    setStatus('Connect the rocket computer to browse flights on microSD.', '');
  }

  window.NeoRcData = {
    onShow() {
      renderConnection();
      if (connected() && !flights.length) refreshFlights().catch(() => {});
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
