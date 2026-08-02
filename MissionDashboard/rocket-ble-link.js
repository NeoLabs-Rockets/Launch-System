/*
  RocketBleLink — independent Web Bluetooth transport for the NL-1 rocket computer.

  Completely separate from NeoBleLink (launch controller). A disconnect or error
  on either device must never tear down the other connection.
*/
(function () {
  'use strict';

  const SERVICE_UUID = '9c4e0001-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const COMMAND_UUID = '9c4e0002-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const STATUS_UUID = '9c4e0003-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const TELEMETRY_UUID = '9c4e0004-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const EVENT_UUID = '9c4e0005-6a2b-4c8d-9e1f-1d6c7a0b2000';

  const CONNECT_TIMEOUT_MS = 10000;
  const WRITE_TIMEOUT_MS = 4000;
  const PING_INTERVAL_MS = 2000;
  const STALE_DEAD_MS = 12000;
  const RECONNECT_DELAYS_MS = [300, 700, 1500, 3000, 6000, 10000];
  const MAX_RECONNECT_ATTEMPTS = 20;
  const NAME_KEY = 'neolabs.rocket.ble.deviceName';
  const NAME_PREFIX = 'NeoLabs Rocket';

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); }
      );
    });
  }

  function makeId() {
    if (globalThis.crypto?.getRandomValues) {
      return globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-');
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class RocketBleLink {
    constructor() {
      this.state = 'idle';
      this.device = null;
      this.lastKnownName = '';
      try { this.lastKnownName = localStorage.getItem(NAME_KEY) || ''; } catch (_) {}
      this.sessionId = makeId();
      this.lastActivityAt = 0;
      this.lastStatus = null;
      this.lastTelemetry = null;
      this.lastEvent = null;
      this.msgSeq = 1;

      this._command = null;
      this._statusChar = null;
      this._telemetryChar = null;
      this._eventChar = null;
      this._writeChain = Promise.resolve();
      this._writeFailures = 0;
      this._listeners = new Map();
      this._pingTimer = null;
      this._watchdogTimer = null;
      this._intentional = false;
      this._reconnecting = false;
      this._reconnectToken = 0;
      this._connectSeq = 0;
      this._wakeReconnect = null;
      this._onGattDisconnected = () => this._handleDrop('gatt_disconnected');
      this._onStatusBound = event => this._onStatus(event);
      this._onTelemetryBound = event => this._onTelemetry(event);
      this._onEventBound = event => this._onEvent(event);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.state === 'reconnecting') this.retryNow();
      });
    }

    static supported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    static get SERVICE_UUID() { return SERVICE_UUID; }

    get connected() {
      return this.state === 'connected';
    }

    get deviceName() {
      return this.device?.name || this.lastKnownName || '';
    }

    on(event, fn) {
      const list = this._listeners.get(event) || [];
      list.push(fn);
      this._listeners.set(event, list);
      return () => {
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      };
    }

    _emit(event, detail) {
      for (const fn of this._listeners.get(event) || []) {
        try { fn(detail); } catch (error) { console.error('[rocket-ble] listener failed:', error); }
      }
    }

    _setState(state, detail = {}) {
      this.state = state;
      this._emit('state', { state, ...detail });
    }

    async connectViaChooser() {
      // Prefer name filter so the chooser does not list the launch controller
      // (also NeoLabs*). Service UUID is optionalServices for GATT access.
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'NeoLabs Rocket' },
          { namePrefix: NAME_PREFIX }
        ],
        optionalServices: [SERVICE_UUID]
      });
      await this.connectDevice(device);
    }

    async restoreGranted() {
      if (!navigator.bluetooth?.getDevices) return false;
      const devices = await navigator.bluetooth.getDevices();
      const candidate = devices.find(d => /rocket/i.test(d.name || ''))
        || devices.find(d => d.name && d.name === this.lastKnownName);
      // Never steal the launch controller device by NeoLabs prefix alone.
      if (!candidate || !/rocket/i.test(candidate.name || this.lastKnownName || '')) return false;
      await this.connectDevice(candidate);
      return true;
    }

    async connectDevice(device) {
      this._intentional = false;
      this._cancelReconnect();
      this.device = device;
      if (device.name) {
        this.lastKnownName = device.name;
        try { localStorage.setItem(NAME_KEY, device.name); } catch (_) {}
      }
      device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
      this._setState('connecting', { deviceName: this.deviceName });
      try {
        await this._establish(device);
      } catch (error) {
        try { device.gatt.disconnect(); } catch (_) {}
        this._teardown();
        this._setState('idle', { reason: 'connect_failed', error: String(error?.message || error) });
        throw error;
      }
    }

    async _establish(device) {
      const seq = ++this._connectSeq;
      const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'Rocket BLE connect');
      const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), CONNECT_TIMEOUT_MS, 'Rocket BLE service');
      const command = await withTimeout(service.getCharacteristic(COMMAND_UUID), CONNECT_TIMEOUT_MS, 'Rocket command');
      const statusChar = await withTimeout(service.getCharacteristic(STATUS_UUID), CONNECT_TIMEOUT_MS, 'Rocket status');
      let telemetryChar = null;
      let eventChar = null;
      try {
        telemetryChar = await service.getCharacteristic(TELEMETRY_UUID);
      } catch (_) {}
      try {
        eventChar = await service.getCharacteristic(EVENT_UUID);
      } catch (_) {}
      if (seq !== this._connectSeq) throw new Error('connection attempt superseded');

      statusChar.removeEventListener('characteristicvaluechanged', this._onStatusBound);
      statusChar.addEventListener('characteristicvaluechanged', this._onStatusBound);
      await withTimeout(statusChar.startNotifications(), CONNECT_TIMEOUT_MS, 'Rocket status notify');

      if (telemetryChar) {
        telemetryChar.removeEventListener('characteristicvaluechanged', this._onTelemetryBound);
        telemetryChar.addEventListener('characteristicvaluechanged', this._onTelemetryBound);
        await withTimeout(telemetryChar.startNotifications(), CONNECT_TIMEOUT_MS, 'Rocket telemetry notify');
      }
      if (eventChar) {
        eventChar.removeEventListener('characteristicvaluechanged', this._onEventBound);
        eventChar.addEventListener('characteristicvaluechanged', this._onEventBound);
        await withTimeout(eventChar.startNotifications(), CONNECT_TIMEOUT_MS, 'Rocket event notify');
      }
      if (seq !== this._connectSeq) throw new Error('connection attempt superseded');

      this._command = command;
      this._statusChar = statusChar;
      this._telemetryChar = telemetryChar;
      this._eventChar = eventChar;
      this._writeChain = Promise.resolve();
      this._writeFailures = 0;
      this.lastActivityAt = Date.now();
      this._setState('connected', { deviceName: this.deviceName });
      this._startPing();
      this._startWatchdog();
      // Time sync + status
      await this.send({ cmd: 'sync_time', unix_ms: Date.now(), rtt_ms: 0 }).catch(() => {});
      await this.send({ cmd: 'status' }).catch(() => {});
      await this.send({ cmd: 'capabilities' }).catch(() => {});
    }

    _handleDrop(reason) {
      if (this._intentional || this.state !== 'connected') return;
      this._stopPing();
      this._stopWatchdog();
      this._command = null;
      this._statusChar = null;
      this._telemetryChar = null;
      this._eventChar = null;
      try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (_) {}
      this._setState('reconnecting', { reason, attempt: 0, nextRetryMs: RECONNECT_DELAYS_MS[0] });
      this._reconnectLoop();
    }

    async _reconnectLoop() {
      if (this._reconnecting || !this.device) return;
      this._reconnecting = true;
      const token = ++this._reconnectToken;
      const device = this.device;
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        const wait = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
        this._setState('reconnecting', { reason: 'gatt_disconnected', attempt, nextRetryMs: wait });
        await this._reconnectSleep(wait);
        if (token !== this._reconnectToken) { this._reconnecting = false; return; }
        try {
          await this._establish(device);
          this._reconnecting = false;
          return;
        } catch (_) {
          try { device.gatt.disconnect(); } catch (_) {}
          if (token !== this._reconnectToken) { this._reconnecting = false; return; }
        }
      }
      this._reconnecting = false;
      this._teardown();
      this._setState('idle', { reason: 'gave_up' });
    }

    _reconnectSleep(ms) {
      return new Promise(resolve => {
        const timer = setTimeout(() => { this._wakeReconnect = null; resolve(); }, ms);
        this._wakeReconnect = () => {
          clearTimeout(timer);
          this._wakeReconnect = null;
          resolve();
        };
      });
    }

    retryNow() {
      if (this.state === 'reconnecting') this._wakeReconnect?.();
    }

    disconnect() {
      this._intentional = true;
      this._cancelReconnect();
      this._connectSeq++;
      this._teardown();
      this._setState('idle', { reason: 'user' });
    }

    _cancelReconnect() {
      this._reconnectToken++;
      this._wakeReconnect?.();
      this._reconnecting = false;
    }

    _teardown() {
      this._stopPing();
      this._stopWatchdog();
      try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (_) {}
      this._command = null;
      this._statusChar = null;
      this._telemetryChar = null;
      this._eventChar = null;
    }

    send(payload) {
      if (this.state !== 'connected' || !this._command) {
        return Promise.reject(new Error(this.state === 'reconnecting' ? 'Rocket BLE reconnecting' : 'Rocket BLE not connected'));
      }
      const seq = this.msgSeq++;
      const body = JSON.stringify({
        ...payload,
        sid: this.sessionId,
        seq,
        msg_id: payload.msg_id || seq
      });
      const run = this._writeChain.catch(() => {}).then(async () => {
        if (this.state !== 'connected' || !this._command) throw new Error('Rocket BLE not connected');
        try {
          await withTimeout(
            this._command.writeValueWithResponse(new TextEncoder().encode(body)),
            WRITE_TIMEOUT_MS,
            'Rocket BLE write'
          );
          this._writeFailures = 0;
        } catch (error) {
          this._writeFailures++;
          const gattUp = !!this.device?.gatt?.connected;
          if (!gattUp || (this._writeFailures >= 3 && Date.now() - this.lastActivityAt > 5000)) {
            this._handleDrop('write_failed');
          }
          throw error;
        }
      });
      this._writeChain = run;
      return run;
    }

    _onStatus(event) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(event.target.value)); } catch (_) { return; }
      this.lastActivityAt = Date.now();
      this.lastStatus = parsed;
      this._emit('status', parsed);
    }

    _onTelemetry(event) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(event.target.value)); } catch (_) { return; }
      this.lastActivityAt = Date.now();
      this.lastTelemetry = parsed;
      this._emit('telemetry', parsed);
    }

    _onEvent(event) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(event.target.value)); } catch (_) {
        // May be command ACK string
        try {
          const text = new TextDecoder().decode(event.target.value);
          parsed = JSON.parse(text);
        } catch (_) { return; }
      }
      this.lastActivityAt = Date.now();
      this.lastEvent = parsed;
      this._emit('event', parsed);
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.state !== 'connected') return;
        this.send({ cmd: 'ping' }).catch(() => {});
      }, PING_INTERVAL_MS);
    }

    _stopPing() {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }

    _startWatchdog() {
      this._stopWatchdog();
      this._watchdogTimer = setInterval(() => {
        if (this.state !== 'connected') return;
        const staleMs = Date.now() - this.lastActivityAt;
        this._emit('health', { staleMs });
        // After liftoff, RF loss is expected — still mark reconnecting but UI
        // should treat it as normal (handled by rocket-computer.js).
        if (staleMs > STALE_DEAD_MS) this._handleDrop('stale');
      }, 1000);
    }

    _stopWatchdog() {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  window.RocketBleLink = RocketBleLink;
})();
