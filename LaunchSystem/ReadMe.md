# NeoLabs Rockets — ESP32 Mission Control

WiFi-controlled trigger/relay switch built on an ESP32. The board runs as its own
WiFi Access Point and serves a NeoLabs-branded web UI with an **arm → launch**
workflow, a 10-second voice countdown, and a REST API. Designed to run off a 9V
battery for portable use.

> Firmware: [`ESP32_AP_Trigger.ino`](ESP32_AP_Trigger.ino)

## Features

- **WiFi Access Point** — no router needed; the ESP32 hosts its own network.
- **Arm/Disarm safety** — the trigger is disabled until the system is armed.
  Auto-disarms after every shot.
- **Launch sequence** — 10 s countdown with English browser TTS; says
  *"Ignition"* at zero, then drives the output **HIGH 500 ms later**.
- **800 ms pulse** — non-blocking HIGH pulse on the trigger pin, then back LOW.
- **Status LED** — solid while armed, 5 Hz blink while firing.
- **Physical ARM button** (optional) — toggles arm state in hardware.
- **REST API** — JSON endpoints for automation/testing.

## Pin assignments

These are defined at the top of the sketch and are the only place you should
change them:

| Function          | GPIO | Direction        | Notes |
|-------------------|------|------------------|-------|
| **Trigger out**   | `26` | OUTPUT           | Goes HIGH for 800 ms on launch → relay IN / driver |
| **Status LED**    | `2`  | OUTPUT           | Onboard LED on most DevKits. Set to `-1` to disable |
| **Physical ARM**  | `25` | INPUT_PULLUP     | Momentary button to **GND** (LOW = pressed). Set to `-1` to disable |

> ⚠️ Avoid GPIO 6–11 (connected to the SPI flash). GPIO 26 / 25 / 2 are safe,
> standard output-capable pins on the NodeMCU DevKit.

## Network / config

Defined near the top of the sketch:

| Setting      | Default            |
|--------------|--------------------|
| SSID         | `NeoLabs-Rockets`  |
| Password     | `launch1234` (WPA2, min. 8 chars) |
| URL          | `http://192.168.4.1` |
| Pulse length | `TRIGGER_MS = 800` ms |

## Parts list

| Qty | Part | Note |
|-----|------|------|
| 1 | ESP32 NodeMCU (USB-C) | diymore or similar |
| 1 | 5V 1-channel relay module (opto-isolated) | with screw terminals |
| 1 | 9V battery clip (I-type) | snap-on |
| 1 | Buck converter (9–12V → 5V) | or LM7805 + caps |
| 1 set | Dupont jumper wires (M-M + M-F) | — |
| 2–4 | Alligator clip leads | for the output |
| 1 | Optional: toggle/momentary switch | hardware arming button |
| 1 | Optional: LED + 220Ω resistor | status / continuity |

**Approx. cost:** ~€15–25

## Wiring

### Power
- **9V battery +** → buck converter **IN (+)**
- **9V battery –** → buck converter **GND**
- Buck **OUT 5V** → ESP32 **VIN**
- Buck **OUT GND** → ESP32 **GND** + relay **GND**

### Relay control
- ESP32 **GPIO 26** (trigger out) → relay **IN**
- ESP32 **GND** → relay **GND**

### Optional physical ARM button
- ESP32 **GPIO 25** → one leg of the button
- Other leg of the button → ESP32 **GND**
  *(uses the internal pull-up; pressing pulls the pin LOW)*

### Optional status LED
- ESP32 **GPIO 2** → LED **anode** → 220Ω resistor → ESP32 **GND**
  *(GPIO 2 already has the onboard LED on most DevKits)*

### Load output (relay side)
- **9V battery +** → relay **COM**
- Relay **NO** → output alligator clip (+)
- **9V battery –** → output alligator clip (–)


## REST API

Base URL: `http://192.168.4.1`

| Method | Endpoint        | Response |
|--------|-----------------|----------|
| `GET`  | `/api/status`   | `{ "armed", "trigger_active", "uptime_ms", "clients" }` |
| `POST` | `/api/arm`      | `{ "ok": true, "armed": true }` |
| `POST` | `/api/disarm`   | `{ "ok": true, "armed": false }` |
| `POST` | `/api/trigger`  | `{ "ok": true }` — or `403 {"ok":false,"error":"not armed"}` |

Trigger requires the system to be armed first:

```bash
curl -X POST http://192.168.4.1/api/arm
curl -X POST http://192.168.4.1/api/trigger
curl       http://192.168.4.1/api/status
```
