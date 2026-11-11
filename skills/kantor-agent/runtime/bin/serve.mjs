import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';
import { buildState } from '../lib/office.mjs';
import { scanConversations } from '../lib/antigravity.mjs';
import { isCliMain } from '../lib/transcripts.mjs';
import { readSafeArtifact } from '../lib/artifacts.mjs';
import { AcpBridge } from '../lib/acp.mjs';
import { isDir, isFile, isInsideDir, isPlainObj, isoMs } from '../lib/util.mjs';
import {
  SECURITY_HEADERS,
  hostAllowed,
  isPureLoopback,
  checkSameOrigin,
  readJsonBody,
  extractBearerOrHeaderToken,
  createAuthManager,
} from '../lib/http.mjs';

const ASSET_MIME_MAP = Object.freeze({
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
});

const CHAT_ACTION_METHODS = Object.freeze({
  '/kerja/api/chat/session': 'openSession',
  '/kerja/api/chat/send': 'sendPrompt',
  '/kerja/api/chat/permission': 'resolvePermission',
  '/kerja/api/chat/cancel': 'cancel',
});

const FALLBACK_PAGE_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kantor Agent</title>
</head>
<body>
  <main>
    <h1>Kantor Agent</h1>
    <p>Antarmuka 3D belum tersedia (views/page.html).</p>
  </main>
</body>
</html>
`;

function sendJson(res, status, data, extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

async function readChatObjectBody(req) {
  const body = await readJsonBody(req, 65536);
  if (!isPlainObj(body)) {
    throw Object.assign(new Error('Body JSON harus berupa objek'), {
      status: 400,
      code: 'INVALID_JSON_OBJECT',
    });
  }
  return body;
}

function sendBuffer(res, status, contentType, buf, extraHeaders = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': String(payload.length),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRedirect(res, status, location) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    Location: location,
    'Content-Length': '0',
  });
  res.end();
}

function servePage(res, runtimeDir) {
  const pagePath = path.join(runtimeDir, 'views', 'page.html');
  if (isFile(pagePath)) {
    try {
      const html = fs.readFileSync(pagePath, 'utf8');
      return sendBuffer(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-cache' });
    } catch {
      return sendJson(res, 500, { ok: false, error: 'Gagal membaca halaman UI' });
    }
  }
  return sendBuffer(res, 200, 'text/html; charset=utf-8', FALLBACK_PAGE_HTML, {
    'Cache-Control': 'no-cache',
  });
}

function serveStaticAsset(res, runtimeDir, rawRelPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawRelPath);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Path aset tidak valid' });
  }

  if (
    !decoded ||
    decoded.includes('\0') ||
    decoded.includes('\\') ||
    decoded.includes(':') ||
    decoded.startsWith('/')
  ) {
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  const segments = decoded.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  const assetsDir = path.join(runtimeDir, 'public', 'assets');
  if (!isDir(assetsDir)) {
    return sendJson(res, 404, { ok: false, error: 'Aset tidak ditemukan' });
  }

  let realAssetsDir;
  try {
    realAssetsDir = fs.realpathSync.native(assetsDir);
  } catch {
    return sendJson(res, 404, { ok: false, error: 'Aset tidak ditemukan' });
  }

  const candidate = path.resolve(realAssetsDir, decoded);
  if (!isInsideDir(candidate, realAssetsDir)) {
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync.native(candidate);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return sendJson(res, 404, { ok: false, error: 'Aset tidak ditemukan' });
    }
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  if (!isInsideDir(realTarget, realAssetsDir)) {
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  let st;
  try {
    st = fs.statSync(realTarget);
  } catch {
    return sendJson(res, 404, { ok: false, error: 'Aset tidak ditemukan' });
  }
  if (!st.isFile()) {
    return sendJson(res, 403, { ok: false, error: 'Akses aset ditolak' });
  }

  let data;
  try {
    data = fs.readFileSync(realTarget);
  } catch {
    return sendJson(res, 500, { ok: false, error: 'Gagal membaca aset' });
  }

  const ext = path.extname(realTarget).toLowerCase();
  const mime = ASSET_MIME_MAP[ext] ?? 'application/octet-stream';
  return sendBuffer(res, 200, mime, data, { 'Cache-Control': 'no-cache' });
}

function handleState(res, { projectDir, storageDir, cfg, acpBridge }) {
  const state = buildState({
    projectDir,
    storageDir,
    cfg,
    acpStatus: acpBridge?.getStatus?.() ?? null,
  });

  // Hapus dbRoot dari sessions agar path lokal filesystem tidak bocor ke klien browser/LAN/tunnel
  if (state?.chat && Array.isArray(state.chat.sessions)) {
    state.chat.sessions = state.chat.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updated: s.updated,
      status: s.status,
    }));
  }

  return sendJson(res, 200, state, { 'Cache-Control': 'no-store' });
}

function handleArtifact(req, res, url, { projectDir, cfg }) {
  const convId = url.searchParams.get('conv') ?? '';
  const relPath = url.searchParams.get('file') ?? '';
  const { allIds, roots } = scanConversations(projectDir, cfg);
  const result = readSafeArtifact({
    convId,
    relPath,
    allowedConvIds: allIds,
    roots,
    isLoopback: isPureLoopback(req),
  });

  if (!result.ok) {
    return sendJson(res, result.status, { ok: false, error: result.error || 'Gagal membaca artifact' });
  }
  if (result.kind === 'json') {
    return sendJson(res, result.status, result.data, { 'Cache-Control': 'no-store' });
  }
  return sendBuffer(res, result.status, result.contentType || 'application/octet-stream', result.data, {
    'Cache-Control': 'no-store',
  });
}

async function handleChat(req, res, pathname, method, { cfg, authManager, acpBridge }) {
  if (cfg?.chat?.enabled === false) {
    return sendJson(res, 503, { ok: false, error: 'Chat dinonaktifkan oleh konfigurasi' });
  }

  if (pathname === '/kerja/api/chat/auth') {
    if (method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'POST' });
    }
    if (!checkSameOrigin(req, { requireOrigin: false })) {
      return sendJson(res, 403, { ok: false, error: 'Permintaan lintas origin ditolak' });
    }

    const body = await readChatObjectBody(req);
    const hdrToken = extractBearerOrHeaderToken(req);
    const bodyToken = typeof body.token === 'string' ? body.token : null;
    const hasValidToken =
      (hdrToken !== null && authManager.verifyToken(hdrToken)) ||
      (bodyToken !== null && authManager.verifyToken(bodyToken));

    if (!hasValidToken && !checkSameOrigin(req, { requireOrigin: true })) {
      return sendJson(res, 403, { ok: false, error: 'Header Origin/Referer wajib disertakan' });
    }

    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isHttps = req.socket?.encrypted === true || proto === 'https';

    if (isPureLoopback(req)) {
      return sendJson(
        res,
        200,
        { ok: true, mode: 'loopback' },
        {
          'Set-Cookie': authManager.setSessionCookieHeader(isHttps),
        }
      );
    }

    if (!hasValidToken) {
      return sendJson(res, 401, { ok: false, error: 'Token chat tidak valid' });
    }

    return sendJson(
      res,
      200,
      { ok: true, mode: 'token' },
      {
        'Set-Cookie': authManager.setSessionCookieHeader(isHttps),
      }
    );
  }

  if (pathname === '/kerja/api/chat/stream') {
    if (method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
    }
    if (!authManager.isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: 'Autentikasi chat diperlukan' });
    }
    if (typeof acpBridge?.subscribeSse !== 'function') {
      return sendJson(res, 503, { ok: false, error: 'Jembatan ACP belum tersedia' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    await acpBridge.subscribeSse(req, res);
    return;
  }

  const actionName = CHAT_ACTION_METHODS[pathname];
  if (!actionName) {
    return sendJson(res, 404, { ok: false, error: 'Endpoint chat tidak ditemukan' });
  }
  if (method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'POST' });
  }
  if (!authManager.isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Autentikasi chat diperlukan' });
  }

  const hdrToken = extractBearerOrHeaderToken(req);
  const hasValidHeaderToken = hdrToken !== null && authManager.verifyToken(hdrToken);
  if (!checkSameOrigin(req, { requireOrigin: !hasValidHeaderToken })) {
    return sendJson(res, 403, { ok: false, error: 'Permintaan lintas origin ditolak' });
  }

  const body = await readChatObjectBody(req);

  if (!acpBridge || typeof acpBridge[actionName] !== 'function') {
    return sendJson(res, 503, { ok: false, error: 'Jembatan ACP belum tersedia' });
  }

  try {
    const result = await acpBridge[actionName](body);
    if (result && typeof result === 'object' && Number.isInteger(result.status) && 'body' in result) {
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 200, result && typeof result === 'object' ? result : { ok: true });
  } catch (err) {
    const isClientError = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
    const isSafe503 = err?.status === 503 && err?.publicSafe === true;
    const status = isClientError || isSafe503 ? err.status : 500;
    const canExpose = isClientError || isSafe503;
    const payload =
      isClientError && err?.body && typeof err.body === 'object'
        ? err.body
        : {
            ok: false,
            error:
              canExpose && typeof err?.message === 'string' && err.message
                ? err.message
                : 'Kesalahan jembatan ACP',
          };
    return sendJson(res, status, payload);
  }
}

/**
 * Membuat instance `http.Server` Kantor Agent lengkap dengan header keamanan,
 * validasi Host, pure-loopback auto-auth, endpoint monitoring, artifact, dan chat ACP.
 */
export function createKantorServer(opts = {}) {
  const runtimeDir = opts.runtimeDir || path.resolve(import.meta.dirname, '..');
  const projectDir = opts.projectDir || process.cwd();
  const storageDir = opts.storageDir || path.join(os.tmpdir(), 'kantor-agent-state');
  const cfg = opts.cfg ?? loadConfig(runtimeDir, projectDir, {
    bind: opts.bind,
    sandbox: opts.sandbox,
  });

  let acpBridge = null;
  let ownedBridge = false;
  if (opts.acpBridge !== undefined) {
    acpBridge = opts.acpBridge;
  } else if (cfg?.chat?.enabled !== false) {
    const isSessionRunningOutsideAcp = (id) => {
      if (acpBridge?.connected && id === acpBridge.sessionId) {
        return false;
      }
      const scan = scanConversations(projectDir, cfg);
      const row = scan.mains.find((r) => r.conversation_id === id);
      if (!row) return false;
      return row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.status === 'RUNNING' || row.not_fully_idle === 1;
    };
    const isCliSession = (id) => {
      const scan = scanConversations(projectDir, cfg);
      return scan.mains.some((r) => r.conversation_id === id && isCliMain(r));
    };
    acpBridge = new AcpBridge({
      projectDir,
      ...(opts.agyBin !== undefined ? { agyBin: opts.agyBin } : {}),
      ...(opts.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: opts.permissionTimeoutMs } : {}),
      cfg,
      isSessionRunningOutsideAcp,
      isCliSession,
    });
    ownedBridge = true;
  }

  const authManager = createAuthManager(storageDir);

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(k, v);
    }

    try {
      const extraAllowed = process.env.KANTOR_ALLOWED_HOSTS || '';
      if (!hostAllowed(req.headers.host, extraAllowed)) {
        return sendJson(res, 421, { ok: false, error: 'Host tidak diizinkan' });
      }

      const rawReqPath = (req.url || '/').split('?')[0];
      if (rawReqPath.startsWith('/kerja/assets/')) {
        if ((req.method || 'GET').toUpperCase() !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return serveStaticAsset(res, runtimeDir, rawReqPath.slice('/kerja/assets/'.length));
      }

      let url;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'URL tidak valid' });
      }

      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      if (pathname === '/') {
        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return sendRedirect(res, 302, '/kerja');
      }

      if (pathname === '/kerja' || pathname === '/kerja/') {
        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return servePage(res, runtimeDir);
      }

      if (pathname === '/kerja/api/ping') {
        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return sendJson(
          res,
          200,
          { ok: true, app: 'kantor-agent', version: '0.1.0', now: isoMs(Date.now()) },
          { 'Cache-Control': 'no-store' }
        );
      }

      if (pathname === '/kerja/api/state') {
        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return handleState(res, { projectDir, storageDir, cfg, acpBridge });
      }

      if (pathname === '/kerja/api/artifact') {
        if (method !== 'GET') {
          return sendJson(res, 405, { ok: false, error: 'Metode tidak diizinkan' }, { Allow: 'GET' });
        }
        return handleArtifact(req, res, url, { projectDir, cfg });
      }

      if (pathname.startsWith('/kerja/api/chat/')) {
        return await handleChat(req, res, pathname, method, { cfg, authManager, acpBridge });
      }

      return sendJson(res, 404, { ok: false, error: 'Tidak ditemukan' });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const isClientError = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
      const status = isClientError ? err.status : 500;
      const errorMsg =
        isClientError && typeof err?.message === 'string' && err.message
          ? err.message
          : 'Kesalahan internal server';
      const extraHeaders = status === 413 ? { Connection: 'close' } : {};
      return sendJson(res, status, { ok: false, error: errorMsg }, extraHeaders);
    }
  });

  server.authManager = authManager;
  server.kantorConfig = cfg;
  server.acpBridge = acpBridge;

  if (ownedBridge && acpBridge && typeof acpBridge.shutdown === 'function') {
    const origClose = server.close.bind(server);
    server.close = (cb) => {
      const shutdownPromise = acpBridge.shutdown().catch(() => {});
      return origClose((err) => {
        shutdownPromise.finally(() => {
          if (typeof cb === 'function') cb(err);
        });
      });
    };
    server.on('close', () => {
      acpBridge.shutdown().catch(() => {});
    });
  }

  return server;
}

export function parseCliArgs(argv) {
  const out = {};
  const parseValidPort = (raw) => {
    const s = String(raw ?? '').trim();
    if (s === '' || !/^\d+$/.test(s)) return null;
    const p = Number(s);
    return Number.isInteger(p) && p >= 0 && p <= 65535 ? p : null;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sandbox') {
      out.sandbox = true;
    } else if (arg === '--no-sandbox') {
      out.sandbox = false;
    } else if (arg.startsWith('--sandbox=')) {
      const val = arg.slice('--sandbox='.length).toLowerCase();
      out.sandbox = val === '1' || val === 'true';
    } else if (arg === '--project' && i + 1 < argv.length) {
      out.project = argv[++i];
    } else if (arg.startsWith('--project=')) {
      out.project = arg.slice('--project='.length);
    } else if (arg === '--storage' && i + 1 < argv.length) {
      out.storage = argv[++i];
    } else if (arg.startsWith('--storage=')) {
      out.storage = arg.slice('--storage='.length);
    } else if (arg === '--bind' && i + 1 < argv.length) {
      out.bind = argv[++i];
    } else if (arg.startsWith('--bind=')) {
      out.bind = arg.slice('--bind='.length);
    } else if (arg === '--port' && i + 1 < argv.length) {
      const p = parseValidPort(argv[++i]);
      if (p !== null) out.port = p;
    } else if (arg.startsWith('--port=')) {
      const p = parseValidPort(arg.slice('--port='.length));
      if (p !== null) out.port = p;
    }
  }
  return out;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const selfPath = fs.realpathSync.native(fileURLToPath(import.meta.url));
    const entryPath = fs.realpathSync.native(path.resolve(process.argv[1]));
    return process.platform === 'win32'
      ? selfPath.toLowerCase() === entryPath.toLowerCase()
      : selfPath === entryPath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = parseCliArgs(process.argv.slice(2));
  const runtimeDir = path.resolve(import.meta.dirname, '..');
  const projectDir = args.project ? path.resolve(args.project) : process.cwd();
  const storageDir = args.storage ? path.resolve(args.storage) : path.join(os.tmpdir(), 'kantor-agent-state');
  const cfg = loadConfig(runtimeDir, projectDir, {
    bind: args.bind,
    sandbox: args.sandbox,
  });
  const bind = args.bind ?? cfg.bind ?? '127.0.0.1';
  const port = args.port ?? cfg.port ?? 8788;

  const server = createKantorServer({
    projectDir,
    runtimeDir,
    storageDir,
    cfg,
    bind,
    port,
  });

  const shutdown = () => {
    Promise.resolve(server.acpBridge?.shutdown?.())
      .catch(() => {})
      .finally(() => {
        server.close(() => process.exit(0));
      });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  server.listen(port, bind, () => {
    const addr = server.address();
    const displayHost = addr && typeof addr === 'object' ? addr.address : bind;
    const displayPort = addr && typeof addr === 'object' ? addr.port : port;
    process.stdout.write(`kantor-agent listening on http://${displayHost}:${displayPort}/kerja\n`);
  });
}
