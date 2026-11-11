import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const args = process.argv.slice(2);
const hasAcp = args.includes('acp');
const hasStdio = args.includes('--stdio');
const hasSandbox = args.includes('--sandbox');

if (process.env.FAKE_AGY_LOG_FILE) {
  try {
    fs.appendFileSync(
      process.env.FAKE_AGY_LOG_FILE,
      JSON.stringify({ pid: process.pid, argv: args, sandbox: hasSandbox, cwd: process.cwd() }) + '\n',
      'utf8'
    );
  } catch {}
}

if (args[0] === 'models') {
  const delayMs = Number(process.env.FAKE_AGY_MODELS_DELAY_MS || 0);
  const exitCode = Number(process.env.FAKE_AGY_MODELS_EXIT ?? 0);
  const defaultModelsOut = [
    'gemini-2.5-pro\tGemini 2.5 Pro',
    'gemini-2.5-flash\tGemini 2.5 Flash',
    'claude-3-7-sonnet\tClaude 3.7 Sonnet',
  ].join('\n') + '\n';
  const modelsOut = process.env.FAKE_AGY_MODELS_OUT !== undefined
    ? process.env.FAKE_AGY_MODELS_OUT
    : defaultModelsOut;

  const run = () => {
    if (process.env.FAKE_AGY_MODELS_NO_STDERR !== '1') {
      process.stderr.write('Fetching available models...\n');
    }
    if (exitCode === 0) {
      process.stdout.write(modelsOut);
    } else {
      process.stderr.write('Error fetching models\n');
    }
    process.exit(exitCode);
  };

  if (delayMs > 0) {
    setTimeout(run, delayMs);
  } else {
    run();
  }
} else if (!hasAcp || !hasStdio) {
  process.stderr.write(`fake-agy: expected "acp --stdio", got ${JSON.stringify(args)}\n`);
  process.exit(2);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

if (process.env.FAKE_AGY_EMIT_NOISE === '1') {
  process.stdout.write('[agy] banner noise line without json\r\n');
  process.stdout.write('{malformed json line\n');
}

let sessionSeq = 0;
const sessions = new Map();
let nextServerId = 1000;
const pendingClientRequests = new Map();
let activeTurn = null;

function cancelActiveTurn() {
  if (!activeTurn) return;
  const turn = activeTurn;
  activeTurn = null;
  if (turn.timer) clearTimeout(turn.timer);
  if (turn.permCleanup) turn.permCleanup();
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: turn.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Giliran dibatalkan' },
      },
    },
  });
  send({
    jsonrpc: '2.0',
    id: turn.rpcId,
    result: { stopReason: 'cancelled' },
  });
}

function handlePrompt(msg) {
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (!sessionId || !sessions.has(sessionId)) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32602, message: `Unknown sessionId: ${sessionId}` },
    });
    return;
  }
  const promptParts = Array.isArray(params.prompt) ? params.prompt : [];
  const text = promptParts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');

  if (text.includes('__SPLIT_UTF8__')) {
    const rawLine = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Halo 🚀 dunia' },
          },
        },
      }) + '\n',
      'utf8'
    );
    const rocketIdx = rawLine.indexOf(Buffer.from('🚀', 'utf8'));
    const splitAt = rocketIdx + 2;
    process.stdout.write(rawLine.subarray(0, splitAt));
    setTimeout(() => {
      process.stdout.write(rawLine.subarray(splitAt));
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }, 15);
    return;
  }

  if (text.includes('__TRAILING_FRAME_EXIT__')) {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    // Tulis frame NDJSON tanpa newline dengan UTF-8 multi-byte di EOF tepat sebelum stdout ditutup
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Frame terakhir tanpa newline 🚀' },
          },
        },
      })
    );
    process.stdout.end(() => process.exit(0));
    return;
  }

  if (text.includes('__CRASH_TURN__')) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Sebelum crash' },
        },
      },
    });
    setTimeout(() => process.exit(1), 15);
    return;
  }

  if (text.includes('__OVERSIZED_STDOUT__')) {
    process.stdout.write('x'.repeat(4 * 1024 * 1024 + 128) + '\n');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Pulih setelah baris >4MB' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (text.includes('__TIMED_TURN__')) {
    const delayMs = Number(process.env.FAKE_AGY_PROMPT_DELAY_MS) || 250;
    const timer = setTimeout(() => {
      if (activeTurn && activeTurn.rpcId === msg.id) {
        activeTurn = null;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Giliran panjang selesai' },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    }, delayMs);
    activeTurn = { rpcId: msg.id, sessionId, timer };
    return;
  }

  if (text.includes('__SLOW_TURN__')) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Memproses tugas panjang...' },
        },
      },
    });
    const timer = setTimeout(() => {
      if (activeTurn && activeTurn.rpcId === msg.id) {
        activeTurn = null;
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    }, 30_000);
    timer.unref();
    activeTurn = { rpcId: msg.id, sessionId, timer };
    return;
  }

  if (text.includes('__NEED_PERM__')) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Meminta izin menjalankan alat...' },
        },
      },
    });

    const permId = `perm-${nextServerId++}`;
    const permCleanup = () => {
      pendingClientRequests.delete(permId);
    };
    activeTurn = { rpcId: msg.id, sessionId, permCleanup };

    pendingClientRequests.set(permId, (resMsg) => {
      pendingClientRequests.delete(permId);
      if (!activeTurn || activeTurn.rpcId !== msg.id) return;
      activeTurn = null;
      const outcome = resMsg?.result?.outcome;
      const optId = typeof outcome?.optionId === 'string' ? outcome.optionId : '';
      const isAllowed =
        outcome?.outcome === 'selected' && optId !== '' && !optId.startsWith('reject');

      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: isAllowed ? `Izin diberikan: ${optId} (allowed)` : 'Izin dibatalkan atau ditolak (cancelled)',
            },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn' },
      });
    });

    send({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: `tc-${permId}`,
          title: 'Jalankan perintah tes',
          kind: 'execute',
        },
        options: [
          { optionId: 'allow_once', name: 'Izinkan Sekali', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Selalu Izinkan', kind: 'allow_always' },
          { optionId: 'reject', name: 'Tolak', kind: 'reject_once' },
        ],
      },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Baik, sedang mengerjakan: ' },
      },
    },
  });

  const t1 = setTimeout(() => {
    if (!activeTurn || activeTurn.rpcId !== msg.id) return;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Baca berkas proyek',
          kind: 'read',
          status: 'in_progress',
        },
      },
    });
    const t2 = setTimeout(() => {
      if (!activeTurn || activeTurn.rpcId !== msg.id) return;
      activeTurn = null;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' },
      });
    }, 10);
    activeTurn.timer = t2;
  }, 10);

  activeTurn = { rpcId: msg.id, sessionId, timer: t1 };
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (process.env.FAKE_AGY_RPC_LOG && typeof msg.method === 'string') {
    try {
      fs.appendFileSync(
        process.env.FAKE_AGY_RPC_LOG,
        JSON.stringify({ method: msg.method, params: msg.params ?? null }) + '\n',
        'utf8'
      );
    } catch {}
  }

  // Response to server -> client request (e.g. session/request_permission)
  if ('id' in msg && !msg.method) {
    const key = String(msg.id);
    const cb = pendingClientRequests.get(key);
    if (cb) cb(msg);
    return;
  }

  // Notification
  if (!('id' in msg) && typeof msg.method === 'string') {
    if (msg.method === 'session/cancel') {
      if (!msg.params?.sessionId || activeTurn?.sessionId === msg.params.sessionId) {
        cancelActiveTurn();
      }
    }
    return;
  }

  // Request
  if ('id' in msg && typeof msg.method === 'string') {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        if (process.env.FAKE_AGY_HANG_INIT === '1') {
          return;
        }
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: 'Fake Antigravity ACP', version: '1.0.0' },
            _meta: { args, sandbox: hasSandbox },
          },
        });
        return;
      }
      case 'session/new': {
        if (process.env.FAKE_AGY_HANG_NEW === '1') {
          return;
        }
        const respondNew = () => {
          sessionSeq += 1;
          const sessionId = `cli-sess-new-${sessionSeq}`;
          sessions.set(sessionId, { cwd: params.cwd || '', mode: 'accept-edits', model: null });
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
        };
        const delayNew = Number(process.env.FAKE_AGY_SLOW_NEW_MS);
        if (Number.isFinite(delayNew) && delayNew > 0) {
          setTimeout(respondNew, delayNew).unref();
        } else {
          respondNew();
        }
        return;
      }
      case 'session/load': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (!sessionId) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'sessionId required' } });
          return;
        }
        sessions.set(sessionId, { cwd: params.cwd || '', mode: 'accept-edits', model: null });
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
        return;
      }
      case 'session/set_mode': {
        if (process.env.FAKE_AGY_FAIL_SET_MODE === '1') {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid mode forced by test' } });
          return;
        }
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (!sessionId || !sessions.has(sessionId)) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown sessionId: ${sessionId}` } });
          return;
        }
        const modeId = params.modeId ?? params.mode;
        sessions.get(sessionId).mode = modeId;
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      case 'session/set_model': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (!sessionId || !sessions.has(sessionId)) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown sessionId: ${sessionId}` } });
          return;
        }
        if (process.env.FAKE_AGY_UNSUPPORTED_MODEL === '1') {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: session/set_model' } });
          return;
        }
        const modelId = params.modelId ?? params.model;
        sessions.get(sessionId).model = modelId;
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      case 'session/prompt': {
        handlePrompt(msg);
        return;
      }
      default: {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    }
  }
}

if (args[0] !== 'models') {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleMessage(JSON.parse(trimmed));
      } catch {}
    }
  });

  process.stdin.on('end', () => {
    const rest = (buf + decoder.end()).trim();
    if (rest) {
      try {
        handleMessage(JSON.parse(rest));
      } catch {}
    }
    if (process.env.FAKE_AGY_IGNORE_EOF === '1') {
      setInterval(() => {}, 1000);
      return;
    }
    setTimeout(() => process.exit(0), 20).unref();
  });

  process.on('SIGTERM', () => {
    process.exit(0);
  });
}
