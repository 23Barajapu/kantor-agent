import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { AcpBridge } from '../skills/kantor-agent/runtime/lib/acp.mjs';
import { createKantorServer } from '../skills/kantor-agent/runtime/bin/serve.mjs';
import { loadConfig } from '../skills/kantor-agent/runtime/lib/config.mjs';

const RUNTIME_DIR = path.resolve(import.meta.dirname, '..', 'skills', 'kantor-agent', 'runtime');
const FAKE_AGY = path.resolve(import.meta.dirname, 'fixtures', 'fake-agy.mjs');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    preview TEXT DEFAULT '',
    step_count INTEGER DEFAULT 0,
    last_modified_time TEXT,
    workspace_uris TEXT,
    status TEXT DEFAULT '',
    source TEXT DEFAULT '',
    agent_name TEXT DEFAULT '',
    parent_conversation_id TEXT DEFAULT '',
    nesting_depth INTEGER DEFAULT 0,
    not_fully_idle INTEGER DEFAULT 0,
    killed INTEGER DEFAULT 0,
    last_user_input_time TEXT,
    app_data_dir TEXT DEFAULT ''
  );
`;

function makeTempDir(prefix = 'kantor-acp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function createMockSseRes() {
  const emitter = new EventEmitter();
  const chunks = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
    },
    write(data) {
      if (this.writableEnded || this.destroyed) return false;
      chunks.push(String(data));
      emitter.emit('chunk', String(data));
      return true;
    },
    end() {
      this.writableEnded = true;
      emitter.emit('close');
    },
    on(ev, fn) {
      emitter.on(ev, fn);
      return this;
    },
    off(ev, fn) {
      emitter.off(ev, fn);
      return this;
    },
    emitClose() {
      this.destroyed = true;
      emitter.emit('close');
    },
    getText() {
      return chunks.join('');
    },
    getEvents() {
      const blocks = chunks.join('').split('\n\n').filter(Boolean);
      const events = [];
      for (const block of blocks) {
        if (block.startsWith(':')) continue;
        let event = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          let data = dataLines.join('\n');
          try {
            data = JSON.parse(data);
          } catch {}
          events.push({ event, data });
        }
      }
      return events;
    },
    waitForEvent(eventName, timeoutMs = 4000, predicate = null) {
      const existing = this.getEvents().find((e) => e.event === eventName && (!predicate || predicate(e.data)));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('chunk', onChunk);
          reject(new Error(`Timeout waiting for SSE event "${eventName}". Received: ${JSON.stringify(this.getEvents().map((e) => e.event))}`));
        }, timeoutMs);
        timer.unref();
        const onChunk = () => {
          const hit = this.getEvents().find((e) => e.event === eventName && (!predicate || predicate(e.data)));
          if (hit) {
            clearTimeout(timer);
            emitter.off('chunk', onChunk);
            resolve(hit);
          }
        };
        emitter.on('chunk', onChunk);
      });
    },
  };
  return res;
}

function seedConversation(antigravityHome, projectDir, convId, opts = {}) {
  const dbPath = path.join(antigravityHome, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    const uri = pathToFileURL(projectDir).href;
    db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, step_count, last_modified_time,
        workspace_uris, status, source, nesting_depth, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      convId,
      opts.title ?? 'Sesi CLI Test',
      opts.step_count ?? 1,
      opts.last_modified_time ?? new Date().toISOString(),
      JSON.stringify([uri]),
      opts.status ?? 'CASCADE_RUN_STATUS_IDLE',
      opts.source ?? 'CORTEX_TRAJECTORY_SOURCE_CLI',
      opts.nesting_depth ?? 0,
      opts.app_data_dir ?? 'antigravity-cli'
    );
  } finally {
    db.close();
  }
}

function rawRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf =
      body === null || body === undefined
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const finalHeaders = { ...headers };
    if (bodyBuf !== null) finalHeaders['Content-Length'] = String(bodyBuf.length);

    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: finalHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (bodyBuf !== null) req.write(bodyBuf);
    req.end();
  });
}

function openLiveSse(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    let rawText = '';
    const events = [];
    let buffer = '';
    const waiters = [];

    const flushWaiters = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const hit = events.find((e) => e.event === w.eventName && (!w.predicate || w.predicate(e.data)));
        if (hit) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(hit);
        }
      }
    };

    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        rawText += chunk;
        buffer += chunk;
        let sepIdx;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          let event = 'message';
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length > 0) {
            let data = dataLines.join('\n');
            try {
              data = JSON.parse(data);
            } catch {}
            events.push({ event, data });
          }
        }
        flushWaiters();
      });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        getRawText: () => rawText,
        waitForEvent(eventName, timeoutMs = 4000, predicate = null) {
          const existing = events.find((e) => e.event === eventName && (!predicate || predicate(e.data)));
          if (existing) return Promise.resolve(existing);
          return new Promise((resWait, rejWait) => {
            const timer = setTimeout(() => {
              rejWait(new Error(`Timeout waiting for live SSE "${eventName}". Got: ${JSON.stringify(events.map((e) => e.event))}`));
            }, timeoutMs);
            timer.unref();
            waiters.push({ eventName, predicate, resolve: resWait, timer });
          });
        },
        close() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('AcpBridge (lib/acp.mjs)', () => {
  it('lazy-starts initialize, creates session with accept-edits default_mode, passes --sandbox when enabled, and handles noise/method-not-found', async () => {
    const dir = makeTempDir();
    const logFile = path.join(dir, 'agy-spawn.log');
    const prevLog = process.env.FAKE_AGY_LOG_FILE;
    const prevNoise = process.env.FAKE_AGY_EMIT_NOISE;
    const prevUnsupported = process.env.FAKE_AGY_UNSUPPORTED_MODEL;
    process.env.FAKE_AGY_LOG_FILE = logFile;
    process.env.FAKE_AGY_EMIT_NOISE = '1';
    process.env.FAKE_AGY_UNSUPPORTED_MODEL = '1';

    const bridgeNoSandbox = new AcpBridge({
      projectDir: dir,
      agyBin: FAKE_AGY,
      cfg: { chat: { enabled: true, default_mode: 'accept-edits', default_model: 'gemini-2.5-pro', sandbox: false } },
    });
    const bridgeSandbox = new AcpBridge({
      projectDir: dir,
      agyBin: FAKE_AGY,
      cfg: { chat: { enabled: true, default_mode: 'accept-edits', default_model: null, sandbox: true } },
    });

    try {
      // Lazy-start: konstruktor tidak langsung spawn
      assert.equal(bridgeNoSandbox.getStatus().connected, false);
      assert.equal(bridgeNoSandbox.child, null);
      assert.equal(fs.existsSync(logFile), false);

      const sess1 = await bridgeNoSandbox.createSession();
      assert.equal(sess1.ok, true);
      assert.equal(sess1.sessionId, 'cli-sess-new-1');
      assert.equal(sess1.mode, 'accept-edits');
      assert.equal(sess1.model, 'gemini-2.5-pro');
      assert.equal(bridgeNoSandbox.getStatus().connected, true);
      assert.equal(bridgeNoSandbox.getStatus().sandbox, false);

      // Sandbox bridge passes --sandbox
      const sess2 = await bridgeSandbox.createSession();
      assert.equal(sess2.ok, true);
      assert.equal(bridgeSandbox.getStatus().sandbox, true);

      const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(logLines.length, 2);
      assert.deepEqual(logLines[0].argv, ['acp', '--stdio']);
      assert.equal(logLines[0].sandbox, false);
      assert.deepEqual(logLines[1].argv, ['acp', '--stdio', '--sandbox']);
      assert.equal(logLines[1].sandbox, true);

      // Concurrent ensureConnected() coalesces to 1 spawn
      const bridgeCoalesce = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      try {
        await Promise.all([bridgeCoalesce.ensureConnected(), bridgeCoalesce.ensureConnected()]);
        const logAfter = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        assert.equal(logAfter.length, 3);
      } finally {
        await bridgeCoalesce.shutdown();
      }

      // Missing binary fails gracefully without leaving busy/starting stuck
      const bridgeMissing = new AcpBridge({
        projectDir: dir,
        agyBin: path.join(dir, 'tidak-ada-agy.exe'),
      });
      await assert.rejects(() => bridgeMissing.sendPrompt('halo'));
      assert.equal(bridgeMissing.getStatus().busy, false);
      assert.equal(bridgeMissing.getStatus().connected, false);
      assert.equal(bridgeMissing.starting, false);
      await bridgeMissing.shutdown();

      // setConfig validations (400) & valid mode update
      await assert.rejects(() => bridgeNoSandbox.setConfig({ mode: 'yolo' }), (err) => err?.status === 400);
      await assert.rejects(() => bridgeNoSandbox.setConfig({ model: '   ' }), (err) => err?.status === 400);
      const updated = await bridgeNoSandbox.setConfig({ mode: 'plan', model: 'gemini-2.5-flash' });
      assert.equal(updated.mode, 'plan');
      assert.equal(updated.model, 'gemini-2.5-flash');
    } finally {
      await bridgeNoSandbox.shutdown();
      await bridgeSandbox.shutdown();
      if (prevLog === undefined) delete process.env.FAKE_AGY_LOG_FILE;
      else process.env.FAKE_AGY_LOG_FILE = prevLog;
      if (prevNoise === undefined) delete process.env.FAKE_AGY_EMIT_NOISE;
      else process.env.FAKE_AGY_EMIT_NOISE = prevNoise;
      if (prevUnsupported === undefined) delete process.env.FAKE_AGY_UNSUPPORTED_MODEL;
      else process.env.FAKE_AGY_UNSUPPORTED_MODEL = prevUnsupported;
      cleanDir(dir);
    }
  });

  it('loadSession() enforces 400 empty id, 409 running outside ACP, 409 non-CLI session, and loads idle CLI session', async () => {
    const dir = makeTempDir();
    const runningSet = new Set(['cli-running']);
    const cliSet = new Set(['cli-running', 'cli-idle']);

    const bridge = new AcpBridge({
      projectDir: dir,
      agyBin: FAKE_AGY,
      isSessionRunningOutsideAcp: (id) => runningSet.has(id),
      isCliSession: (id) => cliSet.has(id),
    });

    try {
      await assert.rejects(() => bridge.loadSession('   '), (err) => err?.status === 400);
      await assert.rejects(() => bridge.loadSession(null), (err) => err?.status === 400);
      await assert.rejects(() => bridge.loadSession('cli-running'), (err) => err?.status === 409);
      await assert.rejects(() => bridge.loadSession('ide-session-1'), (err) => err?.status === 409);

      const loaded = await bridge.loadSession('cli-idle');
      assert.equal(loaded.ok, true);
      assert.equal(loaded.sessionId, 'cli-idle');
      assert.equal(bridge.getStatus().sessionId, 'cli-idle');
      assert.equal(bridge.getStatus().connected, true);
    } finally {
      await bridge.shutdown();
      cleanDir(dir);
    }
  });

  it('sendPrompt() streams session/update to SSE, rejects concurrent turn with 409, and cancelTurn() cancels cleanly', async () => {
    const dir = makeTempDir();
    const bridge = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
    const sse = createMockSseRes();

    try {
      bridge.subscribeSse(sse);
      const initEv = await sse.waitForEvent('init');
      assert.equal(initEv.data.status.connected, false);

      await assert.rejects(() => bridge.sendPrompt('   '), (err) => err?.status === 400);
      await assert.rejects(() => bridge.sendPrompt({ text: '' }), (err) => err?.status === 400);

      const res = await bridge.sendPrompt('Buat modul baru');
      assert.equal(res.status, 202);
      assert.equal(res.body.ok, true);
      assert.equal(bridge.getStatus().busy, true);

      // Concurrent turn rejected with 409
      await assert.rejects(() => bridge.sendPrompt('Giliran kedua'), (err) => err?.status === 409);

      await bridge.waitForTurn();
      assert.equal(bridge.getStatus().busy, false);

      await sse.waitForEvent('turn_done');
      const updates = sse.getEvents().filter((e) => e.event === 'session_update');
      assert.ok(updates.length >= 3);
      assert.ok(updates.some((u) => u.data.kind === 'tool_call'));
      assert.ok(updates.some((u) => String(u.data.text).includes('Buat modul baru')));

      // Slow turn + cancelTurn()
      const sse2 = createMockSseRes();
      bridge.subscribeSse(sse2);
      const slowRes = await bridge.sendPrompt('__SLOW_TURN__');
      assert.equal(slowRes.status, 202);
      assert.equal(bridge.getStatus().busy, true);
      await sse2.waitForEvent('session_update', 3000, (d) => String(d.text).includes('tugas panjang'));

      const cancelRes = await bridge.cancelTurn();
      assert.equal(cancelRes.ok, true);
      await bridge.waitForTurn();
      assert.equal(bridge.getStatus().busy, false);
      await sse2.waitForEvent('turn_cancelled');
      await sse2.waitForEvent('turn_done', 3000, (d) => d.stopReason === 'cancelled');
    } finally {
      await bridge.shutdown();
      cleanDir(dir);
    }
  });

  it('Review Focus #4: interactive permission broker allow_once, timeout auto-cancel (150ms), and clean shutdown without hang', async () => {
    const dir = makeTempDir();

    // 1. Allow once flow
    const bridgeAllow = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, permissionTimeoutMs: 5000 });
    const sseAllow = createMockSseRes();
    try {
      bridgeAllow.subscribeSse(sseAllow);
      const sendRes = await bridgeAllow.sendPrompt('__NEED_PERM__');
      assert.equal(sendRes.status, 202);

      const permEv = await sseAllow.waitForEvent('permission_request');
      const reqId = permEv.data.requestId;
      assert.ok(reqId);
      assert.equal(bridgeAllow.getStatus().pendingPermissionCount, 1);
      assert.ok(Array.isArray(permEv.data.options) && permEv.data.options.length === 3);

      await assert.rejects(() => bridgeAllow.respondPermission('unknown-id', 'allow_once'), (err) => err?.status === 404);
      await assert.rejects(() => bridgeAllow.respondPermission(reqId, ''), (err) => err?.status === 400);

      const resolved = await bridgeAllow.respondPermission(reqId, 'allow_once');
      assert.equal(resolved.ok, true);
      assert.equal(bridgeAllow.getStatus().pendingPermissionCount, 0);

      await bridgeAllow.waitForTurn();
      assert.equal(bridgeAllow.getStatus().busy, false);
      await sseAllow.waitForEvent('permission_resolved');
      await sseAllow.waitForEvent('session_update', 3000, (d) => String(d.text).includes('(allowed)'));
    } finally {
      await bridgeAllow.shutdown();
    }

    // 1b. Permission explicit cancel flow + SSE client disconnect cleanup
    const bridgeCancel = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, permissionTimeoutMs: 5000 });
    const sseCancel = createMockSseRes();
    const sseTransient = createMockSseRes();
    try {
      bridgeCancel.subscribeSse(sseCancel);
      bridgeCancel.subscribeSse(sseTransient);
      assert.equal(bridgeCancel.sseClients.size, 2);
      sseTransient.emitClose();
      assert.equal(bridgeCancel.sseClients.size, 1);

      await bridgeCancel.sendPrompt('__NEED_PERM__');
      const permEv = await sseCancel.waitForEvent('permission_request');
      await bridgeCancel.respondPermission(permEv.data.requestId, 'cancel');
      await bridgeCancel.waitForTurn();
      await sseCancel.waitForEvent('session_update', 2000, (d) => String(d.text).includes('(cancelled)'));
    } finally {
      await bridgeCancel.shutdown();
    }

    // 2. Permission timeout auto-cancels after 150ms
    const bridgeTimeout = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, permissionTimeoutMs: 150 });
    const sseTimeout = createMockSseRes();
    try {
      bridgeTimeout.subscribeSse(sseTimeout);
      await bridgeTimeout.sendPrompt('__NEED_PERM__');

      await sseTimeout.waitForEvent('permission_request');
      assert.equal(bridgeTimeout.getStatus().pendingPermissionCount, 1);

      await sseTimeout.waitForEvent('permission_timeout', 2000);
      assert.equal(bridgeTimeout.getStatus().pendingPermissionCount, 0);

      await bridgeTimeout.waitForTurn();
      assert.equal(bridgeTimeout.getStatus().busy, false);
      await sseTimeout.waitForEvent('session_update', 2000, (d) => String(d.text).includes('(cancelled)'));
    } finally {
      await bridgeTimeout.shutdown();
    }

    // 3. Shutdown while permission pending kills child and cleans timers promptly without hanging
    const bridgeShutdown = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, permissionTimeoutMs: 60_000 });
    const sseShutdown = createMockSseRes();
    try {
      bridgeShutdown.subscribeSse(sseShutdown);
      await bridgeShutdown.sendPrompt('__NEED_PERM__');
      await sseShutdown.waitForEvent('permission_request');
      assert.equal(bridgeShutdown.getStatus().pendingPermissionCount, 1);

      const childRef = bridgeShutdown.child;
      assert.ok(childRef && childRef.pid);

      const t0 = Date.now();
      await bridgeShutdown.shutdown();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2000, `shutdown harus cepat (< 2000ms), aktual ${elapsed}ms`);
      assert.equal(bridgeShutdown.getStatus().connected, false);
      assert.equal(bridgeShutdown.getStatus().busy, false);
      assert.equal(bridgeShutdown.getStatus().pendingPermissionCount, 0);
      assert.equal(sseShutdown.writableEnded, true);
      assert.ok(childRef.exitCode !== null || childRef.signalCode !== null || childRef.killed);
    } finally {
      cleanDir(dir);
    }
  });

  it('caps history buffer at 200 entries and recovers cleanly if child crashes mid-turn', async () => {
    const dir = makeTempDir();
    const bridge = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
    const sse = createMockSseRes();

    try {
      bridge.subscribeSse(sse);
      // Crash recovery
      await bridge.sendPrompt('__CRASH_TURN__');
      await bridge.waitForTurn();
      await sse.waitForEvent('turn_error');
      assert.equal(bridge.getStatus().busy, false);
      assert.equal(bridge.getStatus().connected, false);

      // Subsequent prompt respawns transparently
      const recovered = await bridge.sendPrompt('Pulih kembali');
      assert.equal(recovered.status, 202);
      await bridge.waitForTurn();
      assert.equal(bridge.getStatus().connected, true);
      assert.equal(bridge.getStatus().busy, false);

      // Push > 200 history entries via _pushHistory / updates
      for (let i = 0; i < 250; i++) {
        bridge._pushHistory({ type: 'message', role: 'user', text: `msg-${i}`, ts: new Date().toISOString() });
      }
      const hist = bridge.getHistory();
      assert.equal(hist.length, 200);
      assert.equal(hist[0].text, 'msg-50');
      assert.equal(hist[199].text, 'msg-249');
    } finally {
      await bridge.shutdown();
      cleanDir(dir);
    }
  });
});

describe('serve.mjs + AcpBridge HTTP integration', () => {
  it('wires default lazy AcpBridge into createKantorServer for /state, /session, /send, /permission, /cancel, /stream, and clean shutdown', async () => {
    const base = makeTempDir('kantor-acp-http-');
    const projectDir = path.join(base, 'project');
    const storageDir = path.join(base, 'storage');
    const agHome = path.join(base, 'ag-home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(agHome, { recursive: true });

    seedConversation(agHome, projectDir, 'cli-idle-1', {
      title: 'CLI Idle Session',
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
    });
    seedConversation(agHome, projectDir, 'cli-running-1', {
      title: 'CLI Active External',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
    });
    seedConversation(agHome, projectDir, 'ide-idle-1', {
      title: 'Desktop IDE Session',
      status: 'CASCADE_RUN_STATUS_IDLE',
      source: 'CORTEX_TRAJECTORY_SOURCE_IDE',
      app_data_dir: 'antigravity',
    });

    const prevAg = process.env.ANTIGRAVITY_HOME;
    const prevBin = process.env.KANTOR_AGY_BIN;
    process.env.ANTIGRAVITY_HOME = agHome;
    process.env.KANTOR_AGY_BIN = FAKE_AGY;

    const cfg = loadConfig(RUNTIME_DIR, projectDir);
    const server = createKantorServer({
      projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir,
      cfg,
    });

    let liveSse = null;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;

      // State sebelum lazy-start
      const state0 = await rawRequest(port, { reqPath: '/kerja/api/state', headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(state0.status, 200);
      assert.equal(state0.json.chat.connected, false);
      assert.equal(state0.json.chat.busy, false);

      // Loopback auth cookie
      const authRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(authRes.status, 200);
      const cookiePair = String(authRes.headers['set-cookie'][0]).split(';')[0];

      // Live SSE stream
      liveSse = await openLiveSse(port, '/kerja/api/chat/stream', {
        Host: `127.0.0.1:${port}`,
        Cookie: cookiePair,
      });
      assert.equal(liveSse.status, 200);
      const initEv = await liveSse.waitForEvent('init');
      assert.equal(initEv.data.status.connected, false);

      // Guard: running external CLI session -> 409; IDE session -> 409
      const loadRunning = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/session',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { sessionId: 'cli-running-1' },
      });
      assert.equal(loadRunning.status, 409);

      const loadIde = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/session',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { sessionId: 'ide-idle-1' },
      });
      assert.equal(loadIde.status, 409);

      // Load idle CLI session + mode 'plan'
      const loadOk = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/session',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { sessionId: 'cli-idle-1', mode: 'plan' },
      });
      assert.equal(loadOk.status, 200);
      assert.equal(loadOk.json.sessionId, 'cli-idle-1');
      assert.equal(loadOk.json.status.connected, true);
      assert.equal(loadOk.json.status.mode, 'plan');

      // Send prompt requiring permission
      const sendPerm = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: '__NEED_PERM__' },
      });
      assert.equal(sendPerm.status, 202);

      const permReqEv = await liveSse.waitForEvent('permission_request');
      const permRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/permission',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { requestId: permReqEv.data.requestId, optionId: 'allow_once' },
      });
      assert.equal(permRes.status, 200);
      await liveSse.waitForEvent('turn_done');

      // Slow turn + cancel via HTTP
      const sendSlow = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: '__SLOW_TURN__' },
      });
      assert.equal(sendSlow.status, 202);
      await liveSse.waitForEvent('session_update', 3000, (d) => String(d.text).includes('tugas panjang'));

      const cancelHttp = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/cancel',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(cancelHttp.status, 200);
      await liveSse.waitForEvent('turn_cancelled');
    } finally {
      liveSse?.close();
      await new Promise((resolve) => server.close(resolve));
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      if (prevBin === undefined) delete process.env.KANTOR_AGY_BIN;
      else process.env.KANTOR_AGY_BIN = prevBin;
      cleanDir(base);
    }
  });
});
