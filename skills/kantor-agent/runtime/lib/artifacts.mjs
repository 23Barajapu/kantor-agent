import fs from 'node:fs';
import path from 'node:path';

import {
  isDir,
  isFile,
  isInsideDir,
  readText,
  safeLine,
  redact,
  isoMs,
  tsMs,
  splitR,
  strcmp,
} from './util.mjs';
import { resolveBrainDir } from './antigravity.mjs';

export const MAX_TEXT_BYTES = 256 * 1024; // 256 KB
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_SCANNED_ARTIFACTS = 12;
export const MAX_TODO_ITEMS = 40;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKLIST_REGEX = /^\s*(?:[-*]|\d+\.)\s+\[([ xX/])\]\s+(.+?)\s*$/;

export const ALLOWED_EXT_MAP = {
  '.md': { kind: 'md', category: 'text', mime: 'text/markdown; charset=utf-8' },
  '.txt': { kind: 'txt', category: 'text', mime: 'text/plain; charset=utf-8' },
  '.json': { kind: 'json', category: 'text', mime: 'application/json; charset=utf-8' },
  '.png': { kind: 'image', category: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', category: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', category: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', category: 'image', mime: 'image/webp' },
  '.pdf': { kind: 'pdf', category: 'pdf', mime: 'application/pdf' },
};

/**
 * Memeriksa apakah segmen-segmen relative path aman:
 * - Tidak boleh kosong, '.', atau '..'
 * - Tidak boleh diawali '.' (seperti .system_generated, .user_uploaded, .git)
 * - Tidak boleh 'scratch' (case-insensitive)
 * - File tidak boleh berakhiran '.metadata.json' (case-insensitive)
 */
function isSafeRelativePath(rel) {
  if (!rel || typeof rel !== 'string') return false;
  const segments = rel.split(/[/\\]/);
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return false;
    if (seg.startsWith('.')) return false;
    if (seg.toLowerCase() === 'scratch') return false;
  }
  const baseName = segments[segments.length - 1].toLowerCase();
  if (baseName.endsWith('.metadata.json')) return false;
  return true;
}

function parseChecklistFile(filePath, relPath) {
  const text = readText(filePath);
  if (text === null) return null;

  const lines = splitR(text);
  const items = [];

  for (const line of lines) {
    const m = CHECKLIST_REGEX.exec(line);
    if (!m) continue;

    const mark = m[1];
    const status = mark === ' ' ? 'pending' : (mark === '/' ? 'in_progress' : 'completed');
    const itemText = safeLine(m[2], 120);
    if (itemText === '') continue;

    items.push({ text: itemText, status });
    if (items.length >= MAX_TODO_ITEMS) break;
  }

  if (items.length === 0) return null;

  let at = null;
  const metaPath = filePath + '.metadata.json';
  const metaText = readText(metaPath);
  if (metaText) {
    try {
      const meta = JSON.parse(metaText);
      if (typeof meta.updatedAt === 'string') {
        const ms = tsMs(meta.updatedAt);
        if (ms !== null) at = isoMs(ms);
      }
    } catch {}
  }

  if (!at) {
    try {
      at = isoMs(fs.statSync(filePath).mtimeMs);
    } catch {
      at = null;
    }
  }

  return { items, at, source: relPath };
}

/**
 * Memindai artifact dalam direktori brain secara rekursif, mengecualikan folder internal,
 * membaca metadata bila ada, mengurutkan dari yang terbaru (maks 12 item).
 *
 * @param {string} convId
 * @param {string} brainDir
 * @returns {Array<object>}
 */
export function scanArtifacts(convId, brainDir) {
  if (!brainDir || typeof brainDir !== 'string' || !isDir(brainDir)) {
    return [];
  }

  let realBrainDir;
  try {
    realBrainDir = fs.realpathSync.native(brainDir);
  } catch {
    return [];
  }

  const artifacts = [];

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const lowerName = name.toLowerCase();
      if (name.startsWith('.')) continue;
      if (lowerName === 'scratch') continue;

      const fullPath = path.join(currentDir, name);

      if (entry.isDirectory()) {
        let realSubDir;
        try {
          realSubDir = fs.realpathSync.native(fullPath);
        } catch {
          continue;
        }
        if (!isInsideDir(realSubDir, realBrainDir)) continue;
        const resolvedRelSub = path.relative(realBrainDir, realSubDir);
        if (!isSafeRelativePath(resolvedRelSub)) continue;
        walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (lowerName.endsWith('.metadata.json')) continue;

        const ext = path.extname(name).toLowerCase();
        const extInfo = ALLOWED_EXT_MAP[ext];
        if (!extInfo) continue;

        let realFilePath;
        try {
          realFilePath = fs.realpathSync.native(fullPath);
        } catch {
          continue;
        }
        if (!isInsideDir(realFilePath, realBrainDir)) continue;

        const resolvedRel = path.relative(realBrainDir, realFilePath);
        if (!isSafeRelativePath(resolvedRel)) continue;

        const realExt = path.extname(realFilePath).toLowerCase();
        if (!ALLOWED_EXT_MAP[realExt]) continue;

        let st;
        try {
          st = fs.statSync(realFilePath);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;

        const relPath = path.relative(brainDir, fullPath).replaceAll('\\', '/');

        let summary = '';
        let updatedAt = isoMs(st.mtimeMs);
        let sortingMs = st.mtimeMs;
        let userFacing = false;

        const metaPath = fullPath + '.metadata.json';
        const metaText = readText(metaPath);
        if (metaText) {
          try {
            const meta = JSON.parse(metaText);
            if (typeof meta.summary === 'string') {
              summary = safeLine(meta.summary, 200);
            }
            if (typeof meta.updatedAt === 'string') {
              const parsedMs = tsMs(meta.updatedAt);
              if (parsedMs !== null) {
                updatedAt = isoMs(parsedMs);
                sortingMs = parsedMs;
              }
            }
            if (typeof meta.userFacing === 'boolean') {
              userFacing = meta.userFacing;
            }
          } catch {}
        }

        artifacts.push({
          conv_id: convId,
          name: relPath,
          summary,
          updated_at: updatedAt,
          user_facing: userFacing,
          kind: extInfo.kind,
          previewable: true,
          _sortingMs: sortingMs,
        });
      }
    }
  }

  walk(brainDir);

  artifacts.sort((a, b) => {
    if (b._sortingMs !== a._sortingMs) {
      return b._sortingMs - a._sortingMs;
    }
    return strcmp(a.name, b.name);
  });

  return artifacts.slice(0, MAX_SCANNED_ARTIFACTS).map(({ _sortingMs, ...rest }) => rest);
}

/**
 * Mengekstrak checklist todo dari file task.md di root brainDir,
 * atau fallback ke file markdown aman terbaru yang mengandung checklist.
 *
 * @param {string} brainDir
 * @returns {{ items: Array<object>, at: string | null, source: string } | null}
 */
export function extractTodos(brainDir) {
  if (!brainDir || typeof brainDir !== 'string' || !isDir(brainDir)) {
    return null;
  }

  let realBrainDir;
  try {
    realBrainDir = fs.realpathSync.native(brainDir);
  } catch {
    return null;
  }

  // 1. Cek task.md di level teratas (validasi symlink dan batas brainDir)
  const taskFile = path.join(brainDir, 'task.md');
  if (isFile(taskFile)) {
    let realTaskFile = null;
    try {
      realTaskFile = fs.realpathSync.native(taskFile);
    } catch {}

    if (realTaskFile && isInsideDir(realTaskFile, realBrainDir)) {
      const resolvedRel = path.relative(realBrainDir, realTaskFile);
      if (isSafeRelativePath(resolvedRel)) {
        const taskResult = parseChecklistFile(realTaskFile, 'task.md');
        if (taskResult !== null) {
          return taskResult;
        }
      }
    }
  }

  // 2. Fallback: cari file .md lain yang aman dan terbaru
  const mdCandidates = [];

  function walkMd(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const lowerName = name.toLowerCase();
      if (name.startsWith('.')) continue;
      if (lowerName === 'scratch') continue;

      const fullPath = path.join(currentDir, name);

      if (entry.isDirectory()) {
        let realSub;
        try {
          realSub = fs.realpathSync.native(fullPath);
        } catch {
          continue;
        }
        if (!isInsideDir(realSub, realBrainDir)) continue;
        const resolvedRelSub = path.relative(realBrainDir, realSub);
        if (!isSafeRelativePath(resolvedRelSub)) continue;
        walkMd(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (lowerName === 'task.md' && currentDir === brainDir) continue;
        if (lowerName.endsWith('.metadata.json')) continue;
        if (!lowerName.endsWith('.md')) continue;

        let realFile;
        try {
          realFile = fs.realpathSync.native(fullPath);
        } catch {
          continue;
        }
        if (!isInsideDir(realFile, realBrainDir)) continue;

        const resolvedRel = path.relative(realBrainDir, realFile);
        if (!isSafeRelativePath(resolvedRel)) continue;

        const realExt = path.extname(realFile).toLowerCase();
        if (realExt !== '.md') continue;

        let st;
        try {
          st = fs.statSync(realFile);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;

        let sortingMs = st.mtimeMs;
        const metaPath = fullPath + '.metadata.json';
        const metaText = readText(metaPath);
        if (metaText) {
          try {
            const meta = JSON.parse(metaText);
            if (typeof meta.updatedAt === 'string') {
              const ms = tsMs(meta.updatedAt);
              if (ms !== null) sortingMs = ms;
            }
          } catch {}
        }

        const relPath = path.relative(brainDir, fullPath).replaceAll('\\', '/');
        mdCandidates.push({ fullPath: realFile, relPath, sortingMs });
      }
    }
  }

  walkMd(brainDir);

  mdCandidates.sort((a, b) => {
    if (b.sortingMs !== a.sortingMs) {
      return b.sortingMs - a.sortingMs;
    }
    return strcmp(a.relPath, b.relPath);
  });

  for (const cand of mdCandidates) {
    const result = parseChecklistFile(cand.fullPath, cand.relPath);
    if (result !== null) {
      return result;
    }
  }

  return null;
}

/**
 * Membaca artifact dengan validasi keamanan ketat (anti-traversal, UUID check, symlink bounds,
 * batas ukuran, dan redaksi rahasia).
 *
 * @param {object} params
 * @param {string} params.convId
 * @param {string} params.relPath
 * @param {Set<string>|Array<string>} [params.allowedConvIds]
 * @param {Array<string>} [params.roots]
 * @param {boolean} [params.isLoopback]
 * @returns {{ ok: boolean, status: number, kind?: 'json'|'file', contentType?: string, data?: object|Buffer, error?: string }}
 */
export function readSafeArtifact({ convId, relPath, allowedConvIds, roots, isLoopback }) {
  if (typeof convId !== 'string' || !UUID_REGEX.test(convId)) {
    return { ok: false, status: 404, error: 'Artifact tidak ditemukan' };
  }

  const isAllowed = allowedConvIds && (
    typeof allowedConvIds.has === 'function'
      ? allowedConvIds.has(convId)
      : Array.isArray(allowedConvIds) && allowedConvIds.includes(convId)
  );
  if (!isAllowed) {
    return { ok: false, status: 404, error: 'Artifact tidak ditemukan' };
  }

  const brainDir = resolveBrainDir(convId, roots);
  if (!brainDir) {
    return { ok: false, status: 404, error: 'Direktori brain tidak ditemukan' };
  }

  if (typeof relPath !== 'string' || relPath.trim() === '') {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  if (relPath.includes('\0') || /^[/\\]/.test(relPath) || relPath.includes(':')) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  const segments = relPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg.startsWith('.') || seg.toLowerCase() === 'scratch') {
      return { ok: false, status: 403, error: 'Akses artifact ditolak' };
    }
  }

  if (relPath.toLowerCase().endsWith('.metadata.json')) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  const ext = path.extname(relPath).toLowerCase();
  const extInfo = ALLOWED_EXT_MAP[ext];
  if (!extInfo) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  let realBrainDir;
  try {
    realBrainDir = fs.realpathSync.native(brainDir);
  } catch {
    return { ok: false, status: 404, error: 'Direktori brain tidak ditemukan' };
  }

  const targetCandidate = path.resolve(brainDir, relPath);
  let realTarget;
  try {
    realTarget = fs.realpathSync.native(targetCandidate);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, status: 404, error: 'Artifact tidak ditemukan' };
    }
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  if (!isInsideDir(realTarget, realBrainDir)) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  // Validasi ulang segmen dan ekstensi dari target asli (proteksi symlink internal)
  const resolvedRel = path.relative(realBrainDir, realTarget);
  if (!isSafeRelativePath(resolvedRel)) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  const realExt = path.extname(realTarget).toLowerCase();
  if (!ALLOWED_EXT_MAP[realExt]) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  let st;
  try {
    st = fs.statSync(realTarget);
  } catch {
    return { ok: false, status: 404, error: 'Artifact tidak ditemukan' };
  }

  if (!st.isFile()) {
    return { ok: false, status: 403, error: 'Akses artifact ditolak' };
  }

  let maxBytes = MAX_TEXT_BYTES;
  if (extInfo.category === 'image') {
    maxBytes = MAX_IMAGE_BYTES;
  } else if (extInfo.category === 'pdf') {
    maxBytes = MAX_PDF_BYTES;
  }

  if (st.size > maxBytes) {
    return { ok: false, status: 413, error: 'Ukuran artifact melebihi batas' };
  }

  const cleanRel = relPath.replaceAll('\\', '/');

  if (extInfo.category === 'text') {
    let rawContent;
    try {
      rawContent = fs.readFileSync(realTarget, 'utf8');
    } catch {
      return { ok: false, status: 500, error: 'Gagal membaca artifact' };
    }

    const redactedContent = redact(rawContent);

    let summary = '';
    let updatedAt = isoMs(st.mtimeMs);

    const metaPath = realTarget + '.metadata.json';
    const metaCandidatePath = targetCandidate + '.metadata.json';
    const metaFile = isFile(metaPath) ? metaPath : (isFile(metaCandidatePath) ? metaCandidatePath : null);
    if (metaFile) {
      const metaText = readText(metaFile);
      if (metaText) {
        try {
          const meta = JSON.parse(metaText);
          if (typeof meta.summary === 'string') {
            summary = safeLine(meta.summary, 200);
          }
          if (typeof meta.updatedAt === 'string') {
            const parsedMs = tsMs(meta.updatedAt);
            if (parsedMs !== null) {
              updatedAt = isoMs(parsedMs);
            }
          }
        } catch {}
      }
    }

    return {
      ok: true,
      status: 200,
      kind: 'json',
      contentType: 'application/json; charset=utf-8',
      data: {
        conv_id: convId,
        name: cleanRel,
        summary,
        updated_at: updatedAt,
        local_path: isLoopback === true ? realTarget : null,
        content: redactedContent,
      },
    };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(realTarget);
  } catch {
    return { ok: false, status: 500, error: 'Gagal membaca artifact' };
  }

  return {
    ok: true,
    status: 200,
    kind: 'file',
    contentType: extInfo.mime,
    data: buffer,
  };
}
