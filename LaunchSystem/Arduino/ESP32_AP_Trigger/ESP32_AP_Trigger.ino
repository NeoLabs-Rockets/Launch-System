/* NeoLabs Rockets launch controller — BLE only. */
#include <NimBLEDevice.h>
#include <Adafruit_NeoPixel.h>

#define RELAY_PIN 23
#define CONTINUITY_PIN 34
#define CONTINUITY_ACTIVE_LEVEL LOW
#define STATUS_LED_PIN 26
#define ARM_PIN -1
#define BUZZER_PIN 33
#define TEMPERATURE_PIN 35
#define LAUNCH_CODE "123456"  // must match MissionDashboard LAUNCH_CODE
#define MAX_ATTEMPTS 10
#define TRIGGER_MS 2000UL
#define COUNTDOWN_TIMEOUT_MS 3000UL
#define CONTINUITY_DEBOUNCE_MS 60UL
#define TEMPERATURE_SAMPLE_INTERVAL_MS 1000UL
#define NTC_SAMPLE_COUNT 16
#define NTC_SUPPLY_MV 3300.0f
#define NTC_FIXED_RESISTOR_OHMS 10000.0f
#define NTC_NOMINAL_RESISTANCE_OHMS 10000.0f
#define NTC_NOMINAL_TEMPERATURE_K 298.15f
#define NTC_BETA 3950.0f
#define MAX_SAFE_TEMPERATURE_C 40.0f
#define BUZZER_MIN_FREQUENCY_HZ 1800U
#define BUZZER_MAX_FREQUENCY_HZ 4200U
#define BUZZER_FREQUENCY_STEP_HZ 120U
#define BUZZER_STEP_INTERVAL_MS 25UL
#define BUZZER_DISARM_MS 700UL
#define BUZZER_ARM_MS 900UL
#define BUZZER_TRIGGER_MS 1600UL

static NimBLEUUID SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
static const char BLE_NAME[] = "NeoLabs Launch Controller";
static const char FIRMWARE_VERSION[] = "3.0.0";

NimBLECharacteristic* statusChar = nullptr;
Adafruit_NeoPixel statusPixel(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
bool armed = false, firing = false, countdown = false, locked = false;
bool continuity = false, continuityRaw = false, continuityOverride = false;
float temperatureC = NAN;
unsigned long triggerStarted = 0, lastHeartbeat = 0, lastNotify = 0, continuityChangedAt = 0;
unsigned long lastTemperatureSampleAt = 0;
unsigned long buzzerStopsAt = 0, nextBuzzerStepAt = 0;
uint16_t buzzerFrequencyHz = BUZZER_MIN_FREQUENCY_HZ;
int16_t buzzerFrequencyStepHz = BUZZER_FREQUENCY_STEP_HZ;
uint32_t currentStatusPixelColor = UINT32_MAX;
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

void startBuzzer(unsigned long durationMs) {
  const unsigned long now = millis();
  buzzerFrequencyHz = BUZZER_MIN_FREQUENCY_HZ;
  buzzerFrequencyStepHz = BUZZER_FREQUENCY_STEP_HZ;
  tone(BUZZER_PIN, buzzerFrequencyHz);
  nextBuzzerStepAt = now + BUZZER_STEP_INTERVAL_MS;
  buzzerStopsAt = now + durationMs;
}

float readNtcTemperatureC() {
  uint32_t millivoltSum = 0;
  for (uint8_t i = 0; i < NTC_SAMPLE_COUNT; i++) millivoltSum += analogReadMilliVolts(TEMPERATURE_PIN);
  const float millivolts = millivoltSum / (float)NTC_SAMPLE_COUNT;
  if (millivolts <= 5.0f || millivolts >= NTC_SUPPLY_MV - 5.0f) return NAN;
  const float resistance = NTC_FIXED_RESISTOR_OHMS * millivolts / (NTC_SUPPLY_MV - millivolts);
  const float inverseKelvin = (1.0f / NTC_NOMINAL_TEMPERATURE_K)
    + logf(resistance / NTC_NOMINAL_RESISTANCE_OHMS) / NTC_BETA;
  const float sample = 1.0f / inverseKelvin - 273.15f;
  return sample < -55.0f || sample > 125.0f ? NAN : sample;
}

bool temperatureInterlockActive() {
  return !isnan(temperatureC) && temperatureC >= MAX_SAFE_TEMPERATURE_C;
}

void setStatusPixel(uint8_t red, uint8_t green, uint8_t blue) {
  const uint32_t color = statusPixel.Color(red, green, blue);
  if (color == currentStatusPixelColor) return;
  currentStatusPixelColor = color;
  statusPixel.setPixelColor(0, color);
  statusPixel.show();
}

void safeStop(const char* reason) {
  armed = false;
  countdown = false;
  firing = false;
  continuityOverride = false;
  ownerSid = "";
  lastError = reason;
  digitalWrite(RELAY_PIN, LOW);
  noTone(BUZZER_PIN);
  buzzerStopsAt = 0;
  nextBuzzerStepAt = 0;
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
    if (cmd == "abort" || cmd == "disarm") { safeStop(""); startBuzzer(BUZZER_DISARM_MS); publishStatus(); return; }
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
      if (temperatureInterlockActive()) { lastError = "over_temperature"; publishStatus(); return; }
      if (!continuity && !continuityOverride) { lastError = "no_continuity"; publishStatus(); return; }
      attempts = 0;
      ownerSid = sid;
      armed = true;
      countdown = false;
      startBuzzer(BUZZER_ARM_MS);
      publishStatus();
      return;
    }

    if (!ownerSid.length() || sid != ownerSid) { lastError = "not_owner"; publishStatus(); return; }
    if (cmd == "countdown_start") {
      if (temperatureInterlockActive()) safeStop("over_temperature");
      else if (!continuity && !continuityOverride) safeStop("continuity_lost");
      else if (!armed || firing) lastError = armed ? "trigger_active" : "not_armed";
      else { countdown = true; lastHeartbeat = millis(); }
    } else if (cmd == "heartbeat") {
      if (countdown) lastHeartbeat = millis();
    } else if (cmd == "trigger") {
      if (!armed) lastError = "not_armed";
      else if (temperatureInterlockActive()) safeStop("over_temperature");
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
        startBuzzer(BUZZER_TRIGGER_MS);
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
  statusPixel.begin();
  statusPixel.clear();
  statusPixel.show();
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  analogReadResolution(12);
  analogSetPinAttenuation(TEMPERATURE_PIN, ADC_11db);
  temperatureC = readNtcTemperatureC();
  lastTemperatureSampleAt = millis();

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
  if (now - lastTemperatureSampleAt >= TEMPERATURE_SAMPLE_INTERVAL_MS) {
    lastTemperatureSampleAt = now;
    temperatureC = readNtcTemperatureC();
    if (temperatureInterlockActive() && (armed || countdown || firing)) {
      safeStop("over_temperature");
      startBuzzer(BUZZER_TRIGGER_MS);
    } else if (!temperatureInterlockActive() && lastError == "over_temperature") lastError = "";
    publishStatus();
  }
  const bool sampledContinuity = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
  if (sampledContinuity != continuityRaw) {
    continuityRaw = sampledContinuity;
    continuityChangedAt = now;
  } else if (continuity != continuityRaw && now - continuityChangedAt >= CONTINUITY_DEBOUNCE_MS) {
    continuity = continuityRaw;
    if (continuity) continuityOverride = false;
    if (!continuity && !continuityOverride && (armed || countdown || firing)) {
      safeStop("continuity_lost");
      startBuzzer(BUZZER_DISARM_MS);
    }
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
  if (buzzerStopsAt) {
    if ((long)(now - buzzerStopsAt) >= 0) {
      noTone(BUZZER_PIN);
      buzzerStopsAt = 0;
      nextBuzzerStepAt = 0;
    } else if ((long)(now - nextBuzzerStepAt) >= 0) {
      int32_t nextFrequency = (int32_t)buzzerFrequencyHz + buzzerFrequencyStepHz;
      if (nextFrequency >= BUZZER_MAX_FREQUENCY_HZ || nextFrequency <= BUZZER_MIN_FREQUENCY_HZ) {
        buzzerFrequencyStepHz = -buzzerFrequencyStepHz;
        nextFrequency = constrain(nextFrequency, BUZZER_MIN_FREQUENCY_HZ, BUZZER_MAX_FREQUENCY_HZ);
      }
      buzzerFrequencyHz = (uint16_t)nextFrequency;
      tone(BUZZER_PIN, buzzerFrequencyHz);
      nextBuzzerStepAt = now + BUZZER_STEP_INTERVAL_MS;
    }
  }
  // NeoPixel status: red = firing/fault, amber = armed/countdown/bypass,
  // blue heartbeat = waiting for BLE, green = connected and ready.
  uint8_t red = 0, green = 0, blue = 0;
  if (firing) red = 140;
  else if (temperatureInterlockActive()) { red = 110; blue = 12; }
  else if (countdown && (now / 100) % 2) { red = 120; green = 28; }
  else if (armed) { red = 90; green = 18; }
  else if (continuityOverride) { red = 55; green = 28; }
  else if (!continuity) {
    const unsigned long phase = now % 1200;
    if (phase < 90 || (phase >= 180 && phase < 270)) red = 100;
  } else if (connectedCount == 0) {
    if (now % 2000 < 80) blue = 80;
  } else green = 32;
  setStatusPixel(red, green, blue);
  if (now - lastNotify >= 1000) publishStatus();
  delay(5);
}
