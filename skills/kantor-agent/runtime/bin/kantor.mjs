#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../lib/config.mjs';
import { discoverSurfaceRoots } from '../lib/antigravity.mjs';
import { createAuthManager } from '../lib/http.mjs';
import { isDir, isFile, normalizeWorkspacePath, readText } from '../lib/util.mjs';

const execFileAsync = promisify(execFile);

const RUNTIME_DIR = path.resolve(import.meta.dirname, '..');
const DEFAULT_AGENTS_RESOURCES_DIR = path.resolve(RUNTIME_DIR, '..', 'resources', 'agents');
const SERVE_SCRIPT = path.join(RUNTIME_DIR, 'bin', 'serve.mjs');
const CMD_UNSAFE_RE = /[\x00-\x1f\x7f"&|<>^%!;=]/;
const EXPECTED_AGENT_FILES = [
  'backend-architect.md',
  'frontend-ui-dev.md',
  'product-ops-researcher.md',
  'qa-security-engineer.md',
];
const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultAntigravityConfigDir() {
  const envDir =
    typeof process.env.ANTIGRAVITY_CONFIG_DIR === 'string'
      ? process.env.ANTIGRAVITY_CONFIG_DIR.trim()
      : '';
  return envDir ? path.resolve(envDir) : path.join(os.homedir(), '.gemini', 'config');
}

/**
 * Menyalin 4 templat subagent spesialis IT dari `resourcesDir` ke `<configDir>/agents/`
 * secara idempoten (tidak menimpa file pengguna kecuali `force: true`).
 */
export function setupTeam({ configDir, resourcesDir, force = false } = {}) {
  const resolvedConfigDir =
    typeof configDir === 'string' && configDir.trim() !== ''
      ? path.resolve(configDir.trim())
      : defaultAntigravityConfigDir();
  const resolvedResourcesDir =
    typeof resourcesDir === 'string' && resourcesDir.trim() !== ''
      ? path.resolve(resourcesDir.trim())
      : DEFAULT_AGENTS_RESOURCES_DIR;

  if (!isDir(resolvedResourcesDir)) {
    throw new Error(`Direktori templat agen tidak ditemukan: ${resolvedResourcesDir}`);
  }

  const agentsDir = path.join(resolvedConfigDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const files = fs
    .readdirSync(resolvedResourcesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const copied = [];
  const skipped = [];

  for (const name of files) {
    const src = path.join(resolvedResourcesDir, name);
    const dest = path.join(agentsDir, name);
    if (fs.existsSync(dest) && !force) {
      skipped.push(name);
      continue;
    }
    fs.copyFileSync(src, dest);
    copied.push(name);
  }

  return {
    configDir: resolvedConfigDir,
    agentsDir,
    copied,
    skipped,
  };
}

/**
 * Menghitung direktori storage deterministik per proyek pada `~/.cache/kantor-agent/<slug>-<hash12>`.
 */
export function defaultStorageDir(projectDir) {
  const resolved = path.resolve(projectDir || process.cwd());
  const norm = normalizeWorkspacePath(resolved) || resolved;
  const rawSlug = path.basename(resolved).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = (rawSlug || 'project').slice(0, 32);
  const hash12 = crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.cache', 'kantor-agent', `${slug}-${hash12}`);
}

export function resolveStorageDir(args, projectDir) {
  if (typeof args?.storage === 'string' && args.storage.trim() !== '') {
    return path.resolve(args.storage.trim());
  }
  const envStorage =
    typeof process.env.KANTOR_STORAGE === 'string' ? process.env.KANTOR_STORAGE.trim() : '';
  if (envStorage !== '') {
    return path.resolve(envStorage);
  }
  return defaultStorageDir(projectDir);
}

function parsePortValue(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`Port tidak valid: "${raw}" (wajib bilangan bulat 1..65535)`);
  }
  const port = Number(s);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Port di luar rentang: ${port} (wajib 1..65535)`);
  }
  return port;
}

/**
 * Mengurai argumen CLI launcher `kantor.mjs`.
 */
export function parseLauncherArgs(argv = []) {
  const out = {
    command: '',
    force: false,
    quiet: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--force' || arg === '-f') {
      out.force = true;
    } else if (arg === '--quiet' || arg === '-q') {
      out.quiet = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--sandbox') {
      out.sandbox = true;
    } else if (arg === '--no-sandbox') {
      out.sandbox = false;
    } else if (arg.startsWith('--sandbox=')) {
      const v = arg.slice('--sandbox='.length).toLowerCase();
      out.sandbox = v === '1' || v === 'true';
    } else if (arg === '--project' || arg === '--storage' || arg === '--bind' || arg === '--port') {
      if (i + 1 >= argv.length) {
        throw new Error(`Flag ${arg} membutuhkan nilai`);
      }
      const val = argv[++i];
      if (arg === '--project') out.project = val;
      else if (arg === '--storage') out.storage = val;
      else if (arg === '--bind') out.bind = val;
      else if (arg === '--port') out.port = parsePortValue(val);
    } else if (arg.startsWith('--project=')) {
      out.project = arg.slice('--project='.length);
    } else if (arg.startsWith('--storage=')) {
      out.storage = arg.slice('--storage='.length);
    } else if (arg.startsWith('--bind=')) {
      out.bind = arg.slice('--bind='.length);
    } else if (arg.startsWith('--port=')) {
      out.port = parsePortValue(arg.slice('--port='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Opsi tidak dikenal: ${arg}`);
    } else if (!out.command) {
      out.command = arg;
    } else {
      throw new Error(`Argumen tidak dikenal: ${arg}`);
    }
  }

  return out;
}

function connectHostForBind(bind) {
  const b = String(bind || '127.0.0.1').trim();
  if (b === '' || b === '0.0.0.0') return '127.0.0.1';
  if (b === '::' || b === '[::]') return '::1';
  if (b.startsWith('[') && b.endsWith(']')) return b.slice(1, -1);
  return b;
}

function formatHostForUrl(host) {
  const h = String(host || '127.0.0.1');
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

function isLoopbackBind(bind) {
  const b = String(bind || '127.0.0.1').trim().toLowerCase();
  return b === '127.0.0.1' || b === '::1' || b === '[::1]' || b === 'localhost';
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function terminatePid(pid, gracefulWaitMs = 500) {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  const deadline = Date.now() + gracefulWaitMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await sleep(50);
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  const killDeadline = Date.now() + 1500;
  while (Date.now() < killDeadline) {
    if (!processAlive(pid)) return;
    await sleep(50);
  }
}

function readJsonFile(filePath) {
  const raw = readText(filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function removeFileSafe(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function readLogTail(logPath, maxLines = 20) {
  const txt = readText(logPath);
  if (!txt) return '';
  const lines = txt.trim().split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    srv.once('error', () => finish(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => finish(true));
    });
  });
}

async function findAvailablePort(basePort, bind, maxOffset = 20) {
  const startPort = Math.max(1, Math.min(65535, basePort));
  const endPort = Math.min(65535, startPort + maxOffset);
  for (let port = startPort; port <= endPort; port++) {
    if (await isPortFree(port, bind)) {
      return port;
    }
  }
  throw new Error(`Tidak ada port TCP kosong pada ${bind} di rentang ${startPort}..${endPort}`);
}

async function fetchJson(url, timeoutMs = 1500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Connection: 'close' },
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

async function probePing(connectHost, port, timeoutMs = 1500) {
  const baseUrl = `http://${formatHostForUrl(connectHost)}:${port}`;
  const { status, data } = await fetchJson(`${baseUrl}/kerja/api/ping`, timeoutMs);
  return status === 200 && data?.ok === true && data?.app === 'kantor-agent' ? data : null;
}

async function probeState(connectHost, port, timeoutMs = 1500) {
  const baseUrl = `http://${formatHostForUrl(connectHost)}:${port}`;
  const { status, data } = await fetchJson(`${baseUrl}/kerja/api/state`, timeoutMs);
  return status === 200 && data?.app === 'kantor-agent' ? data : null;
}

async function locateBinary(name, override = '') {
  const candidateRaw = String(override || name || '').trim();
  if (!candidateRaw) return null;

  if (process.platform === 'win32') {
    const rawPathext = String(process.env.PATHEXT || '.EXE;.COM;.CMD;.BAT')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e === '.exe' || e === '.com' || e === '.cmd' || e === '.bat');
    const exts = ['.exe', ...rawPathext.filter((e) => e !== '.exe')];
    const hasSep = candidateRaw.includes('\\') || candidateRaw.includes('/') || candidateRaw.includes(':');

    if (hasSep) {
      if (isFile(candidateRaw)) return candidateRaw;
      if (path.extname(candidateRaw) === '') {
        for (const ext of exts) {
          const cand = `${candidateRaw}${ext}`;
          if (isFile(cand)) return cand;
        }
      }
      return null;
    }

    const pathDirs = String(process.env.PATH || '')
      .split(path.delimiter)
      .map((d) => d.trim().replace(/^"+|"+$/g, ''))
      .filter(Boolean);

    for (const dir of pathDirs) {
      for (const ext of exts) {
        const cand = path.join(dir, `${candidateRaw}${ext}`);
        if (isFile(cand)) return cand;
      }
    }

    try {
      const { stdout } = await execFileAsync('where.exe', [candidateRaw], {
        windowsHide: true,
        timeout: 3000,
      });
      const first = stdout.trim().split(/\r?\n/).find((l) => l.trim() && isFile(l.trim()));
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }

  if (candidateRaw.includes('/')) {
    return isFile(candidateRaw) ? candidateRaw : null;
  }

  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const cand = path.join(dir, candidateRaw);
    if (isFile(cand)) return cand;
  }

  try {
    const { stdout } = await execFileAsync('which', [candidateRaw], { timeout: 3000 });
    const first = stdout.trim().split(/\r?\n/)[0];
    return first && isFile(first) ? first : null;
  } catch {
    return null;
  }
}

async function getBinaryVersion(binPath) {
  if (!binPath) return null;
  try {
    const lower = binPath.toLowerCase();
    if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
      if (CMD_UNSAFE_RE.test(binPath)) return null;
      const comSpec = process.env.ComSpec || 'cmd.exe';
      const { stdout } = await execFileAsync(comSpec, ['/d', '/s', '/c', `""${binPath}" --version"`], {
        windowsHide: true,
        timeout: 5000,
      });
      return stdout.trim().split(/\r?\n/)[0] || null;
    }
    const { stdout } = await execFileAsync(binPath, ['--version'], {
      windowsHide: true,
      timeout: 5000,
    });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

async function stopTunnelInStorage(storageDir) {
  const tunnelJsonPath = path.join(storageDir, 'tunnel.json');
  const tunnelUrlPath = path.join(storageDir, 'tunnel-url.txt');
  const meta = readJsonFile(tunnelJsonPath);
  const hadFile = Boolean(meta) || fs.existsSync(tunnelJsonPath) || fs.existsSync(tunnelUrlPath);
  const wasAlive = Boolean(meta?.pid && processAlive(meta.pid));
  if (wasAlive) {
    await terminatePid(meta.pid, 500);
  }
  removeFileSafe(tunnelJsonPath);
  removeFileSafe(tunnelUrlPath);
  return { hadFile, wasAlive };
}

function checkNodeRequirement() {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  return major > 22 || (major === 22 && minor >= 5);
}

async function handleDetect(args) {
  const nodeOk = checkNodeRequirement();
  let sqliteOk = false;
  try {
    const sqlite = await import('node:sqlite');
    sqliteOk = typeof sqlite.DatabaseSync === 'function';
  } catch {
    sqliteOk = false;
  }

  const agyRequested =
    typeof process.env.KANTOR_AGY_BIN === 'string' && process.env.KANTOR_AGY_BIN.trim() !== ''
      ? process.env.KANTOR_AGY_BIN.trim()
      : 'agy';
  const agyPath = await locateBinary('agy', agyRequested);
  const agyVersion = agyPath ? await getBinaryVersion(agyPath) : null;
  const cfPath = await locateBinary('cloudflared');

  const roots = discoverSurfaceRoots(os.homedir());
  const surfaceRoots = roots.map((r) => ({
    path: r,
    hasDb: isFile(path.join(r, 'conversation_summaries.db')),
  }));
  const dbCount = surfaceRoots.filter((r) => r.hasDb).length;

  const configDir = defaultAntigravityConfigDir();
  const agentsDir = path.join(configDir, 'agents');
  const presentFiles = EXPECTED_AGENT_FILES.filter((f) => isFile(path.join(agentsDir, f)));
  const missingFiles = EXPECTED_AGENT_FILES.filter((f) => !isFile(path.join(agentsDir, f)));

  const report = {
    ok: nodeOk && sqliteOk && Boolean(agyPath),
    platform: process.platform,
    nodeVersion: process.version,
    nodeOk,
    sqliteOk,
    agy: {
      found: Boolean(agyPath),
      path: agyPath,
      version: agyVersion,
    },
    cloudflared: {
      found: Boolean(cfPath),
      path: cfPath,
    },
    surfaceRoots,
    dbCount,
    teamTemplates: {
      agentsDir,
      installed: missingFiles.length === 0,
      count: presentFiles.length,
      files: presentFiles,
      missing: missingFiles,
    },
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!args.quiet) {
    const lines = [
      `Kantor Agent — Deteksi Lingkungan (${process.platform})`,
      `  Node.js       : ${process.version} (${nodeOk ? 'OK >= 22.5' : 'GAGAL < 22.5'})`,
      `  node:sqlite   : ${sqliteOk ? 'tersedia' : 'TIDAK tersedia'}`,
      `  agy CLI       : ${agyPath ? `${agyPath}${agyVersion ? ` (v${agyVersion.replace(/^v/i, '')})` : ''}` : 'TIDAK ditemukan di PATH (chat ACP nonaktif hingga agy terpasang)'}`,
      `  cloudflared   : ${cfPath || 'belum terpasang (opsional untuk tunnel)'}`,
      `  Surface DB    : ${surfaceRoots.length} root ditemukan (${dbCount} memiliki conversation_summaries.db)`,
      ...surfaceRoots.map((r) => `    - ${r.path} [${r.hasDb ? 'DB ada' : 'belum ada DB'}]`),
      `  Tim IT (4 .md): ${presentFiles.length}/4 terpasang di ${agentsDir}${missingFiles.length ? ` (jalankan 'setup-team' untuk memasang: ${missingFiles.join(', ')})` : ''}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  return nodeOk && sqliteOk ? 0 : 1;
}

async function handleSetupTeam(args) {
  const result = setupTeam({ force: args.force });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  if (!args.quiet) {
    const lines = [
      `Tim IT Spesialis Kantor Agent -> ${result.agentsDir}`,
      `  Disalin  (${result.copied.length}): ${result.copied.length ? result.copied.join(', ') : '—'}`,
      `  Dilewati (${result.skipped.length}): ${result.skipped.length ? result.skipped.join(', ') : '—'}`,
    ];
    if (result.skipped.length && !args.force) {
      lines.push('  Tip: gunakan --force bila ingin menimpa templat yang sudah ada.');
    }
    lines.push('  Ketua (Joko) siap mendelegasikan tugas ke: frontend-ui-dev, backend-architect, qa-security-engineer, product-ops-researcher.');
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

function printStartSummary({ header, url, bind, token, projectDir }) {
  const selfScript = path.join(RUNTIME_DIR, 'bin', 'kantor.mjs');
  const lines = [header, `URL: ${url}`];
  if (!isLoopbackBind(bind)) {
    lines.push(`Token: ${token}`);
    lines.push('Peringatan: bind non-loopback aktif; simpan chat-token dengan aman.');
  } else {
    lines.push(`Token: jalankan 'node "${selfScript}" token --project "${projectDir}"' (otomatis di localhost)`);
  }
  lines.push(`Stop: node "${selfScript}" stop --project "${projectDir}"`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function handleStart(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const cfg = loadConfig(RUNTIME_DIR, projectDir, {
    bind: args.bind,
    sandbox: args.sandbox,
  });

  const bind = args.bind ?? cfg.bind ?? '127.0.0.1';
  const basePort = args.port ?? cfg.port ?? 8788;
  const sandbox = args.sandbox ?? cfg.chat?.sandbox ?? false;

  const serverJsonPath = path.join(storageDir, 'server.json');
  const existing = readJsonFile(serverJsonPath);
  if (existing && processAlive(existing.pid) && Number.isInteger(existing.port)) {
    const existingHost = existing.connectHost || connectHostForBind(existing.bind || bind);
    const ping = await probePing(existingHost, existing.port);
    if (ping) {
      const authManager = createAuthManager(storageDir);
      const token = authManager.getToken();
      const existingUrl = existing.url || `http://${formatHostForUrl(existingHost)}:${existing.port}/kerja`;
      const effectiveBind = existing.bind || bind;
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, alreadyRunning: true, ...existing, url: existingUrl }, null, 2)}\n`);
      } else if (!args.quiet) {
        printStartSummary({
          header: 'Kantor Agent sudah berjalan.',
          url: existingUrl,
          bind: effectiveBind,
          token,
          projectDir,
        });
      }
      return 0;
    }
  }

  removeFileSafe(serverJsonPath);
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const authManager = createAuthManager(storageDir);
  const token = authManager.getToken();

  const port = await findAvailablePort(basePort, bind, 20);
  const connectHost = connectHostForBind(bind);
  const localUrl = `http://${formatHostForUrl(connectHost)}:${port}/kerja`;
  const logPath = path.join(storageDir, 'server.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);

  const childArgs = [
    SERVE_SCRIPT,
    '--project',
    projectDir,
    '--storage',
    storageDir,
    '--bind',
    bind,
    '--port',
    String(port),
    ...(sandbox ? ['--sandbox'] : []),
  ];

  let child;
  let childExited = false;
  let exitInfo = '';
  try {
    child = spawn(process.execPath, childArgs, {
      cwd: projectDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('exit', (code, signal) => {
      childExited = true;
      exitInfo = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    });
    child.once('error', (err) => {
      childExited = true;
      exitInfo = err.message;
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (childExited) {
      const tail = readLogTail(logPath, 20);
      throw new Error(
        `Server gagal start (${exitInfo}).${tail ? `\nLog terakhir (${logPath}):\n${tail}` : ''}`
      );
    }
    const ping = await probePing(connectHost, port, 800);
    if (ping) {
      ready = true;
      break;
    }
    await sleep(100);
  }

  if (!ready) {
    await terminatePid(child.pid, 300);
    const tail = readLogTail(logPath, 20);
    throw new Error(
      `Server tidak merespons /kerja/api/ping dalam 8 detik.${tail ? `\nLog terakhir (${logPath}):\n${tail}` : ''}`
    );
  }

  const meta = {
    pid: child.pid,
    port,
    bind,
    connectHost,
    url: localUrl,
    projectDir,
    storageDir,
    sandbox: Boolean(sandbox),
    startedAt: new Date().toISOString(),
  };
  writePrivateFile(serverJsonPath, `${JSON.stringify(meta, null, 2)}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...meta }, null, 2)}\n`);
  } else if (!args.quiet) {
    printStartSummary({
      header: 'Kantor Agent aktif!',
      url: localUrl,
      bind,
      token,
      projectDir,
    });
  }

  return 0;
}

async function handleStop(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const serverJsonPath = path.join(storageDir, 'server.json');

  await stopTunnelInStorage(storageDir);

  const meta = readJsonFile(serverJsonPath);
  const wasAlive = Boolean(meta?.pid && processAlive(meta.pid));
  if (wasAlive) {
    await terminatePid(meta.pid, 500);
  }
  removeFileSafe(serverJsonPath);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: true, wasRunning: wasAlive }, null, 2)}\n`);
  } else if (!args.quiet) {
    process.stdout.write(
      wasAlive
        ? `Kantor Agent (PID ${meta.pid}) berhasil dihentikan.\n`
        : 'Kantor Agent sudah berhenti (tidak sedang berjalan).\n'
    );
  }
  return 0;
}

async function handleRestart(args) {
  await handleStop({ ...args, quiet: true, json: false });
  return handleStart(args);
}

async function handleStatus(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const serverJsonPath = path.join(storageDir, 'server.json');
  const meta = readJsonFile(serverJsonPath);

  if (!meta || !processAlive(meta.pid) || !Number.isInteger(meta.port)) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, running: false, storageDir }, null, 2)}\n`);
    } else if (!args.quiet) {
      process.stdout.write('Status: tidak berjalan (berhenti).\n');
    }
    return 0;
  }

  const connectHost = meta.connectHost || connectHostForBind(meta.bind || '127.0.0.1');
  const ping = await probePing(connectHost, meta.port);
  if (!ping) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, running: false, stale: true, pid: meta.pid, storageDir }, null, 2)}\n`);
    } else if (!args.quiet) {
      process.stdout.write(`Status: tidak berjalan (PID ${meta.pid} tidak merespons).\n`);
    }
    return 0;
  }

  const state = await probeState(connectHost, meta.port);
  const active = state?.stats?.active ?? 0;
  const sessionsActive = state?.stats?.sessions_active ?? 0;
  const publicUrl = state?.public_url ?? null;
  const localUrl = meta.url || `http://${formatHostForUrl(connectHost)}:${meta.port}/kerja`;

  const out = {
    ok: true,
    running: true,
    pid: meta.pid,
    port: meta.port,
    bind: meta.bind || '127.0.0.1',
    url: localUrl,
    public_url: publicUrl,
    active,
    sessions_active: sessionsActive,
    projectDir: meta.projectDir || projectDir,
    storageDir,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else if (!args.quiet) {
    const lines = [
      `Status: berjalan (PID ${out.pid}, bind ${out.bind}, port ${out.port})`,
      `URL   : ${out.url}`,
      `Aktif : ${out.active} subagent, ${out.sessions_active} sesi`,
    ];
    if (publicUrl) {
      lines.push(`Publik: ${publicUrl}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  return 0;
}

async function handleUrl(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const meta = readJsonFile(path.join(storageDir, 'server.json'));
  if (!meta || !processAlive(meta.pid) || !Number.isInteger(meta.port)) {
    process.stderr.write('Kantor Agent belum berjalan. Jalankan perintah "start" terlebih dahulu.\n');
    return 1;
  }

  const tunnelMeta = readJsonFile(path.join(storageDir, 'tunnel.json'));
  const rawTunnel = (readText(path.join(storageDir, 'tunnel-url.txt')) || '').trim();
  const hasLiveTunnel =
    tunnelMeta?.pid &&
    processAlive(tunnelMeta.pid) &&
    /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/kerja$/.test(rawTunnel);

  const connectHost = meta.connectHost || connectHostForBind(meta.bind || '127.0.0.1');
  const localUrl = meta.url || `http://${formatHostForUrl(connectHost)}:${meta.port}/kerja`;
  const chosenUrl = hasLiveTunnel ? rawTunnel : localUrl;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, url: chosenUrl, localUrl, publicUrl: hasLiveTunnel ? rawTunnel : null }, null, 2)}\n`);
  } else {
    process.stdout.write(`${chosenUrl}\n`);
  }
  return 0;
}

function handleToken(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const authManager = createAuthManager(storageDir);
  const token = authManager.getToken();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, token }, null, 2)}\n`);
  } else {
    process.stdout.write(`${token}\n`);
  }
  return 0;
}

async function handleTunnel(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const meta = readJsonFile(path.join(storageDir, 'server.json'));
  if (!meta || !processAlive(meta.pid) || !Number.isInteger(meta.port)) {
    process.stderr.write('Server Kantor Agent belum berjalan. Jalankan "start" terlebih dahulu sebelum membuka tunnel.\n');
    return 1;
  }

  const connectHost = meta.connectHost || connectHostForBind(meta.bind || '127.0.0.1');
  const ping = await probePing(connectHost, meta.port);
  if (!ping) {
    process.stderr.write(`Server pada port ${meta.port} tidak merespons. Jalankan "restart" terlebih dahulu.\n`);
    return 1;
  }

  const tunnelJsonPath = path.join(storageDir, 'tunnel.json');
  const tunnelUrlPath = path.join(storageDir, 'tunnel-url.txt');
  const existingTunnel = readJsonFile(tunnelJsonPath);
  const existingUrl = (readText(tunnelUrlPath) || '').trim();
  if (existingTunnel?.pid && processAlive(existingTunnel.pid) && existingUrl) {
    const token = createAuthManager(storageDir).getToken();
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, alreadyRunning: true, url: existingUrl, token }, null, 2)}\n`);
    } else if (!args.quiet) {
      process.stdout.write(`Tunnel sudah aktif: ${existingUrl}\nToken chat: ${token}\nPeringatan: jangan bagikan URL + token ini ke pihak tidak tepercaya.\n`);
    }
    return 0;
  }

  const cfPath = await locateBinary('cloudflared');
  if (!cfPath) {
    const installHint =
      process.platform === 'win32'
        ? 'Pasang dengan: winget install Cloudflare.cloudflared'
        : process.platform === 'darwin'
          ? 'Pasang dengan: brew install cloudflared'
          : 'Pasang paket cloudflared dari repositori resmi Cloudflare.';
    process.stderr.write(`Perintah cloudflared tidak ditemukan di PATH.\n${installHint}\n`);
    return 1;
  }

  const tunnelLogPath = path.join(storageDir, 'tunnel.log');
  writePrivateFile(tunnelLogPath, '');
  const logFd = fs.openSync(tunnelLogPath, 'a', 0o600);

  let child;
  let childExited = false;
  let exitInfo = '';
  try {
    child = spawn(cfPath, ['tunnel', '--url', `http://${connectHost}:${meta.port}`], {
      cwd: projectDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('exit', (code, signal) => {
      childExited = true;
      exitInfo = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    });
    child.once('error', (err) => {
      childExited = true;
      exitInfo = err.message;
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  const deadline = Date.now() + 12_000;
  let foundBase = '';
  while (Date.now() < deadline) {
    const logText = readText(tunnelLogPath) || '';
    const m = TRY_CLOUDFLARE_RE.exec(logText);
    if (m) {
      foundBase = m[0].toLowerCase().replace(/\/+$/, '');
      break;
    }
    if (childExited) {
      const tail = readLogTail(tunnelLogPath, 20);
      throw new Error(
        `cloudflared berhenti sebelum menghasilkan URL (${exitInfo}).${tail ? `\nLog:\n${tail}` : ''}`
      );
    }
    await sleep(200);
  }

  if (!foundBase) {
    await terminatePid(child.pid, 300);
    const tail = readLogTail(tunnelLogPath, 20);
    throw new Error(
      `Gagal mendapatkan URL trycloudflare.com dalam 12 detik.${tail ? `\nLog:\n${tail}` : ''}`
    );
  }

  const publicUrl = `${foundBase}/kerja`;
  writePrivateFile(tunnelUrlPath, `${publicUrl}\n`);
  writePrivateFile(
    tunnelJsonPath,
    `${JSON.stringify({ pid: child.pid, url: publicUrl, localPort: meta.port, startedAt: new Date().toISOString() }, null, 2)}\n`
  );

  const token = createAuthManager(storageDir).getToken();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, pid: child.pid, url: publicUrl, token }, null, 2)}\n`);
  } else if (!args.quiet) {
    process.stdout.write(
      [
        `Tunnel publik aktif!`,
        `URL Publik : ${publicUrl}`,
        `Token Chat : ${token}`,
        'Keamanan   : Autentikasi chat & eksekusi Ketua wajib memakai chat-token di atas. Jangan bagikan tautan/token secara publik.',
      ].join('\n') + '\n'
    );
  }
  return 0;
}

async function handleTunnelStop(args) {
  const projectDir = path.resolve(args.project || process.cwd());
  const storageDir = resolveStorageDir(args, projectDir);
  const { wasAlive } = await stopTunnelInStorage(storageDir);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: true, wasRunning: wasAlive }, null, 2)}\n`);
  } else if (!args.quiet) {
    process.stdout.write(
      wasAlive ? 'Tunnel cloudflared dihentikan.\n' : 'Tidak ada tunnel aktif.\n'
    );
  }
  return 0;
}

async function handleAutostart(args) {
  try {
    const projectDir = path.resolve(
      args.project ||
        process.env.ANTIGRAVITY_PROJECT_DIR ||
        process.env.PROJECT_DIR ||
        process.cwd()
    );
    const cfg = loadConfig(RUNTIME_DIR, projectDir);
    const envOn =
      process.env.KANTOR_AUTOSTART === '1' ||
      String(process.env.KANTOR_AUTOSTART || '').toLowerCase() === 'true';
    if (cfg.autostart !== true && !envOn) {
      return 0;
    }
    await handleStart({ ...args, project: projectDir, quiet: true, json: false });
  } catch {
    // SessionStart hook tidak boleh menggagalkan startup sesi Antigravity
  }
  return 0;
}

function printHelp() {
  process.stdout.write(
    [
      'Penggunaan: node skills/kantor-agent/runtime/bin/kantor.mjs <perintah> [opsi]',
      '',
      'Perintah:',
      '  setup-team    Salin 4 templat subagent Tim IT ke ~/.gemini/config/agents/',
      '  detect        Periksa Node.js >= 22.5, agy CLI, surface DB, & templat Tim IT',
      '  start         Jalankan server Kantor Agent di latar belakang (detached)',
      '  stop          Hentikan server & tunnel aktif',
      '  restart       Muat ulang server (stop lalu start)',
      '  status        Tampilkan status server, port, aktivitas, & URL publik',
      '  url           Cetak URL aktif Kantor Agent',
      '  token         Cetak chat-token rahasia untuk akses non-loopback/tunnel',
      '  tunnel        Buka tunnel publik HTTPS sementara via cloudflared',
      '  tunnel-stop   Tutup tunnel cloudflared',
      '  autostart     Hook SessionStart opt-in (keluar 0 diam-diam bila nonaktif)',
      '',
      'Opsi:',
      '  --project <dir>   Direktori workspace target (default: cwd)',
      '  --storage <dir>   Direktori state/token/PID (default: ~/.cache/kantor-agent/...)',
      '  --bind <ip>       Alamat bind HTTP (default: 127.0.0.1)',
      '  --port <n>        Port awal scan TCP (default: 8788..8808)',
      '  --sandbox         Aktifkan flag --sandbox pada sesi chat ACP',
      '  --force           Timpa templat agen yang sudah ada saat setup-team',
      '  --quiet           Kurangi output terminal',
      '  --json            Cetak output dalam format JSON',
    ].join('\n') + '\n'
  );
}

async function runCli(argv) {
  let args;
  try {
    args = parseLauncherArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  if (args.help || !args.command || args.command === 'help') {
    printHelp();
    return 0;
  }

  switch (args.command) {
    case 'setup-team':
      return handleSetupTeam(args);
    case 'detect':
      return handleDetect(args);
    case 'start':
      return handleStart(args);
    case 'stop':
      return handleStop(args);
    case 'restart':
      return handleRestart(args);
    case 'status':
      return handleStatus(args);
    case 'url':
      return handleUrl(args);
    case 'token':
      return handleToken(args);
    case 'tunnel':
      return handleTunnel(args);
    case 'tunnel-stop':
      return handleTunnelStop(args);
    case 'autostart':
      return handleAutostart(args);
    default:
      process.stderr.write(`Perintah tidak dikenal: ${args.command}\n`);
      printHelp();
      return 1;
  }
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
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err?.message || String(err)}\n`);
      process.exitCode = 1;
    });
}
