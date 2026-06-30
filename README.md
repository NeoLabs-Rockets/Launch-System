# NeoLabs-Rockets Launch System

<img width="1024" height="1024" alt="rocket-icon-1024" src="https://github.com/user-attachments/assets/205f69a8-6dde-4ae3-9347-e46cbaf7c3ac" />


Rocket systems by NeoLabs — ESP32 launch controller + Node.js mission dashboard.

---

## Mission Dashboard

A single-page web app that runs on a laptop at the launch site and connects to the ESP32 controller over Bluetooth (BLE).

### Quick start

```bash
cd MissionDashboard
npm install        # first time only
npm start
```

Open **http://localhost:3456** in Chrome or Edge (Web Bluetooth requires a Chromium browser over localhost or HTTPS).

The server prints a **Network URL** on startup — open that on any phone on the same WiFi to use it as a camera with the live countdown overlay:

```
  Local:   http://localhost:3456
  Network: http://192.168.x.x:3456  ← open this on your phone
```

### Features

| Feature | Description |
|---------|-------------|
| **Launch Console** | Guided 4-step wizard: Connect → Checklist → Arm → Countdown. BLE connects once and drives every view. |
| **Live BLE keepalive** | Active ping every 2 s detects silent drops; heartbeat during countdown proves the link every 700 ms. |
| **Weather & airspace** | Live wind, temperature, precipitation, and ADS-B aircraft corridor check with GO / HOLD / NO-GO badge. |
| **Location Finder** | OSM-based candidate scorer — rates grid points against roads, highways (big exclusion), settlements, power lines, water, trees, airports, and open fields. Green-only results on the map; links open Google Earth satellite view. |
| **Camera overlay** | Cinematic broadcast HUD with live T−countdown ring (bottom-right), T+ elapsed after ignition, BLE and weather telemetry. |
| **Cross-device camera** | Phone subscribes to the laptop's SSE stream and receives the countdown + BLE state in real time — no BLE on the phone needed. |

### Auth (for public/cloud deployment)

```bash
cp MissionDashboard/.env.example MissionDashboard/.env
# edit .env and set:
DASHBOARD_PASSWORD=your-strong-password
```

HTTP Basic Auth is applied to every route (static files, API, and the SSE stream). Leave `DASHBOARD_PASSWORD` blank for local LAN use — auth is skipped entirely when the variable is unset.

---

## Launch System

ESP32 WiFi + BLE launch controller — see [`/LaunchSystem`](LaunchSystem/).

The ESP32 runs as its own WiFi Access Point and serves a branded web UI with an **arm → launch** workflow, a voice countdown, and a REST API. It also exposes a BLE GATT service used by the Mission Dashboard for a more reliable, guided launch sequence.

See the [LaunchSystem README](LaunchSystem/ReadMe.md) for wiring, pin assignments, parts list, and REST API.
