/* NeoLabs Rockets launch controller — BLE only. */
#include <NimBLEDevice.h>
#include <Adafruit_NeoPixel.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

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
#define OTA_IDLE_TIMEOUT_MS 15000UL
#define OTA_REBOOT_DELAY_MS 1200UL
#define OTA_PROGRESS_INTERVAL_BYTES 2560UL

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "3.0.0"
#endif

static NimBLEUUID SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID OTA_CONTROL_UUID("8f3a0004-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID OTA_DATA_UUID   ("8f3a0005-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID OTA_STATUS_UUID ("8f3a0006-7b2f-4f8a-9d0e-0c5b6f0a1000");
static const char BLE_NAME[] = "NeoLabs Launch Controller";
static const char CURRENT_FIRMWARE_VERSION[] = FIRMWARE_VERSION;

NimBLECharacteristic* statusChar = nullptr;
NimBLECharacteristic* otaStatusChar = nullptr;
Adafruit_NeoPixel statusPixel(1, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);
bool armed = false, firing = false, countdown = false, locked = false;
bool continuity = false, continuityRaw = false, continuityOverride = false;
bool temperatureOverride = false;
bool otaActive = false, otaShaInitialized = false;
float temperatureC = NAN;
unsigned long triggerStarted = 0, lastHeartbeat = 0, lastNotify = 0, continuityChangedAt = 0;
unsigned long lastTemperatureSampleAt = 0;
unsigned long buzzerStopsAt = 0, nextBuzzerStepAt = 0;
uint16_t buzzerFrequencyHz = BUZZER_MIN_FREQUENCY_HZ;
int16_t buzzerFrequencyStepHz = BUZZER_FREQUENCY_STEP_HZ;
uint32_t currentStatusPixelColor = UINT32_MAX;
uint32_t otaExpectedSize = 0, otaReceived = 0, otaLastReported = 0;
unsigned long otaLastActivityAt = 0, otaRebootAt = 0;
uint16_t otaConnectionHandle = BLE_HS_CONN_HANDLE_NONE;
int attempts = 0, connectedCount = 0;
String ownerSid, lastError, otaExpectedSha, otaVersion, otaState = "idle", otaError;
mbedtls_sha256_context otaShaContext;

#ifdef CONFIG_APP_ROLLBACK_ENABLE
// Keep a freshly installed image pending until setup has made the launch output
// safe and successfully brought BLE back online. A reset before that point lets
// the ESP32 bootloader restore the previous OTA slot.
bool verifyRollbackLater() { return true; }
#endif

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

bool validSha256(const String& value) {
  if (value.length() != 64) return false;
  for (size_t i = 0; i < value.length(); i++) {
    const char c = value[i];
    if (!isDigit(c) && !(c >= 'a' && c <= 'f') && !(c >= 'A' && c <= 'F')) return false;
  }
  return true;
}

bool validFirmwareVersion(const String& value) {
  if (value.length() == 0 || value.length() > 63 || !isAlphaNumeric(value[0])) return false;
  for (size_t i = 1; i < value.length(); i++) {
    const char c = value[i];
    if (!isAlphaNumeric(c) && c != '.' && c != '_' && c != '+' && c != '-') return false;
  }
  return true;
}

void publishOtaStatus() {
  if (!otaStatusChar) return;
  char data[180];
  snprintf(data, sizeof(data),
    "{\"state\":\"%s\",\"received\":%lu,\"total\":%lu,\"error\":\"%s\",\"version\":\"%s\"}",
    otaState.c_str(), (unsigned long)otaReceived, (unsigned long)otaExpectedSize,
    otaError.c_str(), otaVersion.c_str());
  otaStatusChar->setValue((uint8_t*)data, strlen(data));
  otaStatusChar->notify();
}

void resetOtaState(const char* state, const char* error = "") {
  if (Update.isRunning()) Update.abort();
  if (otaShaInitialized) {
    mbedtls_sha256_free(&otaShaContext);
    otaShaInitialized = false;
  }
  otaActive = false;
  otaExpectedSize = 0;
  otaReceived = 0;
  otaLastReported = 0;
  otaConnectionHandle = BLE_HS_CONN_HANDLE_NONE;
  otaExpectedSha = "";
  otaVersion = "";
  otaState = state;
  otaError = error;
  publishOtaStatus();
}

void failOta(const char* error) {
  resetOtaState("error", error);
  lastError = "ota_failed";
  publishStatus();
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
  return !temperatureOverride && !isnan(temperatureC) && temperatureC >= MAX_SAFE_TEMPERATURE_C;
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
  temperatureOverride = false;
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
    "{\"a\":%d,\"f\":%d,\"c\":%d,\"l\":%d,\"q\":%d,\"b\":%d,\"t\":%s,\"p\":%d,\"left\":%d,\"n\":%d,\"u\":%lu,\"e\":\"%s\",\"v\":\"%s\"}",
    armed, firing, countdown, locked, continuity, continuityOverride, temperatureValue, temperatureOverride,
    locked ? 0 : MAX_ATTEMPTS - attempts, connectedCount, millis(), lastError.c_str(), CURRENT_FIRMWARE_VERSION);
  statusChar->setValue((uint8_t*)data, strlen(data));
  statusChar->notify();
  lastNotify = millis();
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    connectedCount++;
    publishStatus();
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo& connInfo, int) override {
    if (connectedCount > 0) connectedCount--;
    if (otaActive && connInfo.getConnHandle() == otaConnectionHandle) resetOtaState("aborted", "disconnected");
    if (armed || countdown || continuityOverride || temperatureOverride) safeStop("owner_lost");
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
    if (otaActive || otaRebootAt) { lastError = "update_active"; publishStatus(); return; }
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

    if (cmd == "temperature_override") {
      if (firing || countdown) { lastError = "trigger_active"; publishStatus(); return; }
      if (ownerSid.length() && ownerSid != sid) { lastError = "not_owner"; publishStatus(); return; }
      const bool enabled = jsonInt(body, "enabled", 0) == 1;
      if (enabled) {
        temperatureOverride = true;
        ownerSid = sid;
      } else if (armed && !isnan(temperatureC) && temperatureC >= MAX_SAFE_TEMPERATURE_C) {
        safeStop("over_temperature");
      } else {
        temperatureOverride = false;
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

class OtaControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) override {
    String body = characteristic->getValue().c_str();
    const String cmd = jsonString(body, "cmd");

    if (cmd == "status") { publishOtaStatus(); return; }
    if (otaRebootAt) { publishOtaStatus(); return; }
    if (cmd == "abort") {
      if (otaActive && connInfo.getConnHandle() != otaConnectionHandle) {
        otaError = "not_owner";
        publishOtaStatus();
        return;
      }
      resetOtaState("aborted", "cancelled");
      return;
    }
    if (cmd == "begin") {
      if (otaActive || otaRebootAt) { otaError = "already_active"; publishOtaStatus(); return; }
      if (armed || firing || countdown) { otaState = "error"; otaError = "controller_not_idle"; publishOtaStatus(); return; }

      const int requestedSize = jsonInt(body, "size", 0);
      const String requestedSha = jsonString(body, "sha256");
      const String requestedVersion = jsonString(body, "version");
      if (requestedSize <= 0 || !validSha256(requestedSha) || !validFirmwareVersion(requestedVersion)) {
        otaState = "error";
        otaError = "invalid_manifest";
        publishOtaStatus();
        return;
      }

      safeStop("");
      if (!Update.begin((size_t)requestedSize, U_FLASH)) {
        otaState = "error";
        otaError = Update.errorString();
        publishOtaStatus();
        return;
      }
      mbedtls_sha256_init(&otaShaContext);
      if (mbedtls_sha256_starts_ret(&otaShaContext, 0) != 0) {
        Update.abort();
        mbedtls_sha256_free(&otaShaContext);
        otaState = "error";
        otaError = "sha_init_failed";
        publishOtaStatus();
        return;
      }
      otaShaInitialized = true;
      otaActive = true;
      otaExpectedSize = (uint32_t)requestedSize;
      otaReceived = 0;
      otaLastReported = 0;
      otaLastActivityAt = millis();
      otaConnectionHandle = connInfo.getConnHandle();
      otaExpectedSha = requestedSha;
      otaExpectedSha.toLowerCase();
      otaVersion = requestedVersion;
      otaState = "ready";
      otaError = "";
      lastError = "";
      publishOtaStatus();
      publishStatus();
      return;
    }
    if (cmd == "finish") {
      if (!otaActive || connInfo.getConnHandle() != otaConnectionHandle) {
        otaState = "error";
        otaError = otaActive ? "not_owner" : "not_active";
        publishOtaStatus();
        return;
      }
      if (otaReceived != otaExpectedSize) { failOta("incomplete"); return; }

      uint8_t digest[32];
      if (!otaShaInitialized || mbedtls_sha256_finish_ret(&otaShaContext, digest) != 0) {
        failOta("sha_finish_failed");
        return;
      }
      mbedtls_sha256_free(&otaShaContext);
      otaShaInitialized = false;
      char actualSha[65];
      for (uint8_t i = 0; i < sizeof(digest); i++) snprintf(actualSha + i * 2, 3, "%02x", digest[i]);
      actualSha[64] = '\0';
      if (otaExpectedSha != actualSha) { failOta("sha_mismatch"); return; }
      if (!Update.end(false)) { failOta(Update.errorString()); return; }

      otaActive = false;
      otaState = "complete";
      otaError = "";
      publishOtaStatus();
      otaRebootAt = millis() + OTA_REBOOT_DELAY_MS;
      return;
    }
    otaState = "error";
    otaError = "unknown_command";
    publishOtaStatus();
  }
};

class OtaDataCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) override {
    const std::string value = characteristic->getValue();
    if (!otaActive || connInfo.getConnHandle() != otaConnectionHandle || value.size() <= 4) return;
    const uint8_t* bytes = (const uint8_t*)value.data();
    const uint32_t offset = (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8)
      | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
    const size_t payloadSize = value.size() - 4;
    if (offset < otaReceived) { publishOtaStatus(); return; }
    if (offset != otaReceived || otaReceived + payloadSize > otaExpectedSize) { failOta("invalid_offset"); return; }
    if (Update.write((uint8_t*)bytes + 4, payloadSize) != payloadSize) { failOta(Update.errorString()); return; }
    if (mbedtls_sha256_update_ret(&otaShaContext, bytes + 4, payloadSize) != 0) { failOta("sha_update_failed"); return; }
    otaReceived += payloadSize;
    otaLastActivityAt = millis();
    otaState = "receiving";
    if (otaReceived == otaExpectedSize || otaReceived - otaLastReported >= OTA_PROGRESS_INTERVAL_BYTES) {
      otaLastReported = otaReceived;
      publishOtaStatus();
    }
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
  NimBLECharacteristic* otaControl = service->createCharacteristic(OTA_CONTROL_UUID, NIMBLE_PROPERTY::WRITE);
  otaControl->setCallbacks(new OtaControlCallbacks());
  NimBLECharacteristic* otaData = service->createCharacteristic(OTA_DATA_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  otaData->setCallbacks(new OtaDataCallbacks());
  otaStatusChar = service->createCharacteristic(OTA_STATUS_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->enableScanResponse(true);
  advertising->setName(BLE_NAME);
  advertising->start();
  publishStatus();
  publishOtaStatus();
#ifdef CONFIG_APP_ROLLBACK_ENABLE
  const esp_partition_t* runningPartition = esp_ota_get_running_partition();
  esp_ota_img_states_t otaImageState;
  if (esp_ota_get_state_partition(runningPartition, &otaImageState) == ESP_OK
      && otaImageState == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
  }
#endif
  Serial.println("[OK] BLE-only launch controller ready");
}

void loop() {
  const unsigned long now = millis();
  if (otaActive && now - otaLastActivityAt > OTA_IDLE_TIMEOUT_MS) failOta("timeout");
  if (otaRebootAt && (long)(now - otaRebootAt) >= 0) {
    otaRebootAt = 0;
    ESP.restart();
  }
  if (now - lastTemperatureSampleAt >= TEMPERATURE_SAMPLE_INTERVAL_MS) {
    lastTemperatureSampleAt = now;
    temperatureC = readNtcTemperatureC();
    if (temperatureInterlockActive() && (armed || countdown || firing)) {
      safeStop("over_temperature");
      startBuzzer(BUZZER_TRIGGER_MS);
    } else if (!temperatureInterlockActive() && lastError == "over_temperature") lastError = "";
    publishStatus();
  }
  // The energized relay changes the continuity circuit, so GPIO34 is not a
  // valid measurement during the trigger pulse. Preserve the last verified
  // value until the relay closes, then restart the normal debounce window.
  if (!firing) {
    const bool sampledContinuity = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
    if (sampledContinuity != continuityRaw) {
      continuityRaw = sampledContinuity;
      continuityChangedAt = now;
    } else if (continuity != continuityRaw && now - continuityChangedAt >= CONTINUITY_DEBOUNCE_MS) {
      continuity = continuityRaw;
      if (continuity) continuityOverride = false;
      if (!continuity && !continuityOverride && (armed || countdown)) {
        safeStop("continuity_lost");
        startBuzzer(BUZZER_DISARM_MS);
      }
      else if (continuity && (lastError == "no_continuity" || lastError == "continuity_lost")) lastError = "";
      publishStatus();
    }
  }
  if (firing && now - triggerStarted >= TRIGGER_MS) {
    digitalWrite(RELAY_PIN, LOW);
    firing = false;
    continuityRaw = digitalRead(CONTINUITY_PIN) == CONTINUITY_ACTIVE_LEVEL;
    continuityChangedAt = now;
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
  else if (otaActive) { red = 35; blue = 100; }
  else if (temperatureInterlockActive()) { red = 110; blue = 12; }
  else if (countdown && (now / 100) % 2) { red = 120; green = 28; }
  else if (armed) { red = 90; green = 18; }
  else if (continuityOverride || temperatureOverride) { red = 55; green = 28; }
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
