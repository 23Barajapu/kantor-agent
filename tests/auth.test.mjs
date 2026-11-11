import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  SECURITY_HEADERS,
  hostAllowed,
  isPureLoopback,
  checkSameOrigin,
  readJsonBody,
  createAuthManager,
} from '../skills/kantor-agent/runtime/lib/http.mjs';
import { createKantorServer, parseCliArgs } from '../skills/kantor-agent/runtime/bin/serve.mjs';
import { loadConfig } from '../skills/kantor-agent/runtime/lib/config.mjs';
import { isInsideDir } from '../skills/kantor-agent/runtime/lib/util.mjs';

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

function makeTempDir(prefix = 'kantor-auth-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function createTestEnv() {
  const base = makeTempDir();
  const projectDir = path.join(base, 'project');
  const storageDir = path.join(base, 'storage');
  const antigravityHome = path.join(base, 'ag-home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(antigravityHome, { recursive: true });
  return { base, projectDir, storageDir, antigravityHome };
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
        workspace_uris, status, source, nesting_depth
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      convId,
      opts.title ?? 'Sesi CLI Test',
      opts.step_count ?? 1,
      opts.last_modified_time ?? new Date().toISOString(),
      JSON.stringify([uri]),
      opts.status ?? 'CASCADE_RUN_STATUS_IDLE',
      opts.source ?? 'cli',
      0
    );
  } finally {
    db.close();
  }
}

function rawRequest(port, { method = 'GET', reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body === null || body === undefined
      ? null
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    const finalHeaders = { ...headers };
    if (bodyBuf !== null && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      finalHeaders['Content-Length'] = String(bodyBuf.length);
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: finalHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer: buf,
            text,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf !== null) req.write(bodyBuf);
    req.end();
  });
}

async function startServer(opts) {
  const server = createKantorServer(opts);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  return { server, port: addr.port };
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

function extractCookiePair(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.equal(typeof raw, 'string', 'Set-Cookie header harus berupa string');
  return raw.split(';')[0].trim();
}

function assertApiErrorHeaders(res) {
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
  assert.ok(res.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
  assert.equal(res.headers['cache-control'], 'no-store');
}

describe('http.mjs security primitives', () => {
  it('exports frozen SECURITY_HEADERS with required directives', () => {
    assert.equal(Object.isFrozen(SECURITY_HEADERS), true);
    assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
    assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
    assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.ok(SECURITY_HEADERS['Content-Security-Policy'].includes("frame-ancestors 'none'"));
    assert.ok(SECURITY_HEADERS['Content-Security-Policy'].includes("default-src 'self'"));
    assert.ok(SECURITY_HEADERS['Content-Security-Policy'].includes("object-src 'none'"));
  });

  it('hostAllowed validates IPs, localhost, strict trycloudflare subdomains, and extraAllowed', () => {
    assert.equal(hostAllowed('localhost'), true);
    assert.equal(hostAllowed('localhost:8788'), true);
    assert.equal(hostAllowed('app.localhost:8788'), true);
    assert.equal(hostAllowed('127.0.0.1:8788'), true);
    assert.equal(hostAllowed('192.168.1.50:8788'), true);
    assert.equal(hostAllowed('[::1]:8788'), true);
    assert.equal(hostAllowed('[::1]'), true);
    assert.equal(hostAllowed('::1'), true);
    assert.equal(hostAllowed('abc.trycloudflare.com'), true);
    assert.equal(hostAllowed('sub.abc.trycloudflare.com:443'), true);

    assert.equal(hostAllowed(undefined), false);
    assert.equal(hostAllowed(''), false);
    assert.equal(hostAllowed(123), false);
    assert.equal(hostAllowed('evil.com'), false);
    assert.equal(hostAllowed('evil.com:8788'), false);
    assert.equal(hostAllowed('trycloudflare.com'), false);
    assert.equal(hostAllowed('eviltrycloudflare.com'), false);
    assert.equal(hostAllowed('notlocalhost'), false);
    assert.equal(hostAllowed('localhost/admin'), false);
    assert.equal(hostAllowed('localhost@evil.com'), false);
    assert.equal(hostAllowed('localhost?x=1'), false);
    assert.equal(hostAllowed('localhost#frag'), false);
    assert.equal(hostAllowed('localhost 8788'), false);
    assert.equal(hostAllowed('localhost\r\nX-Test: 1'), false);
    assert.equal(hostAllowed('localhost:0'), false);
    assert.equal(hostAllowed('localhost:65536'), false);
    assert.equal(hostAllowed('localhost:abc'), false);

    const extra = 'kantor.internal, dev.local:8788, *.corp.example';
    assert.equal(hostAllowed('kantor.internal', extra), true);
    assert.equal(hostAllowed('kantor.internal:9000', extra), true);
    assert.equal(hostAllowed('dev.local:8788', extra), true);
    assert.equal(hostAllowed('dev.local:9999', extra), false);
    assert.equal(hostAllowed('dev.local', extra), false);
    assert.equal(hostAllowed('team.corp.example', extra), true);
    assert.equal(hostAllowed('corp.example', extra), false);
  });

  it('isPureLoopback strictly enforces socket loopback, loopback Host, and zero proxy headers', () => {
    const mkReq = (remoteAddress, host, extraHeaders = {}) => ({
      socket: { remoteAddress },
      headers: { host, ...extraHeaders },
    });

    assert.equal(isPureLoopback(mkReq('127.0.0.1', '127.0.0.1:8788')), true);
    assert.equal(isPureLoopback(mkReq('127.0.0.42', 'localhost:8788')), true);
    assert.equal(isPureLoopback(mkReq('::1', '[::1]:8788')), true);
    assert.equal(isPureLoopback(mkReq('::ffff:127.0.0.1', 'sub.localhost')), true);

    assert.equal(isPureLoopback(mkReq('192.168.1.25', '127.0.0.1:8788')), false);
    assert.equal(isPureLoopback(mkReq(undefined, '127.0.0.1:8788')), false);
    assert.equal(isPureLoopback(mkReq('127.0.0.1', 'tunnel.trycloudflare.com')), false);
    assert.equal(isPureLoopback(mkReq('127.0.0.1', '192.168.1.50:8788')), false);
    assert.equal(isPureLoopback(mkReq('127.0.0.1', undefined)), false);

    for (const proxyHeader of [
      'x-forwarded-for',
      'forwarded',
      'cf-connecting-ip',
      'x-forwarded-host',
      'x-real-ip',
      'true-client-ip',
      'via',
    ]) {
      assert.equal(
        isPureLoopback(mkReq('127.0.0.1', '127.0.0.1:8788', { [proxyHeader]: '1.2.3.4' })),
        false,
        `proxy header ${proxyHeader} harus menolak pure loopback`
      );
      assert.equal(
        isPureLoopback(mkReq('127.0.0.1', '127.0.0.1:8788', { [proxyHeader]: '' })),
        false,
        `proxy header ${proxyHeader} kosong yang hadir tetap harus menolak pure loopback`
      );
    }
  });

  it('checkSameOrigin enforces Sec-Fetch-Site strictness, Origin/Referer match, and requireOrigin option', () => {
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788' } }),
      true
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788' } }, { requireOrigin: true }),
      false
    );
    assert.equal(
      checkSameOrigin(
        { method: 'POST', headers: { host: '127.0.0.1:8788', 'sec-fetch-site': 'same-origin' } },
        { requireOrigin: true }
      ),
      true
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', 'sec-fetch-site': 'same-site' } }),
      false
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', 'sec-fetch-site': 'none' } }),
      false
    );
    assert.equal(
      checkSameOrigin({ method: 'GET', headers: { host: '127.0.0.1:8788', 'sec-fetch-site': 'none' } }),
      true
    );
    assert.equal(
      checkSameOrigin(
        { method: 'POST', headers: { host: '127.0.0.1:8788', origin: 'http://127.0.0.1:8788' } },
        { requireOrigin: true }
      ),
      true
    );
    assert.equal(
      checkSameOrigin(
        { method: 'POST', headers: { host: '127.0.0.1:8788', referer: 'http://127.0.0.1:8788/kerja' } },
        { requireOrigin: true }
      ),
      true
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', 'sec-fetch-site': 'cross-site' } }),
      false
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', origin: 'https://attacker.test' } }),
      false
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', origin: 'null' } }),
      false
    );
    assert.equal(
      checkSameOrigin({ method: 'POST', headers: { host: '127.0.0.1:8788', referer: 'https://attacker.test/x' } }),
      false
    );
  });

  it('createAuthManager persists 32-byte hex token, generates HMAC cookie, and checks authorization', () => {
    const dir = makeTempDir('kantor-token-');
    try {
      const stateDir = path.join(dir, 'nested', 'state');
      const mgr1 = createAuthManager(stateDir);
      const token = mgr1.getToken();

      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal(fs.readFileSync(path.join(stateDir, 'chat-token'), 'utf8').trim(), token);

      const mgr2 = createAuthManager(stateDir);
      assert.equal(mgr2.getToken(), token);

      assert.equal(mgr1.verifyToken(token), true);
      assert.equal(mgr1.verifyToken('wrong'), false);
      assert.equal(mgr1.verifyToken(`${token.slice(0, -1)}0` === token ? `${token.slice(0, -1)}1` : `${token.slice(0, -1)}0`), false);
      assert.equal(mgr1.verifyToken(''), false);

      const cookieHdr = mgr1.setSessionCookieHeader(false);
      assert.ok(cookieHdr.startsWith(`kantor_chat=${mgr1.expectedCookieValue()}; Path=/kerja; HttpOnly; SameSite=Strict`));
      assert.equal(cookieHdr.includes('; Secure'), false);
      assert.notEqual(mgr1.expectedCookieValue(), token);

      const secureCookieHdr = mgr1.setSessionCookieHeader(true);
      assert.ok(secureCookieHdr.endsWith('; Secure'));

      const cookiePair = extractCookiePair(cookieHdr);
      assert.equal(mgr1.isAuthorized({ headers: { cookie: cookiePair } }), true);
      assert.equal(mgr1.isAuthorized({ headers: { authorization: `Bearer ${token}` } }), true);
      assert.equal(mgr1.isAuthorized({ headers: { 'x-kantor-token': token } }), true);
      assert.equal(mgr1.isAuthorized({ headers: {} }), false);
      assert.equal(mgr1.isAuthorized({ headers: { cookie: `kantor_chat=${token}` } }), false);
    } finally {
      cleanDir(dir);
    }
  });

  it('readJsonBody parses empty body as {}, rejects invalid JSON (400), > maxBytes / Content-Length / multibyte UTF-8 (413), and premature close', async () => {
    const emptyReq = Readable.from([]);
    assert.deepEqual(await readJsonBody(emptyReq), {});

    const exactBytes = 65536;
    const prefix = '{"v":"';
    const suffix = '"}';
    const exactJson = prefix + 'x'.repeat(exactBytes - prefix.length - suffix.length) + suffix;
    assert.equal(Buffer.byteLength(exactJson), exactBytes);
    const exactParsed = await readJsonBody(Readable.from([Buffer.from(exactJson)]), 65536);
    assert.equal(exactParsed.v.length, exactBytes - prefix.length - suffix.length);

    const overJson = exactJson + ' ';
    assert.equal(Buffer.byteLength(overJson), 65537);
    await assert.rejects(
      () => readJsonBody(Readable.from([Buffer.from(overJson.slice(0, 30000)), Buffer.from(overJson.slice(30000))]), 65536),
      (err) => err?.status === 413 && err?.code === 'PAYLOAD_TOO_LARGE'
    );

    // Multibyte UTF-8 (< 65536 chars tapi > 65536 bytes)
    const emojiText = '🚀'.repeat(20000);
    assert.ok(emojiText.length < 65536);
    const emojiJson = JSON.stringify({ t: emojiText });
    assert.ok(Buffer.byteLength(emojiJson, 'utf8') > 65536);
    await assert.rejects(
      () => readJsonBody(Readable.from([Buffer.from(emojiJson, 'utf8')]), 65536),
      (err) => err?.status === 413 && err?.code === 'PAYLOAD_TOO_LARGE'
    );

    // Declared Content-Length > maxBytes
    const declaredStream = Readable.from([Buffer.from('{"a":1}')]);
    declaredStream.headers = { 'content-length': '70000' };
    await assert.rejects(
      () => readJsonBody(declaredStream, 65536),
      (err) => err?.status === 413 && err?.code === 'PAYLOAD_TOO_LARGE'
    );

    // Premature close before end
    const incompleteStream = new Readable({ read() {} });
    incompleteStream.complete = false;
    const pendingClose = readJsonBody(incompleteStream, 65536);
    incompleteStream.push('{"partial":');
    incompleteStream.destroy();
    await assert.rejects(
      () => pendingClose,
      (err) => err?.status === 400 && err?.code === 'REQUEST_ABORTED'
    );

    await assert.rejects(
      () => readJsonBody(Readable.from([Buffer.from('{bad')]), 65536),
      (err) => err?.status === 400 && err?.code === 'INVALID_JSON'
    );
  });

  it('parseCliArgs ignores empty --port= and parses valid flags, and isInsideDir checks path bounds', () => {
    const emptyPortArgs = parseCliArgs(['--port=', '--bind', '127.0.0.1']);
    assert.equal('port' in emptyPortArgs, false);
    assert.equal(emptyPortArgs.bind, '127.0.0.1');

    const validArgs = parseCliArgs(['--port=8790', '--sandbox']);
    assert.equal(validArgs.port, 8790);
    assert.equal(validArgs.sandbox, true);

    const root = path.resolve(os.tmpdir(), 'kantor-root');
    assert.equal(isInsideDir(path.join(root, 'a', 'b.txt'), root), true);
    assert.equal(isInsideDir(root, root), false);
    assert.equal(isInsideDir(root + '-other' + path.sep + 'x.txt', root), false);
  });
});

describe('serve.mjs HTTP server, security & routes', () => {
  it('enforces Host allowlist (421 vs 200) and SECURITY_HEADERS on ping and state', async () => {
    const env = createTestEnv();
    const convId = '11111111-1111-4111-8111-111111111111';
    seedConversation(env.antigravityHome, env.projectDir, convId, {
      title: 'CLI Session',
      source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
    });

    const prevAg = process.env.ANTIGRAVITY_HOME;
    const prevAllowed = process.env.KANTOR_ALLOWED_HOSTS;
    process.env.ANTIGRAVITY_HOME = env.antigravityHome;
    process.env.KANTOR_ALLOWED_HOSTS = 'kantor.internal';

    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
    });

    try {
      const evil = await rawRequest(port, {
        reqPath: '/kerja/api/ping',
        headers: { Host: 'evil.com' },
      });
      assert.equal(evil.status, 421);
      assert.equal(evil.json?.ok, false);
      assert.equal(evil.headers['x-frame-options'], 'DENY');
      assert.equal(evil.headers['x-content-type-options'], 'nosniff');

      for (const goodHost of [
        `localhost:${port}`,
        '192.168.1.50:8788',
        'abc.trycloudflare.com',
        'kantor.internal',
      ]) {
        const okRes = await rawRequest(port, {
          reqPath: '/kerja/api/ping',
          headers: { Host: goodHost },
        });
        assert.equal(okRes.status, 200, `Host ${goodHost} harus diizinkan`);
        assert.equal(okRes.json?.ok, true);
        assert.equal(okRes.json?.app, 'kantor-agent');
        assert.equal(okRes.headers['cache-control'], 'no-store');
        assert.equal(okRes.headers['x-frame-options'], 'DENY');
        assert.equal(okRes.headers['x-content-type-options'], 'nosniff');
        assert.ok(okRes.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
      }

      const stateRes = await rawRequest(port, {
        reqPath: '/kerja/api/state',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(stateRes.status, 200);
      assert.equal(stateRes.headers['x-frame-options'], 'DENY');
      assert.equal(stateRes.headers['x-content-type-options'], 'nosniff');
      assert.ok(stateRes.headers['content-security-policy']);
      assert.equal(Array.isArray(stateRes.json?.chat?.sessions), true);
      assert.equal(stateRes.json.chat.sessions.length, 1);
      assert.equal(stateRes.json.chat.sessions[0].id, convId);
      assert.equal('dbRoot' in stateRes.json.chat.sessions[0], false, 'dbRoot wajib disanitasi dari state.chat.sessions');
    } finally {
      await stopServer(server);
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      if (prevAllowed === undefined) delete process.env.KANTOR_ALLOWED_HOSTS;
      else process.env.KANTOR_ALLOWED_HOSTS = prevAllowed;
      cleanDir(env.base);
    }
  });

  it('Review Focus #3: pure loopback auto-auth vs proxy/tunnel header token enforcement', async () => {
    const env = createTestEnv();
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const sentPrompts = [];
    const mockBridge = {
      getStatus: () => ({ connected: true, busy: false }),
      sendPrompt: async (body) => {
        sentPrompts.push(body);
        return { ok: true, accepted: true };
      },
    };

    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      acpBridge: mockBridge,
    });

    try {
      const tokenFile = path.join(env.storageDir, 'chat-token');
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      assert.match(token, /^[0-9a-f]{64}$/);

      // 0. POST /kerja/api/chat/auth tanpa Origin dan tanpa token -> 403 (even on pure loopback)
      const authNoOrigin = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(authNoOrigin.status, 403);
      assertApiErrorHeaders(authNoOrigin);
      assert.equal(authNoOrigin.headers['set-cookie'], undefined);

      // 1. Socket 127.0.0.1 WITH proxy header or tunnel Host (dan Origin sah) tanpa token -> 401 (no Set-Cookie)
      for (const badHeaders of [
        { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'X-Forwarded-For': '1.2.3.4' },
        { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Forwarded: 'for=1.2.3.4' },
        { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'CF-Connecting-IP': '1.2.3.4' },
        { Host: 'tunnel.trycloudflare.com', Origin: 'https://tunnel.trycloudflare.com' },
      ]) {
        const res = await rawRequest(port, {
          method: 'POST',
          reqPath: '/kerja/api/chat/auth',
          headers: { ...badHeaders, 'Content-Type': 'application/json' },
          body: {},
        });
        assert.equal(res.status, 401);
        assertApiErrorHeaders(res);
        assert.equal(res.headers['set-cookie'], undefined);
      }

      // 2. Proxy header / tunnel Host WITH valid token (bahkan tanpa Origin, CLI/bootstrap token flow) -> 200 + Set-Cookie + authenticated send works
      const tunnelAuth = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: {
          Host: 'tunnel.trycloudflare.com',
          'X-Forwarded-For': '1.2.3.4',
          'X-Forwarded-Proto': 'https',
          'Content-Type': 'application/json',
        },
        body: { token },
      });
      assert.equal(tunnelAuth.status, 200);
      assert.equal(tunnelAuth.json?.ok, true);
      assert.equal(tunnelAuth.json?.mode, 'token');
      const tunnelSetCookie = Array.isArray(tunnelAuth.headers['set-cookie'])
        ? tunnelAuth.headers['set-cookie'][0]
        : tunnelAuth.headers['set-cookie'];
      assert.ok(tunnelSetCookie.includes('HttpOnly'));
      assert.ok(tunnelSetCookie.includes('SameSite=Strict'));
      assert.ok(tunnelSetCookie.includes('Secure'));

      const cookiePair = extractCookiePair(tunnelSetCookie);
      const sendAfterToken = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: 'tunnel.trycloudflare.com',
          Origin: 'https://tunnel.trycloudflare.com',
          Cookie: cookiePair,
          'Content-Type': 'application/json',
        },
        body: { text: 'Halo Ketua' },
      });
      assert.equal(sendAfterToken.status, 200);
      assert.deepEqual(sentPrompts[0], { text: 'Halo Ketua' });

      // 3. Pure loopback (127.0.0.1 + Host: 127.0.0.1:<port> + Origin matching Host, no proxy headers) -> 200 + Set-Cookie
      const loopbackAuth = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          'Content-Type': 'application/json',
        },
        body: {},
      });
      assert.equal(loopbackAuth.status, 200);
      assert.equal(loopbackAuth.json?.ok, true);
      assert.equal(loopbackAuth.json?.mode, 'loopback');
      const lbSetCookie = Array.isArray(loopbackAuth.headers['set-cookie'])
        ? loopbackAuth.headers['set-cookie'][0]
        : loopbackAuth.headers['set-cookie'];
      assert.ok(lbSetCookie.startsWith('kantor_chat='));
      assert.ok(lbSetCookie.includes('Path=/kerja'));
      assert.ok(lbSetCookie.includes('HttpOnly'));
      assert.ok(lbSetCookie.includes('SameSite=Strict'));
    } finally {
      await stopServer(server);
      cleanDir(env.base);
    }
  });

  it('enforces chat auth (401), CSRF Origin check (403), 64KB body cap (413), disabled chat (503), and ACP bridge delegation', async () => {
    const env = createTestEnv();
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);

    const bridgeCalls = [];
    const mockBridge = {
      getStatus: () => ({ connected: true, busy: false }),
      openSession: async (body) => {
        bridgeCalls.push(['openSession', body]);
        return { ok: true, sessionId: 's-1' };
      },
      sendPrompt: async (body) => {
        bridgeCalls.push(['sendPrompt', body]);
        if (body.conflict) {
          throw { status: 409, message: 'Giliran chat masih aktif' };
        }
        if (body.crash) {
          throw new Error('ENOENT: /secret/internal/path/creds.json failed');
        }
        if (body.crashStatus500) {
          throw { status: 503, message: '/secret/internal/503-leak' };
        }
        return { status: 202, body: { ok: true, queued: true } };
      },
      resolvePermission: async (body) => {
        bridgeCalls.push(['resolvePermission', body]);
        return { ok: true };
      },
      cancel: async (body) => {
        bridgeCalls.push(['cancel', body]);
        return { ok: true };
      },
      subscribeSse: (req, res) => {
        bridgeCalls.push(['subscribeSse', req.url]);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('event: ping\ndata: {"ok":true}\n\n');
        res.end();
      },
    };

    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      acpBridge: mockBridge,
    });

    try {
      const token = server.authManager.getToken();
      const originHdr = `http://127.0.0.1:${port}`;

      // Unauthenticated send on loopback -> 401
      const noAuth = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, 'Content-Type': 'application/json' },
        body: { text: 'test' },
      });
      assert.equal(noAuth.status, 401);
      assertApiErrorHeaders(noAuth);

      // Obtain session cookie via pure loopback auth (dengan Origin)
      const authRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(authRes.status, 200);
      const cookiePair = extractCookiePair(authRes.headers['set-cookie']);

      // Cookie-authenticated POST WITHOUT Origin/Referer/Sec-Fetch-Site -> 403
      const cookieNoOrigin = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          'Content-Type': 'application/json',
        },
        body: { text: 'no-origin' },
      });
      assert.equal(cookieNoOrigin.status, 403);
      assertApiErrorHeaders(cookieNoOrigin);

      // Sec-Fetch-Site: same-site (cross-port) -> 403
      const sameSiteRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: originHdr,
          'Sec-Fetch-Site': 'same-site',
          'Content-Type': 'application/json',
        },
        body: { text: 'same-site' },
      });
      assert.equal(sameSiteRes.status, 403);
      assertApiErrorHeaders(sameSiteRes);

      // Cross-origin CSRF attempt with valid cookie -> 403
      const csrfRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: 'https://attacker.test',
          'Content-Type': 'application/json',
        },
        body: { text: 'hack' },
      });
      assert.equal(csrfRes.status, 403);
      assertApiErrorHeaders(csrfRes);

      // Explicit Bearer token WITHOUT Origin -> 200 (CLI / non-browser client)
      const bearerNoOrigin = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: { text: 'from-cli' },
      });
      assert.equal(bearerNoOrigin.status, 202);

      // Payload > 64 KB -> 413
      const hugePayload = JSON.stringify({ text: 'a'.repeat(66000) });
      assert.ok(Buffer.byteLength(hugePayload) > 65536);
      const tooBigRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: originHdr,
          'Content-Type': 'application/json',
        },
        body: hugePayload,
      });
      assert.equal(tooBigRes.status, 413);
      assertApiErrorHeaders(tooBigRes);

      // Invalid JSON -> 400
      const badJsonRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: originHdr,
          'Content-Type': 'application/json',
        },
        body: '{not-json',
      });
      assert.equal(badJsonRes.status, 400);
      assertApiErrorHeaders(badJsonRes);

      // Non-plain-object JSON body ([], null) -> 400
      for (const nonObj of ['[]', 'null', '"halo"']) {
        const resNonObj = await rawRequest(port, {
          method: 'POST',
          reqPath: '/kerja/api/chat/send',
          headers: {
            Host: `127.0.0.1:${port}`,
            Cookie: cookiePair,
            Origin: originHdr,
            'Content-Type': 'application/json',
          },
          body: nonObj,
        });
        assert.equal(resNonObj.status, 400);
        assertApiErrorHeaders(resNonObj);
      }

      // Unexpected error thrown by acpBridge -> 500 without leaking raw err.message / paths
      const crashRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: originHdr,
          'Content-Type': 'application/json',
        },
        body: { crash: true },
      });
      assert.equal(crashRes.status, 500);
      assertApiErrorHeaders(crashRes);
      assert.equal(crashRes.text.includes('/secret'), false);
      assert.equal(crashRes.text.includes('creds.json'), false);

      const crash503Res = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookiePair,
          Origin: originHdr,
          'Content-Type': 'application/json',
        },
        body: { crashStatus500: true },
      });
      assert.equal(crash503Res.status, 500);
      assertApiErrorHeaders(crash503Res);
      assert.equal(crash503Res.text.includes('/secret'), false);

      // Valid delegation to all bridge routes + 409 error mapping + SSE
      const sessRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/session',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { mode: 'accept-edits' },
      });
      assert.equal(sessRes.status, 200);
      assert.equal(sessRes.json?.sessionId, 's-1');

      const sendRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { text: 'Kerjakan task' },
      });
      assert.equal(sendRes.status, 202);
      assert.equal(sendRes.json?.queued, true);

      const conflictRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { conflict: true },
      });
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.json?.ok, false);
      assertApiErrorHeaders(conflictRes);

      const permRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/permission',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: { requestId: 'p1', optionId: 'allow_once' },
      });
      assert.equal(permRes.status, 200);

      const cancelRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/cancel',
        headers: { Host: `127.0.0.1:${port}`, Origin: originHdr, Cookie: cookiePair, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(cancelRes.status, 200);

      const sseRes = await rawRequest(port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/stream',
        headers: { Host: `127.0.0.1:${port}`, Cookie: cookiePair },
      });
      assert.equal(sseRes.status, 200);
      assert.ok(sseRes.headers['content-type']?.includes('text/event-stream'));
      assert.equal(sseRes.headers['x-frame-options'], 'DENY');
      assert.ok(sseRes.text.includes('event: ping'));

      assert.equal(bridgeCalls.length, 9);
    } finally {
      await stopServer(server);
    }

    // Chat disabled via cfg.chat.enabled = false -> 503
    const disabledCfg = { ...cfg, chat: { ...cfg.chat, enabled: false } };
    const disabledSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg: disabledCfg,
    });
    try {
      const resAuth = await rawRequest(disabledSrv.port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/auth',
        headers: { Host: `127.0.0.1:${disabledSrv.port}`, Origin: `http://127.0.0.1:${disabledSrv.port}`, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(resAuth.status, 503);
      assertApiErrorHeaders(resAuth);

      const resSend = await rawRequest(disabledSrv.port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: { Host: `127.0.0.1:${disabledSrv.port}`, Origin: `http://127.0.0.1:${disabledSrv.port}`, 'Content-Type': 'application/json' },
        body: {},
      });
      assert.equal(resSend.status, 503);
      assertApiErrorHeaders(resSend);
    } finally {
      await stopServer(disabledSrv.server);
    }

    // acpBridge = null (chat enabled) -> 503 after auth on /send and /stream + 405/404 checks
    const noBridgeSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      acpBridge: null,
    });
    try {
      const token = noBridgeSrv.server.authManager.getToken();
      const sendNoBridge = await rawRequest(noBridgeSrv.port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/send',
        headers: {
          Host: `127.0.0.1:${noBridgeSrv.port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: { text: 'halo' },
      });
      assert.equal(sendNoBridge.status, 503);
      assertApiErrorHeaders(sendNoBridge);

      const streamNoBridge = await rawRequest(noBridgeSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/stream',
        headers: {
          Host: `127.0.0.1:${noBridgeSrv.port}`,
          'X-Kantor-Token': token,
        },
      });
      assert.equal(streamNoBridge.status, 503);
      assertApiErrorHeaders(streamNoBridge);

      const wrongMethod = await rawRequest(noBridgeSrv.port, {
        method: 'POST',
        reqPath: '/kerja/api/ping',
        headers: { Host: `127.0.0.1:${noBridgeSrv.port}` },
      });
      assert.equal(wrongMethod.status, 405);
      assertApiErrorHeaders(wrongMethod);

      const notFound = await rawRequest(noBridgeSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/tidak-ada',
        headers: { Host: `127.0.0.1:${noBridgeSrv.port}` },
      });
      assert.equal(notFound.status, 404);
      assertApiErrorHeaders(notFound);
    } finally {
      await stopServer(noBridgeSrv.server);
      cleanDir(env.base);
    }
  });

  it('exposes authenticated GET /kerja/api/chat/models with refresh support and safe degradation', async () => {
    const env = createTestEnv();
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);

    // 1. GET /kerja/api/chat/models without auth from non-loopback -> 401
    const mainSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      agyBin: FAKE_AGY,
    });
    try {
      const port = mainSrv.port;
      const token = mainSrv.server.authManager.getToken();

      const unauthNonLoopback = await rawRequest(port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: {
          Host: `127.0.0.1:${port}`,
          'X-Forwarded-For': '198.51.100.1',
        },
      });
      assert.equal(unauthNonLoopback.status, 401);
      assert.equal(unauthNonLoopback.json?.ok, false);
      assertApiErrorHeaders(unauthNonLoopback);

      // 2. POST /kerja/api/chat/models -> 405 with Allow: GET
      const postMethodRes = await rawRequest(port, {
        method: 'POST',
        reqPath: '/kerja/api/chat/models',
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: {},
      });
      assert.equal(postMethodRes.status, 405);
      assert.equal(postMethodRes.headers['allow'], 'GET');
      assertApiErrorHeaders(postMethodRes);

      // 3. Authenticated GET /kerja/api/chat/models returns 200 JSON with models and security headers
      const okRes = await rawRequest(port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.headers['cache-control'], 'no-store');
      assert.equal(okRes.headers['x-content-type-options'], 'nosniff');
      assert.equal(okRes.json?.ok, true);
      assert.equal(okRes.json?.source, 'agy-models');
      assert.equal(okRes.json?.cached, false);
      assert.equal(okRes.json?.degraded, false);
      assert.ok(Array.isArray(okRes.json?.models));
      assert.ok(okRes.json.models.length >= 2);
      assert.ok(okRes.json.models.some((m) => m.id === 'gemini-2.5-pro' && m.name === 'Gemini 2.5 Pro'));
      assert.equal(okRes.json?.error, undefined);
    } finally {
      await stopServer(mainSrv.server);
    }

    // 4. When cfg.chat.enabled === false -> 503
    const disabledCfg = { ...cfg, chat: { ...cfg.chat, enabled: false } };
    const disabledSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg: disabledCfg,
    });
    try {
      const resDisabled = await rawRequest(disabledSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: { Host: `127.0.0.1:${disabledSrv.port}` },
      });
      assert.equal(resDisabled.status, 503);
      assert.equal(resDisabled.json?.ok, false);
      assertApiErrorHeaders(resDisabled);
    } finally {
      await stopServer(disabledSrv.server);
    }

    // 5. GET /kerja/api/chat/models?refresh=1 forwards { force: true } to acpBridge.listModels
    const bridgeCalls = [];
    const trackingBridge = {
      listModels: async (opts) => {
        bridgeCalls.push(opts);
        return {
          ok: true,
          models: [{ id: 'mock-model', name: 'Mock Model' }],
          source: opts?.force ? 'agy-models' : 'cache',
          cached: !opts?.force,
          degraded: false,
          error: null,
        };
      },
    };
    const trackingSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      acpBridge: trackingBridge,
    });
    try {
      const tToken = trackingSrv.server.authManager.getToken();

      const normalRes = await rawRequest(trackingSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: { Host: `127.0.0.1:${trackingSrv.port}`, Authorization: `Bearer ${tToken}` },
      });
      assert.equal(normalRes.status, 200);
      assert.deepEqual(bridgeCalls[0], { force: false });

      const refreshRes = await rawRequest(trackingSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models?refresh=1',
        headers: { Host: `127.0.0.1:${trackingSrv.port}`, Authorization: `Bearer ${tToken}` },
      });
      assert.equal(refreshRes.status, 200);
      assert.deepEqual(bridgeCalls[1], { force: true });
    } finally {
      await stopServer(trackingSrv.server);
    }

    // 6. When agyBin is missing (ENOENT), returns 200 { ok: false, degraded: true, models: [], error }
    // without leaking filesystem path (err path absent from body)
    const missingBinPath = path.join(env.base, 'nonexistent-agy-binary');
    const missingBinSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      agyBin: missingBinPath,
    });
    try {
      const mToken = missingBinSrv.server.authManager.getToken();
      const missingRes = await rawRequest(missingBinSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: { Host: `127.0.0.1:${missingBinSrv.port}`, Authorization: `Bearer ${mToken}` },
      });
      assert.equal(missingRes.status, 200);
      assert.equal(missingRes.json?.ok, false);
      assert.equal(missingRes.json?.degraded, true);
      assert.deepEqual(missingRes.json?.models, []);
      assert.equal(missingRes.json?.source, 'error');
      assert.ok(typeof missingRes.json?.error === 'string' && missingRes.json.error.length > 0);
      assert.equal(missingRes.text.includes(missingBinPath), false, 'err path must not leak');
      assert.equal(missingRes.text.includes(env.base), false, 'base dir must not leak');
    } finally {
      await stopServer(missingBinSrv.server);
    }

    // 7. When acpBridge is null / missing listModels -> 503
    const noBridgeSrv = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
      acpBridge: null,
    });
    try {
      const nbToken = noBridgeSrv.server.authManager.getToken();
      const nbRes = await rawRequest(noBridgeSrv.port, {
        method: 'GET',
        reqPath: '/kerja/api/chat/models',
        headers: { Host: `127.0.0.1:${noBridgeSrv.port}`, Authorization: `Bearer ${nbToken}` },
      });
      assert.equal(nbRes.status, 503);
      assert.equal(nbRes.json?.ok, false);
      assertApiErrorHeaders(nbRes);
    } finally {
      await stopServer(noBridgeSrv.server);
      cleanDir(env.base);
    }
  });

  it('serves /, /kerja, static assets with traversal protection, and scoped /kerja/api/artifact', async () => {
    const env = createTestEnv();
    const convId = '22222222-2222-4222-8222-222222222222';
    seedConversation(env.antigravityHome, env.projectDir, convId);

    const brainDir = path.join(env.antigravityHome, 'brain', convId);
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(path.join(brainDir, 'plan.md'), '# Rencana\nToken api_key=rahasia12345\n', 'utf8');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(brainDir, 'diagram.png'), pngBytes);

    const fakeRuntime = path.join(env.base, 'runtime');
    fs.mkdirSync(path.join(fakeRuntime, 'public', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(fakeRuntime, 'public', 'assets', 'app.mjs'), 'export const ok = true;\n', 'utf8');
    fs.writeFileSync(path.join(fakeRuntime, 'secret.txt'), 'RAHASIA', 'utf8');

    const prevAg = process.env.ANTIGRAVITY_HOME;
    process.env.ANTIGRAVITY_HOME = env.antigravityHome;

    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: fakeRuntime,
      storageDir: env.storageDir,
      cfg,
    });

    try {
      const rootRedir = await rawRequest(port, {
        reqPath: '/',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(rootRedir.status, 302);
      assert.equal(rootRedir.headers.location, '/kerja');

      const pageRes = await rawRequest(port, {
        reqPath: '/kerja',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(pageRes.status, 200);
      assert.ok(pageRes.headers['content-type']?.includes('text/html'));
      assert.ok(pageRes.text.includes('Kantor Agent'));

      fs.mkdirSync(path.join(fakeRuntime, 'views'), { recursive: true });
      fs.writeFileSync(path.join(fakeRuntime, 'views', 'page.html'), '<!doctype html><h1>Custom Page</h1>', 'utf8');
      const customPageRes = await rawRequest(port, {
        reqPath: '/kerja/',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(customPageRes.status, 200);
      assert.equal(customPageRes.text, '<!doctype html><h1>Custom Page</h1>');

      const assetRes = await rawRequest(port, {
        reqPath: '/kerja/assets/app.mjs',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(assetRes.status, 200);
      assert.equal(assetRes.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(assetRes.text.includes('export const ok = true;'));

      const travAsset = await rawRequest(port, {
        reqPath: '/kerja/assets/%2e%2e/%2e%2e/secret.txt',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(travAsset.status, 403);

      for (const badAssetPath of [
        '/kerja/assets/sub%5cfile.js',
        '/kerja/assets/app%00.js',
        '/kerja/assets/C:secret.txt',
      ]) {
        const badAsset = await rawRequest(port, {
          reqPath: badAssetPath,
          headers: { Host: `127.0.0.1:${port}` },
        });
        assert.equal(badAsset.status, 403, `asset path berbahaya ${badAssetPath} wajib 403`);
      }

      // Symlink escape di public/assets (graceful skip bila OS menolak symlink tanpa privilege)
      const escapeLink = path.join(fakeRuntime, 'public', 'assets', 'escape.txt');
      let symlinkCreated = false;
      try {
        fs.symlinkSync(path.join(fakeRuntime, 'secret.txt'), escapeLink);
        symlinkCreated = true;
      } catch (err) {
        if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
      }
      if (symlinkCreated) {
        const symRes = await rawRequest(port, {
          reqPath: '/kerja/assets/escape.txt',
          headers: { Host: `127.0.0.1:${port}` },
        });
        assert.equal(symRes.status, 403);
      }

      const missAsset = await rawRequest(port, {
        reqPath: '/kerja/assets/tidak-ada.js',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(missAsset.status, 404);

      // Artifact valid via pure loopback -> local_path terisi & rahasia teredaksi
      const artOk = await rawRequest(port, {
        reqPath: `/kerja/api/artifact?conv=${convId}&file=plan.md`,
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(artOk.status, 200);
      assert.equal(artOk.json?.name, 'plan.md');
      assert.ok(typeof artOk.json?.local_path === 'string' && artOk.json.local_path.length > 0);
      assert.equal(artOk.json.content.includes('rahasia12345'), false);

      // Artifact via proxy header -> local_path wajib null
      const artProxy = await rawRequest(port, {
        reqPath: `/kerja/api/artifact?conv=${convId}&file=plan.md`,
        headers: { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '1.2.3.4' },
      });
      assert.equal(artProxy.status, 200);
      assert.equal(artProxy.json?.local_path, null);

      // Traversal & unknown convId
      const artTrav = await rawRequest(port, {
        reqPath: `/kerja/api/artifact?conv=${convId}&file=../secret.txt`,
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(artTrav.status, 403);

      const artUnknown = await rawRequest(port, {
        reqPath: '/kerja/api/artifact?conv=99999999-9999-4999-8999-999999999999&file=plan.md',
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(artUnknown.status, 404);

      const artImg = await rawRequest(port, {
        reqPath: `/kerja/api/artifact?conv=${convId}&file=diagram.png`,
        headers: { Host: `127.0.0.1:${port}` },
      });
      assert.equal(artImg.status, 200);
      assert.equal(artImg.headers['content-type'], 'image/png');
      assert.deepEqual(artImg.buffer, pngBytes);
    } finally {
      await stopServer(server);
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      cleanDir(env.base);
    }
  });
});
