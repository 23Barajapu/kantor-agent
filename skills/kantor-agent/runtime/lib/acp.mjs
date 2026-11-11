import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isPlainObj, isoMs } from './util.mjs';

const VALID_MODES = new Set(['plan', 'accept-edits', 'auto']);
const MAX_HISTORY = 200;
const SSE_HEARTBEAT_MS = 20_000;
const SHUTDOWN_KILL_WAIT_MS = 400;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isMethodNotFoundError(err) {
  if (!err) return false;
  if (err.code === -32601 || err.rpcError?.code === -32601) return true;
  return /method not found/i.test(String(err.message || ''));
}

function extractUpdateText(update) {
  if (!update || typeof update !== 'object') return '';
  if (typeof update.content === 'string') return update.content;
  if (isPlainObj(update.content) && typeof update.content.text === 'string') {
    return update.content.text;
  }
  if (Array.isArray(update.content)) {
    return update.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  if (typeof update.text === 'string') return update.text;
  if (typeof update.title === 'string') return update.title;
  return '';
}

/**
 * Jembatan stdio JSON-RPC 2.0 untuk `agy acp --stdio` dengan lazy-start,
 * guard keamanan `session/load`, antrean giliran tunggal, streaming SSE,
 * dan broker izin interaktif dengan timeout otomatis.
 */
export class AcpBridge {
  constructor({
    projectDir = process.cwd(),
    agyBin = process.env.KANTOR_AGY_BIN || 'agy',
    cfg = {},
    isSessionRunningOutsideAcp = () => false,
    isCliSession = null,
    permissionTimeoutMs = 120_000,
  } = {}) {
    this.projectDir =
      typeof projectDir === 'string' && projectDir.trim() !== '' ? projectDir : process.cwd();
    this.agyBin =
      typeof agyBin === 'string' && agyBin.trim() !== ''
        ? agyBin.trim()
        : process.env.KANTOR_AGY_BIN || 'agy';
    this.cfg = isPlainObj(cfg) ? cfg : {};

    const rawMode = this.cfg?.chat?.default_mode;
    this.defaultMode = typeof rawMode === 'string' && VALID_MODES.has(rawMode) ? rawMode : 'accept-edits';
    const rawModel = this.cfg?.chat?.default_model;
    this.defaultModel =
      typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : null;
    this.sandbox = Boolean(this.cfg?.chat?.sandbox);

    this.isSessionRunningOutsideAcp =
      typeof isSessionRunningOutsideAcp === 'function' ? isSessionRunningOutsideAcp : () => false;
    this.isCliSession = typeof isCliSession === 'function' ? isCliSession : null;
    this.permissionTimeoutMs =
      Number.isFinite(permissionTimeoutMs) && permissionTimeoutMs > 0
        ? permissionTimeoutMs
        : 120_000;

    this.connected = false;
    this.busy = false;
    this.starting = false;
    this.shuttingDown = false;
    this.sessionId = null;
    this.mode = this.defaultMode;
    this.model = this.defaultModel;
    this.lastError = null;

    this.history = [];
    this.pendingRequests = new Map();
    this.pendingPermissions = new Map();
    this.sseClients = new Set();

    this.child = null;
    this._stdoutDecoder = new StringDecoder('utf8');
    this._stdoutBuffer = '';
    this._nextRpcId = 1;
    this._nextHistId = 1;
    this._connectPromise = null;
    this._shutdownPromise = null;
    this._turnPromise = null;
    this._initResult = null;
    this._lastStderr = '';
  }

  getStatus() {
    return {
      connected: this.connected,
      busy: this.busy,
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
      sandbox: this.sandbox,
      pendingPermissionCount: this.pendingPermissions.size,
      lastError: this.lastError,
    };
  }

  getHistory() {
    return this.history.map((entry) => {
      const { _streaming, ...publicEntry } = entry;
      return { ...publicEntry };
    });
  }

  waitForTurn() {
    return this._turnPromise ?? Promise.resolve(null);
  }

  _pushHistory(entry) {
    const item = {
      id: entry.id ?? `h-${this._nextHistId++}`,
      ts: entry.ts || isoMs(Date.now()),
      ...entry,
    };
    this.history.push(item);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    const { _streaming, ...publicItem } = item;
    return publicItem;
  }

  _finalizeStreamingAssistant() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]._streaming) {
        this.history[i]._streaming = false;
      }
    }
  }

  _serializePendingPermissions() {
    return Array.from(this.pendingPermissions.values()).map((entry) => ({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      toolCall: entry.toolCall,
      options: entry.options,
      expiresAt: entry.expiresAt,
    }));
  }

  _formatSse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  _broadcastSse(event, data) {
    if (this.sseClients.size === 0) return;
    const payload = this._formatSse(event, data);
    for (const client of Array.from(this.sseClients)) {
      if (client.closed || client.res.writableEnded || client.res.destroyed) {
        this._cleanupSseClient(client);
        continue;
      }
      try {
        client.res.write(payload);
      } catch {
        this._cleanupSseClient(client);
      }
    }
  }

  _cleanupSseClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
    this.sseClients.delete(client);
  }

  subscribeSse(reqOrRes, maybeRes) {
    const req = maybeRes ? reqOrRes : null;
    const res = maybeRes || reqOrRes;
    if (!res || typeof res.write !== 'function') {
      throw new Error('Response stream tidak valid untuk SSE');
    }

    if (this.shuttingDown) {
      try {
        if (!res.writableEnded && !res.destroyed) res.end();
      } catch {}
      return;
    }

    if (!res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }

    const client = { res, heartbeatTimer: null, closed: false };
    const cleanup = () => this._cleanupSseClient(client);

    client.heartbeatTimer = setInterval(() => {
      if (client.closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, SSE_HEARTBEAT_MS);
    client.heartbeatTimer.unref?.();

    this.sseClients.add(client);
    req?.on?.('close', cleanup);
    res.on?.('close', cleanup);
    res.on?.('error', cleanup);

    try {
      res.write(
        this._formatSse('init', {
          status: this.getStatus(),
          history: this.getHistory(),
          pendingPermissions: this._serializePendingPermissions(),
        })
      );
    } catch {
      cleanup();
    }
  }

  _writeRpc(payload) {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable || child.stdin.destroyed) {
      return false;
    }
    try {
      child.stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  _sendRequest(method, params = {}) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Proses ACP belum terhubung'));
    }
    const id = this._nextRpcId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      const written = this._writeRpc({ jsonrpc: '2.0', id, method, params });
      if (!written) {
        this.pendingRequests.delete(id);
        reject(new Error(`Gagal menulis permintaan ACP: ${method}`));
      }
    });
  }

  _sendNotification(method, params = {}) {
    return this._writeRpc({ jsonrpc: '2.0', method, params });
  }

  _rejectAllPendingRequests(err) {
    for (const [id, pending] of Array.from(this.pendingRequests.entries())) {
      this.pendingRequests.delete(id);
      pending.reject(err);
    }
  }

  _clearPendingPermissions({ writeCancel = false, eventName = 'permission_resolved', optionId = 'cancel' } = {}) {
    for (const [key, entry] of Array.from(this.pendingPermissions.entries())) {
      clearTimeout(entry.timer);
      this.pendingPermissions.delete(key);
      if (writeCancel) {
        this._writeRpc({
          jsonrpc: '2.0',
          id: entry.rpcId,
          result: { outcome: { outcome: 'cancelled' } },
        });
      }
      if (eventName) {
        this._broadcastSse(eventName, {
          requestId: entry.requestId,
          sessionId: entry.sessionId,
          optionId,
          outcome: { outcome: 'cancelled' },
        });
      }
    }
  }

  _handleStdoutLine(rawLine) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObj(msg)) return;

    // 1. JSON-RPC Response (id present, no method)
    if ('id' in msg && msg.id !== undefined && msg.id !== null && typeof msg.method !== 'string') {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if ('error' in msg && msg.error !== undefined && msg.error !== null) {
        const rpcErr = isPlainObj(msg.error) ? msg.error : { message: String(msg.error) };
        const err = new Error(rpcErr.message || `Kesalahan RPC ${pending.method}`);
        err.code = rpcErr.code;
        err.rpcError = rpcErr;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 2. Server -> Client Request (id present + method present)
    if ('id' in msg && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      if (msg.method === 'session/request_permission') {
        this._handlePermissionRequest(msg);
      } else {
        this._writeRpc({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      }
      return;
    }

    // 3. Server -> Client Notification (no id + method present)
    if (!('id' in msg) && typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        this._handleSessionUpdate(msg.params);
      }
    }
  }

  _handlePermissionRequest(msg) {
    const rpcId = msg.id;
    const requestId = String(rpcId);
    const params = isPlainObj(msg.params) ? msg.params : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : this.sessionId;
    const toolCall = params.toolCall ?? null;
    const options = Array.isArray(params.options) ? params.options : [];
    const expiresAt = isoMs(Date.now() + this.permissionTimeoutMs);

    const existing = this.pendingPermissions.get(requestId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      const active = this.pendingPermissions.get(requestId);
      if (!active) return;
      this.pendingPermissions.delete(requestId);
      this._writeRpc({
        jsonrpc: '2.0',
        id: active.rpcId,
        result: { outcome: { outcome: 'cancelled' } },
      });
      this._pushHistory({
        type: 'permission',
        status: 'timeout',
        requestId: active.requestId,
        sessionId: active.sessionId,
        toolCall: active.toolCall,
      });
      this._broadcastSse('permission_timeout', {
        requestId: active.requestId,
        sessionId: active.sessionId,
      });
      this._broadcastSse('status', this.getStatus());
    }, this.permissionTimeoutMs);
    timer.unref?.();

    this.pendingPermissions.set(requestId, {
      requestId,
      rpcId,
      sessionId,
      toolCall,
      options,
      timer,
      expiresAt,
    });

    this._pushHistory({
      type: 'permission',
      status: 'pending',
      requestId,
      sessionId,
      toolCall,
      options,
      expiresAt,
    });

    this._broadcastSse('permission_request', {
      requestId,
      sessionId,
      toolCall,
      options,
      expiresAt,
    });
    this._broadcastSse('status', this.getStatus());
  }

  _handleSessionUpdate(params) {
    const update = isPlainObj(params?.update) ? params.update : isPlainObj(params) ? params : null;
    if (!update) return;

    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : this.sessionId;
    const kind =
      typeof update.sessionUpdate === 'string'
        ? update.sessionUpdate
        : typeof update.type === 'string'
          ? update.type
          : 'update';
    const text = extractUpdateText(update);
    const ts = isoMs(Date.now());

    if (kind === 'agent_message_chunk' || kind === 'agent_message') {
      if (text) {
        const last = this.history[this.history.length - 1];
        if (last && last.type === 'message' && last.role === 'assistant' && last.sessionId === sessionId && last._streaming) {
          last.text += text;
          last.ts = ts;
        } else {
          this._pushHistory({
            type: 'message',
            role: 'assistant',
            text,
            sessionId,
            ts,
            _streaming: true,
          });
        }
      }
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this._finalizeStreamingAssistant();
      this._pushHistory({
        type: 'tool',
        role: 'tool',
        toolCallId: update.toolCallId ?? null,
        title: typeof update.title === 'string' ? update.title : '',
        kind: typeof update.kind === 'string' ? update.kind : kind,
        status: typeof update.status === 'string' ? update.status : '',
        text,
        sessionId,
        ts,
      });
    } else if (kind === 'current_mode_update' && typeof update.currentModeId === 'string' && VALID_MODES.has(update.currentModeId)) {
      this.mode = update.currentModeId;
      this._broadcastSse('status', this.getStatus());
    }

    this._broadcastSse('session_update', {
      sessionId,
      kind,
      text,
      update,
      ts,
    });
  }

  _spawnChild() {
    const acpArgs = ['acp', '--stdio'];
    if (this.sandbox) acpArgs.push('--sandbox');

    const lowerBin = this.agyBin.toLowerCase();
    const isNodeScript = lowerBin.endsWith('.mjs') || lowerBin.endsWith('.js');
    const cmd = isNodeScript ? process.execPath : this.agyBin;
    const args = isNodeScript ? [this.agyBin, ...acpArgs] : acpArgs;

    this._stdoutDecoder = new StringDecoder('utf8');
    this._stdoutBuffer = '';
    this._lastStderr = '';

    const child = spawn(cmd, args, {
      cwd: this.projectDir,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    let disconnected = false;
    const onDisconnect = (errMessage, isError) => {
      if (disconnected) return;
      disconnected = true;

      if (this.child === child) {
        this.child = null;
        this.connected = false;
        this.busy = false;
      }

      if (isError && errMessage && !this.shuttingDown) {
        this.lastError = errMessage;
      }

      this._clearPendingPermissions({
        writeCancel: false,
        eventName: this.shuttingDown ? null : 'permission_resolved',
        optionId: 'cancel',
      });
      this._rejectAllPendingRequests(new Error(errMessage || 'Proses ACP terputus'));

      if (!this.shuttingDown) {
        if (isError && errMessage) {
          this._broadcastSse('error', { error: errMessage });
        }
        this._broadcastSse('status', this.getStatus());
      }
    };

    child.stdin?.on('error', () => {});

    child.stdout?.on('data', (chunk) => {
      if (this.child !== child) return;
      this._stdoutBuffer += this._stdoutDecoder.write(chunk);
      let nlIdx;
      while ((nlIdx = this._stdoutBuffer.indexOf('\n')) !== -1) {
        let line = this._stdoutBuffer.slice(0, nlIdx);
        this._stdoutBuffer = this._stdoutBuffer.slice(nlIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this._handleStdoutLine(line);
      }
    });

    child.stdout?.on('end', () => {
      if (this.child !== child) return;
      const tail = this._stdoutBuffer + this._stdoutDecoder.end();
      this._stdoutBuffer = '';
      if (tail.trim()) {
        this._handleStdoutLine(tail.replace(/\r$/, ''));
      }
    });

    child.stderr?.on('data', (chunk) => {
      const combined = this._lastStderr + String(chunk);
      this._lastStderr = combined.slice(-512);
    });

    child.on('error', (err) => {
      onDisconnect(err?.message || 'Gagal menjalankan proses agy ACP', true);
    });

    child.on('exit', (code, signal) => {
      const unexpected = !this.shuttingDown && (code !== 0 || signal !== null);
      const msg = unexpected
        ? `Proses ACP berhenti (${signal ? `signal ${signal}` : `exit ${code}`})${this._lastStderr.trim() ? `: ${this._lastStderr.trim()}` : ''}`
        : 'Proses ACP berakhir';
      onDisconnect(msg, unexpected);
    });

    return child;
  }

  async _terminateChild() {
    const child = this.child;
    if (!child) {
      this.connected = false;
      this.busy = false;
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.child === child) this.child = null;
      this.connected = false;
      this.busy = false;
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let hardTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        child.off('exit', finish);
        child.off('close', finish);
        if (this.child === child) this.child = null;
        this.connected = false;
        this.busy = false;
        resolve();
      };

      child.once('exit', finish);
      child.once('close', finish);

      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {}
      }, SHUTDOWN_KILL_WAIT_MS);
      killTimer.unref?.();

      hardTimer = setTimeout(finish, SHUTDOWN_KILL_WAIT_MS + 300);
      hardTimer.unref?.();
    });
  }

  async ensureConnected() {
    if (this.shuttingDown) {
      throw httpError(503, 'Jembatan ACP sedang dimatikan');
    }
    if (this.connected && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return this._initResult;
    }
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this.starting = true;
    this._connectPromise = (async () => {
      try {
        this._spawnChild();
        const initRes = await this._sendRequest('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'kantor-agent', version: '0.1.0' },
        });
        this._initResult = initRes ?? {};
        this.connected = true;
        this.lastError = null;
        this._broadcastSse('status', this.getStatus());
        return this._initResult;
      } catch (err) {
        this.lastError = err?.message || 'Gagal memulai koneksi ACP';
        await this._terminateChild();
        throw err;
      } finally {
        this.starting = false;
        this._connectPromise = null;
      }
    })();

    return this._connectPromise;
  }

  async _applySessionMode(sessionId, mode) {
    try {
      await this._sendRequest('session/set_mode', { sessionId, modeId: mode });
    } catch (err) {
      if (!isMethodNotFoundError(err)) throw err;
    }
  }

  async _applySessionModel(sessionId, model) {
    if (model === null) return;
    try {
      await this._sendRequest('session/set_model', { sessionId, modelId: model });
    } catch (err) {
      if (!isMethodNotFoundError(err)) throw err;
    }
  }

  async _createSessionInternal() {
    await this.ensureConnected();
    const res = await this._sendRequest('session/new', {
      cwd: this.projectDir,
      mcpServers: [],
    });
    const newSessionId = typeof res?.sessionId === 'string' && res.sessionId.trim() !== '' ? res.sessionId.trim() : null;
    if (!newSessionId) {
      throw new Error('ACP session/new tidak mengembalikan sessionId');
    }

    this.sessionId = newSessionId;
    await this._applySessionMode(this.sessionId, this.mode);
    if (this.model !== null) {
      await this._applySessionModel(this.sessionId, this.model);
    }

    this._pushHistory({
      type: 'session',
      action: 'new',
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    });
    this._broadcastSse('session', {
      action: 'new',
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    });
    this._broadcastSse('status', this.getStatus());

    return {
      ok: true,
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    };
  }

  async createSession() {
    if (this.shuttingDown) {
      throw httpError(503, 'Jembatan ACP sedang dimatikan');
    }
    if (this.busy || this.starting) {
      throw httpError(409, 'Ketua sedang memproses giliran aktif');
    }
    return this._createSessionInternal();
  }

  async loadSession(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw httpError(400, 'ID sesi wajib diisi');
    }
    const sessionId = id.trim();
    if (/[\x00-\x1f\x7f/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw httpError(400, 'ID sesi tidak valid');
    }

    if (await this.isSessionRunningOutsideAcp(sessionId)) {
      throw httpError(409, 'Sesi sedang berjalan di luar ACP');
    }
    if (this.isCliSession && !(await this.isCliSession(sessionId))) {
      throw httpError(409, 'Hanya sesi root CLI/ACP proyek yang dapat dimuat');
    }

    if (this.shuttingDown) {
      throw httpError(503, 'Jembatan ACP sedang dimatikan');
    }
    if (this.busy || this.starting) {
      throw httpError(409, 'Ketua sedang memproses giliran aktif');
    }

    await this.ensureConnected();
    await this._sendRequest('session/load', {
      sessionId,
      cwd: this.projectDir,
      mcpServers: [],
    });

    this.sessionId = sessionId;
    this._pushHistory({
      type: 'session',
      action: 'load',
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    });
    this._broadcastSse('session', {
      action: 'load',
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    });
    this._broadcastSse('status', this.getStatus());

    return {
      ok: true,
      sessionId: this.sessionId,
      mode: this.mode,
      model: this.model,
    };
  }

  async setConfig({ mode, model } = {}) {
    if (mode !== undefined) {
      if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
        throw httpError(400, 'Mode chat harus salah satu dari plan, accept-edits, atau auto');
      }
    }
    if (model !== undefined) {
      if (model !== null && (typeof model !== 'string' || model.trim() === '')) {
        throw httpError(400, 'Model harus berupa string non-kosong atau null');
      }
    }

    if (mode !== undefined) {
      this.mode = mode;
      if (this.connected && this.sessionId) {
        await this._applySessionMode(this.sessionId, this.mode);
      }
    }
    if (model !== undefined) {
      this.model = model === null ? null : model.trim();
      if (this.connected && this.sessionId && this.model !== null) {
        await this._applySessionModel(this.sessionId, this.model);
      }
    }

    this._broadcastSse('status', this.getStatus());
    return {
      ok: true,
      mode: this.mode,
      model: this.model,
      status: this.getStatus(),
    };
  }

  async sendPrompt(input) {
    let rawText;
    let mode;
    let model;

    if (typeof input === 'string') {
      rawText = input;
    } else if (isPlainObj(input)) {
      rawText = input.text;
      mode = input.mode;
      model = input.model;
    } else {
      throw httpError(400, 'Teks prompt wajib diisi');
    }

    if (typeof rawText !== 'string' || rawText.trim() === '') {
      throw httpError(400, 'Teks prompt wajib diisi');
    }
    if (mode !== undefined && (typeof mode !== 'string' || !VALID_MODES.has(mode))) {
      throw httpError(400, 'Mode chat harus salah satu dari plan, accept-edits, atau auto');
    }
    if (model !== undefined && model !== null && (typeof model !== 'string' || model.trim() === '')) {
      throw httpError(400, 'Model harus berupa string non-kosong atau null');
    }

    if (this.shuttingDown) {
      throw httpError(503, 'Jembatan ACP sedang dimatikan');
    }
    if (this.busy || this.starting) {
      throw httpError(409, 'Ketua sedang memproses giliran aktif');
    }

    const text = rawText.trim();
    this.busy = true;
    this.lastError = null;

    try {
      if (!this.sessionId) {
        if (mode !== undefined) this.mode = mode;
        if (model !== undefined) this.model = model === null ? null : model.trim();
        await this._createSessionInternal();
      } else {
        await this.ensureConnected();
        if (mode !== undefined || model !== undefined) {
          await this.setConfig({ mode, model });
        }
      }

      const activeSessionId = this.sessionId;
      const userMsg = this._pushHistory({
        type: 'message',
        role: 'user',
        text,
        sessionId: activeSessionId,
      });
      this._broadcastSse('message', userMsg);
      this._broadcastSse('status', this.getStatus());

      const rpcPromise = this._sendRequest('session/prompt', {
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text }],
      });

      this._turnPromise = rpcPromise.then(
        (result) => {
          this._finalizeStreamingAssistant();
          this.busy = false;
          this._turnPromise = null;
          const stopReason = result?.stopReason || 'end_turn';
          this._broadcastSse('turn_done', {
            sessionId: activeSessionId,
            stopReason,
            result: result ?? {},
            status: this.getStatus(),
          });
          this._broadcastSse('status', this.getStatus());
          return { ok: true, result: result ?? {} };
        },
        (err) => {
          this._finalizeStreamingAssistant();
          this.busy = false;
          this._turnPromise = null;
          const errMsg = err?.message || 'Giliran ACP gagal';
          if (!this.shuttingDown) {
            this.lastError = errMsg;
            this._pushHistory({
              type: 'error',
              sessionId: activeSessionId,
              error: errMsg,
            });
            this._broadcastSse('turn_error', {
              sessionId: activeSessionId,
              error: errMsg,
              status: this.getStatus(),
            });
            this._broadcastSse('status', this.getStatus());
          }
          return { ok: false, error: errMsg };
        }
      );

      return {
        status: 202,
        body: {
          ok: true,
          sessionId: activeSessionId,
          status: this.getStatus(),
        },
      };
    } catch (err) {
      this.busy = false;
      this._turnPromise = null;
      this.lastError = err?.message || 'Gagal mengirim prompt ke ACP';
      this._broadcastSse('status', this.getStatus());
      throw err;
    }
  }

  async respondPermission(requestId, optionId) {
    const key = requestId === undefined || requestId === null ? '' : String(requestId).trim();
    const entry = key ? this.pendingPermissions.get(key) : null;
    if (!entry) {
      throw httpError(404, 'Permintaan izin tidak ditemukan atau sudah kedaluwarsa');
    }

    if (typeof optionId !== 'string' || optionId.trim() === '') {
      throw httpError(400, 'optionId wajib diisi');
    }
    const cleanOptionId = optionId.trim();

    clearTimeout(entry.timer);
    this.pendingPermissions.delete(key);

    const hasLiteralRejectOption = entry.options.some((o) => o?.optionId === 'reject');
    let outcome;
    if (cleanOptionId === 'cancel' || (cleanOptionId === 'reject' && !hasLiteralRejectOption)) {
      outcome = { outcome: 'cancelled' };
    } else {
      outcome = { outcome: 'selected', optionId: cleanOptionId };
    }

    this._writeRpc({
      jsonrpc: '2.0',
      id: entry.rpcId,
      result: { outcome },
    });

    this._pushHistory({
      type: 'permission',
      status: 'resolved',
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      optionId: cleanOptionId,
      outcome,
      toolCall: entry.toolCall,
    });
    this._broadcastSse('permission_resolved', {
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      optionId: cleanOptionId,
      outcome,
    });
    this._broadcastSse('status', this.getStatus());

    return {
      ok: true,
      requestId: entry.requestId,
      optionId: cleanOptionId,
    };
  }

  async cancelTurn() {
    this._clearPendingPermissions({
      writeCancel: true,
      eventName: 'permission_resolved',
      optionId: 'cancel',
    });

    if (this.connected && this.sessionId && this.child?.stdin?.writable) {
      this._sendNotification('session/cancel', { sessionId: this.sessionId });
    }

    this._broadcastSse('turn_cancelled', {
      sessionId: this.sessionId,
      status: this.getStatus(),
    });
    this._broadcastSse('status', this.getStatus());
    return { ok: true };
  }

  async openSession(body = {}) {
    const params = isPlainObj(body) ? body : {};
    if (params.action === 'history') {
      return { ok: true, status: this.getStatus(), history: this.getHistory() };
    }

    const hasSessionId =
      params.sessionId !== undefined && params.sessionId !== null && String(params.sessionId).trim() !== '';

    if (hasSessionId) {
      await this.loadSession(String(params.sessionId));
    } else if (params.action === 'new' || !this.sessionId) {
      await this.createSession();
    }

    if (params.mode !== undefined || params.model !== undefined) {
      await this.setConfig({ mode: params.mode, model: params.model });
    }

    return {
      ok: true,
      sessionId: this.sessionId,
      status: this.getStatus(),
      history: this.getHistory(),
    };
  }

  async resolvePermission(body = {}) {
    const params = isPlainObj(body) ? body : {};
    return this.respondPermission(params.requestId, params.optionId);
  }

  async cancel() {
    return this.cancelTurn();
  }

  async shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;

    this._shutdownPromise = (async () => {
      this.shuttingDown = true;

      this._clearPendingPermissions({
        writeCancel: true,
        eventName: null,
      });

      if (this.busy && this.sessionId && this.child?.stdin?.writable && !this.child.stdin.destroyed) {
        this._sendNotification('session/cancel', { sessionId: this.sessionId });
      }

      this._rejectAllPendingRequests(new Error('Jembatan ACP dimatikan'));

      for (const client of Array.from(this.sseClients)) {
        this._cleanupSseClient(client);
        try {
          if (!client.res.writableEnded && !client.res.destroyed) {
            client.res.end();
          }
        } catch {}
      }

      await this._terminateChild();
      this._turnPromise = null;
    })();

    return this._shutdownPromise;
  }
}
