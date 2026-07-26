<div align="center">

# NeoLabs-Rockets Launch System

<img src="https://github.com/user-attachments/assets/205f69a8-6dde-4ae3-9347-e46cbaf7c3ac" width="180" alt="NeoLabs Rockets Logo">

**Rocket systems by NeoLabs — ESP32 launch controller + Node.js mission dashboard.**

[![Join the NeoLabs Discord](https://img.shields.io/badge/Join%20NeoLabs-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/f59rg2RwUT)

---

[🚀 Mission Dashboard](#mission-dashboard) · [🛰️ Launch System](#launch-system)

[Compatible with NeoLabs-Rockets launch platform](https://github.com/NeoLabs-Rockets/Launch-Platform)

---

</div>

## Mission Dashboard

A single-page web app that runs on a laptop at the launch site and connects to a custom PCB over Bluetooth (BLE).

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

BLE launch controller — see [`/LaunchSystem`](LaunchSystem/).

<img width="1110" height="647" alt="image" src="https://github.com/user-attachments/assets/a219eb75-a8fe-44fa-bbb5-2142d9208d50" />

<img width="1190" height="485" alt="image" src="https://github.com/user-attachments/assets/dde6c9c8-00ce-4adf-b244-e6070d29d0a6" />
One-layer PCB - no bridges

---

<div align="center">

*Made with ❤️ by [Neo](https://github.com/neooriginal) · [NeoLabs Systems](https://github.com/NeoLabs-Systems)*

</div>
