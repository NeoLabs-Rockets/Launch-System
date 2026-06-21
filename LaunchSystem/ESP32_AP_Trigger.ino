/*
  NeoLabs Rockets — Mission Control
  ─────────────────────────────────────────────────────────────────────────────
  ESP32 NodeMCU DevKit (USB-C) as WiFi Access Point with a modern web UI
  and REST API for armed-and-trigger launch control.

  Features:
    · WiFi Access Point (SSID / password configurable below)
    · NeoLabs-branded mission-control UI served from flash
    · ARM/DISARM button — trigger is gated behind arm state
    · 10-second browser countdown with TTS (Web Speech API, English)
      → "Ignition" spoken at 0; pin goes HIGH 500 ms after
    · Auto-disarm after every trigger
    · Non-blocking 800 ms HIGH pulse on TRIGGER_PIN
    · Optional status LED (5 Hz blink while firing, solid while armed)
    · Optional physical ARM toggle button

  REST API:
    GET  /api/status   → { armed, trigger_active, uptime_ms, clients }
    POST /api/arm      → { ok, armed }
    POST /api/disarm   → { ok, armed }
    POST /api/trigger  → { ok } | { ok, error }

  ─────────────────────────────────────────────────────────────────────────────
  PIN ASSIGNMENTS — change only here
*/
#define TRIGGER_PIN   26    // Output: 800 ms HIGH pulse on fire
#define STATUS_LED     2    // Status LED  (-1 = disabled)  GPIO 2 = onboard
#define ARM_PIN       25    // Physical ARM toggle (-1 = disabled)
                            // Wiring: button between ARM_PIN and GND (INPUT_PULLUP)

// Network
#define AP_SSID   "NeoLabs-Rockets"
#define AP_PASS   "launch1234"           // min. 8 characters (WPA2)

// Timing
#define TRIGGER_MS   800UL   // relay pulse duration in milliseconds
#define DEBOUNCE_MS   50UL   // physical button debounce
// ─────────────────────────────────────────────────────────────────────────────

#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

bool          armed         = false;
bool          triggerActive = false;
unsigned long triggerStart  = 0;

int           lastBtnRead   = HIGH;
unsigned long lastDebounce  = 0;

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
let cdTimer=null,aborted=false;

async function fetchStatus(){
  try{const r=await fetch('/api/status');if(r.ok)applyStatus(await r.json());}catch(_){}
}

function applyStatus(d){
  const armed=!!d.armed,active=!!d.trigger_active;
  const ind=document.getElementById('ind'),stxt=document.getElementById('stxt');

  if(active){setInd(ind,'var(--amber)','0 0 10px var(--amber)');stxt.textContent='TRIGGER ACTIVE — Relay firing…';}
  else if(armed){setInd(ind,'var(--red)','0 0 10px var(--red)');stxt.textContent='SYSTEM ARMED — Ready for launch sequence';}
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
    bArm.className='btn btn-arm is-armed';
    document.getElementById('arm-ico').textContent='🔓';
    document.getElementById('arm-lbl').textContent='DISARM';
    bTrig.disabled=false;bTrig.className='btn btn-trig is-armed';
  }else{
    bArm.className='btn btn-arm';
    document.getElementById('arm-ico').textContent='🔒';
    document.getElementById('arm-lbl').textContent='ARM SYSTEM';
    bTrig.disabled=true;bTrig.className='btn btn-trig';
  }
}

function setInd(el,c,s){el.style.background=c;el.style.boxShadow=s;}
function pad(n){return String(n).padStart(2,'0');}

async function toggleArm(){
  const isArmed=document.getElementById('b-arm').classList.contains('is-armed');
  try{const r=await fetch(isArmed?'/api/disarm':'/api/arm',{method:'POST'});applyStatus(await r.json());}
  catch(_){showToast('Connection error',true);}
}

function startSequence(){
  if(document.getElementById('b-trig').disabled)return;
  aborted=false;
  arc.style.transition='none';
  arc.setAttribute('stroke-dashoffset',0);
  void arc.getBoundingClientRect();
  arc.style.transition='stroke-dashoffset 10s linear';
  arc.setAttribute('stroke-dashoffset',CIRCUM);
  document.getElementById('overlay').classList.add('show');
  runCd(10);
}

function runCd(n){
  if(aborted)return;
  const numEl=document.getElementById('cd-n'),subEl=document.getElementById('cd-sub');
  numEl.textContent=n;
  numEl.style.color=n>6?'#fff':n>3?'var(--amber)':n>0?'#ff8040':'var(--red)';
  numEl.style.fontSize=n<=1?'7em':'5.6em';
  numEl.style.animation=n===0?'ignite .5s ease':'';
  subEl.textContent=n>0?'T-MINUS '+n+' SECOND'+(n===1?'':'S'):'▼  IGNITION  ▼';

  const u=new SpeechSynthesisUtterance(n===0?'Ignition':String(n));
  u.lang='en-US';u.rate=1.05;u.pitch=n<=3?1.4:1.0;
  speechSynthesis.speak(u);

  if(n===0){cdTimer=setTimeout(()=>{if(!aborted)fireTrigger();},500);return;}
  cdTimer=setTimeout(()=>runCd(n-1),1000);
}

function abortSeq(){
  aborted=true;clearTimeout(cdTimer);speechSynthesis.cancel();
  arc.style.transition='none';arc.setAttribute('stroke-dashoffset',0);
  document.getElementById('overlay').classList.remove('show');
  showToast('Launch sequence aborted');
}

async function fireTrigger(){
  const fl=document.createElement('div');
  Object.assign(fl.style,{position:'fixed',inset:'0',background:'rgba(255,110,40,.22)',zIndex:'999',pointerEvents:'none',transition:'opacity .45s'});
  document.body.appendChild(fl);
  setTimeout(()=>{fl.style.opacity='0';setTimeout(()=>fl.remove(),450);},60);

  try{
    const r=await fetch('/api/trigger',{method:'POST'});
    const d=await r.json();
    document.getElementById('overlay').classList.remove('show');
    speechSynthesis.cancel();
    d.ok?showToast('Trigger fired — 800 ms pulse sent'):showToast('Rejected: '+(d.error||'unknown'),true);
    await fetchStatus();
  }catch(_){
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

// ─── Route handlers ──────────────────────────────────────────────────────────
void handleRoot() {
  setCORSHeaders();
  server.send(200, "text/html", HTML_PAGE);
}

void handleStatus() {
  char buf[128];
  snprintf(buf, sizeof(buf),
    "{\"armed\":%s,\"trigger_active\":%s,\"uptime_ms\":%lu,\"clients\":%d}",
    armed         ? "true" : "false",
    triggerActive ? "true" : "false",
    millis(),
    (int)WiFi.softAPgetStationNum()
  );
  sendJSON(200, buf);
}

void handleArm()    { armed = true;  sendJSON(200, "{\"ok\":true,\"armed\":true}"); }
void handleDisarm() { armed = false; sendJSON(200, "{\"ok\":true,\"armed\":false}"); }

void handleTrigger() {
  if (!armed)        { sendJSON(403, "{\"ok\":false,\"error\":\"not armed\"}");         return; }
  if (triggerActive) { sendJSON(409, "{\"ok\":false,\"error\":\"trigger already active\"}"); return; }
  digitalWrite(TRIGGER_PIN, HIGH);
  triggerActive = true;
  triggerStart  = millis();
  armed         = false;
  Serial.println("[TRIGGER] Pulse started");
  sendJSON(200, "{\"ok\":true}");
}

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) { setCORSHeaders(); server.send(204); return; }
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
      if (stable == LOW) { armed = !armed; Serial.printf("[ARM_BTN] %s\n", armed ? "ARMED" : "DISARMED"); }
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
  if (ARM_PIN    >= 0)   pinMode(ARM_PIN, INPUT_PULLUP);

  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(AP_SSID, AP_PASS)) {
    Serial.println("[ERROR] AP startup failed");
    if (STATUS_LED >= 0) while (true) { digitalWrite(STATUS_LED, !digitalRead(STATUS_LED)); delay(100); }
    while (true) delay(1000);
  }
  Serial.printf("[OK] AP up  SSID: %s  IP: %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  server.on("/",            HTTP_GET,  handleRoot);
  server.on("/api/status",  HTTP_GET,  handleStatus);
  server.on("/api/arm",     HTTP_POST, handleArm);
  server.on("/api/disarm",  HTTP_POST, handleDisarm);
  server.on("/api/trigger", HTTP_POST, handleTrigger);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("[OK] Web server started — open http://192.168.4.1");
}

// ─── Loop ────────────────────────────────────────────────────────────────────
void loop() {
  server.handleClient();
  checkArmButton();

  if (triggerActive && (millis() - triggerStart >= TRIGGER_MS)) {
    digitalWrite(TRIGGER_PIN, LOW);
    triggerActive = false;
    Serial.println("[TRIGGER] Pulse complete");
  }

  if (STATUS_LED >= 0) {
    bool ledOn = triggerActive ? ((millis() / 100) % 2 == 0) : armed;
    digitalWrite(STATUS_LED, ledOn ? HIGH : LOW);
  }
}
