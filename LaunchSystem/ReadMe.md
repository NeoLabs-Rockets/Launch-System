# NeoLabs Rockets — ESP32 Mission Control

WiFi-controlled trigger/relay switch built on an ESP32. The board runs as its own
WiFi Access Point and serves a NeoLabs-branded web UI with an **arm → launch**
workflow, a 10-second voice countdown, and a REST API. Designed to run off a 9V
battery for portable use.

> Firmware: [`Arduino/ESP32_AP_Trigger.ino`](Arduino/ESP32_AP_Trigger.ino)

## Features

- **Open WiFi Access Point** — no router and no WiFi password; the ESP32 hosts
  its own network. Security is handled by the arming password instead.
- **Two-step arming** — page 1 is a pre-flight safety **checklist** (every item
  must be acknowledged), page 2 is the **arming code**.
- **Single global password** — one 6-digit code (default `123456`) is required to
  arm, both in the UI and on the `/api/arm` endpoint. Disarming never needs it.
- **Lockout** — after **10** wrong codes the system locks out until reboot
  (counter is kept in RAM only, so a power cycle clears it).
- **Arm/Disarm safety** — the trigger is disabled until the system is armed.
  Auto-disarms after every shot.
- **Launch sequence** — 10 s countdown with English browser TTS; says
  *"Ignition"* at zero, then drives the output **HIGH 500 ms later**.
- **800 ms pulse** — non-blocking HIGH pulse on the trigger pin, then back LOW.
- **Status LED** — solid while armed, 5 Hz blink while firing.
- **Vibration motor** — short haptic buzz on each countdown step and a longer
  buzz at ignition.
- **Physical ARM button** (optional, disabled by default) — toggles arm state in hardware.
- **REST API** — JSON endpoints for automation/testing.

## Pin assignments

These are defined at the top of the sketch and are the only place you should
change them:

| Function          | GPIO | Direction        | Notes |
|-------------------|------|------------------|-------|
| **Trigger out**   | `26` | OUTPUT           | Goes HIGH for 800 ms on launch → relay IN / driver |
| **Status LED**    | `2`  | OUTPUT           | Onboard LED on most DevKits. Set to `-1` to disable |
| **Vibration motor**| `23`| OUTPUT           | Motor **(+)** → GPIO 23, **(–)** → GND. Set to `-1` to disable |
| **Physical ARM**  | `25` | INPUT_PULLUP     | Momentary button to **GND** (LOW = pressed). `-1` = disabled (default) |

> ⚠️ Avoid GPIO 6–11 (connected to the SPI flash). GPIO 26 / 25 / 23 / 2 are safe,
> standard output-capable pins on the NodeMCU DevKit.
>
> ⚠️ Drive the motor through a transistor/MOSFET + flyback diode if it draws more
> than a few mA — an ESP32 GPIO can't power a motor directly. A tiny coin/ERM
> motor on a driver board is fine; bare motors need the driver.

## Network / config

Defined near the top of the sketch:

| Setting      | Default            |
|--------------|--------------------|
| SSID            | `NeoLabs-Rockets` |
| WiFi security   | Open (no password) |
| Arming password | `ARM_CODE = "123456"` (6-digit global code) |
| Lockout         | `MAX_ATTEMPTS = 10` wrong codes → locked until reboot |
| URL             | `http://192.168.4.1` |
| Pulse length    | `TRIGGER_MS = 800` ms |
| Vibration       | `BUZZ_MS = 120` ms/step · `BUZZ_MAX = 1500` ms cap |

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

### Vibration motor
- Motor **(+)** → ESP32 **GPIO 23**
- Motor **(–)** → ESP32 **GND**
  *(For anything bigger than a tiny coin motor, drive it via a transistor/MOSFET
  with a flyback diode rather than straight off the GPIO.)*

### Load output (relay side)
- **9V battery +** → relay **COM**
- Relay **NO** → output alligator clip (+)
- **9V battery –** → output alligator clip (–)


## REST API

Base URL: `http://192.168.4.1`

| Method | Endpoint                  | Response |
|--------|---------------------------|----------|
| `GET`  | `/api/status`             | `{ "armed", "trigger_active", "uptime_ms", "clients" }` |
| `POST` | `/api/arm?code=123456`    | `{ "ok": true, "armed": true }` — `401` invalid code (`attempts_left`), `423` locked out |
| `POST` | `/api/disarm`             | `{ "ok": true, "armed": false }` |
| `POST` | `/api/trigger`            | `{ "ok": true }` — or `403 {"ok":false,"error":"not armed"}` |
| `POST` | `/api/buzz?ms=120`        | `{ "ok": true }` — pulses the motor (`ms` capped at `BUZZ_MAX`) |

`/api/status` also reports `locked` and `attempts_left`. Arming requires the
6-digit global password; triggering requires the system to be armed first:

```bash
curl -X POST "http://192.168.4.1/api/arm?code=123456"
curl -X POST  http://192.168.4.1/api/trigger
curl          http://192.168.4.1/api/status
```
