#!/usr/bin/env node
// Pemeriksaan cepat server yang sedang berjalan (Node >= 18, tanpa Playwright):
// halaman HTML, meta kantor-config, CSP nonce, header keamanan, vendored Three.js,
// Host allowlist (421), anti-traversal, redaksi state, dan auth chat ACP.
//   node bin/check.mjs http://127.0.0.1:8788 [--token <tok>]   -> keluar 0 bila semua lolos
import http from 'node:http';
import https from 'node:https';

function parseArgs(argv) {
  let baseArg = '';
  let token = process.env.KANTOR_CHAT_TOKEN || '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--token' && i + 1 < argv.length) {
      token = argv[++i];
    } else if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length);
    } else if (!arg.startsWith('-') && !baseArg) {
      baseArg = arg;
    }
  }
  const base = (baseArg || `http://127.0.0.1:${process.env.KANTOR_PORT || 8788}`)
    .replace(/\/+$/, '')
    .replace(/\/kerja$/, '');
  return { base, token };
}

function decodeHtmlEntities(str) {
  return String(str).replace(/&(quot|#39|lt|gt|amp);/g, (_, ent) => {
    if (ent === 'quot') return '"';
    if (ent === '#39') return "'";
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    return '&';
  });
}

function rawHostProbe(baseUrl, reqPath, customHost) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: reqPath,
        headers: { Host: customHost },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const { base, token } = parseArgs(process.argv.slice(2));
const origin = new URL(base).origin;
const bad = [];
const good = [];
const t = (name, cond, extra = '') => (cond ? good : bad).push(extra ? `${name} (${extra})` : name);
const get = (p) => fetch(base + p, { redirect: 'manual' });

try {
  const page = await get('/kerja');
  const html = await page.text();
  t('/kerja -> 200', page.status === 200, String(page.status));
  t('header X-Robots-Tag noindex', /noindex/i.test(page.headers.get('x-robots-tag') || ''));
  t('header Referrer-Policy no-referrer', page.headers.get('referrer-policy') === 'no-referrer');
  t('header X-Frame-Options DENY', page.headers.get('x-frame-options') === 'DENY');
  t('header X-Content-Type-Options nosniff', page.headers.get('x-content-type-options') === 'nosniff');

  const csp = page.headers.get('content-security-policy') || '';
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) || '';
  const cspNonceMatch = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrc);
  t(
    'header Content-Security-Policy (nonce tanpa unsafe-inline script)',
    /default-src 'self'/.test(csp) && Boolean(cspNonceMatch) && !scriptSrc.includes("'unsafe-inline'")
  );

  const importMapMatch = /<script\s+type="importmap"\s+nonce="([^"]+)">/i.exec(html);
  t(
    '<script type="importmap" nonce=...> cocok dengan CSP',
    Boolean(importMapMatch && cspNonceMatch && importMapMatch[1] === cspNonceMatch[1])
  );

  const metaMatch = /<meta\s+name="kantor-config"\s+content="([^"]*)">/i.exec(html);
  let cfg = null;
  try {
    cfg = metaMatch ? JSON.parse(decodeHtmlEntities(metaMatch[1])) : null;
  } catch {
    cfg = null;
  }
  t(
    'meta[name="kantor-config"] valid (4 tim & 4 divisi)',
    cfg !== null &&
      Array.isArray(cfg.team) &&
      cfg.team.length === 4 &&
      Array.isArray(cfg.divisions) &&
      cfg.divisions.length === 4
  );

  const pingRes = await get('/kerja/api/ping');
  const pingJson = await pingRes.json().catch(() => null);
  t('/kerja/api/ping -> 200 JSON', pingRes.status === 200 && pingJson?.ok === true && pingJson?.app === 'kantor-agent', String(pingRes.status));

  const r = await get('/kerja/api/state');
  const s = await r.json().catch(() => null);
  t('/kerja/api/state -> JSON', r.status === 200 && s && s.app === 'kantor-agent', String(r.status));
  if (s) {
    for (const k of ['ketua', 'team', 'freelancers', 'feed', 'runs', 'stats', 'chat']) {
      t(`state.${k} ada`, k in s);
    }
    t('state.ketua.role ada', typeof s.ketua?.role === 'string' && s.ketua.role.length > 0);
    t('state.team[0].division ada', Array.isArray(s.team) && s.team.length === 4 && typeof s.team[0]?.division === 'string' && s.team[0].division.length > 0);
    const txt = JSON.stringify(s);
    t('tidak ada token sk-… / ghp_… yang lolos redaksi', !/\bsk-(?!•)[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}/.test(txt));
    const busy = s.team.filter((m2) => m2.state === 'bekerja').map((m2) => m2.name);
    console.log(`  ${s.project}: transkrip ${s.transcripts ? 'ada' : 'belum ada'} · ${s.ketua.name} (${s.ketua.role}) ${s.ketua.state} · tim bekerja: ${busy.join(', ') || '—'} · freelancer: ${s.freelancers.length} · ${s.stats.total} subagent (7 hari)`);
  }

  const assetPaths = [
    '/kerja/assets/kantor.js',
    '/kerja/assets/chat-ui.js',
    '/kerja/assets/vendor/three/build/three.module.js',
    '/kerja/assets/vendor/three/examples/jsm/controls/OrbitControls.js',
    '/kerja/assets/vendor/three/examples/jsm/environments/RoomEnvironment.js',
    '/kerja/assets/vendor/three/examples/jsm/geometries/RoundedBoxGeometry.js',
    '/kerja/assets/vendor/three/examples/jsm/renderers/CSS2DRenderer.js',
  ];
  for (const ap of assetPaths) {
    const ar = await get(ap);
    t(`${ap} -> 200`, ar.status === 200, String(ar.status));
  }

  const evilStatus = await rawHostProbe(base, '/kerja/api/ping', 'evil.com');
  t('Host: evil.com -> 421', evilStatus === 421, String(evilStatus));

  for (const tp of [
    '/kerja/assets/..%2F..%2Fdefaults.json',
    '/kerja/api/artifact?conv=bad&file=../x',
    '/kerja/api/artifact?conv=11111111-1111-4111-8111-111111111111&file=../x',
  ]) {
    const tr = await get(tp);
    t(`tolak traversal ${tp} -> 403/404`, tr.status === 403 || tr.status === 404, String(tr.status));
  }

  for (const p of ['/defaults.json', '/kerja/tidak-ada']) {
    const nr = await get(p);
    t(`404 ${p}`, nr.status === 404, String(nr.status));
  }

  const chatEnabled = s?.chat?.enabled !== false;
  const unauthSend = await fetch(`${base}/kerja/api/chat/send`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'ping' }),
  });
  t(
    'POST /kerja/api/chat/send tanpa auth -> 401',
    chatEnabled ? unauthSend.status === 401 : unauthSend.status === 503,
    String(unauthSend.status)
  );

  const authRes = await fetch(`${base}/kerja/api/chat/auth`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(token ? { token } : {}),
  });
  t(
    'POST /kerja/api/chat/auth -> 200',
    chatEnabled ? authRes.status === 200 : authRes.status === 503,
    String(authRes.status)
  );
} catch (e) {
  bad.push(`tidak bisa terhubung ke ${base}: ${e.cause?.code || e.message}`);
}

for (const g of good) console.log(`  ok    ${g}`);
for (const b of bad) console.log(`  GAGAL ${b}`);
console.log(bad.length ? `GAGAL (${bad.length})` : `OK (${good.length} pemeriksaan) — buka ${base}/kerja`);
process.exit(bad.length ? 1 : 0);
