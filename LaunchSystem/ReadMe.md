# NeoLabs Rockets â€” ESP32 Mission Control

WiFi-controlled trigger/relay switch built on an ESP32. The board runs as its own
WiFi Access Point and serves a NeoLabs-branded web UI with an **arm â†’ launch**
workflow, a 10-second voice countdown, and a REST API. Designed to run off a 9V
battery for portable use.

> Firmware: [`Arduino/ESP32_AP_Trigger/ESP32_AP_Trigger.ino`](Arduino/ESP32_AP_Trigger/ESP32_AP_Trigger.ino)
>
> Web Bluetooth requires a Chromium-family browser such as Chrome or Edge on
> localhost/HTTPS. Firefox and Safari do not currently support this control path.

The AP trigger sketch serves WiFi and BLE at the same time. Use this single
hybrid controller build, then choose Bluetooth or WiFi AP in the Mission
Dashboard.

## Arduino compile settings

Install the **NimBLE-Arduino** library from the Arduino Library Manager before
compiling. The sketch uses NimBLE instead of the default ESP32 BLE stack because
it is much smaller and keeps the hybrid WiFi+BLE build practical.

Recommended Arduino IDE board settings:

| Setting | Value |
|---------|-------|
| Board | ESP32 Dev Module or your exact ESP32 board |
| Partition Scheme | Default works; Huge APP (3MB No OTA) gives more headroom |
| Core Debug Level | None |

The current hybrid sketch compiles on the default ESP32 Dev Module partition
with NimBLE-Arduino installed. If future features push it over the limit, change
**Tools -> Partition Scheme** to a larger APP partition such as
**Huge APP (3MB No OTA)**.

## Features

- **Open WiFi Access Point** â€” no router and no WiFi password; the ESP32 hosts
  its own network. Security is handled by the arming password instead.
- **Two-step arming** â€” page 1 is a pre-flight safety **checklist** (every item
  must be acknowledged), page 2 is the **arming code**.
- **Single global password** â€” one 6-digit code (default `123456`) is required to
  arm, both in the UI and on the `/api/arm` endpoint. Disarming never needs it.
- **Lockout** â€” after **10** wrong codes the system locks out until reboot
  (counter is kept in RAM only, so a power cycle clears it).
- **Arm/Disarm safety** â€” the trigger is disabled until the system is armed.
  Auto-disarms after every shot.
- **Launch sequence** â€” 10 s countdown with English browser TTS; says
  *"Ignition"* at zero, then drives the output **HIGH 500 ms later**.
- **Trigger pulse** — non-blocking HIGH pulse on the trigger pin, then back LOW.
- **Status LED** â€” solid while armed, 5 Hz blink while firing.
- **Vibration motor** — distinct haptic patterns for arm, disarm, wrong code, lockout, countdown start, final-second ticks, abort, link-lost safety stop, and ignition. No idle buzz.
- **Physical ARM button** (optional, disabled by default) â€” toggles arm state in hardware.
- **REST API** â€” JSON endpoints for automation/testing.

## Pin assignments

These are defined at the top of the sketch and are the only place you should
change them:

| Function          | GPIO | Direction        | Notes |
|-------------------|------|------------------|-------|
| **Trigger out**   | `26` | OUTPUT           | Goes HIGH for 2000 ms on launch â†’ relay IN / driver |
| **Status LED**    | `2`  | OUTPUT           | Onboard LED on most DevKits. Set to `-1` to disable |
| **Vibration motor**| `23`| OUTPUT           | Motor **(+)** â†’ GPIO 23, **(â€“)** â†’ GND. Set to `-1` to disable |
| **Physical ARM**  | `25` | INPUT_PULLUP     | Momentary button to **GND** (LOW = pressed). `-1` = disabled (default) |

> âš ï¸ Avoid GPIO 6â€“11 (connected to the SPI flash). GPIO 26 / 25 / 23 / 2 are safe,
> standard output-capable pins on the NodeMCU DevKit.
>
> âš ï¸ Drive the motor through a transistor/MOSFET + flyback diode if it draws more
> than a few mA â€” an ESP32 GPIO can't power a motor directly. A tiny coin/ERM
> motor on a driver board is fine; bare motors need the driver.

## Network / config

Defined near the top of the sketch:

| Setting      | Default            |
|--------------|--------------------|
| SSID            | `NeoLabs-Rockets` |
| WiFi security   | Open (no password) |
| Arming password | `ARM_CODE = "123456"` (6-digit global code) |
| Lockout         | `MAX_ATTEMPTS = 10` wrong codes â†’ locked until reboot |
| URL             | `http://192.168.4.1` |
| Pulse length    | `TRIGGER_MS = 2000` ms |
| Vibration       | Named patterns via `playHaptic(kind)` — non-blocking sequencer, no idle buzz |

## Parts list

| Qty | Part | Note |
|-----|------|------|
| 1 | ESP32 NodeMCU (USB-C) | diymore or similar |
| 1 | 5V 1-channel relay module (opto-isolated) | with screw terminals |
| 1 | 9V battery clip (I-type) | snap-on |
| 1 | Buck converter (9â€“12V â†’ 5V) | or LM7805 + caps |
| 1 set | Dupont jumper wires (M-M + M-F) | â€” |
| 2â€“4 | Alligator clip leads | for the output |
| 1 | Optional: toggle/momentary switch | hardware arming button |
| 1 | Optional: LED + 220Î© resistor | status / continuity |

**Approx. cost:** ~â‚¬15â€“25

## Wiring

### Power
- **9V battery +** â†’ buck converter **IN (+)**
- **9V battery â€“** â†’ buck converter **GND**
- Buck **OUT 5V** â†’ ESP32 **VIN**
- Buck **OUT GND** â†’ ESP32 **GND** + relay **GND**

### Relay control
- ESP32 **GPIO 26** (trigger out) â†’ relay **IN**
- ESP32 **GND** â†’ relay **GND**

### Optional physical ARM button
- ESP32 **GPIO 25** â†’ one leg of the button
- Other leg of the button â†’ ESP32 **GND**
  *(uses the internal pull-up; pressing pulls the pin LOW)*

### Optional status LED
- ESP32 **GPIO 2** â†’ LED **anode** â†’ 220Î© resistor â†’ ESP32 **GND**
  *(GPIO 2 already has the onboard LED on most DevKits)*

### Vibration motor
- Motor **(+)** â†’ ESP32 **GPIO 23**
- Motor **(â€“)** â†’ ESP32 **GND**
  *(For anything bigger than a tiny coin motor, drive it via a transistor/MOSFET
  with a flyback diode rather than straight off the GPIO.)*

### Load output (relay side)
- **9V battery +** â†’ relay **COM**
- Relay **NO** â†’ output alligator clip (+)
- **9V battery â€“** â†’ output alligator clip (â€“)


## REST API

Base URL: `http://192.168.4.1`

| Method | Endpoint                  | Response |
|--------|---------------------------|----------|
| `GET`  | `/api/status`             | `{ "armed", "trigger_active", "uptime_ms", "clients" }` |
| `POST` | `/api/arm?code=123456`    | `{ "ok": true, "armed": true }` â€” `401` invalid code (`attempts_left`), `423` locked out |
| `POST` | `/api/disarm`             | `{ "ok": true, "armed": false }` |
| `POST` | `/api/trigger`            | `{ "ok": true }` â€” or `403 {"ok":false,"error":"not armed"}` |
| `POST` | `/api/buzz?ms=120`        | `{ “ok”: true }` — single haptic pulse of `ms` duration |

`/api/status` also reports `locked` and `attempts_left`. Arming requires the
6-digit global password; triggering requires the system to be armed first:

```bash
curl -X POST "http://192.168.4.1/api/arm?code=123456"
curl -X POST  http://192.168.4.1/api/trigger
curl          http://192.168.4.1/api/status
```
