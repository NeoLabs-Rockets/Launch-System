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
int           lastCountdownBuzzSecond = -1;
String        activeBleSid = "";
String        lastBleError = "";
int           bleConnectedCount = 0;
unsigned long lastBleActivity = 0;
unsigned long lastBleStatusNotify = 0;

// ─── Embedded web UI ─────────────────────────────────────────────────────────
static const char HTML_PAGE_SAFE[] = R"HTMLSAFE(<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeoLabs Launch Controller</title>
<style>
body{margin:0;background:#070b16;color:#dbe7ff;font-family:Arial,Helvetica,sans-serif}header{background:#0b1121;border-bottom:1px solid #20304f;padding:16px}main{max-width:760px;margin:auto;padding:16px}.brand{font-weight:bold;letter-spacing:3px}.sub{color:#9fb0d0;font-size:14px;margin-top:4px}.card{background:#10182c;border:1px solid #20304f;border-radius:8px;margin:0 0 14px;padding:14px}.state{font-size:30px;font-weight:bold}.row{display:table;width:100%;border-spacing:8px}.cell{display:table-cell;width:50%;vertical-align:top}.metric{background:#0b1121;border:1px solid #20304f;border-radius:6px;padding:10px;margin:6px 0}.k{font-size:11px;color:#8090b4;text-transform:uppercase;letter-spacing:1px}.v{font-size:18px;font-weight:bold;margin-top:4px}label{display:block;margin:8px 0;color:#dbe7ff}input[type=password],input[type=number]{width:100%;padding:12px;border-radius:6px;border:1px solid #20304f;background:#070b16;color:#fff;font-size:18px}button{width:100%;padding:13px;margin:5px 0;border-radius:6px;border:1px solid #20304f;background:#17233d;color:#dbe7ff;font-weight:bold;text-transform:uppercase}button:disabled{opacity:.35}.primary{background:#2d6fe0}.danger{background:#4a1720;border-color:#ff4a3d}.ok{color:#36f0a0}.warn{color:#ffb347}.bad{color:#ff4a3d}#overlay{display:none;position:fixed;left:0;top:0;right:0;bottom:0;background:#030713;color:#fff;text-align:center;z-index:10;padding-top:20vh}.num{font-size:120px;font-weight:bold}.toast{display:none;position:fixed;left:12px;right:12px;bottom:12px;background:#0b1121;border:1px solid #20304f;border-radius:8px;padding:12px}.small{color:#8090b4;font-size:13px;line-height:1.35}@media(max-width:620px){.cell{display:block;width:auto}.num{font-size:86px}}
</style>
</head>
<body>
<header><div class="brand">NEOLABS ROCKETS</div><div class="sub">ESP32 AP fallback controller at 192.168.4.1</div></header>
<main>
 <div class="card">
  <div class="k">Controller status</div><div id="state" class="state">CONNECTING</div>
  <div class="row"><div class="cell"><div class="metric"><div class="k">Armed</div><div class="v" id="armed">-</div></div></div><div class="cell"><div class="metric"><div class="k">Countdown</div><div class="v" id="cdstat">-</div></div></div></div>
  <div class="row"><div class="cell"><div class="metric"><div class="k">Clients</div><div class="v" id="clients">-</div></div></div><div class="cell"><div class="metric"><div class="k">Attempts</div><div class="v" id="attempts">-</div></div></div></div>
 </div>
 <div class="card">
  <div class="row"><div class="cell"><div class="k">Arming code</div><input id="code" type="password" inputmode="numeric" maxlength="6"></div><div class="cell"><div class="k">Countdown seconds</div><input id="secs" type="number" min="5" max="60" value="10"></div></div>
  <div class="k">Pre-flight checklist</div>
  <label><input type="checkbox" class="chk"> Area clear and safe distance confirmed.</label>
  <label><input type="checkbox" class="chk"> Mission control dashboard checked: aircraft, weather, location, recovery.</label>
  <label><input type="checkbox" class="chk"> Roads, buildings, dry vegetation, and power lines outside safety radius.</label>
  <label><input type="checkbox" class="chk"> Rocket secured, igniter connected, fire suppression ready, abort word understood.</label>
  <div class="row"><div class="cell"><button id="arm" class="primary">Arm</button></div><div class="cell"><button id="disarm">Disarm</button></div></div>
  <div class="row"><div class="cell"><button id="launch" class="danger">Start countdown</button></div><div class="cell"><button id="abort" class="danger">Abort</button></div></div>
  <div class="small">Keep this page open during AP countdown. If the browser stops heartbeats, the ESP32 disarms safely.</div>
 </div>
</main>
<div id="overlay"><div class="num" id="num">10</div><div id="sub">T-minus 10</div><p><button id="abort2" class="danger" style="max-width:260px">Abort</button></p></div>
<div id="toast" class="toast"></div>
<script>
var statusData={},countTimer=0,beatTimer=0,endsAt=0,lastSay=-99,audioCtx=null;
function id(x){return document.getElementById(x)}
function req(method,path,cb,eb){var x=new XMLHttpRequest();x.onreadystatechange=function(){if(x.readyState===4){if(x.status>=200&&x.status<300){var d={};try{d=JSON.parse(x.responseText||'{}')}catch(e){}cb&&cb(d)}else{eb&&eb(x.responseText||('HTTP '+x.status))}}};x.open(method,path,true);x.setRequestHeader('Cache-Control','no-store');x.send('')}
function toast(t,bad){var e=id('toast');e.innerHTML=t;e.style.borderColor=bad?'#ff4a3d':'#36f0a0';e.style.display='block';setTimeout(function(){e.style.display='none'},3200)}
function allChecked(){var c=document.getElementsByClassName('chk');for(var i=0;i<c.length;i++){if(!c[i].checked)return false}return true}
function codeOk(){return /^[0-9]{6}$/.test(id('code').value)}
function secs(){var n=parseInt(id('secs').value,10);if(isNaN(n))n=10;if(n<5)n=5;if(n>60)n=60;return n}
function render(){var s=statusData,a=!!s.armed,l=!!s.locked,f=!!s.trigger_active,c=!!s.countdown_active;id('state').innerHTML=l?'LOCKED':f?'FIRING':a?'ARMED':'SAFE';id('state').className='state '+(l?'bad':(a||f?'warn':'ok'));id('armed').innerHTML=a?'Yes':'No';id('cdstat').innerHTML=c?'Active':'Idle';id('clients').innerHTML=s.clients==null?'-':s.clients;id('attempts').innerHTML=l?'Locked':(s.attempts_left==null?'-':s.attempts_left);id('arm').disabled=l||a||!allChecked()||!codeOk();id('disarm').disabled=!a;id('launch').disabled=!a||l||!!countTimer;id('abort').disabled=!a&&!countTimer}
function load(){req('GET','/api/status',function(d){statusData=d;render()},function(){id('state').innerHTML='LINK LOST';id('state').className='state bad'})}
function beep(freq,dur){try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.frequency.value=freq;o.connect(g);g.connect(audioCtx.destination);g.gain.value=.04;o.start();g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+dur);o.stop(audioCtx.currentTime+dur)}catch(e){}}
function say(n){var t=n<=0?'Ignition':String(n);try{if(window.speechSynthesis&&window.SpeechSynthesisUtterance){speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(t);u.lang='en-US';u.rate=1;speechSynthesis.speak(u);return}}catch(e){}beep(n<=0?440:880,n<=0?.35:.1)}
function tick(){var ms=endsAt-(new Date()).getTime(),left=Math.max(0,Math.ceil(ms/1000));id('num').innerHTML=left>0?left:'GO';id('sub').innerHTML=left>0?'T-minus '+left:'Ignition';if(left<=10&&left!==lastSay){lastSay=left;say(left)}if(left<=0){clearInterval(countTimer);countTimer=0;clearInterval(beatTimer);beatTimer=0;req('POST','/api/trigger',function(){toast('Trigger command sent',false);id('overlay').style.display='none';load()},function(e){toast('Trigger failed: '+e,true);id('overlay').style.display='none';load()})}}
function heartbeat(){var left=Math.max(0,Math.ceil((endsAt-(new Date()).getTime())/1000));req('POST','/api/countdown/heartbeat?left='+left,function(){},function(){abortLocal('Live link lost',true)})}
function abortLocal(msg,bad){clearInterval(countTimer);countTimer=0;clearInterval(beatTimer);beatTimer=0;id('overlay').style.display='none';req('POST','/api/countdown/abort',function(){},function(){});toast(msg||'Aborted',bad);load()}
id('arm').onclick=function(){req('POST','/api/arm?code='+encodeURIComponent(id('code').value),function(d){id('code').value='';statusData=d;toast('System armed',false);load()},function(e){toast('Arm failed: '+e,true);load()})};
id('disarm').onclick=function(){req('POST','/api/disarm',function(){toast('Disarmed',false);load()},function(e){toast('Disarm failed: '+e,true)})};
id('launch').onclick=function(){var n=secs();req('POST','/api/countdown/start',function(){endsAt=(new Date()).getTime()+n*1000;lastSay=-99;id('overlay').style.display='block';clearInterval(countTimer);countTimer=setInterval(tick,120);clearInterval(beatTimer);beatTimer=setInterval(heartbeat,700);tick();heartbeat()},function(e){toast('Countdown rejected: '+e,true);load()})};
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
  if (left >= 1 && left <= 10 && left != lastCountdownBuzzSecond) {
    lastCountdownBuzzSecond = left;
    buzz(BUZZ_MS);
  }
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
  lastCountdownBuzzSecond = -1;
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
      lastCountdownBuzzSecond = -1;
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
      lastCountdownBuzzSecond = -1;
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
      lastCountdownBuzzSecond = -1;
      buzz(COUNTDOWN_START_BUZZ_MS);
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
      if (!countdownFresh()) { bleSafeAbort("heartbeat_lost", LINK_LOST_BUZZ_MS); publishBleStatus(); return; }
      digitalWrite(TRIGGER_PIN, HIGH);
      buzz(TRIGGER_BUZZ_MS);
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
  server.send(200, "text/html", HTML_PAGE_SAFE);
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
  lastCountdownBuzzSecond = -1;
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
  lastCountdownBuzzSecond = -1;
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
  lastCountdownBuzzSecond = -1;
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
  if (server.hasArg("left")) noteCountdownSecond(server.arg("left").toInt());
  sendJSON(200, "{\"ok\":true}");
}

void handleCountdownAbort() {
  countdownActive = false;
  lastCountdownBuzzSecond = -1;
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
    lastCountdownBuzzSecond = -1;
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
  lastCountdownBuzzSecond = -1;
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
    lastCountdownBuzzSecond = -1;
    activeBleSid = "";
    lastBleError = "heartbeat_lost";
    buzz(LINK_LOST_BUZZ_MS);
    Serial.println("[COUNTDOWN] Heartbeat lost, countdown aborted and system disarmed");
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
