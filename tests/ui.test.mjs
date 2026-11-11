import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { EventEmitter } from 'node:events';
import { createKantorServer } from '../skills/kantor-agent/runtime/bin/serve.mjs';
import { AcpBridge } from '../skills/kantor-agent/runtime/lib/acp.mjs';
import { loadConfig } from '../skills/kantor-agent/runtime/lib/config.mjs';
import { SECURITY_HEADERS } from '../skills/kantor-agent/runtime/lib/http.mjs';

const WORKTREE_ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_DIR = path.join(WORKTREE_ROOT, 'skills', 'kantor-agent', 'runtime');
const CHECK_SCRIPT = path.join(RUNTIME_DIR, 'bin', 'check.mjs');
const FAKE_AGY = path.join(WORKTREE_ROOT, 'tests', 'fixtures', 'fake-agy.mjs');

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

function decodeHtmlEntities(str) {
  return String(str).replace(/&(quot|#39|lt|gt|amp);/g, (_, ent) => {
    if (ent === 'quot') return '"';
    if (ent === '#39') return "'";
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    return '&';
  });
}

function makeTempEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-ui-test-'));
  const projectDir = path.join(base, 'project');
  const storageDir = path.join(base, 'storage');
  const antigravityHome = path.join(base, 'ag-home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(antigravityHome, { recursive: true });
  return { base, projectDir, storageDir, antigravityHome };
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function seedConversation(antigravityHome, projectDir, convId) {
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
      'Sesi UI Test',
      2,
      new Date().toISOString(),
      JSON.stringify([uri]),
      'CASCADE_RUN_STATUS_IDLE',
      'CORTEX_TRAJECTORY_SOURCE_CLI',
      0,
      'antigravity-cli'
    );
  } finally {
    db.close();
  }
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

function rawGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function runCheckCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK_SCRIPT, ...args], {
      cwd: WORKTREE_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Task 8 UI, CSP nonce, XSS escaping & smoke check', () => {
  it('renders page.html with per-response CSP nonce on importmap, meta kantor-config, and strict headers', async () => {
    const env = makeTempEnv();
    const prevAg = process.env.ANTIGRAVITY_HOME;
    process.env.ANTIGRAVITY_HOME = env.antigravityHome;
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
    });

    try {
      const r1 = await rawGet(port, '/kerja', { Host: `127.0.0.1:${port}` });
      assert.equal(r1.status, 200);
      assert.ok(r1.headers['content-type']?.includes('text/html'));
      assert.equal(r1.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(r1.headers['x-frame-options'], 'DENY');
      assert.equal(r1.headers['x-content-type-options'], 'nosniff');
      assert.equal(r1.headers['referrer-policy'], 'no-referrer');

      const csp1 = r1.headers['content-security-policy'] || '';
      assert.equal(csp1.includes("'unsafe-inline'"), true);
      const scriptSrcPart = csp1.split(';').find((d) => d.trim().startsWith('script-src')) || '';
      assert.equal(scriptSrcPart.includes("'unsafe-inline'"), false, 'script-src tidak boleh memakai unsafe-inline');
      const mCspNonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(scriptSrcPart);
      assert.ok(mCspNonce, `script-src wajib mengandung nonce: ${csp1}`);
      const nonce1 = mCspNonce[1];

      const mImportMap = /<script\s+type="importmap"\s+nonce="([^"]+)">/i.exec(r1.text);
      assert.ok(mImportMap, 'importmap wajib memiliki atribut nonce');
      assert.equal(mImportMap[1], nonce1);

      assert.equal(/window\.KANTOR\s*=/.test(r1.text), false, 'tidak boleh ada inline config script window.KANTOR');

      const mMeta = /<meta\s+name="kantor-config"\s+content="([^"]*)">/i.exec(r1.text);
      assert.ok(mMeta, 'meta[name="kantor-config"] wajib ada');
      const parsedCfg = JSON.parse(decodeHtmlEntities(mMeta[1]));
      assert.equal(parsedCfg.ketua, cfg.ketua);
      assert.equal(parsedCfg.ketua_role, 'Lead Architect');
      assert.equal(parsedCfg.team.length, 4);
      assert.equal(parsedCfg.divisions.length, 4);
      assert.equal(parsedCfg.chat.enabled, true);

      // Pastikan nonce berbeda tiap request
      const r2 = await rawGet(port, '/kerja', { Host: `127.0.0.1:${port}` });
      const csp2 = r2.headers['content-security-policy'] || '';
      const mNonce2 = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp2);
      assert.ok(mNonce2);
      assert.notEqual(mNonce2[1], nonce1, 'CSP nonce wajib acak per response');

      // SECURITY_HEADERS pada JSON API tetap tidak berubah
      const ping = await rawGet(port, '/kerja/api/ping', { Host: `127.0.0.1:${port}` });
      assert.equal(ping.headers['content-security-policy'], SECURITY_HEADERS['Content-Security-Policy']);
    } finally {
      await stopServer(server);
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      cleanDir(env.base);
    }
  });

  it('prevents HTML/attribute XSS breakout when cfg.title and cfg.ketua contain hostile markup', async () => {
    const env = makeTempEnv();
    const baseCfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const hostileTitle = '"><script>alert(1)</script><meta name="x';
    const hostileKetua = 'Joko"<img src=x onerror=alert(2)>';
    const cfg = {
      ...baseCfg,
      title: hostileTitle,
      ketua: hostileKetua,
    };

    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
    });

    try {
      const res = await rawGet(port, '/kerja', { Host: `127.0.0.1:${port}` });
      assert.equal(res.status, 200);
      assert.equal(res.text.includes('<script>alert(1)</script>'), false);
      assert.equal(res.text.includes('<img src=x'), false);

      const mTitle = /<title>(.*?)<\/title>/is.exec(res.text);
      assert.ok(mTitle);
      assert.equal(mTitle[1].includes('<script>'), false);
      assert.equal(mTitle[1].includes('&lt;script&gt;'), true);

      const mMeta = /<meta\s+name="kantor-config"\s+content="([^"]*)">/i.exec(res.text);
      assert.ok(mMeta);
      const parsed = JSON.parse(decodeHtmlEntities(mMeta[1]));
      assert.equal(parsed.title, hostileTitle);
      assert.equal(parsed.ketua, hostileKetua);
    } finally {
      await stopServer(server);
      cleanDir(env.base);
    }
  });

  it('serves all Three.js r170 vendored assets and UI modules with 200 and clean Antigravity copy', async () => {
    const env = makeTempEnv();
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
    });

    const assetPaths = [
      '/kerja/assets/kantor.js',
      '/kerja/assets/chat-ui.js',
      '/kerja/assets/vendor/three/build/three.module.js',
      '/kerja/assets/vendor/three/examples/jsm/controls/OrbitControls.js',
      '/kerja/assets/vendor/three/examples/jsm/environments/RoomEnvironment.js',
      '/kerja/assets/vendor/three/examples/jsm/geometries/RoundedBoxGeometry.js',
      '/kerja/assets/vendor/three/examples/jsm/renderers/CSS2DRenderer.js',
    ];

    try {
      for (const p of assetPaths) {
        const res = await rawGet(port, p, { Host: `127.0.0.1:${port}` });
        assert.equal(res.status, 200, `${p} wajib 200`);
        assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.ok(res.text.length > 0);
      }

      const pageHtml = fs.readFileSync(path.join(RUNTIME_DIR, 'views', 'page.html'), 'utf8');
      const kantorJs = fs.readFileSync(path.join(RUNTIME_DIR, 'public', 'assets', 'kantor.js'), 'utf8');
      const chatUiJs = fs.readFileSync(path.join(RUNTIME_DIR, 'public', 'assets', 'chat-ui.js'), 'utf8');
      for (const [name, content] of [
        ['page.html', pageHtml],
        ['kantor.js', kantorJs],
        ['chat-ui.js', chatUiJs],
      ]) {
        assert.equal(/\bClaude\b/i.test(content), false, `${name} tidak boleh menyebut Claude`);
        assert.equal(/\bTodoWrite\b/i.test(content), false, `${name} tidak boleh menyebut TodoWrite`);
      }
    } finally {
      await stopServer(server);
      cleanDir(env.base);
    }
  });

  it('chat-ui.js pure helpers sanitize markdown XSS and deduplicate artifacts safely', async () => {
    const mod = await import(pathToFileURL(path.join(RUNTIME_DIR, 'public', 'assets', 'chat-ui.js')).href);
    assert.equal(typeof mod.renderSafeMarkdown, 'function');
    assert.equal(typeof mod.collectArtifacts, 'function');
    assert.equal(typeof mod.isSafeHref, 'function');
    assert.equal(typeof mod.formatRoleModel, 'function');

    assert.equal(mod.isSafeHref('https://example.com/a'), 'https://example.com/a');
    assert.equal(mod.isSafeHref('http://localhost:8788/kerja'), 'http://localhost:8788/kerja');
    assert.equal(mod.isSafeHref('mailto:tim@example.com'), 'mailto:tim@example.com');
    assert.equal(mod.isSafeHref('javascript:alert(1)'), null);
    assert.equal(mod.isSafeHref('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(mod.isSafeHref('vbscript:msgbox(1)'), null);

    const rm = mod.formatRoleModel('Frontend Engineer', 'gemini-2.5-pro-preview');
    assert.ok(Array.from(rm).length <= 26);
    assert.equal(mod.formatRoleModel('', null, 'Fallback'), 'Fallback');

    const dangerous = [
      '# Judul <script>alert(1)</script>',
      '',
      'Teks **tebal** dan `kode <img onerror=x>` serta [klik](javascript:alert(1)), [data](data:text/html,x), [mail](mailto:hi@example.com), dan [aman](https://example.com/a?b=1&c=2).',
      '',
      '<img src=x onerror=alert(9)>',
      '',
      '```js',
      'const x = "<script>evil()</script>";',
      '```',
      '',
      '- item satu',
      '- item <b onclick=x()>dua</b>',
      '',
      '1. langkah pertama',
      '2. langkah kedua',
    ].join('\n');

    const html = mod.renderSafeMarkdown(dangerous);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<b '), false);
    assert.equal(html.includes('javascript:'), false);
    assert.equal(html.includes('data:text/html'), false);
    assert.equal(html.includes('&lt;img src=x onerror=alert(9)&gt;'), true);
    assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
    assert.equal(html.includes('<strong>tebal</strong>'), true);
    assert.equal(html.includes('<code>kode &lt;img onerror=x&gt;</code>'), true);
    assert.equal(html.includes('href="https://example.com/a?b=1&amp;c=2"'), true);
    assert.equal(html.includes('href="mailto:hi@example.com"'), true);
    assert.equal(html.includes('rel="noopener noreferrer"'), true);
    assert.equal(html.includes('<ol><li>langkah pertama</li><li>langkah kedua</li></ol>'), true);

    const artifacts = mod.collectArtifacts({
      ketua: {
        name: 'Joko',
        role: 'Lead Architect',
        color: '#6a55c9',
        artifacts: [
          { conv_id: 'c1', name: 'plan.md', summary: 'Plan', updated_at: '2026-11-11T05:00:00.000Z', kind: 'md' },
        ],
      },
      runs: [
        {
          id: 'r1',
          label: 'Budi',
          division: 'Frontend & UI',
          color: '#3f6fd1',
          artifacts: [
            { conv_id: 'c1', name: 'plan.md', summary: 'Dup', updated_at: '2026-11-11T05:00:00.000Z', kind: 'md' },
            { conv_id: 'c2', name: 'report.pdf', summary: 'PDF', updated_at: '2026-11-11T06:00:00.000Z', kind: 'pdf' },
          ],
        },
      ],
      team: [],
      freelancers: [],
    });
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].name, 'report.pdf');
    assert.equal(artifacts[1].name, 'plan.md');

    // Review fix tests: link containing inline code / bold + normalizeColors + stream error + session dedup
    const codeLinkHtml = mod.renderSafeMarkdown('Lihat [`kode`](https://example.com) dan [**tebal** `<script>`](https://example.com/a).');
    assert.equal(codeLinkHtml.includes('\0'), false, 'placeholder token tidak boleh bocor');
    assert.equal(codeLinkHtml.includes('TK'), false, 'placeholder TK tidak boleh bocor');
    assert.equal(codeLinkHtml.includes('<a href="https://example.com/" target="_blank" rel="noopener noreferrer"><code>kode</code></a>'), true);
    assert.equal(codeLinkHtml.includes('<strong>tebal</strong> <code>&lt;script&gt;</code>'), true);

    assert.equal(typeof mod.normalizeColors, 'function');
    assert.deepEqual(mod.normalizeColors(undefined), {
      ketua: '#6a55c9',
      team: ['#3f6fd1', '#2f9a6d', '#d9772f', '#c2417a'],
      freelancers: ['#0f8fa3', '#9a7418', '#4f7d3a', '#8a4fa8', '#3d7f9e', '#b8452f'],
    });
    assert.deepEqual(mod.normalizeColors({ ketua: '#123456' }), {
      ketua: '#123456',
      team: ['#3f6fd1', '#2f9a6d', '#d9772f', '#c2417a'],
      freelancers: ['#0f8fa3', '#9a7418', '#4f7d3a', '#8a4fa8', '#3d7f9e', '#b8452f'],
    });
    assert.deepEqual(mod.normalizeColors({ team: ['#111111', ''], freelancers: ['#222222'] }), {
      ketua: '#6a55c9',
      team: ['#111111', '#2f9a6d', '#d9772f', '#c2417a'],
      freelancers: ['#222222'],
    });

    assert.equal(typeof mod.handleStreamErrorEvent, 'function');
    let serverErrors = [];
    let disconnects = 0;
    const rServer = await mod.handleStreamErrorEvent(
      { data: JSON.stringify({ error: 'Baris output ACP melebihi batas 4 MB' }) },
      {
        onServerError: (d) => serverErrors.push(d?.error),
        onDisconnect: () => { disconnects += 1; },
      }
    );
    assert.equal(rServer, 'server_error');
    assert.deepEqual(serverErrors, ['Baris output ACP melebihi batas 4 MB']);
    assert.equal(disconnects, 0);

    const rDrop = await mod.handleStreamErrorEvent(
      { type: 'error' },
      {
        onServerError: (d) => serverErrors.push(d?.error),
        onDisconnect: () => { disconnects += 1; },
      }
    );
    assert.equal(rDrop, 'disconnect');
    assert.equal(disconnects, 1);

    assert.equal(typeof mod.filterDisplayHistory, 'function');
    assert.equal(typeof mod.appendUniqueEntry, 'function');
    const filtered = mod.filterDisplayHistory([
      { id: 'h-1', type: 'session', action: 'new' },
      { id: 'h-2', type: 'permission', status: 'pending' },
      { id: 'h-3', type: 'permission', status: 'resolved' },
    ]);
    assert.deepEqual(filtered.map((x) => x.id), ['h-1', 'h-3']);
    assert.equal(mod.appendUniqueEntry(filtered, { id: 'h-1', type: 'session' }), false);
    assert.equal(mod.appendUniqueEntry(filtered, { id: 'h-4', type: 'session' }), true);
    assert.equal(filtered.length, 3);
  });

  it('AcpBridge broadcasts matching history id on session SSE event (new & load) and check.mjs handles IPv6', async () => {
    const env = makeTempEnv();
    const bridge = new AcpBridge({
      projectDir: env.projectDir,
      agyBin: FAKE_AGY,
      isCliSession: () => true,
    });
    const emitter = new EventEmitter();
    const chunks = [];
    const mockRes = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead() { this.headersSent = true; },
      write(c) { chunks.push(String(c)); emitter.emit('chunk'); return true; },
      end() { this.writableEnded = true; emitter.emit('close'); },
      on(ev, fn) { emitter.on(ev, fn); return this; },
    };

    try {
      bridge.subscribeSse(mockRes);
      await bridge.createSession();
      await bridge.loadSession('cli-idle-1');

      const raw = chunks.join('');
      const sessionMatches = Array.from(raw.matchAll(/event:\s*session\ndata:\s*(\{[^\n]+\})/g)).map((m) =>
        JSON.parse(m[1])
      );
      assert.equal(sessionMatches.length, 2, 'wajib ada 2 event session (new & load)');
      const histSessions = bridge.getHistory().filter((h) => h.type === 'session');
      assert.equal(histSessions.length, 2);
      assert.equal(sessionMatches[0].id, histSessions[0].id);
      assert.equal(sessionMatches[1].id, histSessions[1].id);

      const kantorSrc = fs.readFileSync(path.join(RUNTIME_DIR, 'public', 'assets', 'kantor.js'), 'utf8');
      assert.equal(kantorSrc.includes('normalizeColors(CFG.colors)'), true);

      const checkSource = fs.readFileSync(CHECK_SCRIPT, 'utf8');
      assert.equal(checkSource.includes(".replace(/^\\[|\\]$/g, '')"), true, 'check.mjs wajib melepas kurung siku IPv6');
    } finally {
      await bridge.shutdown();
      cleanDir(env.base);
    }
  });

  it('bin/check.mjs passes end-to-end against live ephemeral createKantorServer (IPv4 & IPv6)', async () => {
    const env = makeTempEnv();
    const convId = '33333333-3333-4333-8333-333333333333';
    seedConversation(env.antigravityHome, env.projectDir, convId);

    const prevAg = process.env.ANTIGRAVITY_HOME;
    process.env.ANTIGRAVITY_HOME = env.antigravityHome;
    const cfg = loadConfig(RUNTIME_DIR, env.projectDir);
    const { server, port } = await startServer({
      projectDir: env.projectDir,
      runtimeDir: RUNTIME_DIR,
      storageDir: env.storageDir,
      cfg,
    });

    let ipv6Server = null;
    try {
      const token = server.authManager.getToken();
      const res = await runCheckCli([`http://127.0.0.1:${port}`, '--token', token]);
      assert.equal(res.code, 0, `check.mjs gagal:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
      assert.ok(res.stdout.includes('OK ('), `Expected OK summary, got:\n${res.stdout}`);

      ipv6Server = createKantorServer({
        projectDir: env.projectDir,
        runtimeDir: RUNTIME_DIR,
        storageDir: env.storageDir,
        cfg,
      });
      const ipv6Port = await new Promise((resolve) => {
        ipv6Server.once('error', () => resolve(null));
        ipv6Server.listen(0, '::1', () => resolve(ipv6Server.address().port));
      });
      if (ipv6Port !== null) {
        const res6 = await runCheckCli([`http://[::1]:${ipv6Port}`, '--token', token]);
        assert.equal(res6.code, 0, `check.mjs IPv6 gagal:\nSTDOUT:\n${res6.stdout}\nSTDERR:\n${res6.stderr}`);
      }
    } finally {
      await stopServer(ipv6Server);
      await stopServer(server);
      if (prevAg === undefined) delete process.env.ANTIGRAVITY_HOME;
      else process.env.ANTIGRAVITY_HOME = prevAg;
      cleanDir(env.base);
    }
  });
});
