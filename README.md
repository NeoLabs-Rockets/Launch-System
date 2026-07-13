<div align="center">

# NeoLabs-Rockets Launch System

<img src="https://github.com/user-attachments/assets/205f69a8-6dde-4ae3-9347-e46cbaf7c3ac" width="180" alt="NeoLabs Rockets Logo">

**Rocket systems by NeoLabs — ESP32 launch controller + Node.js mission dashboard.**

---

[🚀 Mission Dashboard](#mission-dashboard) · [🛰️ Launch System](#launch-system)

[Compatible with NeoLabs-Rockets launch platform](https://github.com/NeoLabs-Rockets/Launch-Platform)

---

</div>

## Mission Dashboard

A single-page web app that runs on a laptop at the launch site and connects to the ESP32 controller over Bluetooth (BLE).

### Features

| Feature | Description |
|---------|-------------|
| **Launch Console** | Guided 4-step wizard: Connect → Checklist → Arm → Countdown. BLE connects once and drives every view. |
| **Live BLE keepalive** | Active ping every 2 s detects silent drops; heartbeat during countdown proves the link every 700 ms. |
| **Weather & airspace** | Live wind, temperature, precipitation, and ADS-B aircraft corridor check with GO / HOLD / NO-GO badge. |
| **Location Finder** | OSM-based candidate scorer — rates grid points against roads, highways (big exclusion), settlements, power lines, water, trees, airports, and open fields. Green-only results on the map; links open Google Earth satellite view. |
| **Camera overlay** | Cinematic broadcast HUD with live T−countdown ring (bottom-right), T+ elapsed after ignition, BLE and weather telemetry. |
| **Cross-device camera** | Phone subscribes to the laptop's SSE stream and receives the countdown + BLE state in real time — no BLE on the phone needed. |

<img width="1889" height="1062" alt="image" src="https://github.com/user-attachments/assets/b27e0e8c-c9e6-4ff2-8b42-a8989720d940" />


---

## Launch System

ESP32 WiFi + BLE launch controller — see [`/LaunchSystem`](LaunchSystem/).

The ESP32 runs as its own WiFi Access Point and serves a branded web UI with an **arm → launch** workflow, a voice countdown, and a REST API. It also exposes a BLE GATT service used by the Mission Dashboard for a more reliable, guided launch sequence.

<img width="606" height="453" alt="image" src="https://github.com/user-attachments/assets/0b5191ed-5da1-4f4f-921d-e79cdb443e06" />

See the [LaunchSystem README](LaunchSystem/ReadMe.md) for wiring, pin assignments, parts list, and REST API.

---

<div align="center">

*Made with ❤️ by [Neo](https://github.com/neooriginal) · [NeoLabs Systems](https://github.com/NeoLabs-Systems)*

</div>
