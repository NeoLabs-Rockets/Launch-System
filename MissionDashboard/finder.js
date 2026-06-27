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

  let map, centerMarker, candidateLayer, hazardLayer, searchLayer;
  let currentFeatures = [];
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
    hazardLayer = L.layerGroup().addTo(map);
    searchLayer = L.layerGroup().addTo(map);
    map.on('click', e => setCenter(e.latlng.lat, e.latlng.lng, true));
    mapReady = true;
  }

  function locate() {
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
    setStatus('Loading OSM safety data', 'Retrying public Overpass mirrors if needed.', 'warn');
    document.getElementById('lf-summary').textContent = 'Analyzing roads, power, settlements, airports, rail, trees, water, public areas, and open fields…';
    try {
      const r = await fetch(`/api/osm-safety?lat=${cfg.lat.toFixed(5)}&lon=${cfg.lon.toFixed(5)}&radiusKm=${cfg.radiusKm}`);
      if (!r.ok) throw new Error(`OSM ${r.status}`);
      const osm = await r.json();
      currentFeatures = normalizeFeatures(osm.elements || []);
      const candidates = scoreCandidates(cfg, currentFeatures);
      lastCandidates = candidates;
      renderMap(cfg, candidates, currentFeatures);
      renderFeatureCounts(currentFeatures);
      renderResults(cfg, candidates, osm);
      setStatus(osm.cached ? 'Using cached OSM data' : 'Analysis complete',
        `${currentFeatures.length} map features checked · ${candidates.length} candidates ranked.`, osm.cached ? 'warn' : 'ok');
    } catch (err) {
      setStatus('OSM data unavailable', 'Try a smaller radius or retry later.', 'bad');
      document.getElementById('lf-results-table').innerHTML =
        '<div class="empty-state" style="color:var(--amber)">Could not load map safety data.</div>';
    }
  }

  function normalizeFeatures(elements) {
    return elements.map(elm => {
      const tags = elm.tags || {};
      const points = [];
      if (Array.isArray(elm.geometry)) {
        elm.geometry.forEach(p => points.push({ lat: p.lat, lon: p.lon }));
      } else if (elm.lat != null && elm.lon != null) {
        points.push({ lat: elm.lat, lon: elm.lon });
      } else if (elm.center) {
        points.push({ lat: elm.center.lat, lon: elm.center.lon });
      }
      return {
        id: `${elm.type}/${elm.id}`,
        tags,
        points,
        category: featureCategory(tags),
        name: tags.name || tags.ref || tags.operator || '',
        isArea: isAreaFeature(elm, tags, points)
      };
    }).filter(f => f.points.length && f.category !== 'other');
  }

  function featureCategory(tags) {
    if (tags.aeroway) return 'airport';
    if (tags.power === 'line' || tags.power === 'minor_line' || tags.power === 'tower' || tags.power === 'pole') return 'power';
    if (tags.natural === 'water' || tags.waterway || ['reservoir', 'basin'].includes(tags.landuse)) return 'water';
    if (tags.place && ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter'].includes(tags.place)) return 'settlement';
    if (tags.building || ['residential', 'industrial', 'commercial', 'retail', 'construction', 'brownfield', 'garages', 'cemetery', 'farmyard'].includes(tags.landuse) ||
        ['school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'place_of_worship', 'community_centre'].includes(tags.amenity)) return 'housing';
    if (tags.railway) return 'rail';
    if (tags.highway) return ['motorway', 'trunk', 'primary', 'secondary'].includes(tags.highway) ? 'highway' : 'road';
    if (tags.natural === 'wood' || tags.natural === 'tree' || tags.natural === 'tree_row' ||
        ['forest', 'orchard', 'vineyard', 'plant_nursery'].includes(tags.landuse)) return 'trees';
    if (['park', 'playground', 'sports_centre', 'recreation_ground'].includes(tags.leisure)) return 'public';
    if (['farmland', 'meadow', 'grass', 'allotments'].includes(tags.landuse) ||
        ['grassland', 'heath', 'scrub', 'bare_rock', 'sand'].includes(tags.natural) ||
        tags.leisure === 'pitch') return 'field';
    return 'other';
  }

  function isAreaFeature(elm, tags, points) {
    if (points.length < 3) return false;
    if (elm.type === 'relation') return true;
    if (tags.area === 'yes' || tags.building || tags.landuse || tags.leisure || tags.aeroway || tags.amenity || tags.place || tags.natural === 'water') return true;
    if (points.length > 3) {
      const first = points[0];
      const last = points[points.length - 1];
      return Math.abs(first.lat - last.lat) < 1e-6 && Math.abs(first.lon - last.lon) < 1e-6;
    }
    return false;
  }

  function scoreCandidates(cfg, features) {
    const grid = candidateGrid(cfg);
    let scored = grid.map(p => scorePoint(p, cfg, features)).filter(c => !c.rejected && c.score >= cfg.minScore);
    if (cfg.sort === 'distance') {
      scored.sort((a, b) => haversine(cfg.lat, cfg.lon, a.lat, a.lon) - haversine(cfg.lat, cfg.lon, b.lat, b.lon));
    } else if (cfg.sort === 'field') {
      scored.sort((a, b) => (a.nearest.field - b.nearest.field) || (b.score - a.score));
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
    return scored.slice(0, cfg.results);
  }

  function candidateGrid(cfg) {
    const pts = [];
    const stepKm = cfg.spacingM / 1000;
    for (let y = -cfg.radiusKm; y <= cfg.radiusKm; y += stepKm) {
      for (let x = -cfg.radiusKm; x <= cfg.radiusKm; x += stepKm) {
        const lat = cfg.lat + (y / 111.32);
        const lon = cfg.lon + (x / (111.32 * Math.max(0.2, Math.cos(cfg.lat * DEG))));
        if (haversine(cfg.lat, cfg.lon, lat, lon) <= cfg.radiusKm) pts.push({ lat, lon });
      }
    }
    return pts;
  }

  function scorePoint(p, cfg, features) {
    const nearest = {
      road: Infinity, highway: Infinity, power: Infinity, housing: Infinity,
      settlement: Infinity, airport: Infinity, trees: Infinity, field: Infinity,
      rail: Infinity, public: Infinity, water: Infinity
    };
    const inside = new Set();
    for (const f of features) {
      const d = distanceToFeatureM(p, f);
      nearest[f.category] = Math.min(nearest[f.category] ?? Infinity, d);
      if (d === 0 && f.isArea) inside.add(f.category);
    }

    const en = cfg.enabled;
    const buf = cfg.buffers;
    const hardRejects = [];
    // Inside-area rejections (only for enabled hazards)
    if (en.housing && inside.has('housing')) hardRejects.push('inside built-up land');
    if (en.settlement && inside.has('settlement')) hardRejects.push('inside settlement');
    if (en.airport && inside.has('airport')) hardRejects.push('inside airport area');
    if (en.public && inside.has('public')) hardRejects.push('inside public/recreation area');
    if (en.trees && inside.has('trees')) hardRejects.push('inside woodland');
    if (en.water && inside.has('water')) hardRejects.push('inside open water');
    // Proximity rejections
    if (en.housing && nearest.housing < Math.max(50, buf.housing * 0.35)) hardRejects.push(`housing ${Math.round(nearest.housing)}m`);
    if (en.settlement && nearest.settlement < Math.max(150, buf.settlement * 0.6)) hardRejects.push(`settlement ${Math.round(nearest.settlement)}m`);
    if (en.airport && nearest.airport < buf.airport * 0.7) hardRejects.push(`airport ${Math.round(nearest.airport)}m`);
    if (en.highway && nearest.highway < Math.max(60, buf.highway * 0.45)) hardRejects.push(`highway ${Math.round(nearest.highway)}m`);
    if (en.rail && nearest.rail < Math.max(60, buf.rail * 0.5)) hardRejects.push(`rail ${Math.round(nearest.rail)}m`);
    if (en.power && nearest.power < Math.max(60, buf.power * 0.45)) hardRejects.push(`power ${Math.round(nearest.power)}m`);
    if (en.water && nearest.water < Math.max(30, buf.water * 0.5)) hardRejects.push(`water ${Math.round(nearest.water)}m`);
    if (cfg.fieldPref === 'require' && nearest.field > 350) hardRejects.push('no open field nearby');
    if (hardRejects.length) return { ...p, score: 0, nearest, risks: hardRejects, rejected: true };

    let score = 100;
    if (en.road) score -= penalty(nearest.road, buf.road, 18);
    if (en.highway) score -= penalty(nearest.highway, buf.highway, 26);
    if (en.power) score -= penalty(nearest.power, buf.power, 28);
    if (en.housing) score -= penalty(nearest.housing, buf.housing, 35);
    if (en.settlement) score -= penalty(nearest.settlement, buf.settlement, 42);
    if (en.airport) score -= penalty(nearest.airport, buf.airport, 45);
    if (en.trees) score -= penalty(nearest.trees, buf.trees, 18);
    if (en.rail) score -= penalty(nearest.rail, buf.rail, 24);
    if (en.public) score -= penalty(nearest.public, buf.public, 24);
    if (en.water) score -= penalty(nearest.water, buf.water, 26);

    if (cfg.fieldPref !== 'ignore') {
      if (nearest.field < 180) score += 12;
      else if (nearest.field < 350) score += 5;
      else score -= 22;
      if (nearest.field > 600) score = Math.min(score, 68);
    }
    if (en.airport && nearest.airport < buf.airport * 0.55) score -= 40;
    if (en.housing && nearest.housing < buf.housing * 0.65) score = Math.min(score, 52);
    if (en.settlement && nearest.settlement < buf.settlement) score = Math.min(score, 48);
    score = Math.round(clamp(score, 0, 100));

    const risks = [];
    HAZARDS.forEach(h => {
      if (!en[h.key]) return;
      const d = nearest[h.key];
      if (Number.isFinite(d) && d < buf[h.key]) risks.push(`${HAZARD_LABEL[h.key]} ${Math.round(d)}m`);
    });
    if (cfg.fieldPref !== 'ignore' && nearest.field > 350) risks.push('no mapped open field nearby');
    if (!risks.length) risks.push(nearest.field < 180 ? 'open field nearby' : 'clear by map data');
    return { ...p, score, nearest, risks, rejected: false };
  }

  function penalty(distM, bufferM, weight) {
    if (!Number.isFinite(distM) || distM >= bufferM) return 0;
    return weight * (1 - distM / bufferM);
  }

  function distanceToFeatureM(p, feature) {
    if (feature.isArea && pointInPolygon(p, feature.points)) return 0;
    let best = Infinity;
    for (const q of feature.points) best = Math.min(best, haversine(p.lat, p.lon, q.lat, q.lon) * 1000);
    if (feature.points.length > 1) {
      const points = feature.points;
      for (let i = 0; i < points.length - 1; i++) {
        best = Math.min(best, distanceToSegmentM(p, points[i], points[i + 1]));
      }
      if (feature.isArea) best = Math.min(best, distanceToSegmentM(p, points[points.length - 1], points[0]));
    }
    return best;
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lon, yi = polygon[i].lat;
      const xj = polygon[j].lon, yj = polygon[j].lat;
      const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
        (point.lon < (xj - xi) * (point.lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function distanceToSegmentM(p, a, b) {
    const cosLat = Math.max(0.2, Math.cos(p.lat * DEG));
    const ax = (a.lon - p.lon) * 111320 * cosLat;
    const ay = (a.lat - p.lat) * 111320;
    const bx = (b.lon - p.lon) * 111320 * cosLat;
    const by = (b.lat - p.lat) * 111320;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    if (!len2) return Math.sqrt(ax * ax + ay * ay);
    const t = clamp((-(ax * vx + ay * vy)) / len2, 0, 1);
    const x = ax + vx * t, y = ay + vy * t;
    return Math.sqrt(x * x + y * y);
  }

  function renderMap(cfg, candidates, features) {
    if (!map) return;
    candidateLayer.clearLayers();
    hazardLayer.clearLayers();
    drawSearchRadius();
    renderHazards(features);
    candidates.forEach((c, i) => {
      const cls = c.score >= 78 ? 'good' : c.score >= 62 ? 'warn' : 'bad';
      const color = cls === 'good' ? '#36f0a0' : cls === 'warn' ? '#ffb347' : '#ff4a3d';
      L.circleMarker([c.lat, c.lon], {
        radius: i === 0 ? 9 : 6, color, fillColor: color, fillOpacity: 0.75, weight: 2
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

  function renderHazards(features) {
    const colors = Object.fromEntries(HAZARDS.map(h => [h.key, h.color]));
    colors.field = '#2f8f5f';
    features.filter(f => f.category !== 'field').slice(0, 800).forEach(f => {
      const color = colors[f.category] || '#c9d6ef';
      if (f.isArea && f.points.length > 2) {
        L.polygon(f.points.map(p => [p.lat, p.lon]), { color, fillColor: color, fillOpacity: 0.08, weight: 2, opacity: 0.35 }).addTo(hazardLayer);
      } else if (f.points.length > 1) {
        L.polyline(f.points.map(p => [p.lat, p.lon]), { color, weight: 2, opacity: 0.35 }).addTo(hazardLayer);
      } else {
        L.circleMarker([f.points[0].lat, f.points[0].lon], { radius: 3, color, fillColor: color, fillOpacity: 0.45, weight: 1 }).addTo(hazardLayer);
      }
    });
  }

  function candidatePopup(c, i) {
    return `<b>#${i + 1} · score ${c.score}</b><br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>${c.risks.join('<br>')}`;
  }

  function renderFeatureCounts(features) {
    const card = document.getElementById('finder-feature-card');
    const wrap = document.getElementById('lf-feature-counts');
    if (!card || !wrap) return;
    const counts = {};
    features.forEach(f => { counts[f.category] = (counts[f.category] || 0) + 1; });
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
    summary.textContent = `${candidates.length} candidates above score ${cfg.minScore} · ${osm.cached ? 'cached OSM data' : 'fresh OSM data'} · ranked by ${cfg.sort}.`;
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
          const osmUrl = `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(5)}&mlon=${c.lon.toFixed(5)}#map=17/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}`;
          return `<tr>
            <td>#${i + 1}</td>
            <td><span class="score-pill ${cls}">${c.score}</span></td>
            <td>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</td>
            <td>${dist.toFixed(2)} km</td>
            <td style="color:var(--muted)">${escapeHtml(c.risks.slice(0, 4).join(' · '))}</td>
            <td class="${c.nearest.field < 180 ? 'ac-dist-far' : 'ac-dist-close'}">${field}</td>
            <td><button class="lf-focus" data-i="${i}" type="button">Focus</button> <a href="${osmUrl}" target="_blank" rel="noopener" style="color:var(--ice)">OSM</a></td>
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
