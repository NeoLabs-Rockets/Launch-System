# NeoLabs Rockets

Rocket systems by NeoLabs.

## Launch System

ESP32 WiFi-based launch controller — see [`/LaunchSystem`](LaunchSystem/).

The ESP32 runs as its own WiFi Access Point and serves a web UI
with an **arm → launch** workflow, a 10-second voice countdown (browser TTS,
*"Ignition"* at zero), and a REST API. On launch it drives a trigger GPIO HIGH
for 800 ms to fire a relay/igniter, then auto-disarms.

See the [LaunchSystem README](LaunchSystem/ReadMe.md) for wiring, pin assignments,
parts list, and the full REST API.
