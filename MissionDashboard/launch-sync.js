/*
  NeoLaunchSync — server synchronization for the mission dashboard.

  Owns every conversation with the local relay server:
    · the SSE launch stream, with a liveness watchdog that recreates the
      EventSource when the server heartbeat stops arriving
    · the BLE owner lease (claim / heartbeat / explicit release on page hide)
    · remote command RPC routed through the BLE owner, with auth retry
    · server link quality monitoring (/api/health round-trip)

  Events:
    'shared_state'   server-authoritative launch state snapshot
    'client_count'   { clients }
    'remote_command' command addressed to the BLE owner
    'auth_request'   join-code verification addressed to the BLE owner
    'command_result' result relayed from the BLE owner
    'launch_event'   countdown_start / countdown_tick / abort / ignition
    'stream'         { state: 'open' | 'degraded' | 'reconnecting' }
    'serverlink'     { state, latency, failures, checkedAt, quality, detail }
*/
(function () {
  'use strict';

  const SSE_STALE_MS = 30000;      // server heartbeats every 10 s
  const SSE_CHECK_INTERVAL_MS = 5000;
  const HEALTH_INTERVAL_MS = 5000;
  const COMMAND_TIMEOUT_MS = 8000;
  const CLAIM_RETRIES = 4;

  function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class NeoLaunchSync {
    constructor(clientId) {
      this.clientId = clientId;
      this.stream = null;
      this.lastEventAt = 0;
      this.serverLink = { state: 'marginal', latency: null, failures: 0, checkedAt: 0 };
      this._listeners = new Map();
      this._pending = new Map();
      this._started = false;
      this.streamInstanceId = null;
      this.healthInstanceId = null;
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
        try { fn(detail); } catch (error) { console.error('[launch-sync] listener failed:', error); }
      }
    }

    /* ── SSE stream ──────────────────────────────────────────────────────── */

    start() {
      if (this._started) return;
      this._started = true;
      this._openStream();
      setInterval(() => this._checkStream(), SSE_CHECK_INTERVAL_MS);
      this._startHealthMonitor();
    }

    _openStream() {
      try { this.stream?.close(); } catch (_) {}
      const stream = new EventSource(`/api/launch-stream?clientId=${encodeURIComponent(this.clientId)}`);
      this.stream = stream;
      this.lastEventAt = Date.now();
      stream.onopen = () => {
        this.lastEventAt = Date.now();
        this._emit('stream', { state: 'open' });
      };
      stream.onerror = () => {
        this.streamInstanceId = null;
        this._emit('stream', { state: 'degraded' });
      };
      stream.onmessage = event => {
        this.lastEventAt = Date.now();
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        this._route(message);
      };
    }

    // EventSource auto-retries transient errors, but a half-dead connection
    // (proxy timeout, sleeping laptop) can sit open while delivering nothing.
    // The server emits heartbeats, so silence means the stream is gone.
    _checkStream() {
      if (!this.stream) return;
      const stale = this.lastEventAt && Date.now() - this.lastEventAt > SSE_STALE_MS;
      if (stale || this.stream.readyState === EventSource.CLOSED) {
        this._emit('stream', { state: 'reconnecting' });
        this._openStream();
      }
    }

    _route(message) {
      if (message.serverInstanceId) this.streamInstanceId = String(message.serverInstanceId);
      switch (message.type) {
        case 'heartbeat':
          break; // stream liveness only
        case 'shared_state':
          this._emit('shared_state', message.state || {});
          break;
        case 'client_count':
          this._emit('client_count', message);
          break;
        case 'remote_command':
          this._emit('remote_command', message);
          break;
        case 'auth_request':
          this._emit('auth_request', message);
          break;
        case 'command_result':
          this._resolveCommand(message);
          this._emit('command_result', message);
          break;
        case 'countdown_start':
        case 'countdown_tick':
        case 'abort':
        case 'ignition':
          this._emit('launch_event', message);
          break;
        default:
          break;
      }
    }

    /* ── Owner lease ─────────────────────────────────────────────────────── */

    async claimOwner(info = {}) {
      for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
        try {
          const response = await fetch('/api/auth/owner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: this.clientId, ...info })
          });
          const body = await response.json().catch(() => ({}));
          if (response.ok) return { ok: true, state: body.state || null };
          if (response.status === 409) return { ok: false, conflict: true, state: body.state || null };
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
      return { ok: false, conflict: false, state: null };
    }

    // Fire-and-forget: also safe to call from pagehide via sendBeacon so other
    // devices can take over immediately instead of waiting out the lease TTL.
    releaseOwner(reason = 'released') {
      const payload = JSON.stringify({ clientId: this.clientId, reason });
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon && navigator.sendBeacon('/api/auth/owner/release', blob)) return;
      } catch (_) {}
      fetch('/api/auth/owner/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    }

    /* ── Messaging ───────────────────────────────────────────────────────── */

    // Resolves to the Response (or null on network failure) so callers can
    // react to rejections like a 409 owner conflict instead of missing them.
    relay(message) {
      return fetch('/api/launch-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message, clientId: this.clientId })
      }).catch(() => null);
    }

    async fetchState() {
      const response = await fetch(`/api/launch-state?clientId=${encodeURIComponent(this.clientId)}`);
      if (!response.ok) throw new Error(`launch-state HTTP ${response.status}`);
      return response.json();
    }

    // Route a command through the BLE owner. `ensureAuth` is an async callback
    // that acquires a launch-code session and resolves true when authorized.
    async sendCommand(command, args = {}, ensureAuth = null, retried = false) {
      const commandId = makeId();
      const completion = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(commandId);
          reject(new Error('BLE owner did not confirm the command'));
        }, COMMAND_TIMEOUT_MS);
        this._pending.set(commandId, { resolve, reject, timer });
      });
      completion.catch(() => {}); // avoid unhandled rejection when dropped early
      let response;
      try {
        response = await fetch('/api/launch-command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandId, command, args, clientId: this.clientId })
        });
      } catch (_) {
        this._dropPending(commandId);
        throw new Error('Dashboard server unreachable');
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 401 && !retried && ensureAuth) {
        this._dropPending(commandId);
        const authorized = await ensureAuth();
        if (!authorized) throw new Error('Launch authorization is required to control the BLE owner');
        return this.sendCommand(command, args, ensureAuth, true);
      }
      if (!response.ok) {
        this._dropPending(commandId);
        throw new Error(body.error || 'Remote command failed');
      }
      return completion;
    }

    _resolveCommand(message) {
      const pending = this._pending.get(message.commandId);
      if (!pending) return;
      this._pending.delete(message.commandId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error || 'Command rejected by BLE controller'));
    }

    _dropPending(commandId) {
      const pending = this._pending.get(commandId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(commandId);
    }

    /* ── Server link quality ─────────────────────────────────────────────── */

    _startHealthMonitor() {
      const check = async () => {
        const started = performance.now();
        try {
          const response = await fetch(`/api/health?t=${Date.now()}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(2500)
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const health = await response.json();
          this.healthInstanceId = String(health.instanceId || '');
          const latency = Math.round(performance.now() - started);
          const instanceMismatch = !!this.streamInstanceId && !!this.healthInstanceId && this.streamInstanceId !== this.healthInstanceId;
          this.serverLink = {
            state: instanceMismatch || latency > 800 ? 'nogo' : latency > 250 ? 'marginal' : 'go',
            latency,
            failures: 0,
            checkedAt: Date.now(),
            instanceMismatch
          };
        } catch (_) {
          this.serverLink = {
            ...this.serverLink,
            state: 'nogo',
            latency: null,
            failures: (this.serverLink.failures || 0) + 1,
            checkedAt: Date.now()
          };
        }
        const quality = this.serverLink.state === 'go' ? 'Good' : this.serverLink.state === 'marginal' ? 'Limited' : 'Poor';
        const detail = this.serverLink.instanceMismatch
          ? 'Multiple unsynchronized dashboard server instances detected'
          : this.serverLink.latency == null
          ? 'Server not responding'
          : `${this.serverLink.latency} ms response time`;
        this._emit('serverlink', { ...this.serverLink, quality, detail });
      };
      check();
      setInterval(check, HEALTH_INTERVAL_MS);
    }
  }

  window.NeoLaunchSync = NeoLaunchSync;
})();
