/* NeoLabs Rockets launch controller — BLE only. */
#include <NimBLEDevice.h>

#define RELAY_PIN 23
#define CONTINUITY_PIN 39
#define CONTINUITY_ACTIVE_LEVEL HIGH  // GPIO39 needs an external pull-down
#define RED_LED_PIN 26
#define ARM_PIN -1
#define VIBRATION_PIN 36
#if defined(CONFIG_IDF_TARGET_ESP32) && VIBRATION_PIN >= 34 && VIBRATION_PIN <= 39
  // GPIO34-39 are input-only on the original ESP32. Keep the requested pin in
  // one place, but never pretend that GPIO36 can drive the motor on this board.
  #define VIBRATION_OUTPUT_AVAILABLE 0
#else
  #define VIBRATION_OUTPUT_AVAILABLE 1
#endif
#define LAUNCH_CODE "123456"  // must match MissionDashboard LAUNCH_CODE
#define MAX_ATTEMPTS 10
#define TRIGGER_MS 2000UL
#define COUNTDOWN_TIMEOUT_MS 3000UL
#define CONTINUITY_DEBOUNCE_MS 60UL

static NimBLEUUID SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
static const char BLE_NAME[] = "NeoLabs Launch Controller";
static const char FIRMWARE_VERSION[] = "2.3.0";

NimBLECharacteristic* statusChar = nullptr;
bool armed = false, firing = false, countdown = false, locked = false;
bool continuity = false, continuityRaw = false;
unsigned long triggerStarted = 0, lastHeartbeat = 0, lastNotify = 0, continuityChangedAt = 0;
int attempts = 0, connectedCount = 0;
String ownerSid, lastError;

String jsonString(const String& src, const char* key) {
  String pattern = String("\"") + key + "\":\"";
  int start = src.indexOf(pattern);
  if (start < 0) return "";
  start += pattern.length();
  int end = src.indexOf('"', start);
  return end < 0 ? "" : src.substring(start, end);
}

int jsonInt(const String& src, const char* key, int fallback) {
  String pattern = String("\"") + key + "\":";
  int start = src.indexOf(pattern);
  if (start < 0) return fallback;
  start += pattern.length();
  while (start < (int)src.length() && src[start] == ' ') start++;
  int end = start;
  while (end < (int)src.length() && isDigit(src[end])) end++;
  return end == start ? fallback : src.substring(start, end).toInt();
}

void motorPulse(unsigned long ms = 100) {
#if VIBRATION_OUTPUT_AVAILABLE
  digitalWrite(VIBRATION_PIN, HIGH);
  delay(ms);
  digitalWrite(VIBRATION_PIN, LOW);
#else
  (void)ms;
#endif
}

void safeStop(const char* reason) {
  armed = false;
  countdown = false;
  firing = false;
  ownerSid = "";
  lastError = reason;
  digitalWrite(RELAY_PIN, LOW);
}

void publishStatus() {
  if (!statusChar) return;
  char data[190];
  snprintf(data, sizeof(data),
    "{\"a\":%d,\"f\":%d,\"c\":%d,\"l\":%d,\"q\":%d,\"left\":%d,\"n\":%d,\"u\":%lu,\"e\":\"%s\",\"v\":\"%s\"}",
    armed, firing, countdown, locked, continuity, locked ? 0 : MAX_ATTEMPTS - attempts,
    connectedCount, millis(), lastError.c_str(), FIRMWARE_VERSION);
  statusChar->setValue((uint8_t*)data, strlen(data));
  statusChar->notify();
  lastNotify = millis();
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    connectedCount++;
    publishStatus();
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    if (connectedCount > 0) connectedCount--;
    if (armed || countdown) safeStop("owner_lost");
    NimBLEDevice::getAdvertising()->start();
    publishStatus();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo&) override {
    String body = characteristic->getValue().c_str();
    String cmd = jsonString(body, "cmd"), sid = jsonString(body, "sid");
    lastError = "";

    if (cmd == "status") {
      publishStatus();
      return;
    }
    if (cmd == "abort" || cmd == "disarm") { safeStop(""); motorPulse(80); publishStatus(); return; }
    if (cmd == "auth") {
      lastError = jsonString(body, "code") == LAUNCH_CODE ? "auth_ok" : "auth_failed";
      publishStatus();
      return;
    }
    if (locked) { lastError = "locked"; publishStatus(); return; }

    if (cmd == "arm") {
      if (ownerSid.length() && ownerSid != sid) { lastError = "not_owner"; publishStatus(); return; }
      if (!continuity) { lastError = "no_continuity"; publishStatus(); return; }
      attempts = 0;
      ownerSid = sid;
      armed = true;
      countdown = false;
      motorPulse(100);
      publishStatus();
      return;
    }

    if (!ownerSid.length() || sid != ownerSid) { lastError = "not_owner"; publishStatus(); return; }
    if (cmd == "countdown_start") {
      if (!continuity) safeStop("continuity_lost");
      else if (!armed || firing) lastError = armed ? "trigger_active" : "not_armed";
      else { countdown = true; lastHeartbeat = millis(); }
    } else if (cmd == "heartbeat") {
      if (countdown) lastHeartbeat = millis();
    } else if (cmd == "trigger") {
      if (!armed) lastError = "not_armed";
      else if (!continuity) safeStop("continuity_lost");
      else if (!countdown || millis() - lastHeartbeat > COUNTDOWN_TIMEOUT_MS) safeStop("heartbeat_lost");
      else {
        digitalWrite(RELAY_PIN, HIGH);
        firing = true;
        triggerStarted = millis();
        armed = false;
        countdown = false;
        ownerSid = "";
        motorPulse(120);
      }
    } else lastError = "unknown_cmd";
    publishStatus();
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  pinMode(CONTINUITY_PIN, INPUT); // GPIO39 has no internal pull-up/down
  continuityRaw = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
  continuity = continuityRaw;
  pinMode(RED_LED_PIN, OUTPUT);
  digitalWrite(RED_LED_PIN, LOW);
#if VIBRATION_OUTPUT_AVAILABLE
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(VIBRATION_PIN, LOW);
#else
  Serial.println("[WARN] GPIO36 is input-only on ESP32; vibration output disabled");
#endif

  NimBLEDevice::init(BLE_NAME);
  NimBLEDevice::setMTU(185);
  NimBLEDevice::setPower(9);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* service = server->createService(SERVICE_UUID);
  NimBLECharacteristic* command = service->createCharacteristic(COMMAND_UUID, NIMBLE_PROPERTY::WRITE);
  command->setCallbacks(new CommandCallbacks());
  statusChar = service->createCharacteristic(STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  service->start();
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->enableScanResponse(true);
  advertising->setName(BLE_NAME);
  advertising->start();
  publishStatus();
  Serial.println("[OK] BLE-only launch controller ready");
}

void loop() {
  const unsigned long now = millis();
  const bool sampledContinuity = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
  if (sampledContinuity != continuityRaw) {
    continuityRaw = sampledContinuity;
    continuityChangedAt = now;
  } else if (continuity != continuityRaw && now - continuityChangedAt >= CONTINUITY_DEBOUNCE_MS) {
    continuity = continuityRaw;
    if (!continuity && (armed || countdown)) safeStop("continuity_lost");
    else if (continuity && (lastError == "no_continuity" || lastError == "continuity_lost")) lastError = "";
    publishStatus();
  }
  if (firing && now - triggerStarted >= TRIGGER_MS) {
    digitalWrite(RELAY_PIN, LOW);
    firing = false;
    publishStatus();
  }
  if (countdown && now - lastHeartbeat > COUNTDOWN_TIMEOUT_MS) {
    safeStop("heartbeat_lost");
    publishStatus();
  }
  // Red LED: solid = relay firing, 5 Hz = countdown, solid = armed,
  // double flash = no continuity, short heartbeat = no BLE client.
  bool ledOn = false;
  if (firing) ledOn = true;
  else if (countdown) ledOn = (now / 100) % 2;
  else if (armed) ledOn = true;
  else if (!continuity) {
    const unsigned long phase = now % 1200;
    ledOn = phase < 90 || (phase >= 180 && phase < 270);
  } else if (connectedCount == 0) ledOn = now % 2000 < 80;
  digitalWrite(RED_LED_PIN, ledOn ? HIGH : LOW);
  if (now - lastNotify >= 1000) publishStatus();
  delay(5);
}
