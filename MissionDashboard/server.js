const express = require('express');
const path = require('path');

const app = express();
const PORT = 3456;

app.use(express.static(path.join(__dirname)));

// Proxy aircraft API — browser can't call adsb.fi directly (CORS)
app.get('/api/aircraft', async (req, res) => {
  const { lat, lon, dist } = req.query;
  if (!lat || !lon || !dist) {
    return res.status(400).json({ error: 'lat, lon, dist required' });
  }
  try {
    const url = `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}`;
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'NeoLabs-MissionDashboard/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  NeoLabs · Mission Dashboard\n  http://localhost:${PORT}\n`);
});
