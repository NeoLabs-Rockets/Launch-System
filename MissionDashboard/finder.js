/*
  NeoLabs Mission Dashboard — Launch Location Finder.
  Wrapped in an IIFE so its helpers never collide with the other view scripts in
  the single-page app. Scores a grid of candidate launch points against OSM
  hazards (roads, power, housing, settlements, rail, airports, trees, public
  areas, water) with per-hazard enable toggles, buffers, and open-field weighting.
*/
(function () {
  'use strict';

  const FINDER_SETTINGS_KEY = 'neolabs.locationFinder.settings';
  const DEG = Math.PI / 180;

  // Hazard categories: enable toggle id, buffer input id, soft penalty weight.
  const HAZARDS = [
    { key: 'road',       en: 'lf-en-road',       buf: 'lf-road',       weight: 18, color: '#9fd4ff' },
    { key: 'highway',    en: 'lf-en-highway',    buf: 'lf-highway',    weight: 26, color: '#ffb347' },
    { key: 'power',      en: 'lf-en-power',      buf: 'lf-power',      weight: 28, color: '#ff4a3d' },
    { key: 'housing',    en: 'lf-en-housing',    buf: 'lf-housing',    weight: 35, color: '#ff4a3d' },
    { key: 'settlement', en: 'lf-en-settlement', buf: 'lf-settlement', weight: 42, color: '#ff6a5d' },
    { key: 'rail',       en: 'lf-en-rail',       buf: 'lf-rail',       weight: 24, color: '#c9d6ef' },
    { key: 'airport',    en: 'lf-en-airport',    buf: 'lf-airport',    weight: 45, color: '#ff4a3d' },
    { key: 'trees',      en: 'lf-en-trees',      buf: 'lf-trees',      weight: 18, color: '#36f0a0' },
    { key: 'public',     en: 'lf-en-public',     buf: 'lf-public',     weight: 24, color: '#ffb347' },
    { key: 'water',      en: 'lf-en-water',      buf: 'lf-water',      weight: 26, color: '#4d9fff' }
  ];
  const HAZARD_LABEL = {
    road: 'road', highway: 'highway', power: 'power line', housing: 'housing',
    settlement: 'settlement', rail: 'rail', airport: 'airport', trees: 'trees',
    public: 'public area', water: 'water'
  };

  let map, centerMarker, candidateLayer, searchLayer;
  let lastCandidates = [];
  let mapReady = false;

  window.FinderApp = { onShow };

  document.addEventListener('DOMContentLoaded', () => {
    restoreSettings();
    bindControls();
  });

  function onShow() {
    if (!mapReady) initMap();
    if (map) setTimeout(() => map.invalidateSize(), 80);
    // Default the center to the dashboard's acquired location if nothing set yet.
    const haveCenter = Number.isFinite(Number(val('lf-lat'))) && Number.isFinite(Number(val('lf-lon')));
    if (!haveCenter) {
      const shared = sharedLocation();
      if (shared) {
        setCenter(shared.lat, shared.lon, true);
        setStatus('Location ready', 'Adjust filters or run analysis.', 'ok');
      } else {
        locate();
      }
    }
  }

  // Reuse the dashboard's acquired GPS fix (a shared top-level binding) so the
  // finder doesn't trigger a second location prompt when one is already known.
  function sharedLocation() {
    try {
      if (typeof userLat === 'number' && typeof userLon === 'number'
          && Number.isFinite(userLat) && Number.isFinite(userLon)) {
        return { lat: userLat, lon: userLon };
      }
    } catch (_) {}
    return null;
  }

  function bindControls() {
    document.getElementById('lf-locate').addEventListener('click', locate);
    document.getElementById('lf-analyze').addEventListener('click', analyze);
    finderControls().forEach(elm => {
      elm.addEventListener('change', persistSettings);
    });
  }

  function finderControls() {
    return Array.from(document.querySelectorAll('#view-finder input, #view-finder select'));
  }

  function restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(FINDER_SETTINGS_KEY) || '{}');
      // Migrate the former 600 m highway default to the new conservative value.
      if (String(saved['lf-highway'] ?? '') === '600') saved['lf-highway'] = '3000';
      finderControls().forEach(elm => {
        if (!(elm.id in saved)) return;
        if (elm.type === 'checkbox') elm.checked = !!saved[elm.id];
        else if (saved[elm.id] !== '') elm.value = saved[elm.id];
      });
    } catch (_) {}
  }

  function persistSettings() {
    const data = {};
    finderControls().forEach(elm => {
      data[elm.id] = elm.type === 'checkbox' ? elm.checked : elm.value;
    });
    try { localStorage.setItem(FINDER_SETTINGS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function initMap() {
    if (!window.L) {
      setStatus('Map library unavailable', 'Reload when internet is available.', 'bad');
      return;
    }
    map = L.map('finder-map', { zoomControl: true }).setView([51.1657, 10.4515], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    candidateLayer = L.layerGroup().addTo(map);
    searchLayer = L.layerGroup().addTo(map);
    map.on('click', e => setCenter(e.latlng.lat, e.latlng.lng, true));
    mapReady = true;
  }

  function locate() {
    if (!navigator.geolocation?.getCurrentPosition) {
      setStatus('GPS unavailable', 'Needs HTTPS or localhost — enter coordinates or click the map.', 'warn');
      return;
    }
    setStatus('Getting GPS', 'Waiting for browser location.', 'warn');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCenter(pos.coords.latitude, pos.coords.longitude, true);
        setStatus('Location ready', 'Adjust filters or run analysis.', 'ok');
      },
      () => setStatus('GPS unavailable', 'Enter coordinates or click the map.', 'warn'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function setCenter(lat, lon, pan) {
    document.getElementById('lf-lat').value = Number(lat).toFixed(5);
    document.getElementById('lf-lon').value = Number(lon).toFixed(5);
    persistSettings();
    if (!map) return;
    const ll = [lat, lon];
    if (centerMarker) centerMarker.setLatLng(ll);
    else centerMarker = L.marker(ll).addTo(map).bindPopup('Search center');
    if (pan) map.setView(ll, Math.max(map.getZoom(), 12));
    drawSearchRadius();
  }

  function val(id) { return document.getElementById(id)?.value; }
  function on(id) { return !!document.getElementById(id)?.checked; }

  function values() {
    const read = id => Number(document.getElementById(id).value);
    const enabled = {};
    const buffers = {};
    HAZARDS.forEach(h => {
      enabled[h.key] = on(h.en);
      buffers[h.key] = clamp(read(h.buf), 10, 12000);
    });
    return {
      lat: read('lf-lat'),
      lon: read('lf-lon'),
      radiusKm: clamp(read('lf-radius'), 1, 15),
      spacingM: clamp(read('lf-spacing'), 120, 1000),
      minScore: clamp(read('lf-minscore'), 0, 100),
      results: clamp(read('lf-results'), 5, 60),
      sort: val('lf-sort') || 'score',
      fieldPref: val('lf-fieldpref') || 'prefer',
      enabled,
      buffers
    };
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
  }

  async function analyze() {
    const cfg = values();
    if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lon)) {
      setStatus('No center point', 'Use GPS, enter coordinates, or click the map.', 'bad');
      return;
    }
    if (!mapReady) initMap();
    setCenter(cfg.lat, cfg.lon, false);
    setStatus('Analyzing area', '', 'warn');
    document.getElementById('lf-summary').textContent = 'Analyzing area…';
    try {
      await window.NeoAuthReady;
      const r = await fetch('/api/finder-analysis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg)
      });
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const osm = await r.json();
      const candidates = osm.candidates || [];
      lastCandidates = candidates;
      renderMap(cfg, candidates, osm.green || []);
      renderFeatureCounts(osm.featureCounts || {});
      renderResults(cfg, candidates, osm);
      setStatus(osm.cached ? 'Using cached OSM data' : 'Analysis complete',
        `${osm.featureCount || 0} map features checked · ${candidates.length} candidates ranked.`, osm.cached ? 'warn' : 'ok');
    } catch (err) {
      setStatus('OSM data unavailable', 'Try a smaller radius or retry later.', 'bad');
      document.getElementById('lf-results-table').innerHTML =
        '<div class="empty-state" style="color:var(--amber)">Could not load map safety data.</div>';
    }
  }

  function renderMap(cfg, candidates, greenCandidates) {
    if (!map) return;
    candidateLayer.clearLayers();
    drawSearchRadius();
    greenCandidates.forEach(c => {
      L.circle([c.lat, c.lon], {
        radius: cfg.spacingM * 0.72, stroke: false, fillColor: '#36f0a0', fillOpacity: 0.28
      }).addTo(candidateLayer);
    });
    candidates.forEach((c, i) => {
      if (c.score < 78) return; // only plot green (safe) candidates
      L.circleMarker([c.lat, c.lon], {
        radius: i === 0 ? 9 : 6, color: '#36f0a0', fillColor: '#36f0a0', fillOpacity: 0.75, weight: 2
      }).addTo(candidateLayer).bindPopup(candidatePopup(c, i));
    });
    const b = bboxFor(cfg);
    map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [24, 24] });
  }

  function drawSearchRadius() {
    if (!map || !searchLayer) return;
    searchLayer.clearLayers();
    const lat = Number(val('lf-lat'));
    const lon = Number(val('lf-lon'));
    const radiusKm = clamp(Number(val('lf-radius')), 1, 15);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    L.circle([lat, lon], { radius: radiusKm * 1000, color: '#4d9fff', fillColor: '#4d9fff', fillOpacity: 0.04, weight: 1 }).addTo(searchLayer);
  }

  function candidatePopup(c, i) {
    const geUrl = `https://earth.google.com/web/@${c.lat.toFixed(5)},${c.lon.toFixed(5)},0a,500d,0h,0t,0r`;
    return `<b>#${i + 1} · score ${c.score}</b><br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>${c.risks.join('<br>')}<br><a href="${geUrl}" target="_blank" rel="noopener">Open in Google Earth ↗</a>`;
  }

  function renderFeatureCounts(features) {
    const card = document.getElementById('finder-feature-card');
    const wrap = document.getElementById('lf-feature-counts');
    if (!card || !wrap) return;
    const counts = Array.isArray(features) ? {} : features;
    if (Array.isArray(features)) features.forEach(f => { counts[f.category] = (counts[f.category] || 0) + 1; });
    const order = ['field', ...HAZARDS.map(h => h.key)];
    const chips = order.filter(k => counts[k]).map(k => {
      const label = k === 'field' ? 'open field' : HAZARD_LABEL[k];
      return `<span class="lf-count-chip"><b>${counts[k]}</b> ${label}</span>`;
    }).join('');
    wrap.innerHTML = chips || '<span class="lf-count-chip">No mapped features in range</span>';
    card.style.display = 'block';
  }

  function renderResults(cfg, candidates, osm) {
    const summary = document.getElementById('lf-summary');
    const table = document.getElementById('lf-results-table');
    summary.textContent = `${candidates.length} green candidates (score ${Math.max(78, cfg.minScore)}+) · ${osm.cached ? 'cached OSM data' : 'fresh OSM data'} · ranked by ${cfg.sort}.`;
    if (!candidates.length) {
      table.innerHTML = '<div class="empty-state" style="color:var(--amber)">No candidates passed the current filters. Increase radius, relax buffers, or disable some hazards.</div>';
      return;
    }
    table.innerHTML = `
      <table>
        <thead><tr><th>Rank</th><th>Score</th><th>Coordinates</th><th>From center</th><th>Nearest hazards</th><th>Open field</th><th></th></tr></thead>
        <tbody>${candidates.map((c, i) => {
          const cls = c.score >= 78 ? 'good' : c.score >= 62 ? 'warn' : 'bad';
          const dist = haversine(cfg.lat, cfg.lon, c.lat, c.lon);
          const field = Number.isFinite(c.nearest.field) ? `${Math.round(c.nearest.field)} m` : '—';
          const geUrl = `https://earth.google.com/web/@${c.lat.toFixed(5)},${c.lon.toFixed(5)},0a,500d,0h,0t,0r`;
          return `<tr>
            <td>#${i + 1}</td>
            <td><span class="score-pill ${cls}">${c.score}</span></td>
            <td>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</td>
            <td>${dist.toFixed(2)} km</td>
            <td style="color:var(--muted)">${escapeHtml(c.risks.slice(0, 4).join(' · '))}</td>
            <td class="${c.nearest.field < 180 ? 'ac-dist-far' : 'ac-dist-close'}">${field}</td>
            <td><button class="lf-focus" data-i="${i}" type="button">Focus</button> <a href="${geUrl}" target="_blank" rel="noopener" style="color:var(--ice)">Earth ↗</a></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    table.querySelectorAll('.lf-focus').forEach(btn => {
      btn.addEventListener('click', () => focusCandidate(Number(btn.dataset.i)));
    });
  }

  function focusCandidate(i) {
    const c = lastCandidates[i];
    if (!c || !map) return;
    map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15), { animate: true });
    candidateLayer.eachLayer(layer => {
      if (layer.getLatLng && Math.abs(layer.getLatLng().lat - c.lat) < 1e-6 && Math.abs(layer.getLatLng().lng - c.lon) < 1e-6) {
        layer.openPopup();
      }
    });
    document.getElementById('view-finder').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setStatus(title, detail, state) {
    const banner = document.getElementById('finder-banner');
    if (banner) banner.className = `net-banner ${state || 'warn'}`;
    const s = document.getElementById('finder-status');
    const d = document.getElementById('finder-detail');
    if (s) s.textContent = title;
    if (d) d.textContent = detail;
  }

  function bboxFor(cfg) {
    const dLat = cfg.radiusKm / 111.32;
    const dLon = cfg.radiusKm / (111.32 * Math.max(0.2, Math.cos(cfg.lat * DEG)));
    return { south: cfg.lat - dLat, west: cfg.lon - dLon, north: cfg.lat + dLat, east: cfg.lon + dLon };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
})();
