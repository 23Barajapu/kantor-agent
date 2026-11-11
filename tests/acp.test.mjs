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
import { isCliMain } from '../skills/kantor-agent/runtime/lib/transcripts.mjs';
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
      let ended = false;
      const endWaiters = [];
      res.setEncoding('utf8');
      res.on('end', () => {
        ended = true;
        while (endWaiters.length) endWaiters.shift()();
      });
      res.on('close', () => {
        ended = true;
        while (endWaiters.length) endWaiters.shift()();
      });
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
        isEnded: () => ended,
        waitForEnd(timeoutMs = 3000) {
          if (ended) return Promise.resolve();
          return new Promise((resEnd, rejEnd) => {
            const t = setTimeout(() => rejEnd(new Error('Timeout waiting for SSE end')), timeoutMs);
            t.unref();
            endWaiters.push(() => {
              clearTimeout(t);
              resEnd();
            });
          });
        },
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

      // Memuat ulang sesi yang sudah aktif pada bridge ini berhasil tanpa false-positive 409
      runningSet.add('cli-idle');
      const reloadedSame = await bridge.loadSession('cli-idle');
      assert.equal(reloadedSame.ok, true);
      assert.equal(reloadedSame.sessionId, 'cli-idle');

      // Namun saat busy === true, loadSession wajib menolak 409
      bridge.busy = true;
      await assert.rejects(() => bridge.loadSession('cli-idle'), (err) => err?.status === 409);
      bridge.busy = false;
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
        assert.equal(bridgeShutdown.getStatus().sessionId, null);
        assert.equal(bridgeShutdown.getStatus().pendingPermissionCount, 0);
        assert.equal(sseShutdown.writableEnded, true);
        assert.ok(childRef.exitCode !== null || childRef.signalCode !== null || childRef.killed);
      } finally {
        await bridgeShutdown.shutdown();
      }
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
      // Crash recovery: sessionId wajib reset ke null saat child mati,
      // streaming assistant entry difinalisasi, dan _turnPromise bersih (null setelah settle)
      await bridge.sendPrompt('__CRASH_TURN__');
      const turnOutcome = await bridge.waitForTurn();
      assert.equal(turnOutcome.ok, false);
      await sse.waitForEvent('turn_error');
      assert.equal(bridge.getStatus().busy, false);
      assert.equal(bridge.getStatus().connected, false);
      assert.equal(bridge.getStatus().sessionId, null);
      assert.equal(bridge._turnPromise, null);
      assert.equal(await bridge.waitForTurn(), null);
      const crashedAssistant = bridge.history.find(
        (h) => h.type === 'message' && h.role === 'assistant' && String(h.text).includes('Sebelum crash')
      );
      assert.ok(crashedAssistant, 'streamed assistant chunk before crash must be recorded in history');
      assert.notEqual(crashedAssistant._streaming, true, 'streamed assistant entry must be finalized on child crash');

      // Guard: stale rejection from an old crashed turn must not clobber a newly started turn's busy/lastError/turnPromise
      const prevDelay = process.env.FAKE_AGY_PROMPT_DELAY_MS;
      process.env.FAKE_AGY_PROMPT_DELAY_MS = '300';
      try {
        await bridge.createSession();
        // Manually trigger a turn that rejects asynchronously after we start a second turn
        await bridge.sendPrompt('__SLOW_TURN__');
        const oldTurnPromise = bridge._turnPromise;
        const oldChild = bridge.child;
        // Simulate child drop -> _handleChildExit resets busy=false & _activeTurnId=0, rejects pending rpcPromise
        bridge._handleChildExit(oldChild, 'old turn dropped', true);
        try { oldChild?.kill('SIGKILL'); } catch {}
        // Start a brand-new turn BEFORE oldTurnPromise's microtask runs!
        const newTurnStartPromise = bridge.sendPrompt('__TIMED_TURN__');
        const newStatusWhileStarting = bridge.getStatus();
        assert.equal(newStatusWhileStarting.busy, true);
        assert.equal(newStatusWhileStarting.lastError, null);
        await oldTurnPromise;
        await newTurnStartPromise;
        // After oldTurnPromise settles, the NEW turn must STILL be busy with null lastError!
        assert.equal(bridge.getStatus().busy, true);
        assert.equal(bridge.getStatus().lastError, null);
        assert.notEqual(bridge._turnPromise, null);
        const newOutcome = await bridge.waitForTurn();
        assert.equal(newOutcome.ok, true);
        assert.equal(bridge.getStatus().busy, false);
        assert.equal(bridge._turnPromise, null);
      } finally {
        if (prevDelay === undefined) delete process.env.FAKE_AGY_PROMPT_DELAY_MS;
        else process.env.FAKE_AGY_PROMPT_DELAY_MS = prevDelay;
      }

      // Subsequent prompt respawns transparently dan menghasilkan sessionId baru
      const recovered = await bridge.sendPrompt('Pulih kembali');
      assert.equal(recovered.status, 202);
      await bridge.waitForTurn();
      assert.equal(bridge.getStatus().connected, true);
      assert.equal(bridge.getStatus().busy, false);
      assert.ok(bridge.getStatus().sessionId);

      // Oversized stdout line > 4 MB dibuang aman tanpa crash & baris valid berikutnya tetap terbaca
      const oversizedRes = await bridge.sendPrompt('__OVERSIZED_STDOUT__');
      assert.equal(oversizedRes.status, 202);
      await bridge.waitForTurn();
      await sse.waitForEvent('error', 3000, (d) => String(d.error).includes('4 MB'));
      await sse.waitForEvent('session_update', 3000, (d) => String(d.text).includes('Pulih setelah baris >4MB'));

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

  it('supports createSession({ mode, model }) single-RPC setup, sendPrompt pre-validation, rpcTimeoutMs (not prompt), Windows .cmd, and post-shutdown idempotency', async () => {
    const dir = makeTempDir('kantor-acp-hardening-');
    const rpcLog = path.join(dir, 'rpc.log');
    const prevRpcLog = process.env.FAKE_AGY_RPC_LOG;
    const prevDelay = process.env.FAKE_AGY_PROMPT_DELAY_MS;
    const prevHangInit = process.env.FAKE_AGY_HANG_INIT;
    process.env.FAKE_AGY_RPC_LOG = rpcLog;
    process.env.FAKE_AGY_PROMPT_DELAY_MS = '1400';

    try {
      // 1. sendPrompt validates mode/model BEFORE locking busy or spawning child
      const bridgeVal = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, rpcTimeoutMs: 1200 });
      await assert.rejects(
        () => bridgeVal.sendPrompt({ text: 'Halo', mode: 'invalid-mode' }),
        (err) => err?.status === 400
      );
      await assert.rejects(
        () => bridgeVal.sendPrompt({ text: 'Halo', model: '   ' }),
        (err) => err?.status === 400
      );
      assert.equal(bridgeVal.getStatus().busy, false);
      assert.equal(bridgeVal.getStatus().connected, false);
      assert.equal(bridgeVal.getStatus().sessionId, null);
      assert.equal(bridgeVal.child, null);

      // 2. createSession({ mode, model }) sends session/set_mode only ONCE + session/prompt ignores rpcTimeoutMs (1400ms > 1200ms)
      const created = await bridgeVal.createSession({ mode: 'plan', model: 'gemini-2.5-pro' });
      assert.equal(created.ok, true);
      assert.equal(created.mode, 'plan');
      assert.equal(created.model, 'gemini-2.5-pro');
      const rpcs = fs.readFileSync(rpcLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const setModeCalls = rpcs.filter((r) => r.method === 'session/set_mode');
      assert.equal(setModeCalls.length, 1);
      assert.equal(setModeCalls[0].params.modeId, 'plan');

      const slowPromptRes = await bridgeVal.sendPrompt('__TIMED_TURN__');
      assert.equal(slowPromptRes.status, 202);
      const turnOutcome = await bridgeVal.waitForTurn();
      assert.equal(turnOutcome.ok, true);
      assert.equal(turnOutcome.result.stopReason, 'end_turn');

      // 3. Idempotent shutdown() 2x and post-shutdown calls fail cleanly with 503 without respawning
      await bridgeVal.shutdown();
      await bridgeVal.shutdown();
      assert.equal(bridgeVal.child, null);
      await assert.rejects(() => bridgeVal.createSession(), (err) => err?.status === 503);
      await assert.rejects(() => bridgeVal.loadSession('cli-idle'), (err) => err?.status === 503);
      await assert.rejects(() => bridgeVal.sendPrompt('halo'), (err) => err?.status === 503);
      assert.equal(bridgeVal.child, null);

      // 4. Control RPC timeout (rpcTimeoutMs: 120) when child hangs on initialize
      process.env.FAKE_AGY_HANG_INIT = '1';
      const bridgeHang = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY, rpcTimeoutMs: 120 });
      await assert.rejects(() => bridgeHang.createSession(), /Batas waktu RPC ACP/);
      assert.equal(bridgeHang.getStatus().connected, false);
      assert.equal(bridgeHang.getStatus().busy, false);
      assert.equal(bridgeHang.starting, false);
      assert.equal(bridgeHang.child, null);
      await bridgeHang.shutdown();
      delete process.env.FAKE_AGY_HANG_INIT;

      // 5. Windows .cmd wrapper execution via ComSpec & metacharacter rejection (only on win32)
      if (process.platform === 'win32') {
        const cmdPath = path.join(dir, 'agy (x86) wrapper.cmd');
        fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${FAKE_AGY}" %*\r\n`, 'utf8');
        const bridgeCmd = new AcpBridge({
          projectDir: dir,
          agyBin: cmdPath,
          cfg: { chat: { sandbox: true } },
        });
        try {
          const cmdSess = await bridgeCmd.createSession();
          assert.equal(cmdSess.ok, true);
          assert.equal(bridgeCmd._initResult?._meta?.sandbox, true);
        } finally {
          await bridgeCmd.shutdown();
        }

        for (const badCmdName of ['agy&calc.cmd', 'agy;calc.cmd', 'agy=val.cmd']) {
          const unsafeCmdBridge = new AcpBridge({
            projectDir: dir,
            agyBin: path.join(dir, badCmdName),
          });
          await assert.rejects(() => unsafeCmdBridge.createSession(), /tidak aman/);
          assert.equal(unsafeCmdBridge.child, null);
          await unsafeCmdBridge.shutdown();
        }
      }

      // 6. Multi-byte UTF-8 split across chunks & trailing NDJSON frame with UTF-8 emitted right before stdout close
      const bridgeFrames = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      const sseFrames = createMockSseRes();
      try {
        bridgeFrames.subscribeSse(sseFrames);
        await bridgeFrames.sendPrompt('__SPLIT_UTF8__');
        await bridgeFrames.waitForTurn();
        await sseFrames.waitForEvent('session_update', 3000, (d) => String(d.text).includes('Halo 🚀 dunia'));

        await bridgeFrames.sendPrompt('__TRAILING_FRAME_EXIT__');
        await bridgeFrames.waitForTurn();
        await sseFrames.waitForEvent('session_update', 3000, (d) =>
          String(d.text).includes('Frame terakhir tanpa newline 🚀')
        );
      } finally {
        await bridgeFrames.shutdown();
      }

      // 6b. sendPrompt({ text, mode, model }) on an ALREADY active session uses _setConfigInternal without 409,
      //     and failed _applySessionMode in createSession() rolls back without leaving orphan sessionId/_boundChild
      const bridgeOverride = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      try {
        const sInit = await bridgeOverride.createSession();
        assert.equal(sInit.mode, 'accept-edits');
        const promptOverrideRes = await bridgeOverride.sendPrompt({
          text: 'uji mode',
          mode: 'plan',
          model: 'gemini-test',
        });
        assert.equal(promptOverrideRes.status, 202);
        assert.equal(promptOverrideRes.body.ok, true);
        assert.equal(bridgeOverride.getStatus().mode, 'plan');
        assert.equal(bridgeOverride.getStatus().model, 'gemini-test');
        await bridgeOverride.waitForTurn();
      } finally {
        await bridgeOverride.shutdown();
      }

      const prevFailSetMode = process.env.FAKE_AGY_FAIL_SET_MODE;
      process.env.FAKE_AGY_FAIL_SET_MODE = '1';
      const bridgeRollback = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      try {
        await assert.rejects(() => bridgeRollback.createSession(), /Invalid mode forced by test/);
        assert.equal(bridgeRollback.getStatus().sessionId, null);
        assert.equal(bridgeRollback._boundChild, null);
      } finally {
        if (prevFailSetMode === undefined) delete process.env.FAKE_AGY_FAIL_SET_MODE;
        else process.env.FAKE_AGY_FAIL_SET_MODE = prevFailSetMode;
        await bridgeRollback.shutdown();
      }

      // 7. fake-agy rejects -32602 for unknown/uncreated sessionId, openSession rejects ""/{} with 400, and _sessionBusy blocks parallel races (409)
      const prevSlowNew = process.env.FAKE_AGY_SLOW_NEW_MS;
      process.env.FAKE_AGY_SLOW_NEW_MS = '180';
      const bridgeRace = new AcpBridge({
        projectDir: dir,
        agyBin: FAKE_AGY,
        isCliSession: () => true,
      });
      try {
        await bridgeRace.ensureConnected();
        await assert.rejects(
          () => bridgeRace._sendRpc('session/prompt', { sessionId: 'tidak-pernah-dibuat', prompt: [{ type: 'text', text: 'x' }] }),
          (err) => err?.code === -32602
        );

        await assert.rejects(() => bridgeRace.openSession({ sessionId: '' }), (err) => err?.status === 400);
        await assert.rejects(() => bridgeRace.openSession({ sessionId: {} }), (err) => err?.status === 400);

        const [r1, r2] = await Promise.allSettled([
          bridgeRace.createSession(),
          bridgeRace.loadSession('cli-idle'),
        ]);
        const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejected = [r1, r2].filter((r) => r.status === 'rejected');
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason?.status, 409);
      } finally {
        if (prevSlowNew === undefined) delete process.env.FAKE_AGY_SLOW_NEW_MS;
        else process.env.FAKE_AGY_SLOW_NEW_MS = prevSlowNew;
        await bridgeRace.shutdown();
      }

      // 8. Mid-startup cancellation in sendPrompt() aborts cleanly without pushing history or overwriting lastError
      process.env.FAKE_AGY_SLOW_NEW_MS = '220';
      const bridgeStartupCancel = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      try {
        const sendPromise = bridgeStartupCancel.sendPrompt('Jangan pernah dikirim');
        await new Promise((r) => setTimeout(r, 40));
        await bridgeStartupCancel.cancelTurn();
        await assert.rejects(() => sendPromise, (err) => err?.status === 409);
        assert.equal(bridgeStartupCancel.getStatus().busy, false);
        assert.equal(bridgeStartupCancel.getStatus().lastError, null);
        assert.equal(
          bridgeStartupCancel.getHistory().some((h) => h.role === 'user' && h.text === 'Jangan pernah dikirim'),
          false
        );
      } finally {
        if (prevSlowNew === undefined) delete process.env.FAKE_AGY_SLOW_NEW_MS;
        else process.env.FAKE_AGY_SLOW_NEW_MS = prevSlowNew;
        await bridgeStartupCancel.shutdown();
      }

      // 9. isCliMain rejects false-positive 'CLIENT' source & late close on stale child1 does not clobber child2
      assert.equal(
        isCliMain({ nesting_depth: 0, source: 'CORTEX_TRAJECTORY_SOURCE_CLIENT', app_data_dir: 'antigravity', dbRoot: '/x/antigravity' }),
        false
      );
      assert.equal(
        isCliMain({ nesting_depth: 0, source: 'CORTEX_TRAJECTORY_SOURCE_CLI', app_data_dir: 'antigravity', dbRoot: '/x/antigravity' }),
        true
      );
      assert.equal(
        isCliMain({ nesting_depth: 0, source: 'ACP_CLI', app_data_dir: 'antigravity', dbRoot: '/x/antigravity' }),
        true
      );

      const bridgeLateClose = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      try {
        await bridgeLateClose.createSession();
        const child1 = bridgeLateClose.child;
        const child2 = new EventEmitter();
        bridgeLateClose.child = child2;
        bridgeLateClose._boundChild = child2;
        bridgeLateClose.connected = true;
        bridgeLateClose.sessionId = 'sess-child-2';

        bridgeLateClose._handleChildExit(child1, 'stale error', true);
        assert.equal(bridgeLateClose.child, child2);
        assert.equal(bridgeLateClose._boundChild, child2);
        assert.equal(bridgeLateClose.connected, true);
        assert.equal(bridgeLateClose.sessionId, 'sess-child-2');
        assert.equal(bridgeLateClose.lastError, null);
        // Restore child1 so shutdown cleans up the real child cleanly
        bridgeLateClose.child = child1;
      } finally {
        await bridgeLateClose.shutdown();
      }

      // 10. Dead child1 (exitCode !== null before 'close') respawns child2 on sendPrompt() while preserving busy lock (409)
      const bridgeRespawnBusy = new AcpBridge({ projectDir: dir, agyBin: FAKE_AGY });
      let oldRealChild = null;
      try {
        await bridgeRespawnBusy.createSession();
        oldRealChild = bridgeRespawnBusy.child;
        // Buat deadChild1 yang sudah berstatus exitCode = 1 sementara 'close' belum tiba
        const deadChild1 = new EventEmitter();
        deadChild1.exitCode = 1;
        deadChild1.signalCode = null;
        deadChild1.stdin = { writable: true, destroyed: false, end() {}, on() {} };
        bridgeRespawnBusy.child = deadChild1;
        bridgeRespawnBusy._boundChild = deadChild1;
        bridgeRespawnBusy.sessionId = 'dead-sess-before-close';
        bridgeRespawnBusy.connected = true;

        const sendP1 = bridgeRespawnBusy.sendPrompt('__TIMED_TURN__');
        assert.equal(bridgeRespawnBusy.getStatus().busy, true);
        await assert.rejects(() => bridgeRespawnBusy.sendPrompt('Konkuren saat respawn'), (err) => err?.status === 409);

        const resP1 = await sendP1;
        assert.equal(resP1.status, 202);
        assert.equal(bridgeRespawnBusy.getStatus().busy, true);
        assert.notEqual(bridgeRespawnBusy.child, deadChild1);
        assert.notEqual(bridgeRespawnBusy.getStatus().sessionId, 'dead-sess-before-close');
        await assert.rejects(() => bridgeRespawnBusy.sendPrompt('Konkuren saat turn aktif'), (err) => err?.status === 409);

        const timedRes = await bridgeRespawnBusy.waitForTurn();
        assert.equal(timedRes.ok, true);
        assert.equal(bridgeRespawnBusy.getStatus().busy, false);
      } finally {
        // Bersihkan oldRealChild yang sempat dilepas
        try {
          oldRealChild?.stdin?.end();
          oldRealChild?.kill('SIGTERM');
        } catch {}
        await bridgeRespawnBusy.shutdown();
      }

      // 11. Windows .cmd tree termination via taskkill /T /F kills grandchild node.exe even when EOF is ignored (win32 only)
      if (process.platform === 'win32') {
        const cmdTreeLog = path.join(dir, 'cmd-tree.log');
        const prevLogTree = process.env.FAKE_AGY_LOG_FILE;
        const prevIgnoreEof = process.env.FAKE_AGY_IGNORE_EOF;
        process.env.FAKE_AGY_LOG_FILE = cmdTreeLog;
        process.env.FAKE_AGY_IGNORE_EOF = '1';

        const cmdHangPath = path.join(dir, 'agy hang wrapper.cmd');
        fs.writeFileSync(cmdHangPath, `@echo off\r\n"${process.execPath}" "${FAKE_AGY}" %*\r\n`, 'utf8');
        const bridgeCmdTree = new AcpBridge({
          projectDir: dir,
          agyBin: cmdHangPath,
        });
        try {
          await bridgeCmdTree.sendPrompt('__SLOW_TURN__');
          const logEntry = JSON.parse(fs.readFileSync(cmdTreeLog, 'utf8').trim().split('\n')[0]);
          const grandchildPid = logEntry.pid;
          assert.ok(Number.isInteger(grandchildPid));

          await bridgeCmdTree.shutdown();
          // Tunggu sejenak agar OS membersihkan tabel proses setelah taskkill /T /F
          await new Promise((r) => setTimeout(r, 150));
          let stillAlive = true;
          try {
            process.kill(grandchildPid, 0);
          } catch (err) {
            if (err?.code === 'ESRCH') stillAlive = false;
          }
          assert.equal(stillAlive, false, `Grandchild node PID ${grandchildPid} wajib mati oleh taskkill /T /F`);
        } finally {
          await bridgeCmdTree.shutdown();
          if (prevLogTree === undefined) delete process.env.FAKE_AGY_LOG_FILE;
          else process.env.FAKE_AGY_LOG_FILE = prevLogTree;
          if (prevIgnoreEof === undefined) delete process.env.FAKE_AGY_IGNORE_EOF;
          else process.env.FAKE_AGY_IGNORE_EOF = prevIgnoreEof;
        }
      }
    } finally {
      if (prevRpcLog === undefined) delete process.env.FAKE_AGY_RPC_LOG;
      else process.env.FAKE_AGY_RPC_LOG = prevRpcLog;
      if (prevDelay === undefined) delete process.env.FAKE_AGY_PROMPT_DELAY_MS;
      else process.env.FAKE_AGY_PROMPT_DELAY_MS = prevDelay;
      if (prevHangInit === undefined) delete process.env.FAKE_AGY_HANG_INIT;
      else process.env.FAKE_AGY_HANG_INIT = prevHangInit;
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

      // GET /kerja/api/state saat izin menggantung wajib memantulkan status ACP aktif
      const stateBusy = await rawRequest(port, { reqPath: '/kerja/api/state', headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(stateBusy.status, 200);
      assert.equal(stateBusy.json.chat.connected, true);
      assert.equal(stateBusy.json.chat.busy, true);
      assert.equal(stateBusy.json.chat.pending_permission_count, 1);
      assert.equal(stateBusy.json.chat.session_id, 'cli-idle-1');

      const permRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/permission',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { requestId: permReqEv.data.requestId, optionId: 'allow_once' },
      });
      assert.equal(permRes.status, 200);
      await liveSse.waitForEvent('turn_done');

      // Reload sesi aktif yang sedang terhubung dengan bridge ini tetap 200
      const reloadSelf = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/session',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { sessionId: 'cli-idle-1' },
      });
      assert.equal(reloadSelf.status, 200);
      assert.equal(reloadSelf.json.sessionId, 'cli-idle-1');

      // sendPrompt({ text, mode, model }) pada sesi yang sudah aktif via HTTP berhasil 202 (tanpa 409)
      const sendOverrideHttp = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: 'uji mode', mode: 'auto', model: 'gemini-test' },
      });
      assert.equal(sendOverrideHttp.status, 202);
      assert.equal(sendOverrideHttp.json.ok, true);
      assert.equal(sendOverrideHttp.json.status.mode, 'auto');
      assert.equal(sendOverrideHttp.json.status.model, 'gemini-test');
      await liveSse.waitForEvent('turn_done', 3000, (d) => d.status?.mode === 'auto');
      await server.acpBridge.waitForTurn();

      // Slow turn + concurrent HTTP 409 + cancel via HTTP
      const sendSlow = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: '__SLOW_TURN__' },
      });
      assert.equal(sendSlow.status, 202);
      await liveSse.waitForEvent('session_update', 3000, (d) => String(d.text).includes('tugas panjang'));

      const sendConflictHttp = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: 'Konflik saat sibuk' },
      });
      assert.equal(sendConflictHttp.status, 409);

      const cancelHttp = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/cancel',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(cancelHttp.status, 200);
      await liveSse.waitForEvent('turn_cancelled');
      await server.acpBridge.waitForTurn();

      // server.close() sambil klien SSE masih terbuka wajib menutup SSE dan child secara bersih
      const spawnedChild = server.acpBridge.child;
      assert.ok(spawnedChild);
      await new Promise((resolve) => server.close(resolve));
      await liveSse.waitForEnd();
      assert.equal(liveSse.isEnded(), true);
      liveSse = null;
      assert.equal(server.acpBridge.getStatus().connected, false);
      assert.ok(spawnedChild.exitCode !== null || spawnedChild.signalCode !== null || spawnedChild.killed);
    } finally {
      liveSse?.close();
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      if (prevBin === undefined) delete process.env.KANTOR_AGY_BIN;
      else process.env.KANTOR_AGY_BIN = prevBin;
      cleanDir(base);
    }
  });

  it('returns redacted 500 without leaking paths when agyBin is missing (ENOENT)', async () => {
    const base = makeTempDir('kantor-acp-enoent-');
    const projectDir = path.join(base, 'project');
    const storageDir = path.join(base, 'storage');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });

    const missingSecretBin = path.join(base, 'rahasia-internal-tidak-ada', 'agy-secret.exe');
    const cfg = loadConfig(RUNTIME_DIR, projectDir);
    const server = createKantorServer({
      projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir,
      cfg,
      agyBin: missingSecretBin,
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      const origin = `http://127.0.0.1:${port}`;
      const authRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' },
        body: {},
      });
      const cookiePair = String(authRes.headers['set-cookie'][0]).split(';')[0];

      const res = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: origin, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: 'Halo' },
      });
      assert.equal(res.status, 500);
      assert.equal(res.json?.ok, false);
      assert.equal(res.text.includes('rahasia-internal-tidak-ada'), false);
      assert.equal(res.text.includes('agy-secret.exe'), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      cleanDir(base);
    }
  });
});
