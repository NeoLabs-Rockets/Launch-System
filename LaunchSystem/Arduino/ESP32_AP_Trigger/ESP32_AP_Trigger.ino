/*
  NeoLabs Rockets — Mission Control
  ─────────────────────────────────────────────────────────────────────────────
  ESP32 NodeMCU DevKit (USB-C) as WiFi Access Point with a modern web UI
  and REST API for armed-and-trigger launch control.

  Features:
    · WiFi Access Point (open network, SSID configurable below)
    · NeoLabs-branded mission-control UI served from flash
    · ARM/DISARM button — trigger is gated behind arm state
    · 10-second browser countdown with TTS (Web Speech API, English)
      → "Ignition" spoken at 0; pin goes HIGH 500 ms after
    · Auto-disarm after every trigger
    · Non-blocking 800 ms HIGH pulse on TRIGGER_PIN
    · Optional status LED (5 Hz blink while firing, solid while armed)
    · Optional physical ARM toggle button

  REST API:
    GET  /api/status         → { armed, trigger_active, uptime_ms, clients, locked, attempts_left }
    POST /api/arm?code=NNNNNN → { ok, armed } | 401 invalid code | 423 locked out
    POST /api/disarm         → { ok, armed }
    POST /api/trigger        → { ok } | { ok:false, error }
    POST /api/buzz?ms=NNN    → { ok }   (pulses the vibration motor, ms capped at BUZZ_MAX)

  Security:
    · WiFi AP is OPEN (no WiFi password).
    · A single 6-digit global password (ARM_CODE) protects arming, UI + API.
    · After MAX_ATTEMPTS wrong codes the system locks out until reboot (RAM).

  ─────────────────────────────────────────────────────────────────────────────
  PIN ASSIGNMENTS — change only here
*/
#define TRIGGER_PIN   26    // Output: 800 ms HIGH pulse on fire
#define STATUS_LED     2    // Status LED  (-1 = disabled)  GPIO 2 = onboard
#define ARM_PIN       -1    // Physical ARM toggle (-1 = disabled)
                            // Wiring: button between ARM_PIN and GND (INPUT_PULLUP)
#define MOTOR_PIN     23    // Vibration motor (+) → GPIO 23, (-) → GND. -1 = disabled

// Network — open Access Point (no WiFi password); arming is what's protected
#define AP_SSID   "NeoLabs-Rockets"

// Security — single global password used to arm via both UI and API
#define ARM_CODE      "123456"           // 6-digit global password
#define MAX_ATTEMPTS  10                 // wrong-code tries before lockout (RAM, until reboot)

// Timing
#define TRIGGER_MS   2000UL   // relay pulse duration in milliseconds
#define DEBOUNCE_MS   50UL   // physical button debounce
#define BUZZ_MS      120UL   // default vibration pulse (per countdown step)
#define BUZZ_MAX    5000UL   // hard cap on any single vibration pulse
#define COUNTDOWN_CLIENT_TIMEOUT_MS 3000UL // abort if the launch page stops heartbeating
#define BLE_LINK_TIMEOUT_MS 5000UL // safety fallback if an armed BLE session disappears

// Haptic feedback
#define ARM_BUZZ_MS                 450UL
#define DISARM_BUZZ_MS              900UL
#define WRONG_CODE_BUZZ_MS          180UL
#define LOCKOUT_BUZZ_MS            3000UL
#define COUNTDOWN_START_BUZZ_MS     700UL
#define ABORT_BUZZ_MS              3000UL
#define LINK_LOST_BUZZ_MS          2500UL
#define TRIGGER_BUZZ_MS            1200UL
#define ARMED_IDLE_BUZZ_MS           90UL
#define ARMED_IDLE_BUZZ_INTERVAL_MS 5000UL
// ─────────────────────────────────────────────────────────────────────────────

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <NimBLEDevice.h>

WebServer server(80);
DNSServer dnsServer;

static NimBLEUUID BLE_SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID BLE_COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID BLE_STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
NimBLECharacteristic* bleStatusChar = nullptr;

const byte DNS_PORT = 53;
IPAddress apIP(192, 168, 4, 1);
const char BLE_NAME[] = "NeoLabs Launch Controller";

bool          armed         = false;
bool          triggerActive = false;
unsigned long triggerStart  = 0;

int           armAttempts   = 0;        // failed arm attempts (RAM only)
bool          lockedOut     = false;    // true after MAX_ATTEMPTS, until reboot

bool          motorActive   = false;    // vibration motor currently on
unsigned long motorOff      = 0;        // millis() at which to switch it off
unsigned long lastArmedBuzz = 0;        // last idle armed reminder buzz

void buzz(unsigned long ms);
void publishBleStatus();
bool countdownFresh();
void restartBleAdvertising();

int           lastBtnRead   = HIGH;
unsigned long lastDebounce  = 0;

bool          countdownActive = false;  // true while a browser-owned countdown is live
unsigned long countdownLastBeat = 0;    // last browser heartbeat during countdown
String        activeBleSid = "";
String        lastBleError = "";
int           bleConnectedCount = 0;
unsigned long lastBleActivity = 0;
unsigned long lastBleStatusNotify = 0;

// ─── Embedded web UI ─────────────────────────────────────────────────────────
static const char HTML_PAGE[] = R"HTMLPAGE(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeoLabs Rockets · Mission Control</title>
<style>
:root{
  --bg:#070b16;--bg2:#0c1224;--panel:rgba(18,26,48,.55);--border:#1b2746;
  --blue:#4d9fff;--blue-d:#2d6fe0;--ice:#9fd4ff;--glow:#5ab8ff;
  --green:#36f0a0;--red:#ff4a3d;--amber:#ffb347;
  --text:#dbe7ff;--muted:#5b6a8f;--silver:#c9d6ef;
  --font:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  min-height:100vh;color:var(--text);font-family:var(--font);
  background:
    radial-gradient(1100px 700px at 50% -10%,rgba(45,111,224,.16),transparent 60%),
    radial-gradient(800px 500px at 85% 110%,rgba(40,90,200,.10),transparent 55%),
    var(--bg);
  position:relative;overflow-x:hidden;
}
/* faint star field */
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5;
  background-image:radial-gradient(1px 1px at 20% 30%,rgba(255,255,255,.5),transparent),
    radial-gradient(1px 1px at 70% 65%,rgba(255,255,255,.35),transparent),
    radial-gradient(1px 1px at 40% 80%,rgba(255,255,255,.3),transparent),
    radial-gradient(1px 1px at 88% 18%,rgba(255,255,255,.4),transparent),
    radial-gradient(1px 1px at 12% 70%,rgba(255,255,255,.3),transparent);}

/* ── Header / wordmark ── */
header{position:sticky;top:0;z-index:50;display:flex;justify-content:space-between;align-items:center;
  padding:16px 26px;border-bottom:1px solid var(--border);
  background:linear-gradient(180deg,rgba(7,11,22,.92),rgba(7,11,22,.6));backdrop-filter:blur(14px)}
.brand{display:flex;align-items:center;gap:14px}
.hole{width:38px;height:38px;flex-shrink:0;filter:drop-shadow(0 0 8px rgba(90,184,255,.55))}
.wm{font-size:1.15em;letter-spacing:.42em;font-weight:600;line-height:1}
.wm .neo{background:linear-gradient(180deg,#fff,var(--silver));-webkit-background-clip:text;background-clip:text;color:transparent}
.wm .labs{background:linear-gradient(180deg,var(--ice),var(--blue));-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font-size:.6em;letter-spacing:.34em;color:var(--muted);margin-top:6px;text-transform:uppercase}
.hdr-dots{display:flex;gap:7px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:all .4s}
.on-blue{background:var(--blue)!important;box-shadow:0 0 9px var(--blue)!important}
.on-red{background:var(--red)!important;box-shadow:0 0 9px var(--red)!important;animation:dpulse 1s infinite}
.on-amber{background:var(--amber)!important;box-shadow:0 0 9px var(--amber)!important}
@keyframes dpulse{0%,100%{opacity:1}50%{opacity:.3}}

main{max-width:840px;margin:0 auto;padding:30px 18px;position:relative;z-index:1}
.lbl{font-size:.62em;letter-spacing:.28em;color:var(--muted);text-transform:uppercase;margin:0 0 10px 4px}

.card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:22px;
  margin-bottom:22px;position:relative;backdrop-filter:blur(8px);
  box-shadow:0 14px 40px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.03);
  transition:border-color .4s,box-shadow .4s}

.armed-warn{display:none;margin-bottom:16px;border:1px solid rgba(255,74,61,.5);border-radius:10px;
  padding:10px 14px;font-size:.7em;letter-spacing:.28em;color:var(--red);text-align:center;
  background:rgba(255,74,61,.06);animation:warn-pulse 1.3s infinite}
.armed-warn.show{display:block}
.conn-warn{display:none;margin-bottom:16px;border:1px solid rgba(255,179,71,.55);border-radius:10px;
  padding:10px 14px;font-size:.7em;letter-spacing:.18em;color:var(--amber);text-align:center;
  background:rgba(255,179,71,.08)}
.conn-warn.show{display:block}
@keyframes warn-pulse{0%,100%{opacity:1}50%{opacity:.45}}

.status-badge{display:flex;align-items:center;gap:12px;font-size:.98em;margin-bottom:18px;font-weight:500}
.ind{width:11px;height:11px;border-radius:50%;flex-shrink:0;transition:all .4s}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{background:rgba(7,11,22,.5);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.sk{font-size:.58em;color:var(--muted);letter-spacing:.14em;text-transform:uppercase}
.sv{font-size:.95em;margin-top:4px;color:var(--silver);font-variant-numeric:tabular-nums}

.btn-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:480px){.btn-row{grid-template-columns:1fr}}
.btn{width:100%;border:none;border-radius:14px;padding:34px 16px;font-family:inherit;
  font-size:.92em;letter-spacing:.16em;cursor:pointer;font-weight:600;text-transform:uppercase;
  transition:all .18s;display:flex;flex-direction:column;align-items:center;gap:10px}
.btn:disabled{opacity:.22;cursor:not-allowed}
.btn:not(:disabled):active{transform:scale(.97)}
.ico{font-size:2.1em;line-height:1}
.btn-arm{background:linear-gradient(160deg,rgba(45,111,224,.16),rgba(12,18,36,.6));
  color:var(--ice);border:1px solid rgba(77,159,255,.4);box-shadow:0 0 22px rgba(77,159,255,.08)}
.btn-arm:not(:disabled):hover{border-color:var(--blue);box-shadow:0 0 34px rgba(77,159,255,.35)}
.btn-arm.is-armed{background:linear-gradient(160deg,rgba(255,140,40,.16),rgba(36,18,10,.6));
  color:var(--amber);border:1px solid rgba(255,179,71,.5);box-shadow:0 0 22px rgba(255,179,71,.12)}
.btn-arm.is-armed:hover{border-color:var(--amber);box-shadow:0 0 34px rgba(255,179,71,.4)}
.btn-trig{background:linear-gradient(160deg,rgba(255,74,61,.1),rgba(28,12,12,.6));
  color:#ff8a7d;border:1px solid rgba(255,74,61,.25)}
.btn-trig:not(:disabled):hover{border-color:rgba(255,74,61,.85);color:#fff;box-shadow:0 0 30px rgba(255,74,61,.4)}
.btn-trig.is-armed{color:#fff;border-color:var(--red);box-shadow:0 0 28px rgba(255,74,61,.32);
  animation:rpulse 1.7s infinite;background:linear-gradient(160deg,rgba(255,74,61,.22),rgba(40,12,12,.7))}
@keyframes rpulse{0%,100%{box-shadow:0 0 18px rgba(255,74,61,.22)}50%{box-shadow:0 0 42px rgba(255,74,61,.7)}}
#launch-card.armed{border-color:rgba(255,74,61,.4);box-shadow:0 0 38px rgba(255,74,61,.1),inset 0 0 36px rgba(255,74,61,.04)}

/* ── Countdown overlay ── */
#overlay{display:none;position:fixed;inset:0;z-index:500;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(900px 700px at 50% 45%,rgba(20,12,30,.6),rgba(4,6,14,.98));backdrop-filter:blur(10px)}
#overlay.show{display:flex}
.cd-head{letter-spacing:.34em;color:var(--muted);font-size:.72em;text-transform:uppercase;margin-bottom:26px}
.cd-ring{position:relative;width:250px;height:250px;margin-bottom:18px}
.cd-ring svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
#arc-bg{fill:none;stroke:var(--border);stroke-width:4}
#arc{fill:none;stroke:var(--red);stroke-width:4;stroke-linecap:round;filter:drop-shadow(0 0 12px var(--red));transition:none}
#cd-n{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:5.6em;font-weight:800;
  color:#fff;text-shadow:0 0 34px rgba(255,90,60,.85),0 0 70px rgba(255,50,30,.35);transition:color .3s,font-size .2s}
.cd-sub{color:var(--amber);letter-spacing:.2em;font-size:.82em;margin-bottom:38px;text-align:center;min-height:1.4em;font-weight:500}
@keyframes ignite{0%,100%{transform:scale(1)}40%{transform:scale(1.18)}}
.btn-abort{background:transparent;border:1px solid var(--muted);color:var(--muted);border-radius:11px;
  padding:14px 42px;font-family:inherit;font-size:.8em;letter-spacing:.18em;cursor:pointer;transition:all .2s;
  text-transform:uppercase;font-weight:600}
.btn-abort:hover{border-color:var(--red);color:var(--red);box-shadow:0 0 16px rgba(255,74,61,.3)}

/* ── Arm modal (pre-flight checklist + code) ── */
#armModal{display:none;position:fixed;inset:0;z-index:550;align-items:flex-start;justify-content:center;
  padding:40px 16px;overflow-y:auto;background:rgba(4,6,14,.86);backdrop-filter:blur(10px)}
#armModal.show{display:flex}
.modal{width:100%;max-width:440px;background:linear-gradient(180deg,var(--bg2),#0a0f1f);
  border:1px solid var(--border);border-radius:18px;padding:26px;
  box-shadow:0 24px 70px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.04)}
.modal.shake{animation:shake .4s}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-9px)}40%,80%{transform:translateX(9px)}}
.steps{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:22px}
.step-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:.72em;font-weight:700;color:var(--muted);background:rgba(7,11,22,.6);
  border:1px solid var(--border);transition:all .25s}
.step-dot.on{color:#001124;background:linear-gradient(160deg,var(--blue),var(--blue-d));border-color:var(--blue);
  box-shadow:0 0 14px rgba(77,159,255,.4)}
.step-dot.done{color:var(--green);border-color:rgba(54,240,160,.5);background:rgba(54,240,160,.08)}
.step-line{width:46px;height:2px;background:var(--border);border-radius:2px}
.modal h2{font-size:.9em;letter-spacing:.2em;font-weight:600;color:var(--ice);text-transform:uppercase;
  display:flex;align-items:center;gap:9px}
.modal h2 .wn{color:var(--amber)}
.modal .sub{font-size:.7em;letter-spacing:.06em;color:var(--muted);margin:6px 0 20px;line-height:1.5}
.check{display:flex;align-items:flex-start;gap:12px;padding:11px 13px;margin-bottom:9px;cursor:pointer;
  background:rgba(7,11,22,.5);border:1px solid var(--border);border-radius:11px;
  font-size:.8em;line-height:1.4;transition:all .15s;user-select:none}
.check:hover{border-color:rgba(77,159,255,.35)}
.check.ok{border-color:rgba(54,240,160,.5);background:rgba(54,240,160,.05)}
.check .box{width:20px;height:20px;flex-shrink:0;border:1.6px solid var(--muted);border-radius:6px;
  display:flex;align-items:center;justify-content:center;font-size:.8em;color:#04121f;transition:all .15s}
.check.ok .box{background:var(--green);border-color:var(--green)}
.check .box::after{content:'✓';opacity:0;font-weight:900;transition:opacity .15s}
.check.ok .box::after{opacity:1}
.code-lbl{font-size:.62em;letter-spacing:.24em;color:var(--muted);text-transform:uppercase;margin:22px 0 10px}
.code-row{display:flex;gap:8px;justify-content:space-between}
.code-row input{width:100%;aspect-ratio:1/1.15;text-align:center;font-family:var(--font);
  font-size:1.5em;font-weight:700;color:#fff;background:rgba(7,11,22,.7);
  border:1px solid var(--border);border-radius:11px;outline:none;transition:all .15s;
  -moz-appearance:textfield}
.code-row input::-webkit-outer-spin-button,.code-row input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.code-row input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(77,159,255,.18)}
.code-row input.filled{border-color:rgba(77,159,255,.6);color:var(--ice)}
.modal-err{min-height:1.3em;font-size:.72em;letter-spacing:.08em;color:var(--red);text-align:center;margin:14px 0 4px}
.modal-btns{display:grid;grid-template-columns:1fr 1.4fr;gap:12px;margin-top:8px}
.m-cancel,.m-confirm{border:none;border-radius:12px;padding:15px;font-family:inherit;font-weight:600;
  font-size:.8em;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .15s}
.m-cancel{background:transparent;border:1px solid var(--muted);color:var(--muted)}
.m-cancel:hover{border-color:var(--text);color:var(--text)}
.m-confirm{background:linear-gradient(160deg,var(--blue),var(--blue-d));color:#001124}
.m-confirm:hover:not(:disabled){box-shadow:0 0 26px rgba(77,159,255,.5)}
.m-confirm:disabled{opacity:.25;cursor:not-allowed}

#toast{position:fixed;bottom:26px;right:26px;background:var(--bg2);border:1px solid var(--border);
  border-radius:11px;padding:13px 22px;font-size:.82em;letter-spacing:.03em;opacity:0;transform:translateY(8px);
  transition:all .3s;z-index:600;max-width:320px;pointer-events:none;box-shadow:0 12px 30px rgba(0,0,0,.5)}
#toast.show{opacity:1;transform:translateY(0)}

footer{text-align:center;color:var(--muted);font-size:.62em;letter-spacing:.2em;padding:8px 0 32px;
  position:relative;z-index:1;text-transform:uppercase}
</style>
</head>
<body>
<div id="vig" style="display:none;position:fixed;inset:0;pointer-events:none;z-index:2;background:radial-gradient(ellipse at 50% 50%,transparent 58%,rgba(255,40,30,.1) 100%)"></div>

<header>
  <div class="brand">
    <!-- NeoLabs black-hole mark -->
    <svg class="hole" viewBox="0 0 100 100" aria-label="NeoLabs">
      <defs>
        <radialGradient id="core" cx="50%" cy="50%" r="50%">
          <stop offset="62%" stop-color="#000"/>
          <stop offset="80%" stop-color="#0a1830"/>
          <stop offset="100%" stop-color="#000"/>
        </radialGradient>
        <linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#9fd4ff"/>
          <stop offset="50%" stop-color="#4d9fff"/>
          <stop offset="100%" stop-color="#1c4f9e"/>
        </linearGradient>
      </defs>
      <ellipse cx="50" cy="50" rx="46" ry="13" fill="none" stroke="url(#ringg)" stroke-width="2.4" opacity=".85"/>
      <circle cx="50" cy="50" r="26" fill="url(#core)"/>
      <circle cx="50" cy="50" r="26" fill="none" stroke="url(#ringg)" stroke-width="3"/>
      <path d="M24 50a26 26 0 0 0 52 0" fill="none" stroke="#cfe9ff" stroke-width="1.6" opacity=".9"/>
    </svg>
    <div>
      <div class="wm"><span class="neo">NEO</span><span class="labs">LABS</span></div>
      <div class="tag">Rockets · Mission Control</div>
    </div>
  </div>
  <div class="hdr-dots">
    <div class="dot on-blue"></div>
    <div class="dot" id="d1"></div>
    <div class="dot" id="d2"></div>
  </div>
</header>

<main>
  <div class="lbl">System Status</div>
  <div class="card">
    <div class="conn-warn" id="conn-warn">LIVE LINK LOST - RECONNECT TO 192.168.4.1</div>
    <div class="armed-warn" id="armed-warn">&#9888;&nbsp;SYSTEM ARMED &mdash; TRIGGER ENABLED</div>
    <div class="status-badge"><div class="ind" id="ind"></div><div id="stxt">Connecting&hellip;</div></div>
    <div class="stats">
      <div class="stat"><div class="sk">Uptime</div><div class="sv" id="s-up">&#8212;</div></div>
      <div class="stat"><div class="sk">Clients</div><div class="sv" id="s-cl">&#8212;</div></div>
      <div class="stat"><div class="sk">IP Address</div><div class="sv" id="s-ip">&#8212;</div></div>
      <div class="stat"><div class="sk">Trigger Pin</div><div class="sv">GPIO 26</div></div>
    </div>
  </div>

  <div class="lbl">Launch Control</div>
  <div class="card" id="launch-card">
    <div class="btn-row">
      <button class="btn btn-arm" id="b-arm" onclick="toggleArm()">
        <span class="ico" id="arm-ico">&#128274;</span>
        <span id="arm-lbl">ARM SYSTEM</span>
      </button>
      <button class="btn btn-trig" id="b-trig" onclick="startSequence()" disabled>
        <span class="ico">&#128640;</span>
        LAUNCH SEQUENCE
      </button>
    </div>
  </div>
</main>

<footer>NeoLabs Rockets &middot; ESP32 Mission Control</footer>

<!-- Arm modal: step 1 = pre-flight checklist, step 2 = global password -->
<div id="armModal">
  <div class="modal" id="modalBox">
    <div class="steps">
      <div class="step-dot on" id="sd1">1</div><div class="step-line"></div>
      <div class="step-dot" id="sd2">2</div>
    </div>

    <!-- Step 1: checklist -->
    <div id="step1">
      <h2><span class="wn">&#9888;</span> Pre-Flight Checklist</h2>
      <div class="sub">Confirm every safety item before continuing to the arming code.</div>

      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Launch area is <b>clear of people</b>, animals and obstructions; bystanders at a safe distance.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Igniter / load is wired correctly and the rocket is secured on the pad.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Power supply is stable and all connections are firm.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Weather and surroundings are safe for launch; no fire hazard nearby.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Checked mission control dashboard, including planes, weather, and recovery area.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Pad is aimed away from people, buildings, roads, dry vegetation, and power lines.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Fire suppression, first-aid plan, and recovery route are ready.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>Abort word and countdown procedure are understood by everyone nearby.</div></div>
      <div class="check" onclick="toggleCheck(this)"><div class="box"></div>
        <div>I am <b>authorized to launch</b> and ready to abort if anything goes wrong.</div></div>

      <div class="modal-btns">
        <button class="m-cancel"  onclick="closeArmModal()">Cancel</button>
        <button class="m-confirm" id="toStep2" onclick="gotoStep(2)" disabled>Continue</button>
      </div>
    </div>

    <!-- Step 2: global password -->
    <div id="step2" style="display:none">
      <h2><span class="wn">&#128274;</span> Arming Code</h2>
      <div class="sub">Enter the 6-digit global password to arm the launch trigger.</div>

      <div class="code-row" id="codeRow">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
        <input type="password" inputmode="numeric" maxlength="1" autocomplete="off">
      </div>

      <div class="modal-err" id="modalErr"></div>
      <div class="modal-btns">
        <button class="m-cancel"  onclick="gotoStep(1)">Back</button>
        <button class="m-confirm" id="confirmArm" onclick="confirmArm()" disabled>Arm System</button>
      </div>
    </div>
  </div>
</div>

<div id="overlay">
  <div class="cd-head">&#9654;&nbsp;LAUNCH SEQUENCE &mdash; STAND BY</div>
  <div class="cd-ring">
    <svg viewBox="0 0 200 200"><circle id="arc-bg" cx="100" cy="100" r="88"/><circle id="arc" cx="100" cy="100" r="88"/></svg>
    <div id="cd-n">10</div>
  </div>
  <div class="cd-sub" id="cd-sub">T-MINUS 10 SECONDS</div>
  <button class="btn-abort" onclick="abortSeq()">&#9632;&nbsp;ABORT SEQUENCE</button>
</div>

<div id="toast"></div>

<script>
const CIRCUM=2*Math.PI*88;
const arc=document.getElementById('arc');
arc.setAttribute('stroke-dasharray',CIRCUM);
arc.setAttribute('stroke-dashoffset',0);
let cdTimer=null,heartbeatTimer=null,aborted=false,liveLink=false,speechReady=false,audioCtx=null;

function fetchWithTimeout(url,opts={},timeout=1800){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),timeout);
  return fetch(url,{...opts,signal:ctrl.signal}).finally(()=>clearTimeout(t));
}

async function fetchStatus(){
  try{
    const r=await fetchWithTimeout('/api/status');
    if(r.ok){setLiveLink(true);applyStatus(await r.json());return;}
  }catch(_){}
  setLiveLink(false);
  if(document.getElementById('overlay').classList.contains('show'))abortSeq('Live link lost - countdown stopped',true);
}

function applyStatus(d){
  const armed=!!d.armed,active=!!d.trigger_active;
  if(d.locked!=null)lockedOut=!!d.locked;
  const ind=document.getElementById('ind'),stxt=document.getElementById('stxt');

  if(active){setInd(ind,'var(--amber)','0 0 10px var(--amber)');stxt.textContent='TRIGGER ACTIVE — Relay firing…';}
  else if(armed){setInd(ind,'var(--red)','0 0 10px var(--red)');stxt.textContent='SYSTEM ARMED — Ready for launch sequence';}
  else if(lockedOut){setInd(ind,'var(--red)','0 0 10px var(--red)');stxt.textContent='LOCKED OUT — Too many wrong codes; reboot required';}
  else{setInd(ind,'var(--green)','0 0 10px var(--green)');stxt.textContent='SYSTEM SAFE — Disarmed';}

  document.getElementById('armed-warn').className='armed-warn'+(armed?' show':'');
  document.getElementById('launch-card').className='card'+(armed?' armed':'');
  document.getElementById('vig').style.display=armed?'block':'none';
  document.getElementById('d1').className='dot '+(armed?'on-red':'');
  document.getElementById('d2').className='dot '+(active?'on-amber':'');

  if(d.uptime_ms!=null){const s=Math.floor(d.uptime_ms/1000);document.getElementById('s-up').textContent=pad(Math.floor(s/3600))+':'+pad(Math.floor((s%3600)/60))+':'+pad(s%60);}
  if(d.clients!=null)document.getElementById('s-cl').textContent=d.clients;

  const bArm=document.getElementById('b-arm'),bTrig=document.getElementById('b-trig');
  if(armed){
    bArm.className='btn btn-arm is-armed';bArm.disabled=false;
    document.getElementById('arm-ico').textContent='🔓';
    document.getElementById('arm-lbl').textContent='DISARM';
    bTrig.disabled=false;bTrig.className='btn btn-trig is-armed';
  }else if(lockedOut){
    bArm.className='btn btn-arm';bArm.disabled=true;
    document.getElementById('arm-ico').textContent='⛔';
    document.getElementById('arm-lbl').textContent='LOCKED OUT';
    bTrig.disabled=true;bTrig.className='btn btn-trig';
  }else{
    bArm.className='btn btn-arm';bArm.disabled=false;
    document.getElementById('arm-ico').textContent='🔒';
    document.getElementById('arm-lbl').textContent='ARM SYSTEM';
    bTrig.disabled=true;bTrig.className='btn btn-trig';
  }
}

function setInd(el,c,s){el.style.background=c;el.style.boxShadow=s;}
function pad(n){return String(n).padStart(2,'0');}
function setLiveLink(ok){
  liveLink=ok;
  document.getElementById('conn-warn').className='conn-warn'+(ok?'':' show');
  if(!ok){
    const ind=document.getElementById('ind'),stxt=document.getElementById('stxt');
    setInd(ind,'var(--amber)','0 0 10px var(--amber)');
    stxt.textContent='LIVE LINK LOST - Arduino not responding';
    document.getElementById('b-trig').disabled=true;
  }
}

// ARM button → checklist+code modal; DISARM → immediate (no code, safety)
function toggleArm(){
  if(document.getElementById('b-arm').classList.contains('is-armed')) disarm();
  else openArmModal();
}

async function disarm(){
  try{const r=await fetch('/api/disarm',{method:'POST'});applyStatus(await r.json());}
  catch(_){showToast('Connection error',true);}
}

// ── Arm modal (2 steps: checklist → code) ─────────────────────────────────────
const codeInputs=[...document.querySelectorAll('#codeRow input')];
let lockedOut=false;

function openArmModal(){
  if(lockedOut){showToast('System locked out — reboot required',true);return;}
  document.querySelectorAll('.check').forEach(c=>c.classList.remove('ok'));
  codeInputs.forEach(i=>{i.value='';i.classList.remove('filled');});
  document.getElementById('modalErr').textContent='';
  gotoStep(1);
  refreshChecklist();refreshConfirm();
  document.getElementById('armModal').classList.add('show');
}
function closeArmModal(){document.getElementById('armModal').classList.remove('show');}

function gotoStep(n){
  document.getElementById('step1').style.display=n===1?'':'none';
  document.getElementById('step2').style.display=n===2?'':'none';
  document.getElementById('sd1').className='step-dot '+(n===1?'on':'done');
  document.getElementById('sd2').className='step-dot '+(n===2?'on':'');
  if(n===2)setTimeout(()=>codeInputs[0].focus(),60);
}

function toggleCheck(el){el.classList.toggle('ok');refreshChecklist();}

function allChecked(){return [...document.querySelectorAll('.check')].every(c=>c.classList.contains('ok'));}
function codeValue(){return codeInputs.map(i=>i.value).join('');}
function refreshChecklist(){document.getElementById('toStep2').disabled=!allChecked();}
function refreshConfirm(){document.getElementById('confirmArm').disabled=codeValue().length!==6;}

// 6-box code entry: auto-advance, backspace, paste
codeInputs.forEach((inp,idx)=>{
  inp.addEventListener('input',()=>{
    inp.value=inp.value.replace(/\D/g,'').slice(0,1);
    inp.classList.toggle('filled',!!inp.value);
    if(inp.value&&idx<5)codeInputs[idx+1].focus();
    refreshConfirm();
  });
  inp.addEventListener('keydown',e=>{
    if(e.key==='Backspace'&&!inp.value&&idx>0)codeInputs[idx-1].focus();
    if(e.key==='Enter'&&!document.getElementById('confirmArm').disabled)confirmArm();
  });
  inp.addEventListener('paste',e=>{
    e.preventDefault();
    const d=(e.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,6);
    [...d].forEach((ch,i)=>{if(codeInputs[i]){codeInputs[i].value=ch;codeInputs[i].classList.add('filled');}});
    if(d.length)codeInputs[Math.min(d.length,5)].focus();
    refreshConfirm();
  });
});

async function confirmArm(){
  const btn=document.getElementById('confirmArm');
  if(btn.disabled)return;
  btn.disabled=true;
  const err=document.getElementById('modalErr');err.textContent='';
  try{
    const r=await fetch('/api/arm?code='+encodeURIComponent(codeValue()),{method:'POST'});
    const d=await r.json();
    if(r.ok&&d.armed){closeArmModal();applyStatus(d);showToast('System armed — trigger enabled');}
    else if(r.status===423){
      lockedOut=true;closeArmModal();
      showToast('Too many wrong codes — locked out until reboot',true);
      fetchStatus();
    }else{
      const left=(d.attempts_left!=null)?' — '+d.attempts_left+' left':'';
      err.textContent='✖ '+(d.error||'arming rejected').toUpperCase()+left;
      const box=document.getElementById('modalBox');box.classList.add('shake');setTimeout(()=>box.classList.remove('shake'),400);
      codeInputs.forEach(i=>{i.value='';i.classList.remove('filled');});codeInputs[0].focus();
      refreshConfirm();
    }
  }catch(_){err.textContent='✖ CONNECTION ERROR';refreshConfirm();}
}

function primeSpeech(){
  if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window))return false;
  try{speechSynthesis.cancel();speechSynthesis.getVoices();speechReady=true;return true;}catch(_){return false;}
}
if('speechSynthesis' in window)speechSynthesis.onvoiceschanged=()=>{speechReady=true;};

function beep(freq=880,dur=.12){
  try{
    audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.frequency.value=freq;o.type='sine';g.gain.value=.035;
    o.connect(g);g.connect(audioCtx.destination);o.start();
    g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+dur);
    o.stop(audioCtx.currentTime+dur);
  }catch(_){}
}

function speakStep(n){
  if(primeSpeech()){
    try{
      const u=new SpeechSynthesisUtterance(n===0?'Ignition':String(n));
      const voices=speechSynthesis.getVoices();
      const en=voices.find(v=>/^en[-_]/i.test(v.lang))||voices[0];
      if(en)u.voice=en;
      u.lang=(en&&en.lang)||'en-US';u.rate=1.0;u.pitch=n<=3?1.25:1.0;u.volume=1;
      speechSynthesis.cancel();speechSynthesis.speak(u);return;
    }catch(_){}
  }
  beep(n===0?440:880,n===0?.35:.1);
}

function cancelSpeech(){try{if('speechSynthesis' in window)speechSynthesis.cancel();}catch(_){}}

async function startSequence(){
  if(document.getElementById('b-trig').disabled)return;
  primeSpeech();
  aborted=false;
  try{
    const r=await fetchWithTimeout('/api/countdown/start',{method:'POST'});
    const d=await r.json();
    if(!r.ok||!d.ok){showToast('Countdown rejected: '+(d.error||'unknown'),true);fetchStatus();return;}
  }catch(_){setLiveLink(false);showToast('Cannot start countdown - live link lost',true);return;}
  startHeartbeat();
  arc.style.transition='none';
  arc.setAttribute('stroke-dashoffset',0);
  void arc.getBoundingClientRect();
  arc.style.transition='stroke-dashoffset 10s linear';
  arc.setAttribute('stroke-dashoffset',CIRCUM);
  document.getElementById('overlay').classList.add('show');
  runCd(10);
}

function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer=setInterval(async()=>{
    try{
      const r=await fetchWithTimeout('/api/countdown/heartbeat',{method:'POST'},1400);
      if(!r.ok)throw new Error('heartbeat rejected');
      setLiveLink(true);
    }catch(_){
      setLiveLink(false);
      abortSeq('Live link lost - countdown stopped',true);
    }
  },900);
}
function stopHeartbeat(){if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null;}}

function runCd(n){
  if(aborted)return;
  const numEl=document.getElementById('cd-n'),subEl=document.getElementById('cd-sub');
  numEl.textContent=n;
  numEl.style.color=n>6?'#fff':n>3?'var(--amber)':n>0?'#ff8040':'var(--red)';
  numEl.style.fontSize=n<=1?'7em':'5.6em';
  numEl.style.animation=n===0?'ignite .5s ease':'';
  subEl.textContent=n>0?'T-MINUS '+n+' SECOND'+(n===1?'':'S'):'▼  IGNITION  ▼';

  speakStep(n);

  // Short haptic buzz each step; a longer one at ignition
  buzz(n===0?450:120);

  if(n===0){cdTimer=setTimeout(()=>{if(!aborted)fireTrigger();},500);return;}
  cdTimer=setTimeout(()=>runCd(n-1),1000);
}

// Fire-and-forget vibration request to the ESP32
function buzz(ms){fetch('/api/buzz?ms='+ms,{method:'POST'}).catch(()=>{});}

async function abortSeq(msg='Launch sequence aborted',err=false){
  aborted=true;clearTimeout(cdTimer);stopHeartbeat();cancelSpeech();
  arc.style.transition='none';arc.setAttribute('stroke-dashoffset',0);
  document.getElementById('overlay').classList.remove('show');
  fetch('/api/countdown/abort',{method:'POST'}).catch(()=>{});
  showToast(msg,err);
}

async function fireTrigger(){
  const fl=document.createElement('div');
  Object.assign(fl.style,{position:'fixed',inset:'0',background:'rgba(255,110,40,.22)',zIndex:'999',pointerEvents:'none',transition:'opacity .45s'});
  document.body.appendChild(fl);
  setTimeout(()=>{fl.style.opacity='0';setTimeout(()=>fl.remove(),450);},60);

  try{
    const r=await fetchWithTimeout('/api/trigger',{method:'POST'},2200);
    const d=await r.json();
    stopHeartbeat();
    document.getElementById('overlay').classList.remove('show');
    cancelSpeech();
    d.ok?showToast('Trigger fired — 800 ms pulse sent'):showToast('Rejected: '+(d.error||'unknown'),true);
    await fetchStatus();
  }catch(_){
    stopHeartbeat();setLiveLink(false);
    document.getElementById('overlay').classList.remove('show');
    showToast('Connection error during trigger',true);
  }
}

function showToast(msg,err){
  const el=document.getElementById('toast');
  el.textContent=(err?'✖ ':'✔ ')+msg;
  el.style.borderColor=err?'var(--red)':'var(--green)';
  el.style.color=err?'#ff8a7d':'var(--green)';
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),3500);
}

document.getElementById('s-ip').textContent=location.hostname;
fetchStatus();
setInterval(fetchStatus,2500);
</script>
</body>
</html>
)HTMLPAGE";

static const char HTML_PAGE_SAFE[] = R"HTMLSAFE(<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeoLabs Launch Controller</title>
<style>
:root{--bg:#070b16;--panel:#10182c;--panel2:#0b1121;--border:#20304f;--text:#dbe7ff;--muted:#8090b4;--blue:#4d9fff;--green:#36f0a0;--amber:#ffb347;--red:#ff4a3d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif}
header{padding:18px 16px;border-bottom:1px solid var(--border);background:#080d19;position:sticky;top:0;z-index:2}
.wrap{max-width:820px;margin:auto}.brand{font-weight:800;letter-spacing:.16em;text-transform:uppercase}.sub{color:var(--muted);font-size:.86rem;margin-top:4px}
main{padding:18px 16px 36px}.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;margin:0 0 14px;box-shadow:0 12px 32px rgba(0,0,0,.25)}
.top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.state{font-size:1.35rem;font-weight:900;letter-spacing:.08em}.pill{border:1px solid var(--border);border-radius:999px;padding:5px 10px;color:var(--muted);font-size:.78rem}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}@media(max-width:640px){.grid{grid-template-columns:repeat(2,1fr)}}
.metric{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px}.k{font-size:.68rem;color:var(--muted);letter-spacing:.12em;text-transform:uppercase}.v{font-weight:800;margin-top:4px}
label{display:block;color:var(--muted);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}
input{width:100%;border:1px solid var(--border);border-radius:8px;background:#070b16;color:var(--text);font:inherit;padding:11px;outline:none}input:focus{border-color:var(--blue)}
.row{display:grid;grid-template-columns:1fr 140px;gap:10px}@media(max-width:560px){.row{grid-template-columns:1fr}}
.checks{display:grid;gap:8px;margin:12px 0}.checks label{display:flex;gap:9px;align-items:flex-start;background:#0b1121;border:1px solid var(--border);border-radius:8px;padding:10px;text-transform:none;letter-spacing:0;color:var(--text);font-size:.9rem;line-height:1.35;margin:0}.checks input{width:auto;margin-top:2px;accent-color:var(--green)}
.buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}@media(max-width:760px){.buttons{grid-template-columns:1fr 1fr}}button{border:1px solid var(--border);border-radius:8px;background:#0b1121;color:var(--text);font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:12px 10px;cursor:pointer}button:disabled{opacity:.42;cursor:not-allowed}.ok{border-color:rgba(54,240,160,.55);color:var(--green)}.warn{border-color:rgba(255,179,71,.6);color:var(--amber)}.bad{border-color:rgba(255,74,61,.55);color:var(--red)}.primary{background:linear-gradient(135deg,#255dcc,#4d9fff);border:0;color:#fff}.danger{background:rgba(255,74,61,.12);border-color:rgba(255,74,61,.45);color:#ffb3aa}
#count{display:none;position:fixed;inset:0;background:rgba(3,7,19,.94);z-index:5;place-items:center;text-align:center;padding:20px}.big{font-size:clamp(5rem,18vw,12rem);font-weight:1000;line-height:.9}.countsub{color:var(--amber);letter-spacing:.16em;text-transform:uppercase;margin:16px 0 28px}.toast{position:fixed;left:16px;right:16px;bottom:16px;max-width:640px;margin:auto;background:#080d19;border:1px solid var(--border);border-radius:10px;padding:12px;display:none;color:var(--text);z-index:8}.show{display:block}.muted{color:var(--muted)}.linklost{border-color:rgba(255,179,71,.65)}
</style>
</head>
<body>
<header><div class="wrap"><div class="brand">NeoLabs Rockets</div><div class="sub">ESP32 local launch controller - open 192.168.4.1 in a normal browser, not the WiFi popup.</div></div></header>
<main class="wrap">
  <section class="card" id="status-card">
    <div class="top"><div><div class="k">Controller status</div><div class="state" id="state">CONNECTING</div></div><div class="pill" id="link">live link starting</div></div>
    <div class="grid">
      <div class="metric"><div class="k">Armed</div><div class="v" id="armed">-</div></div>
      <div class="metric"><div class="k">Countdown</div><div class="v" id="cdstat">-</div></div>
      <div class="metric"><div class="k">Clients</div><div class="v" id="clients">-</div></div>
      <div class="metric"><div class="k">Attempts</div><div class="v" id="attempts">-</div></div>
    </div>
  </section>
  <section class="card">
    <div class="row">
      <div><label for="code">Arming code</label><input id="code" inputmode="numeric" maxlength="6" type="password" autocomplete="off"></div>
      <div><label for="secs">Countdown seconds</label><input id="secs" type="number" min="5" max="60" value="10"></div>
    </div>
    <div class="checks">
      <label><input type="checkbox" class="chk"> Area clear and safe distance confirmed.</label>
      <label><input type="checkbox" class="chk"> Checked mission control dashboard: aircraft, weather, location, and recovery area.</label>
      <label><input type="checkbox" class="chk"> Roads, buildings, dry vegetation, and power lines are outside the safety radius.</label>
      <label><input type="checkbox" class="chk"> Rocket secured, igniter connected, fire suppression ready, abort word understood.</label>
    </div>
    <div class="buttons">
      <button id="arm" class="primary" type="button">Arm</button>
      <button id="disarm" type="button">Disarm</button>
      <button id="launch" class="danger" type="button">Countdown</button>
      <button id="abort" class="danger" type="button">Abort</button>
    </div>
    <p class="muted">If this page loses the live link, the browser aborts locally and the ESP32 countdown heartbeat times out.</p>
  </section>
</main>
<div id="count"><div><div class="big" id="countnum">10</div><div class="countsub" id="countsub">T-minus 10 seconds</div><button id="abort2" class="danger" type="button">Abort sequence</button></div></div>
<div class="toast" id="toast"></div>
<script>
'use strict';
var statusData={},heartbeatTimer=null,countTimer=null,endsAt=0,live=false,lastStatusAt=0,audioCtx=null;
var qs=function(id){return document.getElementById(id)};
function toast(msg,bad){var t=qs('toast');t.textContent=msg;t.style.borderColor=bad?'var(--red)':'var(--green)';t.classList.add('show');setTimeout(function(){t.classList.remove('show')},3200)}
function api(path,opt,ms){ms=ms||1800;var c=new AbortController();var timer=setTimeout(function(){c.abort()},ms);return fetch(path,Object.assign({cache:'no-store',signal:c.signal},opt||{})).then(function(r){if(!r.ok)return r.json().catch(function(){return {error:r.statusText}}).then(function(b){throw new Error(b.error||r.statusText)});return r.json().catch(function(){return {}})}).finally(function(){clearTimeout(timer)})}
function setLink(ok){live=ok;qs('link').textContent=ok?'live link ok':'live link lost';qs('status-card').classList.toggle('linklost',!ok);if(!ok&&isCounting())abortSeq('Live link lost - countdown stopped',true)}
function loadStatus(){api('/api/status',{},1600).then(function(d){lastStatusAt=Date.now();setLink(true);apply(d)}).catch(function(){setLink(false);render()})}
function apply(d){statusData=d||{};render()}
function render(){var armed=!!statusData.armed,locked=!!statusData.locked,active=!!statusData.trigger_active,cd=!!statusData.countdown_active;qs('state').textContent=!live?'LINK LOST':locked?'LOCKED':active?'FIRING':armed?'ARMED':'SAFE';qs('state').className='state '+(!live||locked?'bad':active||armed?'warn':'ok');qs('armed').textContent=armed?'Yes':'No';qs('cdstat').textContent=cd?'Active':'Idle';qs('clients').textContent=statusData.clients==null?'-':statusData.clients;qs('attempts').textContent=locked?'Locked':statusData.attempts_left==null?'-':statusData.attempts_left;var checks=[].slice.call(document.querySelectorAll('.chk')).every(function(c){return c.checked});var code=/^[0-9]{6}$/.test(qs('code').value.trim());qs('arm').disabled=!live||armed||locked||!checks||!code;qs('disarm').disabled=!live||!armed;qs('launch').disabled=!live||!armed||locked||isCounting();qs('abort').disabled=!live||(!armed&&!isCounting())}
function code(){return qs('code').value.trim()}
function secs(){return Math.max(5,Math.min(60,Number(qs('secs').value)||10))}
function isCounting(){return !!countTimer||qs('count').style.display==='grid'}
function beep(freq,dur){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=freq;o.connect(g);g.connect(audioCtx.destination);g.gain.value=.04;o.start();g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+dur);o.stop(audioCtx.currentTime+dur)}catch(e){}}
function say(txt){try{if('speechSynthesis'in window&&'SpeechSynthesisUtterance'in window){speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(txt);u.lang='en-US';u.rate=1;speechSynthesis.speak(u);return}}catch(e){}beep(txt==='Ignition'?440:880,txt==='Ignition'?.35:.12)}
function heartbeat(){api('/api/countdown/heartbeat',{method:'POST'},1200).then(function(){setLink(true)}).catch(function(){setLink(false);abortSeq('Live link lost - countdown stopped',true)})}
function startHeartbeat(){stopHeartbeat();heartbeatTimer=setInterval(heartbeat,700)}
function stopHeartbeat(){if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=null}}
function tick(){var leftMs=endsAt-Date.now(),left=Math.max(0,Math.ceil(leftMs/1000));qs('countnum').textContent=left>0?left:'GO';qs('countsub').textContent=left>0?'T-minus '+left+' seconds':'Ignition';if(left<=10&&left>0&&Math.abs(leftMs-left*1000)<180)say(String(left));if(left<=0){clearInterval(countTimer);countTimer=null;stopHeartbeat();say('Ignition');api('/api/trigger',{method:'POST'},2200).then(function(){toast('Trigger command sent',false);setTimeout(function(){qs('count').style.display='none';loadStatus()},700)}).catch(function(e){toast('Trigger failed: '+e.message,true);qs('count').style.display='none';loadStatus()})}}
function arm(){api('/api/arm?code='+encodeURIComponent(code()),{method:'POST'},1900).then(function(d){qs('code').value='';apply(d);toast('System armed',false)}).catch(function(e){toast('Arm failed: '+e.message,true);loadStatus()})}
function disarm(){api('/api/disarm',{method:'POST'},1600).then(function(d){stopHeartbeat();apply(d);toast('System disarmed',false)}).catch(function(e){toast('Disarm failed: '+e.message,true)})}
function startSeq(){var n=secs();api('/api/countdown/start',{method:'POST'},1700).then(function(){endsAt=Date.now()+n*1000;qs('count').style.display='grid';startHeartbeat();clearInterval(countTimer);countTimer=setInterval(tick,100);tick();toast('Countdown started',false)}).catch(function(e){toast('Countdown rejected: '+e.message,true);loadStatus()})}
function abortSeq(msg,bad){clearInterval(countTimer);countTimer=null;stopHeartbeat();qs('count').style.display='none';api('/api/countdown/abort',{method:'POST'},1200).catch(function(){});toast(msg||'Countdown aborted',!!bad);loadStatus()}
qs('arm').onclick=arm;qs('disarm').onclick=disarm;qs('launch').onclick=startSeq;qs('abort').onclick=function(){abortSeq('Countdown aborted',false)};qs('abort2').onclick=qs('abort').onclick;document.addEventListener('input',render);loadStatus();setInterval(loadStatus,1800);setInterval(function(){if(live&&lastStatusAt&&Date.now()-lastStatusAt>4200)setLink(false)},1000);
</script>
</body>
</html>)HTMLSAFE";

static const char CAPTIVE_PAGE[] = R"CAPTIVEPAGE(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeoLabs Rockets</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b16;color:#dbe7ff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:24px}
main{max-width:360px}
h1{font-size:1.15rem;letter-spacing:.14em;text-transform:uppercase;color:#9fd4ff}
p{line-height:1.45;color:#c9d6ef}
.ip{font-size:1.7rem;font-weight:800;color:#36f0a0;margin:14px 0}
small{color:#5b6a8f}
</style>
</head>
<body>
<main>
  <h1>NeoLabs Rockets</h1>
  <p>This WiFi popup cannot run Mission Control reliably.</p>
  <p>Open this address in Chrome, Safari, Edge, or Firefox:</p>
  <div class="ip">192.168.4.1</div>
  <small>This popup should close automatically after the device marks the WiFi connection as successful.</small>
  <script>setTimeout(()=>{try{window.close();}catch(e){}},4500);</script>
</main>
</body>
</html>)CAPTIVEPAGE";

// ─── Helpers ─────────────────────────────────────────────────────────────────
void setCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin",  "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Cache-Control",                "no-store");
}

void sendJSON(int code, const char* body) {
  setCORSHeaders();
  server.send(code, "application/json", body);
}

String jsonString(const String& src, const char* key) {
  String pat = String("\"") + key + "\":\"";
  int i = src.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  int e = src.indexOf("\"", i);
  return e < 0 ? "" : src.substring(i, e);
}

bool bleCodeOk(const String& body) {
  return jsonString(body, "code") == ARM_CODE;
}

bool bleSidAllowed(const String& sid) {
  return activeBleSid.length() == 0 || sid == activeBleSid;
}

void bleSafeAbort(const char* reason, unsigned long buzzMs) {
  armed = false;
  countdownActive = false;
  activeBleSid = "";
  lastBleError = reason;
  buzz(buzzMs);
}

void publishBleStatus() {
  if (!bleStatusChar) return;
  char buf[190];
  snprintf(buf, sizeof(buf),
    "{\"a\":%d,\"f\":%d,\"c\":%d,\"l\":%d,\"left\":%d,\"n\":%d,\"u\":%lu,\"e\":\"%s\"}",
    armed ? 1 : 0,
    triggerActive ? 1 : 0,
    countdownActive ? 1 : 0,
    lockedOut ? 1 : 0,
    lockedOut ? 0 : (MAX_ATTEMPTS - armAttempts),
    bleConnectedCount,
    millis(),
    lastBleError.c_str()
  );
  bleStatusChar->setValue((uint8_t*)buf, strlen(buf));
  bleStatusChar->notify();
  lastBleStatusNotify = millis();
}

class HybridBleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    bleConnectedCount++;
    lastBleActivity = millis();
    restartBleAdvertising();
    publishBleStatus();
  }

  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    if (bleConnectedCount > 0) bleConnectedCount--;
    if (activeBleSid.length() > 0 && (armed || countdownActive)) {
      bleSafeAbort("ble_disconnect", LINK_LOST_BUZZ_MS);
    }
    restartBleAdvertising();
    publishBleStatus();
  }
};

class HybridBleCommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo&) override {
    String body = characteristic->getValue().c_str();
    String cmd = jsonString(body, "cmd");
    String sid = jsonString(body, "sid");
    lastBleActivity = millis();
    lastBleError = "";

    if (cmd == "status") { publishBleStatus(); return; }
    if (cmd == "abort") { bleSafeAbort("abort", ABORT_BUZZ_MS); publishBleStatus(); return; }
    if (cmd == "disarm") {
      armed = false;
      countdownActive = false;
      activeBleSid = "";
      lastBleError = "";
      buzz(DISARM_BUZZ_MS);
      publishBleStatus();
      return;
    }

    if (lockedOut) { lastBleError = "locked"; publishBleStatus(); return; }

    if (cmd == "arm") {
      if (!bleCodeOk(body)) {
        armAttempts++;
        buzz(armAttempts >= MAX_ATTEMPTS ? LOCKOUT_BUZZ_MS : WRONG_CODE_BUZZ_MS);
        if (armAttempts >= MAX_ATTEMPTS) lockedOut = true;
        lastBleError = "bad_code";
        publishBleStatus();
        return;
      }
      armAttempts = 0;
      armed = true;
      countdownActive = false;
      activeBleSid = sid;
      lastBleError = "";
      lastArmedBuzz = millis();
      buzz(ARM_BUZZ_MS);
      publishBleStatus();
      return;
    }

    if (!bleSidAllowed(sid)) { lastBleError = "not_owner"; publishBleStatus(); return; }

    if (cmd == "countdown_start") {
      if (!bleCodeOk(body)) { lastBleError = "code_required"; publishBleStatus(); return; }
      if (!armed || triggerActive) {
        lastBleError = !armed ? "not_armed" : "trigger_active";
        publishBleStatus();
        return;
      }
      countdownActive = true;
      countdownLastBeat = millis();
      buzz(COUNTDOWN_START_BUZZ_MS);
      publishBleStatus();
      return;
    }

    if (cmd == "heartbeat") {
      if (armed && countdownActive) countdownLastBeat = millis();
      publishBleStatus();
      return;
    }

    if (cmd == "trigger") {
      if (!bleCodeOk(body)) { lastBleError = "code_required"; publishBleStatus(); return; }
      if (!armed) { lastBleError = "not_armed"; publishBleStatus(); return; }
      if (!countdownFresh()) { bleSafeAbort("heartbeat_lost", LINK_LOST_BUZZ_MS); publishBleStatus(); return; }
      digitalWrite(TRIGGER_PIN, HIGH);
      buzz(TRIGGER_BUZZ_MS);
      triggerActive = true;
      triggerStart  = millis();
      armed         = false;
      countdownActive = false;
      activeBleSid = "";
      Serial.println("[TRIGGER] BLE pulse started");
      publishBleStatus();
      return;
    }

    lastBleError = "unknown_cmd";
    publishBleStatus();
  }
};

void setupBLE() {
  NimBLEDevice::init(BLE_NAME);
  NimBLEDevice::setMTU(185);
  NimBLEDevice::setPower(9);
  NimBLEServer* bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new HybridBleServerCallbacks());

  NimBLEService* bleService = bleServer->createService(BLE_SERVICE_UUID);
  NimBLECharacteristic* bleCommandChar = bleService->createCharacteristic(
    BLE_COMMAND_UUID,
    NIMBLE_PROPERTY::WRITE
  );
  bleCommandChar->setCallbacks(new HybridBleCommandCallbacks());

  bleStatusChar = bleService->createCharacteristic(
    BLE_STATUS_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );
  bleService->start();

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->enableScanResponse(true);
  advertising->setName(BLE_NAME);
  advertising->start();
  Serial.println("[OK] BLE advertising - NeoLabs Launch Controller");
  publishBleStatus();
}

void restartBleAdvertising() {
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (advertising) advertising->start();
}

// ─── Route handlers ──────────────────────────────────────────────────────────
void handleRoot() {
  setCORSHeaders();
  server.send(200, "text/html", HTML_PAGE_SAFE);
}

void handleCaptivePortal() {
  setCORSHeaders();
  server.send(200, "text/html", CAPTIVE_PAGE);
}

void handleAndroidProbe() {
  setCORSHeaders();
  server.send(204, "text/plain", "");
}

void handleAppleProbe() {
  setCORSHeaders();
  server.send(200, "text/html", "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");
}

void handleWindowsProbe() {
  setCORSHeaders();
  server.send(200, "text/plain", "Microsoft Connect Test");
}

void handleStatus() {
  char buf[220];
  snprintf(buf, sizeof(buf),
    "{\"armed\":%s,\"trigger_active\":%s,\"uptime_ms\":%lu,\"clients\":%d,\"locked\":%s,\"attempts_left\":%d,\"countdown_active\":%s}",
    armed         ? "true" : "false",
    triggerActive ? "true" : "false",
    millis(),
    (int)WiFi.softAPgetStationNum(),
    lockedOut ? "true" : "false",
    lockedOut ? 0 : (MAX_ATTEMPTS - armAttempts),
    countdownActive ? "true" : "false"
  );
  sendJSON(200, buf);
}

void handleArm() {
  // Locked out until reboot once too many wrong codes were entered
  if (lockedOut) { sendJSON(423, "{\"ok\":false,\"error\":\"locked out\"}"); return; }

  // 6-digit global password required (from ?code= query or form body)
  if (server.arg("code") != ARM_CODE) {
    armAttempts++;
    if (armAttempts >= MAX_ATTEMPTS) {
      lockedOut = true;
      buzz(LOCKOUT_BUZZ_MS);
      Serial.println("[SECURITY] Locked out after too many wrong codes");
      lastBleError = "locked";
      publishBleStatus();
      sendJSON(423, "{\"ok\":false,\"error\":\"locked out\"}");
      return;
    }
    buzz(WRONG_CODE_BUZZ_MS);
    lastBleError = "bad_code";
    publishBleStatus();
    char buf[80];
    snprintf(buf, sizeof(buf),
      "{\"ok\":false,\"error\":\"invalid code\",\"attempts_left\":%d}",
      MAX_ATTEMPTS - armAttempts);
    sendJSON(401, buf);
    return;
  }

  armAttempts = 0;   // reset counter on success
  armed = true;
  countdownActive = false;
  activeBleSid = "";
  lastBleError = "";
  lastArmedBuzz = millis();
  buzz(ARM_BUZZ_MS);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true,\"armed\":true}");
}
void handleDisarm() {
  armed = false;
  countdownActive = false;
  activeBleSid = "";
  lastBleError = "";
  buzz(DISARM_BUZZ_MS);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true,\"armed\":false}");
}

bool countdownFresh() {
  return countdownActive && (millis() - countdownLastBeat <= COUNTDOWN_CLIENT_TIMEOUT_MS);
}

void handleCountdownStart() {
  if (!armed)        { sendJSON(403, "{\"ok\":false,\"error\":\"not armed\"}"); return; }
  if (triggerActive) { sendJSON(409, "{\"ok\":false,\"error\":\"trigger already active\"}"); return; }
  countdownActive = true;
  countdownLastBeat = millis();
  activeBleSid = "";
  lastBleError = "";
  buzz(COUNTDOWN_START_BUZZ_MS);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

void handleCountdownHeartbeat() {
  if (!armed || triggerActive || !countdownActive) {
    sendJSON(409, "{\"ok\":false,\"error\":\"countdown inactive\"}");
    return;
  }
  countdownLastBeat = millis();
  sendJSON(200, "{\"ok\":true}");
}

void handleCountdownAbort() {
  countdownActive = false;
  activeBleSid = "";
  lastBleError = "abort";
  buzz(ABORT_BUZZ_MS);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

void handleTrigger() {
  if (!armed)        { sendJSON(403, "{\"ok\":false,\"error\":\"not armed\"}");         return; }
  if (triggerActive) { sendJSON(409, "{\"ok\":false,\"error\":\"trigger already active\"}"); return; }
  if (!countdownFresh()) {
    countdownActive = false;
    armed = false;
    activeBleSid = "";
    lastBleError = "heartbeat_lost";
    buzz(LINK_LOST_BUZZ_MS);
    publishBleStatus();
    sendJSON(409, "{\"ok\":false,\"error\":\"live countdown link lost\"}");
    return;
  }
  digitalWrite(TRIGGER_PIN, HIGH);
  buzz(TRIGGER_BUZZ_MS);
  triggerActive = true;
  triggerStart  = millis();
  armed         = false;
  countdownActive = false;
  activeBleSid = "";
  lastBleError = "";
  Serial.println("[TRIGGER] Pulse started");
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

// Start a non-blocking vibration pulse of the given duration (clamped)
void buzz(unsigned long ms) {
  if (MOTOR_PIN < 0) return;
  if (ms > BUZZ_MAX) ms = BUZZ_MAX;
  if (ms < 1)        ms = 1;
  if (armed && !countdownActive && !triggerActive) lastArmedBuzz = millis();
  digitalWrite(MOTOR_PIN, HIGH);
  motorActive = true;
  motorOff    = millis() + ms;
}

void handleBuzz() {
  unsigned long ms = server.hasArg("ms") ? (unsigned long)server.arg("ms").toInt() : BUZZ_MS;
  buzz(ms);
  sendJSON(200, "{\"ok\":true}");
}

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) { setCORSHeaders(); server.send(204); return; }

  // Captive portal fallback:
  // Anything that is not an API request gets a lightweight instruction page.
  // The full Mission Control UI is only served from http://192.168.4.1/.
  if (!server.uri().startsWith("/api/")) {
    handleCaptivePortal();
    return;
  }

  sendJSON(404, "{\"ok\":false,\"error\":\"not found\"}");
}

// ─── Physical ARM button (debounced toggle) ───────────────────────────────────
void checkArmButton() {
  if (ARM_PIN < 0) return;
  int reading = digitalRead(ARM_PIN);
  if (reading != lastBtnRead) lastDebounce = millis();
  if ((millis() - lastDebounce) > DEBOUNCE_MS) {
    static int stable = HIGH;
    if (reading != stable) {
      stable = reading;
      if (stable == LOW) {
        armed = !armed;
        if (armed) {
          lastArmedBuzz = millis();
          buzz(ARM_BUZZ_MS);
        } else {
          countdownActive = false;
          activeBleSid = "";
          lastBleError = "";
          buzz(DISARM_BUZZ_MS);
        }
        publishBleStatus();
        Serial.printf("[ARM_BTN] %s\n", armed ? "ARMED" : "DISARMED");
      }
    }
  }
  lastBtnRead = reading;
}

// ─── Setup ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(TRIGGER_PIN, OUTPUT);
  digitalWrite(TRIGGER_PIN, LOW);
  if (STATUS_LED >= 0) { pinMode(STATUS_LED, OUTPUT); digitalWrite(STATUS_LED, LOW); }
  if (MOTOR_PIN  >= 0) { pinMode(MOTOR_PIN,  OUTPUT); digitalWrite(MOTOR_PIN,  LOW); }
  if (ARM_PIN    >= 0)   pinMode(ARM_PIN, INPUT_PULLUP);

  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));

  if (!WiFi.softAP(AP_SSID)) {           // open network, no WiFi password
    Serial.println("[ERROR] AP startup failed");
    if (STATUS_LED >= 0) while (true) { digitalWrite(STATUS_LED, !digitalRead(STATUS_LED)); delay(100); }
    while (true) delay(1000);
  }
  Serial.printf("[OK] AP up  SSID: %s  IP: %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  // Wildcard DNS redirects all hostnames to the ESP32 AP IP.
  dnsServer.start(DNS_PORT, "*", apIP);

  server.on("/",                         HTTP_GET,  handleRoot);

  // Common captive-network checks. Return the expected success response so the
  // OS popup closes; real control UI stays at http://192.168.4.1/.
  server.on("/generate_204",             HTTP_GET,  handleAndroidProbe);
  server.on("/gen_204",                  HTTP_GET,  handleAndroidProbe);
  server.on("/hotspot-detect.html",      HTTP_GET,  handleAppleProbe);
  server.on("/library/test/success.html",HTTP_GET,  handleAppleProbe);
  server.on("/ncsi.txt",                 HTTP_GET,  handleWindowsProbe);
  server.on("/connecttest.txt",          HTTP_GET,  handleWindowsProbe);
  server.on("/redirect",                 HTTP_GET,  handleCaptivePortal);

  server.on("/api/status",               HTTP_GET,  handleStatus);
  server.on("/api/arm",                  HTTP_POST, handleArm);
  server.on("/api/disarm",               HTTP_POST, handleDisarm);
  server.on("/api/countdown/start",      HTTP_POST, handleCountdownStart);
  server.on("/api/countdown/heartbeat",  HTTP_POST, handleCountdownHeartbeat);
  server.on("/api/countdown/abort",      HTTP_POST, handleCountdownAbort);
  server.on("/api/trigger",              HTTP_POST, handleTrigger);
  server.on("/api/buzz",                 HTTP_POST, handleBuzz);
  server.onNotFound(handleNotFound);
  server.begin();
  setupBLE();
  Serial.println("[OK] Web server started - open http://192.168.4.1/ in a browser");
}

// ─── Loop ────────────────────────────────────────────────────────────────────
void loop() {
  dnsServer.processNextRequest();
  server.handleClient();
  checkArmButton();

  if (triggerActive && (millis() - triggerStart >= TRIGGER_MS)) {
    digitalWrite(TRIGGER_PIN, LOW);
    triggerActive = false;
    Serial.println("[TRIGGER] Pulse complete");
    publishBleStatus();
  }

  if (countdownActive && (millis() - countdownLastBeat > COUNTDOWN_CLIENT_TIMEOUT_MS)) {
    countdownActive = false;
    armed = false;
    activeBleSid = "";
    lastBleError = "heartbeat_lost";
    buzz(LINK_LOST_BUZZ_MS);
    Serial.println("[COUNTDOWN] Heartbeat lost, countdown aborted and system disarmed");
    publishBleStatus();
  }

  if (activeBleSid.length() > 0 && bleConnectedCount == 0 && (armed || countdownActive) &&
      (millis() - lastBleActivity > BLE_LINK_TIMEOUT_MS)) {
    bleSafeAbort("ble_link_lost", LINK_LOST_BUZZ_MS);
    Serial.println("[BLE] Active session disappeared, system disarmed");
    publishBleStatus();
  }

  if (armed && !countdownActive && !triggerActive && !motorActive &&
      (millis() - lastArmedBuzz >= ARMED_IDLE_BUZZ_INTERVAL_MS)) {
    buzz(ARMED_IDLE_BUZZ_MS);
    lastArmedBuzz = millis();
  }

  // End the vibration pulse once its duration has elapsed (non-blocking)
  if (motorActive && (long)(millis() - motorOff) >= 0) {
    digitalWrite(MOTOR_PIN, LOW);
    motorActive = false;
  }

  if (STATUS_LED >= 0) {
    bool ledOn = triggerActive ? ((millis() / 100) % 2 == 0) : armed;
    digitalWrite(STATUS_LED, ledOn ? HIGH : LOW);
  }

  if (bleStatusChar && (millis() - lastBleStatusNotify >= 1000)) {
    publishBleStatus();
  }
}
