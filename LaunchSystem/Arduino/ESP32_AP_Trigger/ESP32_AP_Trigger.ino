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
#define BUZZ_MS      120UL   // default pulse for the /api/buzz test endpoint
#define BUZZ_MAX    5000UL   // hard cap on any single vibration pulse
#define COUNTDOWN_CLIENT_TIMEOUT_MS 3000UL // abort if the launch page stops heartbeating
#define BLE_LINK_TIMEOUT_MS 5000UL // safety fallback if an armed BLE session disappears

// Haptics — deliberately sparse. The motor only fires for meaningful events,
// each as a short, distinct pattern. There is NO idle "armed" reminder buzz,
// and the countdown only ticks for the final few seconds.
#define COUNTDOWN_TICK_FROM 3   // buzz the countdown only at T-3, T-2, T-1
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

// Non-blocking haptic sequencer state
static const int HAPTIC_MAX = 16;
unsigned long hapticSteps[HAPTIC_MAX];   // alternating ON,OFF,ON… durations (ms)
int           hapticCount   = 0;
int           hapticIndex   = 0;
unsigned long hapticStepEnd = 0;
bool          hapticRunning = false;

enum HapticKind {
  H_NONE, H_ARM, H_DISARM, H_WRONG, H_LOCKOUT,
  H_CD_START, H_TICK, H_ABORT, H_LINKLOST, H_TRIGGER
};

void buzz(unsigned long ms);
void playHaptic(HapticKind kind);
void startHaptic(const unsigned long* steps, int count);
void updateHaptic();
void publishBleStatus();
bool countdownFresh();
void restartBleAdvertising();

int           lastBtnRead   = HIGH;
unsigned long lastDebounce  = 0;

bool          countdownActive = false;  // true while a browser-owned countdown is live
unsigned long countdownLastBeat = 0;    // last browser heartbeat during countdown
int           lastCountdownBuzzSecond = -1;
String        activeBleSid = "";
String        lastBleError = "";
int           bleConnectedCount = 0;
unsigned long lastBleActivity = 0;
unsigned long lastBleStatusNotify = 0;

// ─── Embedded web UI ─────────────────────────────────────────────────────────
static const char HTML_PAGE_SAFE[] PROGMEM = R"HTMLSAFE(<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeoLabs Launch Controller</title>
<style>
:root{--bg:#04060e;--panel:rgba(16,24,46,.6);--bd:#16223f;--blue:#4d9fff;--blued:#2d6fe0;--ice:#9fd4ff;--green:#36f0a0;--red:#ff4a3d;--amber:#ffb347;--tx:#dbe7ff;--mut:#64759c}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--tx);min-height:100vh;-webkit-font-smoothing:antialiased;background:radial-gradient(900px 520px at 50% -12%,rgba(45,111,224,.18),transparent 60%),var(--bg)}
header{display:flex;align-items:center;gap:13px;padding:15px 18px;border-bottom:1px solid var(--bd);background:linear-gradient(180deg,rgba(7,11,22,.92),rgba(7,11,22,.6));position:sticky;top:0;z-index:5}
.logo{width:36px;height:36px;flex:0 0 auto;filter:drop-shadow(0 0 8px rgba(90,184,255,.55))}
.brand{font-weight:800;letter-spacing:.34em;font-size:15px}
.brand b{color:var(--blue)}
.sub{font-size:10px;letter-spacing:.2em;color:var(--mut);text-transform:uppercase;margin-top:4px}
main{max-width:680px;margin:0 auto;padding:18px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:18px;margin-bottom:14px}
.sec{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--mut);margin-bottom:13px}
.statline{display:flex;align-items:center;gap:18px}
.badge{width:108px;height:108px;border-radius:50%;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;border:3px solid var(--green);box-shadow:0 0 28px rgba(54,240,160,.22),inset 0 0 26px rgba(54,240,160,.05);transition:.4s}
.badge b{font-size:21px;font-weight:800;letter-spacing:.05em;color:var(--green)}
.badge span{font-size:9px;letter-spacing:.18em;color:var(--mut);margin-top:4px;text-transform:uppercase}
.badge.warn{border-color:var(--amber);box-shadow:0 0 28px rgba(255,179,71,.24),inset 0 0 26px rgba(255,179,71,.05)}
.badge.warn b{color:var(--amber)}
.badge.bad{border-color:var(--red);box-shadow:0 0 32px rgba(255,74,61,.3),inset 0 0 26px rgba(255,74,61,.05)}
.badge.bad b{color:var(--red)}
.grid{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:9px}
.m{background:rgba(7,11,22,.55);border:1px solid var(--bd);border-radius:9px;padding:10px 12px}
.k{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--mut)}
.m .v{font-size:17px;font-weight:700;color:var(--ice);margin-top:4px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:13px}
.field .k{display:block;margin-bottom:6px}
input[type=password],input[type=number]{width:100%;padding:12px;border-radius:9px;border:1px solid var(--bd);background:rgba(7,11,22,.7);color:#fff;font-size:17px;font-family:inherit;letter-spacing:.12em}
input:focus{outline:none;border-color:var(--blue)}
.checks{display:grid;gap:8px;margin:6px 0 14px}
.checks label{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.4;color:var(--tx);background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:9px;padding:10px 12px;cursor:pointer}
.checks input{margin-top:1px;width:17px;height:17px;accent-color:var(--green);flex:0 0 auto}
.btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
button{padding:13px;border-radius:10px;border:1px solid var(--bd);background:rgba(77,159,255,.1);color:var(--tx);font-weight:700;text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-family:inherit;cursor:pointer;transition:.18s}
button:hover:not(:disabled){border-color:rgba(77,159,255,.5);background:rgba(77,159,255,.16)}
button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.35;cursor:not-allowed}
.primary{background:linear-gradient(135deg,var(--blued),var(--blue));border:none;color:#fff}
.danger{background:rgba(255,74,61,.12);border-color:rgba(255,74,61,.4);color:#ffb4ad}
.danger:hover:not(:disabled){background:rgba(255,74,61,.2);border-color:rgba(255,74,61,.6)}
.note{font-size:12px;color:var(--mut);line-height:1.5;margin-top:4px}
#overlay{display:none;position:fixed;inset:0;z-index:20;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:radial-gradient(680px 480px at 50% 32%,rgba(255,74,61,.12),transparent 62%),#020409}
#overlay.on{display:flex}
.ring{position:relative;width:264px;height:264px}
.ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ring .trk{fill:none;stroke:rgba(159,212,255,.14);stroke-width:6}
.ring .arc{fill:none;stroke:var(--amber);stroke-width:6;stroke-linecap:round;stroke-dasharray:578;stroke-dashoffset:0;transition:stroke-dashoffset .2s linear}
.ctr{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.num{font-size:96px;font-weight:800;letter-spacing:.02em;text-shadow:0 0 36px rgba(255,74,61,.4)}
#sub{margin-top:18px;letter-spacing:.32em;text-transform:uppercase;color:var(--amber);font-size:14px}
#overlay button{max-width:240px;margin-top:30px}
.toast{display:none;position:fixed;left:14px;right:14px;bottom:14px;max-width:520px;margin:0 auto;background:#0b1121;border:1px solid var(--bd);border-radius:11px;padding:13px 15px;font-size:14px;z-index:30}
</style>
</head>
<body>
<header>
<svg class="logo" viewBox="0 0 100 100"><ellipse cx="50" cy="50" rx="46" ry="13" fill="none" stroke="#4d9fff" stroke-width="2.4" opacity=".85"/><circle cx="50" cy="50" r="26" fill="#020a18"/><circle cx="50" cy="50" r="26" fill="none" stroke="#9fd4ff" stroke-width="3"/><path d="M24 50a26 26 0 0 0 52 0" fill="none" stroke="#cfe9ff" stroke-width="1.6"/></svg>
<div><div class="brand">NEO<b>LABS</b> ROCKETS</div><div class="sub">AP Fallback Controller &middot; 192.168.4.1</div></div>
</header>
<main>
 <div class="card">
  <div class="statline">
   <div class="badge" id="badge"><b id="state">LINK</b><span>Controller</span></div>
   <div class="grid">
    <div class="m"><div class="k">Armed</div><div class="v" id="armed">-</div></div>
    <div class="m"><div class="k">Countdown</div><div class="v" id="cdstat">-</div></div>
    <div class="m"><div class="k">Clients</div><div class="v" id="clients">-</div></div>
    <div class="m"><div class="k">Attempts</div><div class="v" id="attempts">-</div></div>
   </div>
  </div>
 </div>
 <div class="card">
  <div class="sec">Arm &amp; Launch</div>
  <div class="row">
   <div class="field"><span class="k">Arming code</span><input id="code" type="password" inputmode="numeric" maxlength="6" placeholder="------"></div>
   <div class="field"><span class="k">Countdown s</span><input id="secs" type="number" min="5" max="60" value="10"></div>
  </div>
  <div class="k" style="margin-bottom:8px">Pre-flight checklist</div>
  <div class="checks">
   <label><input type="checkbox" class="chk"> Area clear and safe distance confirmed.</label>
   <label><input type="checkbox" class="chk"> Mission control dashboard checked: aircraft, weather, location, recovery.</label>
   <label><input type="checkbox" class="chk"> Roads, buildings, dry vegetation, and power lines outside safety radius.</label>
   <label><input type="checkbox" class="chk"> Rocket secured, igniter connected, fire suppression ready, abort word understood.</label>
  </div>
  <div class="btns"><button id="arm" class="primary">Arm</button><button id="disarm">Disarm</button></div>
  <div class="btns"><button id="launch" class="danger">Start Countdown</button><button id="abort" class="danger">Abort</button></div>
  <div class="note">Keep this page open during the AP countdown. If the browser stops sending heartbeats, the ESP32 safely disarms.</div>
 </div>
</main>
<div id="overlay">
 <div class="ring"><svg viewBox="0 0 200 200"><circle class="trk" cx="100" cy="100" r="92"></circle><circle class="arc" id="arc" cx="100" cy="100" r="92"></circle></svg><div class="ctr"><div class="num" id="num">10</div></div></div>
 <div id="sub">T-minus 10</div>
 <button id="abort2" class="danger">Abort</button>
</div>
<div id="toast" class="toast"></div>
<script>
var statusData={},countTimer=0,beatTimer=0,endsAt=0,cdTotal=10,lastSay=-99,audioCtx=null;
var ARC=578;
function id(x){return document.getElementById(x)}
function req(method,path,cb,eb){var x=new XMLHttpRequest();x.onreadystatechange=function(){if(x.readyState===4){if(x.status>=200&&x.status<300){var d={};try{d=JSON.parse(x.responseText||'{}')}catch(e){}cb&&cb(d)}else{eb&&eb(x.responseText||('HTTP '+x.status))}}};x.open(method,path,true);x.setRequestHeader('Cache-Control','no-store');x.send('')}
function toast(t,bad){var e=id('toast');e.textContent=t;e.style.borderColor=bad?'#ff4a3d':'#36f0a0';e.style.display='block';clearTimeout(toast._t);toast._t=setTimeout(function(){e.style.display='none'},3200)}
function allChecked(){var c=document.getElementsByClassName('chk');for(var i=0;i<c.length;i++){if(!c[i].checked)return false}return true}
function codeOk(){return /^[0-9]{6}$/.test(id('code').value)}
function secs(){var n=parseInt(id('secs').value,10);if(isNaN(n))n=10;if(n<5)n=5;if(n>60)n=60;return n}
function render(){var s=statusData,a=!!s.armed,l=!!s.locked,f=!!s.trigger_active,c=!!s.countdown_active;id('state').textContent=l?'LOCKED':f?'FIRING':a?'ARMED':'SAFE';id('badge').className='badge '+(l||f?'bad':a?'warn':'');id('armed').textContent=a?'Yes':'No';id('cdstat').textContent=c?'Active':'Idle';id('clients').textContent=s.clients==null?'-':s.clients;id('attempts').textContent=l?'Locked':(s.attempts_left==null?'-':s.attempts_left);id('arm').disabled=l||a||!allChecked()||!codeOk();id('disarm').disabled=!a;id('launch').disabled=!a||l||!!countTimer;id('abort').disabled=!a&&!countTimer}
function load(){req('GET','/api/status',function(d){statusData=d;render()},function(){id('state').textContent='LINK?';id('badge').className='badge bad'})}
function beep(freq,dur){try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=freq;o.connect(g);g.connect(audioCtx.destination);g.gain.value=.04;o.start();g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+dur);o.stop(audioCtx.currentTime+dur)}catch(e){}}
function say(n){var t=n<=0?'Ignition':String(n);try{if(window.speechSynthesis&&window.SpeechSynthesisUtterance){speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(t);u.lang='en-US';u.rate=1;speechSynthesis.speak(u);return}}catch(e){}beep(n<=0?440:880,n<=0?.35:.1)}
function closeOv(){id('overlay').classList.remove('on')}
function tick(){var ms=endsAt-Date.now(),left=Math.max(0,Math.ceil(ms/1000));id('num').textContent=left>0?left:'GO';id('sub').textContent=left>0?'T-minus '+left:'Ignition';var frac=Math.max(0,Math.min(1,(ms/1000)/cdTotal));id('arc').style.strokeDashoffset=(ARC*(1-frac)).toFixed(1);if(left<=10&&left!==lastSay){lastSay=left;say(left)}if(left<=0){clearInterval(countTimer);countTimer=0;clearInterval(beatTimer);beatTimer=0;req('POST','/api/trigger',function(){toast('Trigger command sent',false);closeOv();load()},function(e){toast('Trigger failed: '+e,true);closeOv();load()})}}
function heartbeat(){var left=Math.max(0,Math.ceil((endsAt-Date.now())/1000));req('POST','/api/countdown/heartbeat?left='+left,function(){},function(){abortLocal('Live link lost',true)})}
function abortLocal(msg,bad){clearInterval(countTimer);countTimer=0;clearInterval(beatTimer);beatTimer=0;closeOv();req('POST','/api/countdown/abort',function(){},function(){});toast(msg||'Aborted',bad);load()}
id('arm').onclick=function(){req('POST','/api/arm?code='+encodeURIComponent(id('code').value),function(d){id('code').value='';statusData=d;toast('System armed',false);load()},function(e){toast('Arm failed: '+e,true);load()})};
id('disarm').onclick=function(){req('POST','/api/disarm',function(){toast('Disarmed',false);load()},function(e){toast('Disarm failed: '+e,true)})};
id('launch').onclick=function(){var n=secs();cdTotal=n;req('POST','/api/countdown/start',function(){endsAt=Date.now()+n*1000;lastSay=-99;id('overlay').classList.add('on');id('arc').style.strokeDashoffset=0;clearInterval(countTimer);countTimer=setInterval(tick,120);clearInterval(beatTimer);beatTimer=setInterval(heartbeat,700);tick();heartbeat()},function(e){toast('Countdown rejected: '+e,true);load()})};
id('abort').onclick=function(){abortLocal('Aborted',false)};id('abort2').onclick=id('abort').onclick;document.onchange=render;document.onkeyup=render;load();setInterval(load,2000);
</script>
</body>
</html>)HTMLSAFE";

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

int jsonInt(const String& src, const char* key, int fallback) {
  String pat = String("\"") + key + "\":";
  int i = src.indexOf(pat);
  if (i < 0) return fallback;
  i += pat.length();
  while (i < (int)src.length() && src[i] == ' ') i++;
  int e = i;
  if (e < (int)src.length() && src[e] == '-') e++;
  while (e < (int)src.length() && isDigit(src[e])) e++;
  if (e <= i) return fallback;
  return src.substring(i, e).toInt();
}

void noteCountdownSecond(int left) {
  if (!countdownActive) return;
  if (left >= 1 && left <= COUNTDOWN_TICK_FROM && left != lastCountdownBuzzSecond) {
    lastCountdownBuzzSecond = left;
    playHaptic(H_TICK);
  }
}

bool bleCodeOk(const String& body) {
  return jsonString(body, "code") == ARM_CODE;
}

bool bleSidAllowed(const String& sid) {
  return activeBleSid.length() == 0 || sid == activeBleSid;
}

void bleSafeAbort(const char* reason, HapticKind kind) {
  armed = false;
  countdownActive = false;
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = reason;
  playHaptic(kind);
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
    if (cmd == "abort") { bleSafeAbort("abort", H_ABORT); publishBleStatus(); return; }
    if (cmd == "disarm") {
      armed = false;
      countdownActive = false;
      lastCountdownBuzzSecond = -1;
      activeBleSid = "";
      lastBleError = "";
      playHaptic(H_DISARM);
      publishBleStatus();
      return;
    }

    if (lockedOut) { lastBleError = "locked"; publishBleStatus(); return; }

    if (cmd == "arm") {
      if (!bleCodeOk(body)) {
        armAttempts++;
        playHaptic(armAttempts >= MAX_ATTEMPTS ? H_LOCKOUT : H_WRONG);
        if (armAttempts >= MAX_ATTEMPTS) lockedOut = true;
        lastBleError = "bad_code";
        publishBleStatus();
        return;
      }
      armAttempts = 0;
      armed = true;
      countdownActive = false;
      lastCountdownBuzzSecond = -1;
      activeBleSid = sid;
      lastBleError = "";
      playHaptic(H_ARM);
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
      lastCountdownBuzzSecond = -1;
      playHaptic(H_CD_START);
      publishBleStatus();
      return;
    }

    if (cmd == "heartbeat") {
      if (armed && countdownActive) {
        countdownLastBeat = millis();
        noteCountdownSecond(jsonInt(body, "left", -1));
      }
      publishBleStatus();
      return;
    }

    if (cmd == "trigger") {
      if (!bleCodeOk(body)) { lastBleError = "code_required"; publishBleStatus(); return; }
      if (!armed) { lastBleError = "not_armed"; publishBleStatus(); return; }
      if (!countdownFresh()) { bleSafeAbort("heartbeat_lost", H_LINKLOST); publishBleStatus(); return; }
      digitalWrite(TRIGGER_PIN, HIGH);
      playHaptic(H_TRIGGER);
      triggerActive = true;
      triggerStart  = millis();
      armed         = false;
      countdownActive = false;
      lastCountdownBuzzSecond = -1;
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
  server.send_P(200, "text/html", HTML_PAGE_SAFE);
}

void handleCaptivePortal() {
  handleRoot();
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
      playHaptic(H_LOCKOUT);
      Serial.println("[SECURITY] Locked out after too many wrong codes");
      lastBleError = "locked";
      publishBleStatus();
      sendJSON(423, "{\"ok\":false,\"error\":\"locked out\"}");
      return;
    }
    playHaptic(H_WRONG);
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
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = "";
  playHaptic(H_ARM);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true,\"armed\":true}");
}
void handleDisarm() {
  armed = false;
  countdownActive = false;
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = "";
  playHaptic(H_DISARM);
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
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = "";
  playHaptic(H_CD_START);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

void handleCountdownHeartbeat() {
  if (!armed || triggerActive || !countdownActive) {
    sendJSON(409, "{\"ok\":false,\"error\":\"countdown inactive\"}");
    return;
  }
  countdownLastBeat = millis();
  if (server.hasArg("left")) noteCountdownSecond(server.arg("left").toInt());
  sendJSON(200, "{\"ok\":true}");
}

void handleCountdownAbort() {
  countdownActive = false;
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = "abort";
  playHaptic(H_ABORT);
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

void handleTrigger() {
  if (!armed)        { sendJSON(403, "{\"ok\":false,\"error\":\"not armed\"}");         return; }
  if (triggerActive) { sendJSON(409, "{\"ok\":false,\"error\":\"trigger already active\"}"); return; }
  if (!countdownFresh()) {
    countdownActive = false;
    armed = false;
    lastCountdownBuzzSecond = -1;
    activeBleSid = "";
    lastBleError = "heartbeat_lost";
    playHaptic(H_LINKLOST);
    publishBleStatus();
    sendJSON(409, "{\"ok\":false,\"error\":\"live countdown link lost\"}");
    return;
  }
  digitalWrite(TRIGGER_PIN, HIGH);
  playHaptic(H_TRIGGER);
  triggerActive = true;
  triggerStart  = millis();
  armed         = false;
  countdownActive = false;
  lastCountdownBuzzSecond = -1;
  activeBleSid = "";
  lastBleError = "";
  Serial.println("[TRIGGER] Pulse started");
  publishBleStatus();
  sendJSON(200, "{\"ok\":true}");
}

// ─── Non-blocking haptics ─────────────────────────────────────────────────────
// Plays a pattern of alternating ON/OFF durations (ms) without blocking loop().
// steps[0] is always an ON pulse; steps[1] an OFF gap; and so on.
void startHaptic(const unsigned long* steps, int count) {
  if (MOTOR_PIN < 0 || count <= 0) return;
  if (count > HAPTIC_MAX) count = HAPTIC_MAX;
  for (int i = 0; i < count; i++) hapticSteps[i] = steps[i];
  hapticCount   = count;
  hapticIndex   = 0;
  hapticRunning = true;
  digitalWrite(MOTOR_PIN, HIGH);
  hapticStepEnd = millis() + hapticSteps[0];
}

// Advance the pattern; call once per loop().
void updateHaptic() {
  if (!hapticRunning) return;
  if ((long)(millis() - hapticStepEnd) < 0) return;
  hapticIndex++;
  if (hapticIndex >= hapticCount) {
    digitalWrite(MOTOR_PIN, LOW);
    hapticRunning = false;
    return;
  }
  bool on = (hapticIndex % 2 == 0);   // even index = ON, odd = OFF gap
  digitalWrite(MOTOR_PIN, on ? HIGH : LOW);
  hapticStepEnd = millis() + hapticSteps[hapticIndex];
}

// Single clamped pulse — used only by the /api/buzz test endpoint.
void buzz(unsigned long ms) {
  if (ms > BUZZ_MAX) ms = BUZZ_MAX;
  if (ms < 1)        ms = 1;
  unsigned long one[1] = { ms };
  startHaptic(one, 1);
}

// One short, distinct pattern per meaningful event. Kept brief on purpose.
void playHaptic(HapticKind kind) {
  switch (kind) {
    case H_ARM:      { const unsigned long s[] = {150};                 startHaptic(s, 1); break; }  // one confident pulse
    case H_DISARM:   { const unsigned long s[] = {70, 90, 70};          startHaptic(s, 3); break; }  // soft double-tap
    case H_WRONG:    { const unsigned long s[] = {55, 80, 55};          startHaptic(s, 3); break; }  // quick low double
    case H_LOCKOUT:  { const unsigned long s[] = {220,130,220,130,220}; startHaptic(s, 5); break; }  // firm triple
    case H_CD_START: { const unsigned long s[] = {110};                 startHaptic(s, 1); break; }  // brief acknowledge
    case H_TICK:     { const unsigned long s[] = {45};                  startHaptic(s, 1); break; }  // tiny final-second tick
    case H_ABORT:    { const unsigned long s[] = {200,110,200,110,200}; startHaptic(s, 5); break; }  // urgent triple
    case H_LINKLOST: { const unsigned long s[] = {160,100,160,100,160}; startHaptic(s, 5); break; }  // safe-stop triple
    case H_TRIGGER:  { const unsigned long s[] = {320};                 startHaptic(s, 1); break; }  // one firm ignition pulse
    default: break;
  }
}

void handleBuzz() {
  unsigned long ms = server.hasArg("ms") ? (unsigned long)server.arg("ms").toInt() : BUZZ_MS;
  buzz(ms);
  sendJSON(200, "{\"ok\":true}");
}

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) { setCORSHeaders(); server.send(204); return; }

  // Anything that is not an API request falls back to the AP controller.
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
          playHaptic(H_ARM);
        } else {
          countdownActive = false;
          lastCountdownBuzzSecond = -1;
          activeBleSid = "";
          lastBleError = "";
          playHaptic(H_DISARM);
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
  server.on("/index.html",               HTTP_GET,  handleRoot);

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
    lastCountdownBuzzSecond = -1;
    activeBleSid = "";
    lastBleError = "heartbeat_lost";
    playHaptic(H_LINKLOST);
    Serial.println("[COUNTDOWN] Heartbeat lost, countdown aborted and system disarmed");
    publishBleStatus();
  }

  // Advance any active haptic pattern (no idle "armed" buzzing — the status LED
  // shows the armed state instead).
  updateHaptic();

  if (STATUS_LED >= 0) {
    bool ledOn = triggerActive ? ((millis() / 100) % 2 == 0) : armed;
    digitalWrite(STATUS_LED, ledOn ? HIGH : LOW);
  }

  if (bleStatusChar && (millis() - lastBleStatusNotify >= 1000)) {
    publishBleStatus();
  }
}
