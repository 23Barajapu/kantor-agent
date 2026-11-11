import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
});

const PROXY_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'cf-connecting-ip',
  'x-forwarded-host',
  'x-real-ip',
  'true-client-ip',
  'via',
];

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
const PORT_RE = /^([1-9]\d{0,4})$/;

function parsePort(portStr) {
  const m = PORT_RE.exec(portStr);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 65535 ? n : null;
}

function isValidHostname(host) {
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return false;
  return host.split('.').every((label) => label.length >= 1 && label.length <= 63);
}

/**
 * Mengurai header Host HTTP menjadi `{ hostname, port, isIp }`, atau `null` bila formatnya tidak valid/berbahaya.
 * Mendukung IPv6 ber-kurung siku (`[::1]:8788`, `[::1]`), IPv6/IPv4 polos, dan hostname DNS.
 */
export function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return null;
  if (/[\s\x00-\x1f\x7f/@?#\\]/.test(hostHeader)) return null;

  if (hostHeader.startsWith('[')) {
    const closeIdx = hostHeader.indexOf(']');
    if (closeIdx <= 1) return null;
    const ipv6 = hostHeader.slice(1, closeIdx);
    if (net.isIP(ipv6) !== 6) return null;
    const rest = hostHeader.slice(closeIdx + 1);
    if (rest === '') {
      return { hostname: ipv6.toLowerCase(), port: null, isIp: true };
    }
    if (!rest.startsWith(':')) return null;
    const port = parsePort(rest.slice(1));
    if (port === null) return null;
    return { hostname: ipv6.toLowerCase(), port, isIp: true };
  }

  if (hostHeader.includes('[') || hostHeader.includes(']')) return null;

  if (net.isIP(hostHeader) === 6) {
    return { hostname: hostHeader.toLowerCase(), port: null, isIp: true };
  }

  const firstColon = hostHeader.indexOf(':');
  const lastColon = hostHeader.lastIndexOf(':');
  if (firstColon !== lastColon) return null;

  let hostPart = hostHeader;
  let port = null;
  if (firstColon !== -1) {
    hostPart = hostHeader.slice(0, firstColon);
    port = parsePort(hostHeader.slice(firstColon + 1));
    if (port === null || hostPart.length === 0) return null;
  }

  if (net.isIP(hostPart) !== 0) {
    return { hostname: hostPart.toLowerCase(), port, isIp: true };
  }

  if (!isValidHostname(hostPart)) return null;
  return { hostname: hostPart.toLowerCase(), port, isIp: false };
}

/**
 * Memeriksa apakah header `Host` diizinkan (IP literal, `localhost`/`*.localhost`,
 * `*.trycloudflare.com`, atau daftar `extraAllowed` dipisah koma).
 */
export function hostAllowed(hostHeader, extraAllowed = '') {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;

  const { hostname, port, isIp } = parsed;
  if (isIp) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.trycloudflare.com') && hostname.length > '.trycloudflare.com'.length) {
    return true;
  }

  if (typeof extraAllowed === 'string' && extraAllowed.trim() !== '') {
    for (const rawEntry of extraAllowed.split(',')) {
      const entry = rawEntry.trim();
      if (!entry) continue;

      if (entry.startsWith('*.')) {
        const pat = parseHostHeader(entry.slice(2));
        if (!pat || pat.isIp) continue;
        if (
          hostname.endsWith(`.${pat.hostname}`) &&
          (pat.port === null || pat.port === port)
        ) {
          return true;
        }
        continue;
      }

      const pat = parseHostHeader(entry);
      if (pat && pat.hostname === hostname && (pat.port === null || pat.port === port)) {
        return true;
      }
    }
  }

  return false;
}

function isLoopbackIp(ip) {
  if (typeof ip !== 'string') return false;
  const s = ip.trim().toLowerCase();
  if (!s) return false;
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIPv4(v4) && v4.startsWith('127.');
  }
  return net.isIPv4(s) && s.startsWith('127.');
}

function hasHeaderValue(val) {
  if (Array.isArray(val)) {
    return val.some((item) => String(item ?? '').trim() !== '');
  }
  return val !== undefined && val !== null && String(val).trim() !== '';
}

/**
 * Menentukan apakah request berasal murni dari loopback lokal tanpa proxy/tunnel.
 * Wajib: socket `remoteAddress` loopback + header `Host` loopback + nol header proxy.
 */
export function isPureLoopback(req) {
  const remote = req?.socket?.remoteAddress;
  if (!isLoopbackIp(remote)) return false;

  const parsedHost = parseHostHeader(req?.headers?.host);
  if (!parsedHost) return false;

  const hostIsLoopback =
    parsedHost.hostname === 'localhost' ||
    parsedHost.hostname.endsWith('.localhost') ||
    isLoopbackIp(parsedHost.hostname);
  if (!hostIsLoopback) return false;

  const headers = req?.headers ?? {};
  for (const h of PROXY_HEADERS) {
    if (hasHeaderValue(headers[h])) return false;
  }

  return true;
}

/**
 * Memvalidasi Same-Origin (anti-CSRF) berdasarkan `Sec-Fetch-Site`, `Origin`, dan `Referer`.
 */
export function checkSameOrigin(req) {
  const headers = req?.headers ?? {};
  const secFetchSite = headers['sec-fetch-site'];
  if (secFetchSite !== undefined) {
    const list = Array.isArray(secFetchSite) ? secFetchSite : [secFetchSite];
    if (list.some((v) => String(v ?? '').trim().toLowerCase() === 'cross-site')) {
      return false;
    }
  }

  const reqHost = typeof headers.host === 'string' ? headers.host.trim() : '';

  if (headers.origin !== undefined) {
    if (typeof headers.origin !== 'string' || !reqHost) return false;
    try {
      const u = new URL(headers.origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.host.toLowerCase() === reqHost.toLowerCase();
    } catch {
      return false;
    }
  }

  if (headers.referer !== undefined) {
    if (typeof headers.referer !== 'string' || !reqHost) return false;
    try {
      const u = new URL(headers.referer);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.host.toLowerCase() === reqHost.toLowerCase();
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Membaca body JSON dari `IncomingMessage` dengan batas ukuran ketat (`maxBytes`, default 64 KB).
 * Body kosong mengembalikan `{}`; payload terlalu besar melempar `{ status: 413, code: 'PAYLOAD_TOO_LARGE' }`.
 */
export function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const rawLen = req?.headers?.['content-length'];
    if (rawLen !== undefined) {
      const declared = Number(rawLen);
      if (Number.isFinite(declared) && declared > maxBytes) {
        if (typeof req.pause === 'function') req.pause();
        reject(Object.assign(new Error('Payload melebihi batas ukuran'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
    }

    let chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks = [];
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        if (typeof req.pause === 'function') req.pause();
        fail(Object.assign(new Error('Payload melebihi batas ukuran'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      chunks = [];
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Body JSON tidak valid'), { status: 400, code: 'INVALID_JSON' }));
      }
    };

    const onError = (err) => {
      fail(Object.assign(err instanceof Error ? err : new Error('Gagal membaca request'), { status: 400, code: 'READ_ERROR' }));
    };

    const onAborted = () => {
      fail(Object.assign(new Error('Request dibatalkan klien'), { status: 400, code: 'REQUEST_ABORTED' }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(cookieHeader) {
  const out = new Map();
  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out.set(key, val);
  }
  return out;
}

export function extractBearerOrHeaderToken(req) {
  const auth = req?.headers?.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const hdr = req?.headers?.['x-kantor-token'];
  if (typeof hdr === 'string' && hdr.trim() !== '') {
    return hdr.trim();
  }
  return null;
}

/**
 * Mengelola token rahasia chat (`<stateDir>/chat-token`) dan cookie sesi HMAC-SHA256 `HttpOnly; SameSite=Strict`.
 */
export function createAuthManager(stateDir) {
  const tokenPath = path.join(stateDir, 'chat-token');
  let token = null;

  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0 && !/[\s\x00-\x1f\x7f]/.test(existing)) {
      token = existing;
    }
  } catch {}

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  }

  const expectedCookie = crypto
    .createHmac('sha256', token)
    .update('kantor-chat-session:v1')
    .digest('hex');

  const getToken = () => token;
  const verifyToken = (cand) => typeof cand === 'string' && cand.length > 0 && constantTimeEqual(cand, token);
  const expectedCookieValue = () => expectedCookie;
  const setSessionCookieHeader = (isHttps) =>
    `kantor_chat=${expectedCookie}; Path=/kerja; HttpOnly; SameSite=Strict${isHttps ? '; Secure' : ''}`;

  const isAuthorized = (req) => {
    const cookies = parseCookies(req?.headers?.cookie);
    const cookieVal = cookies.get('kantor_chat');
    if (cookieVal && constantTimeEqual(cookieVal, expectedCookie)) {
      return true;
    }
    const hdrToken = extractBearerOrHeaderToken(req);
    return hdrToken !== null && verifyToken(hdrToken);
  };

  return {
    getToken,
    verifyToken,
    expectedCookieValue,
    setSessionCookieHeader,
    isAuthorized,
  };
}
