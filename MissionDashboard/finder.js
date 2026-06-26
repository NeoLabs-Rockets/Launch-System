const FINDER_SETTINGS_KEY = 'neolabs.locationFinder.settings';
const DEG = Math.PI / 180;

let map;
let centerMarker;
let candidateLayer;
let hazardLayer;
let searchLayer;
let currentFeatures = [];

const ids = {
  lat: 'lf-lat',
  lon: 'lf-lon',
  radius: 'lf-radius',
  spacing: 'lf-spacing',
  road: 'lf-road',
  highway: 'lf-highway',
  power: 'lf-power',
  housing: 'lf-housing',
  airport: 'lf-airport',
  trees: 'lf-trees',
  minscore: 'lf-minscore',
  results: 'lf-results'
};

window.addEventListener('DOMContentLoaded', () => {
  startFinderClock();
  restoreSettings();
  initMap();
  bindControls();
  locate();
});

function startFinderClock() {
  const tick = () => {
    const d = new Date();
    document.getElementById('finder-clock').textContent =
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function bindControls() {
  document.getElementById('lf-locate').addEventListener('click', locate);
  document.getElementById('lf-analyze').addEventListener('click', analyze);
  Object.values(ids).forEach(id => {
    document.getElementById(id).addEventListener('change', persistSettings);
  });
}

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(FINDER_SETTINGS_KEY) || '{}');
    Object.entries(saved).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el && value !== '') el.value = value;
    });
  } catch (_) {}
}

function persistSettings() {
  const data = {};
  Object.values(ids).forEach(id => {
    data[id] = document.getElementById(id).value;
  });
  localStorage.setItem(FINDER_SETTINGS_KEY, JSON.stringify(data));
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
}

function locate() {
  setStatus('Getting GPS', 'Waiting for browser location.', 'warn');
  navigator.geolocation.getCurrentPosition(
    pos => {
      setCenter(pos.coords.latitude, pos.coords.longitude, true);
      setStatus('Location ready', 'Adjust buffers or run analysis.', 'ok');
    },
    () => setStatus('GPS unavailable', 'Enter coordinates or click the map.', 'warn'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setCenter(lat, lon, pan) {
  document.getElementById(ids.lat).value = Number(lat).toFixed(5);
  document.getElementById(ids.lon).value = Number(lon).toFixed(5);
  persistSettings();
  if (!map) return;
  const ll = [lat, lon];
  if (centerMarker) centerMarker.setLatLng(ll);
  else centerMarker = L.marker(ll).addTo(map).bindPopup('Search center');
  if (pan) map.setView(ll, Math.max(map.getZoom(), 12));
  drawSearchRadius();
}

function values() {
  const read = id => Number(document.getElementById(ids[id]).value);
  return {
    lat: read('lat'),
    lon: read('lon'),
    radiusKm: clamp(read('radius'), 1, 15),
    spacingM: clamp(read('spacing'), 150, 1000),
    roadM: clamp(read('road'), 20, 800),
    highwayM: clamp(read('highway'), 50, 1500),
    powerM: clamp(read('power'), 50, 1500),
    housingM: clamp(read('housing'), 100, 2000),
    airportM: clamp(read('airport'), 500, 10000),
    treesM: clamp(read('trees'), 20, 1000),
    minScore: clamp(read('minscore'), 0, 100),
    results: clamp(read('results'), 5, 40)
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
  setCenter(cfg.lat, cfg.lon, false);
  setStatus('Loading OSM safety data', 'Retrying public Overpass mirrors if needed.', 'warn');
  document.getElementById('lf-summary').textContent = 'Analyzing roads, power lines, settlement areas, airports, trees, rail, public places, and open fields.';
  try {
    const r = await fetch(`/api/osm-safety?lat=${cfg.lat.toFixed(5)}&lon=${cfg.lon.toFixed(5)}&radiusKm=${cfg.radiusKm}`);
    if (!r.ok) throw new Error(`OSM ${r.status}`);
    const osm = await r.json();
    currentFeatures = normalizeFeatures(osm.elements || []);
    const candidates = scoreCandidates(cfg, currentFeatures);
    renderMap(cfg, candidates, currentFeatures);
    renderResults(cfg, candidates, osm);
    setStatus(osm.cached ? 'Using cached OSM data' : 'Analysis complete',
      `${currentFeatures.length} map features checked. ${candidates.length} candidates scored.`, osm.cached ? 'warn' : 'ok');
  } catch (err) {
    setStatus('OSM data unavailable', 'Try a smaller radius or retry later.', 'bad');
    document.getElementById('lf-results-table').innerHTML =
      '<div class="empty-state" style="color:var(--amber)">Could not load map safety data.</div>';
  }
}

function normalizeFeatures(elements) {
  return elements.map(el => {
    const tags = el.tags || {};
    const points = [];
    if (Array.isArray(el.geometry)) {
      el.geometry.forEach(p => points.push({ lat: p.lat, lon: p.lon }));
    } else if (el.lat != null && el.lon != null) {
      points.push({ lat: el.lat, lon: el.lon });
    } else if (el.center) {
      points.push({ lat: el.center.lat, lon: el.center.lon });
    }
    return {
      id: `${el.type}/${el.id}`,
      tags,
      points,
      category: featureCategory(tags),
      name: tags.name || tags.ref || tags.operator || '',
      isArea: isAreaFeature(el, tags, points)
    };
  }).filter(f => f.points.length && f.category !== 'other');
}

function featureCategory(tags) {
  if (tags.aeroway) return 'airport';
  if (tags.power === 'line' || tags.power === 'minor_line' || tags.power === 'tower' || tags.power === 'pole') return 'power';
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

function isAreaFeature(el, tags, points) {
  if (points.length < 3) return false;
  if (el.type === 'relation') return true;
  if (tags.area === 'yes' || tags.building || tags.landuse || tags.leisure || tags.aeroway || tags.amenity || tags.place) return true;
  if (points.length > 3) {
    const first = points[0];
    const last = points[points.length - 1];
    return Math.abs(first.lat - last.lat) < 1e-6 && Math.abs(first.lon - last.lon) < 1e-6;
  }
  return false;
}

function scoreCandidates(cfg, features) {
  const grid = candidateGrid(cfg);
  return grid.map(p => scorePoint(p, cfg, features))
    .filter(c => !c.rejected && c.score >= cfg.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.results);
}

function candidateGrid(cfg) {
  const pts = [];
  const stepKm = cfg.spacingM / 1000;
  const dLat = stepKm / 111.32;
  const dLon = stepKm / (111.32 * Math.max(0.2, Math.cos(cfg.lat * DEG)));
  for (let y = -cfg.radiusKm; y <= cfg.radiusKm; y += stepKm) {
    for (let x = -cfg.radiusKm; x <= cfg.radiusKm; x += stepKm) {
      const lat = cfg.lat + (y / 111.32);
      const lon = cfg.lon + (x / (111.32 * Math.max(0.2, Math.cos(cfg.lat * DEG))));
      if (haversine(cfg.lat, cfg.lon, lat, lon) <= cfg.radiusKm) pts.push({ lat, lon });
    }
  }
  return pts.filter((_, i) => i % Math.max(1, Math.round(dLat / dLon)) === 0);
}

function scorePoint(p, cfg, features) {
  const nearest = {
    road: Infinity, highway: Infinity, power: Infinity, housing: Infinity,
    settlement: Infinity, airport: Infinity, trees: Infinity, field: Infinity,
    rail: Infinity, public: Infinity
  };
  const inside = new Set();
  for (const f of features) {
    const d = distanceToFeatureM(p, f);
    nearest[f.category] = Math.min(nearest[f.category] ?? Infinity, d);
    if (d === 0 && f.isArea) inside.add(f.category);
  }

  const hardRejects = [];
  if (inside.has('housing')) hardRejects.push('inside housing or built-up land');
  if (inside.has('settlement')) hardRejects.push('inside mapped settlement');
  if (inside.has('airport')) hardRejects.push('inside airport/helipad area');
  if (inside.has('public')) hardRejects.push('inside park/playground/public recreation area');
  if (inside.has('trees')) hardRejects.push('inside trees/wooded area');
  if (nearest.housing < Math.max(50, cfg.housingM * 0.35)) hardRejects.push(`too close to buildings/housing ${Math.round(nearest.housing)}m`);
  if (nearest.settlement < Math.max(150, cfg.housingM * 0.6)) hardRejects.push(`too close to town/settlement ${Math.round(nearest.settlement)}m`);
  if (nearest.airport < cfg.airportM * 0.7) hardRejects.push(`too close to airport ${Math.round(nearest.airport)}m`);
  if (nearest.highway < Math.max(60, cfg.highwayM * 0.45)) hardRejects.push(`too close to highway ${Math.round(nearest.highway)}m`);
  if (nearest.rail < Math.max(80, cfg.roadM)) hardRejects.push(`too close to rail ${Math.round(nearest.rail)}m`);
  if (nearest.power < Math.max(80, cfg.powerM * 0.45)) hardRejects.push(`too close to power line ${Math.round(nearest.power)}m`);
  if (hardRejects.length) {
    return { ...p, score: 0, nearest, risks: hardRejects, rejected: true };
  }

  let score = 100;
  score -= penalty(nearest.road, cfg.roadM, 18);
  score -= penalty(nearest.highway, cfg.highwayM, 26);
  score -= penalty(nearest.power, cfg.powerM, 28);
  score -= penalty(nearest.housing, cfg.housingM, 35);
  score -= penalty(nearest.settlement, cfg.housingM * 1.4, 42);
  score -= penalty(nearest.airport, cfg.airportM, 45);
  score -= penalty(nearest.trees, cfg.treesM, 18);
  score -= penalty(nearest.rail, Math.max(150, cfg.roadM * 1.5), 24);
  score -= penalty(nearest.public, Math.max(180, cfg.housingM * 0.55), 24);
  if (nearest.field < 180) score += 12;
  else if (nearest.field < 350) score += 5;
  else score -= 22;
  if (nearest.airport < cfg.airportM * 0.55) score -= 40;
  if (nearest.housing < cfg.housingM * 0.65) score = Math.min(score, 52);
  if (nearest.settlement < cfg.housingM) score = Math.min(score, 48);
  if (nearest.field > 600) score = Math.min(score, 68);
  score = Math.round(clamp(score, 0, 100));

  const risks = [];
  if (nearest.settlement < cfg.housingM * 1.4) risks.push(`settlement ${Math.round(nearest.settlement)}m`);
  if (nearest.housing < cfg.housingM) risks.push(`housing ${Math.round(nearest.housing)}m`);
  if (nearest.power < cfg.powerM) risks.push(`power ${Math.round(nearest.power)}m`);
  if (nearest.highway < cfg.highwayM) risks.push(`highway ${Math.round(nearest.highway)}m`);
  if (nearest.road < cfg.roadM) risks.push(`road ${Math.round(nearest.road)}m`);
  if (nearest.rail < Math.max(150, cfg.roadM * 1.5)) risks.push(`rail ${Math.round(nearest.rail)}m`);
  if (nearest.airport < cfg.airportM) risks.push(`airport ${Math.round(nearest.airport)}m`);
  if (nearest.trees < cfg.treesM) risks.push(`trees ${Math.round(nearest.trees)}m`);
  if (nearest.public < Math.max(180, cfg.housingM * 0.55)) risks.push(`public area ${Math.round(nearest.public)}m`);
  if (nearest.field > 350) risks.push('no mapped open field nearby');
  if (!risks.length) risks.push(nearest.field < 180 ? 'mapped open field nearby' : 'clear by map data');
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
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
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
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (!len2) return Math.sqrt(ax * ax + ay * ay);
  const t = clamp((-(ax * vx + ay * vy)) / len2, 0, 1);
  const x = ax + vx * t;
  const y = ay + vy * t;
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
      radius: i === 0 ? 9 : 6,
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 2
    }).addTo(candidateLayer).bindPopup(candidatePopup(c, i));
  });
  const b = bboxFor(cfg);
  map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [24, 24] });
}

function drawSearchRadius() {
  if (!map || !searchLayer) return;
  searchLayer.clearLayers();
  const cfg = values();
  if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lon)) return;
  L.circle([cfg.lat, cfg.lon], {
    radius: cfg.radiusKm * 1000,
    color: '#4d9fff',
    fillColor: '#4d9fff',
    fillOpacity: 0.04,
    weight: 1
  }).addTo(searchLayer);
}

function renderHazards(features) {
  const colors = {
    road: '#9fd4ff',
    highway: '#ffb347',
    power: '#ff4a3d',
    housing: '#ff4a3d',
    settlement: '#ff4a3d',
    airport: '#ff4a3d',
    trees: '#36f0a0',
    field: '#36f0a0',
    rail: '#c9d6ef',
    public: '#ffb347'
  };
  features.filter(f => f.category !== 'field').slice(0, 700).forEach(f => {
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
  return `<b>#${i + 1} - score ${c.score}</b><br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>${c.risks.join('<br>')}`;
}

function renderResults(cfg, candidates, osm) {
  const summary = document.getElementById('lf-summary');
  const table = document.getElementById('lf-results-table');
  summary.textContent = `${candidates.length} candidates above score ${cfg.minScore}. ${osm.cached ? 'OSM cache in use.' : 'Fresh OSM data.'}`;
  if (!candidates.length) {
    table.innerHTML = '<div class="empty-state" style="color:var(--amber)">No candidates passed the current buffers. Increase radius or relax buffers.</div>';
    return;
  }
  table.innerHTML = `
    <table>
      <thead><tr><th>Rank</th><th>Score</th><th>Coordinates</th><th>Nearest risks</th><th>Map</th></tr></thead>
      <tbody>${candidates.map((c, i) => {
        const cls = c.score >= 78 ? 'good' : c.score >= 62 ? 'warn' : 'bad';
        const url = `https://www.openstreetmap.org/?mlat=${c.lat.toFixed(5)}&mlon=${c.lon.toFixed(5)}#map=17/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}`;
        return `<tr>
          <td>#${i + 1}</td>
          <td><span class="score-pill ${cls}">${c.score}</span></td>
          <td>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</td>
          <td>${escapeHtml(c.risks.join(' | '))}</td>
          <td><a href="${url}" target="_blank" rel="noopener" style="color:var(--ice)">OSM</a></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function setStatus(title, detail, state) {
  const banner = document.getElementById('finder-banner');
  banner.className = `net-banner ${state || 'warn'}`;
  document.getElementById('finder-status').textContent = title;
  document.getElementById('finder-detail').textContent = detail;
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
