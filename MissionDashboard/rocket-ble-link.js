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
  const FILE_DATA_UUID = '9c4e0006-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const OTA_CONTROL_UUID = '9c4e0007-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const OTA_DATA_UUID = '9c4e0008-6a2b-4c8d-9e1f-1d6c7a0b2000';
  const OTA_STATUS_UUID = '9c4e0009-6a2b-4c8d-9e1f-1d6c7a0b2000';

  const CONNECT_TIMEOUT_MS = 10000;
  const WRITE_TIMEOUT_MS = 4000;
  const FILE_CHUNK_TIMEOUT_MS = 8000;
  const PING_INTERVAL_MS = 2000;
  const STALE_DEAD_MS = 12000;
  const FILE_CHUNK_MAX = 160;
  const OTA_CHUNK_BYTES = 160;
  const OTA_WINDOW_CHUNKS = 16;
  const OTA_ACK_TIMEOUT_MS = 10000;
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
      this.fileTransferSupported = false;

      this._command = null;
      this._statusChar = null;
      this._telemetryChar = null;
      this._eventChar = null;
      this._fileDataChar = null;
      this._otaControl = null;
      this._otaData = null;
      this._otaStatusChar = null;
      this._otaStatus = null;
      this._otaWaiters = new Set();
      this._otaInProgress = false;
      this._expectedOtaReboot = false;
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
      this._eventWaiters = new Set();
      this._chunkWaiters = new Set();
      this._onGattDisconnected = () => this._handleDrop('gatt_disconnected');
      this._onStatusBound = event => this._onStatus(event);
      this._onTelemetryBound = event => this._onTelemetry(event);
      this._onEventBound = event => this._onEvent(event);
      this._onFileDataBound = event => this._onFileData(event);
      this._onOtaNotifyBound = event => this._onOtaNotify(event);

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

    get otaSupported() {
      return !!(this._otaControl && this._otaData && this._otaStatusChar);
    }

    get otaInProgress() {
      return this._otaInProgress || this._expectedOtaReboot;
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
      let fileDataChar = null;
      try {
        telemetryChar = await service.getCharacteristic(TELEMETRY_UUID);
      } catch (_) {}
      try {
        eventChar = await service.getCharacteristic(EVENT_UUID);
      } catch (_) {}
      try {
        fileDataChar = await service.getCharacteristic(FILE_DATA_UUID);
      } catch (_) {}
      let otaControl = null;
      let otaData = null;
      let otaStatusChar = null;
      try {
        [otaControl, otaData, otaStatusChar] = await Promise.all([
          service.getCharacteristic(OTA_CONTROL_UUID),
          service.getCharacteristic(OTA_DATA_UUID),
          service.getCharacteristic(OTA_STATUS_UUID)
        ]);
      } catch (_) {
        // Older firmware without OTA remains usable.
      }
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
      if (fileDataChar) {
        fileDataChar.removeEventListener('characteristicvaluechanged', this._onFileDataBound);
        fileDataChar.addEventListener('characteristicvaluechanged', this._onFileDataBound);
        await withTimeout(fileDataChar.startNotifications(), CONNECT_TIMEOUT_MS, 'Rocket file data notify');
      }
      if (otaStatusChar) {
        otaStatusChar.removeEventListener('characteristicvaluechanged', this._onOtaNotifyBound);
        otaStatusChar.addEventListener('characteristicvaluechanged', this._onOtaNotifyBound);
        await withTimeout(otaStatusChar.startNotifications(), CONNECT_TIMEOUT_MS, 'Rocket OTA notifications');
      }
      if (seq !== this._connectSeq) throw new Error('connection attempt superseded');

      this._command = command;
      this._statusChar = statusChar;
      this._telemetryChar = telemetryChar;
      this._eventChar = eventChar;
      this._fileDataChar = fileDataChar;
      this._otaControl = otaControl;
      this._otaData = otaData;
      this._otaStatusChar = otaStatusChar;
      this._otaStatus = null;
      this.fileTransferSupported = !!fileDataChar;
      this._writeChain = Promise.resolve();
      this._writeFailures = 0;
      this.lastActivityAt = Date.now();
      this._setState('connected', {
        deviceName: this.deviceName,
        fileTransfer: this.fileTransferSupported,
        ota: this.otaSupported,
        otaReconnected: this._expectedOtaReboot
      });
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
      this._fileDataChar = null;
      this._otaControl = null;
      this._otaData = null;
      this._otaStatusChar = null;
      this._rejectEventWaiters(new Error('BLE disconnected'));
      this._rejectChunkWaiters(new Error('BLE disconnected'));
      this._rejectOtaWaiters(new Error(this._expectedOtaReboot ? 'Controller restarting' : 'BLE disconnected during update'));
      try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (_) {}
      const dropReason = this._expectedOtaReboot ? 'ota_reboot' : reason;
      this._setState('reconnecting', { reason: dropReason, attempt: 0, nextRetryMs: RECONNECT_DELAYS_MS[0] });
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
      this._expectedOtaReboot = false;
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
      this._fileDataChar = null;
      this._otaControl = null;
      this._otaData = null;
      this._otaStatusChar = null;
      this.fileTransferSupported = false;
      this._rejectEventWaiters(new Error('BLE disconnected'));
      this._rejectChunkWaiters(new Error('BLE disconnected'));
      this._rejectOtaWaiters(new Error('BLE disconnected'));
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
          this.lastActivityAt = Date.now();
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

    /** Wait for next event/status JSON matching predicate. */
    waitForEvent(predicate, timeoutMs = FILE_CHUNK_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this._eventWaiters.delete(waiter);
          reject(new Error('Rocket event timed out'));
        }, timeoutMs);
        this._eventWaiters.add(waiter);
      });
    }

    _rejectEventWaiters(error) {
      for (const w of this._eventWaiters) {
        clearTimeout(w.timer);
        w.reject(error);
      }
      this._eventWaiters.clear();
    }

    _rejectChunkWaiters(error) {
      for (const w of this._chunkWaiters) {
        clearTimeout(w.timer);
        w.reject(error);
      }
      this._chunkWaiters.clear();
    }

    waitForChunk(expectedOffset, timeoutMs = FILE_CHUNK_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const waiter = { expectedOffset, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this._chunkWaiters.delete(waiter);
          reject(new Error(`File chunk timeout at offset ${expectedOffset}`));
        }, timeoutMs);
        this._chunkWaiters.add(waiter);
      });
    }

    async listFlights() {
      const pending = this.waitForEvent(p => p?.cmd === 'list_flights' && Array.isArray(p.flights));
      await this.send({ cmd: 'list_flights' });
      const msg = await pending;
      return msg.flights || [];
    }

    async listFiles(flight) {
      const pending = this.waitForEvent(p => p?.cmd === 'list_files' && p.flight === flight);
      await this.send({ cmd: 'list_files', flight });
      const msg = await pending;
      return msg.files || [];
    }

    async downloadFile(flight, fileName, onProgress) {
      if (!this.fileTransferSupported) {
        throw new Error('This rocket firmware does not support file transfer — flash an updated build');
      }
      const beginPending = this.waitForEvent(p => p?.cmd === 'file_begin' && p.file === fileName);
      await this.send({ cmd: 'file_begin', flight, file: fileName });
      const begin = await beginPending;
      if (begin.result !== 'ACK') throw new Error(begin.detail || 'file_begin failed');
      const total = Number(begin.size) || 0;
      const chunkMax = Number(begin.chunk) || FILE_CHUNK_MAX;
      const parts = [];
      let offset = 0;
      while (offset < total) {
        const want = Math.min(chunkMax, total - offset);
        const chunkPromise = this.waitForChunk(offset);
        await this.send({ cmd: 'file_read', offset, len: want, total });
        const chunk = await chunkPromise;
        parts.push(chunk.data);
        offset += chunk.len;
        if (typeof onProgress === 'function') onProgress({ offset, total, file: fileName });
        if (chunk.len === 0) break;
      }
      await this.send({ cmd: 'file_close' }).catch(() => {});
      // Merge Uint8Arrays
      const out = new Uint8Array(offset);
      let pos = 0;
      for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
      }
      return out;
    }

    async deleteFlight(flight) {
      const pending = this.waitForEvent(
        p => p?.cmd === 'delete_flight' || p?.detail === 'deleted' || p?.detail === 'delete_failed',
        6000
      );
      await this.send({ cmd: 'delete_flight', flight });
      const res = await pending;
      if (res.result === 'NACK' || res.result === 'REJECTED') {
        throw new Error(res.detail || 'delete failed');
      }
      return res;
    }

    /* ── OTA (mirrors Launch Controller NeoBleLink.installFirmware) ───── */

    async installFirmware(manifest, firmwareBytes) {
      if (this.state !== 'connected') throw new Error('Rocket BLE not connected');
      if (!this.otaSupported) throw new Error('Rocket computer requires a one-time USB firmware update');
      if (this._otaInProgress) throw new Error('Firmware update already in progress');
      const bytes = firmwareBytes instanceof Uint8Array ? firmwareBytes : new Uint8Array(firmwareBytes);
      if (!manifest || bytes.byteLength !== manifest.size) throw new Error('Firmware size does not match manifest');

      this._otaInProgress = true;
      this._otaStatus = null;
      this._stopPing();
      try {
        await this._writeOtaControl({
          cmd: 'begin',
          size: manifest.size,
          sha256: manifest.sha256,
          version: manifest.version
        });
        await this._waitForOtaStatus(status => status.state === 'ready' || status.state === 'error');
        this._throwForOtaError();

        let offset = 0;
        while (offset < bytes.byteLength) {
          const windowEnd = Math.min(bytes.byteLength, offset + OTA_CHUNK_BYTES * OTA_WINDOW_CHUNKS);
          while (offset < windowEnd) {
            const payloadEnd = Math.min(bytes.byteLength, offset + OTA_CHUNK_BYTES);
            const packet = new Uint8Array(4 + payloadEnd - offset);
            new DataView(packet.buffer).setUint32(0, offset, true);
            packet.set(bytes.subarray(offset, payloadEnd), 4);
            const write = this._otaData.writeValueWithoutResponse
              ? this._otaData.writeValueWithoutResponse(packet)
              : this._otaData.writeValueWithResponse(packet);
            await withTimeout(write, WRITE_TIMEOUT_MS, 'Rocket OTA data write');
            offset = payloadEnd;
          }
          await this._writeOtaControl({ cmd: 'status' });
          await this._waitForOtaStatus(status => status.state === 'error' || Number(status.received) >= offset);
          this._throwForOtaError();
        }

        this._expectedOtaReboot = true;
        await this._writeOtaControl({ cmd: 'finish' });
        await this._waitForOtaStatus(status => status.state === 'complete' || status.state === 'error');
        this._throwForOtaError();
        return this._otaStatus;
      } catch (error) {
        this._expectedOtaReboot = false;
        try { await this._writeOtaControl({ cmd: 'abort' }); } catch (_) {}
        throw error;
      } finally {
        this._otaInProgress = false;
        this._startPing();
      }
    }

    waitForFirmwareVersion(version, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          this._expectedOtaReboot = false;
          reject(new Error('Rocket computer did not reconnect with the new firmware'));
        }, timeoutMs);
        unsubscribe = this.on('status', status => {
          const ver = status?.ver || status?.v;
          if (ver !== version) return;
          clearTimeout(timer);
          unsubscribe();
          this._expectedOtaReboot = false;
          resolve(status);
        });
        if (this.state === 'connected') this.send({ cmd: 'status' }).catch(() => {});
      });
    }

    _writeOtaControl(payload) {
      if (this.state !== 'connected' || !this._otaControl) {
        return Promise.reject(new Error('OTA control unavailable'));
      }
      const body = new TextEncoder().encode(JSON.stringify(payload));
      return withTimeout(this._otaControl.writeValueWithResponse(body), WRITE_TIMEOUT_MS, 'Rocket OTA control');
    }

    _waitForOtaStatus(predicate) {
      if (this._otaStatus && predicate(this._otaStatus)) return Promise.resolve(this._otaStatus);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this._otaWaiters.delete(waiter);
          reject(new Error('OTA acknowledgement timed out'));
        }, OTA_ACK_TIMEOUT_MS);
        this._otaWaiters.add(waiter);
      });
    }

    _throwForOtaError() {
      if (this._otaStatus?.state === 'error') {
        throw new Error(this._otaStatus.error || 'Rocket computer rejected firmware update');
      }
    }

    _rejectOtaWaiters(error) {
      for (const waiter of this._otaWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this._otaWaiters.clear();
    }

    _onOtaNotify(event) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(event.target.value)); } catch (_) { return; }
      this.lastActivityAt = Date.now();
      this._otaStatus = parsed;
      this._emit('ota-status', parsed);
      for (const waiter of [...this._otaWaiters]) {
        if (!waiter.predicate(parsed)) continue;
        clearTimeout(waiter.timer);
        this._otaWaiters.delete(waiter);
        waiter.resolve(parsed);
      }
    }

    /*
      Decode one notification. Silently swallowing a parse failure here hides
      real faults: an oversized firmware payload is truncated at (ATT MTU - 3)
      bytes on the wire, so every update fails to parse and the UI just shows
      stale/empty fields with no indication anything is wrong. Report instead.
    */
    _parseNotification(event, kind) {
      const raw = new TextDecoder().decode(event.target.value);
      try {
        return JSON.parse(raw);
      } catch (err) {
        const counts = this._parseFailures || (this._parseFailures = {});
        counts[kind] = (counts[kind] || 0) + 1;
        // Unterminated JSON that starts valid is the signature of MTU truncation.
        const truncated = raw.startsWith('{') && !raw.trimEnd().endsWith('}');
        this.lastParseError = {
          kind,
          bytes: raw.length,
          truncated,
          at: Date.now(),
          sample: raw.slice(0, 120)
        };
        if (counts[kind] === 1 || counts[kind] % 50 === 0) {
          console.error(
            `[rocket-ble] ${kind} notification failed to parse (${counts[kind]}x, ${raw.length} B)`
            + (truncated
              ? ' — payload looks TRUNCATED: the firmware is sending more than the'
                + ' negotiated ATT MTU allows. Shrink the payload or raise BLE_MTU_TARGET.'
              : ''),
            raw.slice(0, 120)
          );
        }
        this._emit('parseerror', this.lastParseError);
        return null;
      }
    }

    _onStatus(event) {
      const parsed = this._parseNotification(event, 'status');
      if (!parsed) return;
      this.lastActivityAt = Date.now();
      this.lastStatus = parsed;
      this._emit('status', parsed);
      this._resolveEventWaiters(parsed);
    }

    _onTelemetry(event) {
      const parsed = this._parseNotification(event, 'telemetry');
      if (!parsed) return;
      this.lastActivityAt = Date.now();
      this.lastTelemetry = parsed;
      this._emit('telemetry', parsed);
    }

    _onEvent(event) {
      const parsed = this._parseNotification(event, 'event');
      if (!parsed) return;
      this.lastActivityAt = Date.now();
      this.lastEvent = parsed;
      this._emit('event', parsed);
      this._resolveEventWaiters(parsed);
    }

    _resolveEventWaiters(parsed) {
      for (const w of [...this._eventWaiters]) {
        try {
          if (!w.predicate(parsed)) continue;
        } catch (_) { continue; }
        clearTimeout(w.timer);
        this._eventWaiters.delete(w);
        w.resolve(parsed);
      }
    }

    _onFileData(event) {
      const value = event.target.value; // DataView
      if (!value || value.byteLength < 10) return;
      const offset = value.getUint32(0, true);
      const total = value.getUint32(4, true);
      const len = value.getUint16(8, true);
      const data = new Uint8Array(value.buffer, value.byteOffset + 10, len);
      this.lastActivityAt = Date.now();
      const chunk = { offset, total, len, data: new Uint8Array(data) };
      this._emit('file-chunk', chunk);
      for (const w of [...this._chunkWaiters]) {
        if (w.expectedOffset !== offset) continue;
        clearTimeout(w.timer);
        this._chunkWaiters.delete(w);
        w.resolve(chunk);
      }
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.state !== 'connected') return;
        // Pause pings during heavy file transfer waiters
        if (this._chunkWaiters.size > 0) return;
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
        // Don't drop during active file transfer
        if (this._chunkWaiters.size > 0 || this._eventWaiters.size > 0) return;
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
