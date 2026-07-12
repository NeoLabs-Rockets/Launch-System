/* NeoLabs Rockets launch controller — BLE only. */
#include <NimBLEDevice.h>

#define TRIGGER_PIN 26
#define STATUS_LED 2
#define ARM_PIN -1
#define MOTOR_PIN 23
#define LAUNCH_CODE "123456"  // must match MissionDashboard LAUNCH_CODE
#define MAX_ATTEMPTS 10
#define TRIGGER_MS 2000UL
#define COUNTDOWN_TIMEOUT_MS 3000UL
#define LINK_TIMEOUT_MS 5000UL

static NimBLEUUID SERVICE_UUID("8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID COMMAND_UUID("8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000");
static NimBLEUUID STATUS_UUID ("8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000");
static const char BLE_NAME[] = "NeoLabs Launch Controller";

NimBLECharacteristic* statusChar = nullptr;
bool armed = false, firing = false, countdown = false, locked = false;
unsigned long triggerStarted = 0, lastHeartbeat = 0, lastOwnerActivity = 0, lastNotify = 0;
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
  if (MOTOR_PIN < 0) return;
  digitalWrite(MOTOR_PIN, HIGH);
  delay(ms);
  digitalWrite(MOTOR_PIN, LOW);
}

void safeStop(const char* reason) {
  armed = false;
  countdown = false;
  ownerSid = "";
  lastError = reason;
  digitalWrite(TRIGGER_PIN, LOW);
}

void publishStatus() {
  if (!statusChar) return;
  char data[190];
  snprintf(data, sizeof(data),
    "{\"a\":%d,\"f\":%d,\"c\":%d,\"l\":%d,\"left\":%d,\"n\":%d,\"u\":%lu,\"e\":\"%s\"}",
    armed, firing, countdown, locked, locked ? 0 : MAX_ATTEMPTS - attempts,
    connectedCount, millis(), lastError.c_str());
  statusChar->setValue((uint8_t*)data, strlen(data));
  statusChar->notify();
  lastNotify = millis();
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo&) override {
    connectedCount++;
    NimBLEDevice::getAdvertising()->start();
    publishStatus();
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int) override {
    if (connectedCount > 0) connectedCount--;
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
      if (ownerSid.length() && sid == ownerSid) lastOwnerActivity = millis();
      publishStatus();
      return;
    }
    if (cmd == "abort" || cmd == "disarm") { safeStop(cmd.c_str()); motorPulse(80); publishStatus(); return; }
    if (cmd == "auth") {
      lastError = jsonString(body, "code") == LAUNCH_CODE ? "auth_ok" : "auth_failed";
      publishStatus();
      return;
    }
    if (locked) { lastError = "locked"; publishStatus(); return; }

    if (cmd == "arm") {
      if (ownerSid.length() && ownerSid != sid) { lastError = "not_owner"; publishStatus(); return; }
      attempts = 0;
      ownerSid = sid;
      armed = true;
      countdown = false;
      lastOwnerActivity = millis();
      motorPulse(100);
      publishStatus();
      return;
    }

    if (!ownerSid.length() || sid != ownerSid) { lastError = "not_owner"; publishStatus(); return; }
    lastOwnerActivity = millis();
    if (cmd == "countdown_start") {
      if (!armed || firing) lastError = armed ? "trigger_active" : "not_armed";
      else { countdown = true; lastHeartbeat = millis(); }
    } else if (cmd == "heartbeat") {
      if (countdown) lastHeartbeat = millis();
    } else if (cmd == "trigger") {
      if (!armed) lastError = "not_armed";
      else if (!countdown || millis() - lastHeartbeat > COUNTDOWN_TIMEOUT_MS) safeStop("heartbeat_lost");
      else {
        digitalWrite(TRIGGER_PIN, HIGH);
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
  pinMode(TRIGGER_PIN, OUTPUT);
  digitalWrite(TRIGGER_PIN, LOW);
  if (STATUS_LED >= 0) pinMode(STATUS_LED, OUTPUT);
  if (MOTOR_PIN >= 0) { pinMode(MOTOR_PIN, OUTPUT); digitalWrite(MOTOR_PIN, LOW); }

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
  if (firing && now - triggerStarted >= TRIGGER_MS) {
    digitalWrite(TRIGGER_PIN, LOW);
    firing = false;
    publishStatus();
  }
  if (countdown && now - lastHeartbeat > COUNTDOWN_TIMEOUT_MS) {
    safeStop("heartbeat_lost");
    publishStatus();
  }
  if (armed && ownerSid.length() && now - lastOwnerActivity > LINK_TIMEOUT_MS) {
    safeStop("owner_lost");
    publishStatus();
  }
  if (STATUS_LED >= 0) digitalWrite(STATUS_LED, firing ? ((now / 100) % 2) : armed);
  if (now - lastNotify >= 1000) publishStatus();
  delay(5);
}
