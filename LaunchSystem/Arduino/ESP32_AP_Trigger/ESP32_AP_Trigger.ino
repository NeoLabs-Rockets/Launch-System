/* NeoLabs Rockets launch controller — BLE only. */
#include <NimBLEDevice.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#define RELAY_PIN 23
#define CONTINUITY_PIN 34
#define CONTINUITY_ACTIVE_LEVEL LOW
#define RED_LED_PIN 26
#define ARM_PIN -1
#define BUZZER_PIN 33
#define TEMPERATURE_PIN 18
#define LAUNCH_CODE "123456"  // must match MissionDashboard LAUNCH_CODE
#define MAX_ATTEMPTS 10
#define TRIGGER_MS 2000UL
#define COUNTDOWN_TIMEOUT_MS 3000UL
#define CONTINUITY_DEBOUNCE_MS 60UL
#define TEMPERATURE_SAMPLE_INTERVAL_MS 1000UL
#define TEMPERATURE_CONVERSION_MS 750UL

static NimBLEUUID SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
static const char BLE_NAME[] = "NeoLabs Launch Controller";
static const char FIRMWARE_VERSION[] = "2.8.1";

NimBLECharacteristic* statusChar = nullptr;
OneWire temperatureBus(TEMPERATURE_PIN);
DallasTemperature temperatureSensors(&temperatureBus);
bool armed = false, firing = false, countdown = false, locked = false;
bool continuity = false, continuityRaw = false, continuityOverride = false;
bool temperatureConversionPending = false;
float temperatureC = NAN;
unsigned long triggerStarted = 0, lastHeartbeat = 0, lastNotify = 0, continuityChangedAt = 0;
unsigned long temperatureConversionStartedAt = 0, lastTemperatureRequestAt = 0;
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

void buzzerPulse(unsigned long ms = 100) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
}

void safeStop(const char* reason) {
  armed = false;
  countdown = false;
  firing = false;
  continuityOverride = false;
  ownerSid = "";
  lastError = reason;
  digitalWrite(RELAY_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);
}

void publishStatus() {
  if (!statusChar) return;
  char data[220];
  char temperatureValue[16];
  if (isnan(temperatureC)) strcpy(temperatureValue, "null");
  else snprintf(temperatureValue, sizeof(temperatureValue), "%.2f", temperatureC);
  snprintf(data, sizeof(data),
    "{\"a\":%d,\"f\":%d,\"c\":%d,\"l\":%d,\"q\":%d,\"b\":%d,\"t\":%s,\"left\":%d,\"n\":%d,\"u\":%lu,\"e\":\"%s\",\"v\":\"%s\"}",
    armed, firing, countdown, locked, continuity, continuityOverride, temperatureValue,
    locked ? 0 : MAX_ATTEMPTS - attempts, connectedCount, millis(), lastError.c_str(), FIRMWARE_VERSION);
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
    if (armed || countdown || continuityOverride) safeStop("owner_lost");
    else ownerSid = "";
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
    if (cmd == "abort" || cmd == "disarm") { safeStop(""); buzzerPulse(80); publishStatus(); return; }
    if (cmd == "auth") {
      lastError = jsonString(body, "code") == LAUNCH_CODE ? "auth_ok" : "auth_failed";
      publishStatus();
      return;
    }
    if (locked) { lastError = "locked"; publishStatus(); return; }

    if (cmd == "continuity_override") {
      if (firing || countdown) { lastError = "trigger_active"; publishStatus(); return; }
      if (ownerSid.length() && ownerSid != sid) { lastError = "not_owner"; publishStatus(); return; }
      const bool enabled = jsonInt(body, "enabled", 0) == 1;
      if (enabled) {
        continuityOverride = true;
        ownerSid = sid;
      } else if (armed && !continuity) {
        safeStop("continuity_lost");
      } else {
        continuityOverride = false;
        if (!armed) ownerSid = "";
      }
      publishStatus();
      return;
    }

    if (cmd == "arm") {
      if (ownerSid.length() && ownerSid != sid) { lastError = "not_owner"; publishStatus(); return; }
      if (!continuity && !continuityOverride) { lastError = "no_continuity"; publishStatus(); return; }
      attempts = 0;
      ownerSid = sid;
      armed = true;
      countdown = false;
      buzzerPulse(100);
      publishStatus();
      return;
    }

    if (!ownerSid.length() || sid != ownerSid) { lastError = "not_owner"; publishStatus(); return; }
    if (cmd == "countdown_start") {
      if (!continuity && !continuityOverride) safeStop("continuity_lost");
      else if (!armed || firing) lastError = armed ? "trigger_active" : "not_armed";
      else { countdown = true; lastHeartbeat = millis(); }
    } else if (cmd == "heartbeat") {
      if (countdown) lastHeartbeat = millis();
    } else if (cmd == "trigger") {
      if (!armed) lastError = "not_armed";
      else if (!continuity && !continuityOverride) safeStop("continuity_lost");
      else if (!countdown || millis() - lastHeartbeat > COUNTDOWN_TIMEOUT_MS) safeStop("heartbeat_lost");
      else {
        digitalWrite(RELAY_PIN, HIGH);
        firing = true;
        triggerStarted = millis();
        armed = false;
        countdown = false;
        continuityOverride = false;
        ownerSid = "";
        buzzerPulse(120);
      }
    } else lastError = "unknown_cmd";
    publishStatus();
  }
};

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  pinMode(CONTINUITY_PIN, INPUT); // External continuity network provides the logic level.
  continuityRaw = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
  continuity = continuityRaw;
  pinMode(RED_LED_PIN, OUTPUT);
  digitalWrite(RED_LED_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  temperatureSensors.begin();
  temperatureSensors.setWaitForConversion(false);
  temperatureSensors.requestTemperatures();
  temperatureConversionPending = true;
  temperatureConversionStartedAt = millis();
  lastTemperatureRequestAt = temperatureConversionStartedAt;

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
  if (temperatureConversionPending && now - temperatureConversionStartedAt >= TEMPERATURE_CONVERSION_MS) {
    const float sample = temperatureSensors.getTempCByIndex(0);
    temperatureC = sample == DEVICE_DISCONNECTED_C || sample < -55.0f || sample > 125.0f ? NAN : sample;
    temperatureConversionPending = false;
    publishStatus();
  } else if (!temperatureConversionPending && now - lastTemperatureRequestAt >= TEMPERATURE_SAMPLE_INTERVAL_MS) {
    temperatureSensors.requestTemperatures();
    temperatureConversionPending = true;
    temperatureConversionStartedAt = now;
    lastTemperatureRequestAt = now;
  }
  const bool sampledContinuity = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
  if (sampledContinuity != continuityRaw) {
    continuityRaw = sampledContinuity;
    continuityChangedAt = now;
  } else if (continuity != continuityRaw && now - continuityChangedAt >= CONTINUITY_DEBOUNCE_MS) {
    continuity = continuityRaw;
    if (continuity) continuityOverride = false;
    if (!continuity && !continuityOverride && (armed || countdown)) safeStop("continuity_lost");
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
