/*
  NeoBleLink — resilient Web Bluetooth transport for the NeoLabs launch controller.

  Owns everything about the physical BLE link so the rest of the dashboard never
  touches GATT directly:
    · device selection + permission-based restore (navigator.bluetooth.getDevices)
    · GATT connect and characteristic discovery with hard timeouts
    · automatic reconnect with capped exponential backoff after unexpected drops
    · serialized command writes with per-write timeouts
    · link watchdog fed by controller notifications + keep-alive status pings

  States: idle → connecting → connected ⇄ reconnecting → idle

  Events:
    'state'  { state, reason?, attempt?, nextRetryMs?, error? }
    'status' parsed controller status JSON (raw {a,f,c,l,q,b,left,n,u,e,v};
                                             q = continuity, b = temporary bypass)
    'health' { staleMs } while connected (controller notifies every ~1 s)
*/
(function () {
  'use strict';

  const SERVICE_UUID = '8f3a0001-7b2f-4f8a-9d0e-0c5b6f0a1000';
  const COMMAND_UUID = '8f3a0002-7b2f-4f8a-9d0e-0c5b6f0a1000';
  const STATUS_UUID = '8f3a0003-7b2f-4f8a-9d0e-0c5b6f0a1000';

  const CONNECT_TIMEOUT_MS = 10000;
  const WRITE_TIMEOUT_MS = 4000;
  const PING_INTERVAL_MS = 2000;
  const STALE_DEAD_MS = 8000;
  const RECONNECT_DELAYS_MS = [300, 700, 1500, 3000, 6000, 10000];
  const MAX_RECONNECT_ATTEMPTS = 20;
  const NAME_KEY = 'neolabs.ble.deviceName';

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

  class NeoBleLink {
    constructor() {
      this.state = 'idle';
      this.device = null;
      this.lastKnownName = '';
      try { this.lastKnownName = localStorage.getItem(NAME_KEY) || ''; } catch (_) {}
      // Stable per-page-load session id: the ESP32 grants arm/launch ownership
      // to this sid, so it must survive BLE reconnects within the same page.
      this.sessionId = makeId();
      this.lastActivityAt = 0;

      this._command = null;
      this._statusChar = null;
      this._writeChain = Promise.resolve();
      this._writeFailures = 0;
      this._listeners = new Map();
      this._pingTimer = null;
      this._watchdogTimer = null;
      this._pingSuspended = false;
      this._intentional = false;
      this._reconnecting = false;
      this._reconnectToken = 0;
      this._connectSeq = 0;
      this._wakeReconnect = null;
      this._onGattDisconnected = () => this._handleDrop('gatt_disconnected');
      this._onNotifyBound = event => this._onNotify(event);

      // Returning to a backgrounded tab should retry immediately instead of
      // sitting out the remainder of a long backoff window.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.state === 'reconnecting') this.retryNow();
      });
    }

    static supported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

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
        try { fn(detail); } catch (error) { console.error('[ble-link] listener failed:', error); }
      }
    }

    _setState(state, detail = {}) {
      this.state = state;
      this._emit('state', { state, ...detail });
    }

    /* ── Connecting ──────────────────────────────────────────────────────── */

    async connectViaChooser() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'NeoLabs' }],
        optionalServices: [SERVICE_UUID]
      });
      await this.connectDevice(device);
    }

    // Reconnect to an already-granted device without a chooser prompt.
    async restoreGranted() {
      if (!navigator.bluetooth?.getDevices) return false;
      const devices = await navigator.bluetooth.getDevices();
      const candidate = devices.find(d => /^NeoLabs/i.test(d.name || ''))
        || devices.find(d => d.name && d.name === this.lastKnownName);
      if (!candidate) return false;
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
      const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'BLE connect');
      const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), CONNECT_TIMEOUT_MS, 'BLE service discovery');
      const command = await withTimeout(service.getCharacteristic(COMMAND_UUID), CONNECT_TIMEOUT_MS, 'BLE command lookup');
      const statusChar = await withTimeout(service.getCharacteristic(STATUS_UUID), CONNECT_TIMEOUT_MS, 'BLE status lookup');
      if (seq !== this._connectSeq) throw new Error('connection attempt superseded');
      statusChar.removeEventListener('characteristicvaluechanged', this._onNotifyBound);
      statusChar.addEventListener('characteristicvaluechanged', this._onNotifyBound);
      await withTimeout(statusChar.startNotifications(), CONNECT_TIMEOUT_MS, 'BLE notifications');
      if (seq !== this._connectSeq) throw new Error('connection attempt superseded');

      this._command = command;
      this._statusChar = statusChar;
      this._writeChain = Promise.resolve();
      this._writeFailures = 0;
      this.lastActivityAt = Date.now();
      this._setState('connected', { deviceName: this.deviceName });
      this._startPing();
      this._startWatchdog();
      this.send({ cmd: 'status' }).catch(() => {});
    }

    /* ── Dropping / reconnecting ─────────────────────────────────────────── */

    _handleDrop(reason) {
      if (this._intentional || this.state !== 'connected') return;
      this._stopPing();
      this._stopWatchdog();
      this._command = null;
      this._statusChar = null;
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
        this._setState('reconnecting', { attempt, nextRetryMs: wait });
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
    }

    /* ── I/O ─────────────────────────────────────────────────────────────── */

    send(payload) {
      if (this.state !== 'connected' || !this._command) {
        return Promise.reject(new Error(this.state === 'reconnecting' ? 'BLE reconnecting' : 'BLE not connected'));
      }
      const body = JSON.stringify({ ...payload, sid: this.sessionId, seq: Date.now() });
      const run = this._writeChain.catch(() => {}).then(async () => {
        if (this.state !== 'connected' || !this._command) throw new Error('BLE not connected');
        try {
          await withTimeout(
            this._command.writeValueWithResponse(new TextEncoder().encode(body)),
            WRITE_TIMEOUT_MS,
            'BLE write'
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

    // During an active countdown the 700 ms heartbeat already proves the link;
    // running the ping concurrently just competes for GATT bandwidth.
    setPingSuspended(suspended) {
      this._pingSuspended = !!suspended;
    }

    _onNotify(event) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(event.target.value)); } catch (_) { return; }
      // Only a valid controller response proves end-to-end liveness. A host
      // write completing (or malformed notification bytes arriving) must not
      // keep a half-dead status channel alive forever.
      this.lastActivityAt = Date.now();
      this._emit('status', parsed);
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.state !== 'connected' || this._pingSuspended) return;
        this.send({ cmd: 'status' }).catch(() => {});
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
        if (staleMs > STALE_DEAD_MS) this._handleDrop('stale');
      }, 1000);
    }

    _stopWatchdog() {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  window.NeoBleLink = NeoBleLink;
})();
