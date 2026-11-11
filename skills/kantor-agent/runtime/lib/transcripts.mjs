import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanConversations } from './antigravity.mjs';
import {
  basename,
  clip,
  isPlainObj,
  isoMs,
  normalizeWorkspacePath,
  oneLine,
  phpTrim,
  redact,
  safeLine,
  tsMs,
} from './util.mjs';

const CACHE_VERSION = 1;
const HEAD_MAX = 1024;
const CHUNK_SIZE = 1024 * 1024;
const MAX_SEGS = 20;
const MAX_EVENTS = 120;
const MAX_FILES = 12;
const MAX_RESUMES = 80;
const MAX_STOPS = 80;
const MAX_SEEN_STEPS = 256;
const MAX_PENDING_SUBAGENTS = 32;
const MAX_PENDING_TOOLS = 64;

const LIMIT_RE = /(usage limit|rate limit|limit reached|quota|resource_exhausted|resets? (at|in))/i;
const RESULT_STEP_TYPES = new Set([
  'GENERIC',
  'VIEW_FILE',
  'RUN_COMMAND',
  'LIST_DIRECTORY',
  'CODE_ACTION',
  'GREP_SEARCH',
  'ASK_QUESTION',
  'SEARCH_WEB',
]);

function md5Hex(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

function toNonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function unquoteArg(v) {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      const sanitized = trimmed.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      try {
        const parsed = JSON.parse(sanitized);
        if (typeof parsed === 'string') return parsed;
      } catch {
        return trimmed;
      }
    }
  }
  return v;
}

function argStr(args, ...keys) {
  if (!isPlainObj(args)) return '';
  for (const k of keys) {
    const raw = args[k];
    if (raw === undefined || raw === null) continue;
    const val = unquoteArg(raw);
    if (typeof val === 'string') {
      if (phpTrim(val) !== '') return val;
      continue;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  }
  return '';
}

function argArray(args, ...keys) {
  if (!isPlainObj(args)) return [];
  for (const k of keys) {
    const raw = args[k];
    if (Array.isArray(raw)) {
      return raw.map((x) => phpTrim(String(unquoteArg(x) ?? ''))).filter(Boolean);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.map((x) => phpTrim(String(unquoteArg(x) ?? ''))).filter(Boolean);
          }
        } catch {}
      }
      const unquoted = phpTrim(String(unquoteArg(raw) ?? ''));
      if (unquoted) return [unquoted];
    }
  }
  return [];
}

function cleanModel(v) {
  const raw = unquoteArg(v);
  if (typeof raw !== 'string') return null;
  const cleaned = phpTrim(raw.replace(/[\x00-\x1f\x7f]+/g, ' '));
  if (!cleaned) return null;
  return clip(redact(cleaned), 60);
}

function normalizeWithExistingAncestor(rawPath) {
  const normDirect = normalizeWorkspacePath(rawPath);
  if (!normDirect) return '';

  let fsPath = rawPath.trim();
  if (/^file:\/\//i.test(fsPath)) {
    try {
      fsPath = fileURLToPath(fsPath);
    } catch {
      fsPath = normDirect;
    }
  }

  let cur = path.resolve(fsPath);
  const tail = [];
  while (cur) {
    try {
      const real = fs.realpathSync.native(cur);
      const joined = tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      let out = joined.replaceAll('\\', '/');
      if (out.length > 1 && out.endsWith('/') && !/^[a-zA-Z]:\/$/.test(out)) {
        out = out.slice(0, -1);
      }
      return process.platform === 'win32' ? out.toLowerCase() : out;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return normDirect;
}

function relPath(rawPath, projectDir) {
  const p = phpTrim(unquoteArg(rawPath) || '');
  if (!p) return '';

  let result = '';
  const isAbs = path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^file:\/\//i.test(p);

  if (projectDir && isAbs) {
    const normProj = normalizeWithExistingAncestor(projectDir);
    const normP = normalizeWithExistingAncestor(p);
    const prefix = normProj.endsWith('/') ? normProj : `${normProj}/`;

    if (normP === normProj) {
      result = '.';
    } else if (normP.startsWith(prefix)) {
      if (!/^file:\/\//i.test(p)) {
        const rel = path.relative(projectDir, p).replaceAll('\\', '/');
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          result = rel;
        }
      }
      if (!result) result = normP.slice(prefix.length);
    } else {
      result = basename(p.replaceAll('\\', '/'));
    }
  } else if (isAbs) {
    result = basename(p.replaceAll('\\', '/'));
  } else {
    result = p.replaceAll('\\', '/');
  }

  return oneLine(result, 120);
}

function extractSpawnedConversationId(row) {
  if (typeof row.conversationId === 'string' && row.conversationId.trim() !== '') {
    return row.conversationId.trim();
  }

  const rawText =
    typeof row.content === 'string'
      ? row.content
      : typeof row.tool_result === 'string'
        ? row.tool_result
        : '';
  if (!rawText) return null;

  // Hasil manage_subagents Action="list" memuat array active subagent(s), bukan invoke_subagent baru
  if (/active subagent\(s\):/i.test(rawText)) return null;

  const createdIdx = rawText.indexOf('Created the following subagent:');
  if (createdIdx !== -1) {
    const slice = rawText.slice(createdIdx);
    const match = /"conversationId"\s*:\s*"([^"\r\n]+)"/.exec(slice);
    return match ? match[1].trim() : null;
  }

  // Fallback untuk fixture ringkas GENERIC JSON tanpa header "Created the following subagent:"
  if (/^\s*\[/.test(rawText) || (rawText.startsWith('Created At:') && rawText.includes('\nFile Path:'))) {
    return null;
  }
  const match = /"conversationId"\s*:\s*"([^"\r\n]+)"/.exec(rawText);
  if (!match) return null;
  const before = rawText.slice(0, match.index);
  const lastArrayOpen = before.lastIndexOf('[');
  const lastObjOpen = before.lastIndexOf('{');
  if (lastArrayOpen !== -1 && lastArrayOpen < lastObjOpen && /\[\s*\{/.test(before.slice(lastArrayOpen))) {
    return null;
  }
  return match[1].trim();
}

function freshSummary() {
  return {
    offset: 0,
    head: '',
    headLen: 0,
    started: null,
    updated: null,
    lastKind: null,
    tokens: { input: 0, output: 0, cache_read: 0, total: 0 },
    lastStepKey: null,
    lastStep: null,
    seenStepKeys: [],
    segs: [],
    events: [],
    files: [],
    pendingSubagents: [],
    pendingToolCalls: [],
    spawned: {},
    resumes: [],
    stops: [],
    limit: null,
  };
}

function applyStepTokenDelta(s, inTok, outTok, cacheTok) {
  s.tokens.input += Math.max(0, inTok - s.lastStep.input);
  s.tokens.output += Math.max(0, outTok - s.lastStep.output);
  s.tokens.cache_read += Math.max(0, cacheTok - s.lastStep.cache_read);
  s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cache_read;

  s.lastStep.input = Math.max(s.lastStep.input, inTok);
  s.lastStep.output = Math.max(s.lastStep.output, outTok);
  s.lastStep.cache_read = Math.max(s.lastStep.cache_read, cacheTok);
}

function isValidSummaryShape(s) {
  return (
    isPlainObj(s) &&
    typeof s.offset === 'number' &&
    typeof s.head === 'string' &&
    isPlainObj(s.tokens) &&
    Array.isArray(s.segs) &&
    Array.isArray(s.events) &&
    Array.isArray(s.files) &&
    Array.isArray(s.pendingSubagents) &&
    isPlainObj(s.spawned) &&
    Array.isArray(s.resumes) &&
    Array.isArray(s.stops)
  );
}

function pushEvent(s, ev) {
  s.events.push(ev);
  if (s.events.length > MAX_EVENTS) {
    s.events.splice(0, s.events.length - MAX_EVENTS);
  }
}

function addModifiedFile(s, rawPath, projectDir) {
  const rel = relPath(rawPath, projectDir);
  if (!rel || rel === '.') return;
  const idx = s.files.indexOf(rel);
  if (idx !== -1) s.files.splice(idx, 1);
  s.files.push(rel);
  if (s.files.length > MAX_FILES) {
    s.files.splice(0, s.files.length - MAX_FILES);
  }
}

function openSegment(segs, t, cooldownSec) {
  if (!t) return;
  const ms = tsMs(t);
  if (ms === null) return;

  if (segs.length === 0) {
    segs.push([t, null]);
    return;
  }

  const last = segs[segs.length - 1];
  if (last[1] !== null) {
    const endMs = tsMs(last[1]);
    if (endMs !== null && ms - endMs <= cooldownSec * 1000) {
      last[1] = null;
    } else {
      segs.push([t, null]);
      if (segs.length > MAX_SEGS) {
        segs.splice(0, segs.length - MAX_SEGS);
      }
    }
  }
}

function closeSegment(segs, t) {
  if (!t || segs.length === 0) return;
  const last = segs[segs.length - 1];
  if (last[1] === null) {
    last[1] = t;
  }
}

function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

function mergeResumesAndStops(baseSegs, resumeTimes, stopTimes, cooldownSec) {
  const segs = baseSegs.map(([a, b]) => [a, b]);
  const timeline = [];
  for (const t of resumeTimes) {
    const ms = tsMs(t);
    if (ms !== null) timeline.push({ kind: 'resume', t, ms });
  }
  for (const t of stopTimes) {
    const ms = tsMs(t);
    if (ms !== null) timeline.push({ kind: 'stop', t, ms });
  }
  timeline.sort((a, b) => a.ms - b.ms || (a.kind === b.kind ? 0 : a.kind === 'resume' ? -1 : 1));

  for (const item of timeline) {
    if (item.kind === 'resume') {
      if (segs.length === 0) {
        segs.push([item.t, null]);
        continue;
      }
      const last = segs[segs.length - 1];
      if (last[1] !== null) {
        const endMs = tsMs(last[1]);
        if (endMs !== null && item.ms > endMs) {
          openSegment(segs, item.t, cooldownSec);
        }
      }
    } else if (segs.length > 0) {
      const last = segs[segs.length - 1];
      const startMs = tsMs(last[0]);
      if (last[1] === null && (startMs === null || item.ms >= startMs)) {
        last[1] = item.t;
      }
    }
  }
  return segs;
}

export function isCliMain(row) {
  if (!row || row.nesting_depth !== 0 || row.parent_conversation_id) return false;
  if (row.app_data_dir === 'antigravity-cli') return true;
  const sourceUpper = String(row.source || '').toUpperCase();
  if (sourceUpper === 'CORTEX_TRAJECTORY_SOURCE_CLI' || sourceUpper.includes('CLI')) return true;
  const dbRootClean = String(row.dbRoot || '')
    .replace(/[\\/]+$/, '')
    .replaceAll('\\', '/')
    .toLowerCase();
  return path.posix.basename(dbRootClean) === 'antigravity-cli' && row.app_data_dir !== 'antigravity';
}

function readBytesAt(fd, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(fd, buf, offset, length - offset, position + offset);
    if (n <= 0) break;
    offset += n;
  }
  return offset === length ? buf : buf.subarray(0, offset);
}

/**
 * Pembaca inkremental `transcript.jsonl` Antigravity dengan cache byte-offset + MD5 header 1 KB,
 * ekstraksi token terdeduplikasi, redaksi event tool, serta pairing parent-child subagent.
 */
export class TranscriptScanner {
  constructor(storageDir = null, cfg = {}) {
    this.storageDir = typeof storageDir === 'string' && storageDir.trim() !== '' ? storageDir : null;
    this.cfg = isPlainObj(cfg) ? cfg : {};
    this.memo = new Map();
  }

  _cooldownSec() {
    const c = Number(this.cfg?.cooldown);
    return Number.isFinite(c) && c > 0 ? c : 60;
  }

  _memoKey(file) {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  _cacheFilePath(file) {
    if (!this.storageDir) return null;
    return path.join(this.storageDir, 'cache', `ag-${md5Hex(this._memoKey(file))}.json`);
  }

  _loadDiskCache(file) {
    const cacheFile = this._cacheFilePath(file);
    if (!cacheFile) return null;
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.v === CACHE_VERSION && isValidSummaryShape(parsed.s)) {
        return parsed;
      }
    } catch {}
    return null;
  }

  _saveDiskCache(file, size, mtimeMs, s) {
    const cacheFile = this._cacheFilePath(file);
    if (!cacheFile) return;
    try {
      const dir = path.dirname(cacheFile);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ v: CACHE_VERSION, size, mtimeMs, head: s.head, s });
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, cacheFile);
    } catch {}
  }

  _consumeToolCall(s, tc, t, projectDir) {
    if (!isPlainObj(tc)) return;
    const name = typeof tc.name === 'string' ? tc.name : typeof tc.tool === 'string' ? tc.tool : '';
    if (!name) return;
    const args = isPlainObj(tc.args) ? tc.args : {};

    if (name === 'read_file' || name === 'view_file') {
      const p = argStr(args, 'Path', 'AbsolutePath', 'file_path', 'path');
      const label = relPath(p, projectDir);
      pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`Baca ${label || 'berkas'}`, 120) });
      return;
    }

    if (name === 'write_file' || name === 'write_to_file') {
      const p = argStr(args, 'Path', 'TargetFile', 'file_path', 'path');
      addModifiedFile(s, p, projectDir);
      const label = relPath(p, projectDir);
      pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`Tulis ${label || 'berkas'}`, 120) });
      return;
    }

    if (name === 'edit_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
      const p = argStr(args, 'Path', 'TargetFile', 'file_path', 'path');
      addModifiedFile(s, p, projectDir);
      const label = relPath(p, projectDir);
      pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`Ubah ${label || 'berkas'}`, 120) });
      return;
    }

    if (name === 'list_dir') {
      const p = argStr(args, 'DirectoryPath', 'Path', 'path');
      const label = relPath(p, projectDir);
      pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`Daftar ${label || 'folder'}`, 120) });
      return;
    }

    if (name === 'grep_search' || name === 'find_by_name') {
      const q = argStr(args, 'Query', 'Pattern', 'toolSummary');
      pushEvent(s, { t, kind: 'tool', tool: name, text: q ? oneLine(`Cari: ${safeLine(q, 80)}`, 120) : 'Cari berkas' });
      return;
    }

    if (name === 'run_command') {
      const summary = phpTrim(argStr(args, 'toolSummary'));
      const text = summary ? oneLine(summary, 120) : 'Jalankan perintah';
      pushEvent(s, { t, kind: 'tool', tool: name, text });
      return;
    }

    if (name === 'search_web') {
      const q = argStr(args, 'query', 'Query', 'toolSummary');
      pushEvent(s, { t, kind: 'tool', tool: name, text: q ? oneLine(`Cari web: ${safeLine(q, 80)}`, 120) : 'Cari web' });
      return;
    }

    if (name === 'call_mcp_tool' || name.startsWith('mcp_')) {
      if (name === 'call_mcp_tool') {
        const srv = phpTrim(argStr(args, 'ServerName'));
        const fn = phpTrim(argStr(args, 'ToolName'));
        const target = srv && fn ? `${srv}/${fn}` : fn || srv || 'tool';
        pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`MCP: ${target}`, 120) });
      } else {
        pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`MCP: ${name.slice(4)}`, 120) });
      }
      return;
    }

    if (name === 'manage_task') {
      const action = phpTrim(argStr(args, 'Action'));
      pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(`Tugas: ${action || 'manage'}`, 120) });
      return;
    }

    if (name === 'schedule') {
      const summary = phpTrim(argStr(args, 'toolSummary'));
      pushEvent(s, { t, kind: 'tool', tool: name, text: summary ? oneLine(`Jadwal: ${summary}`, 120) : 'Jadwal tugas' });
      return;
    }

    if (name === 'invoke_subagent') {
      const roleRaw = phpTrim(argStr(args, 'Role'));
      const role = roleRaw ? safeLine(roleRaw, 60) : null;
      const model = cleanModel(args.Model);
      const typeRaw = phpTrim(argStr(args, 'TypeName'));
      const agentType = typeRaw ? clip(redact(typeRaw), 40) : '';
      const promptRaw = phpTrim(argStr(args, 'Prompt'));
      const prompt = promptRaw ? safeLine(promptRaw, 140) : '';

      pushBounded(s.pendingSubagents, { role, model, agentType, prompt, t }, MAX_PENDING_SUBAGENTS);
      pushEvent(s, {
        t,
        kind: 'tool',
        tool: name,
        text: oneLine(`Mendelegasikan: ${role || agentType || 'subagent'}`, 120),
      });
      return;
    }

    if (name === 'send_message') {
      const recipient = phpTrim(argStr(args, 'Recipient'));
      if (recipient && t) {
        pushBounded(s.resumes, { recipient, t }, MAX_RESUMES);
      }
      pushEvent(s, {
        t,
        kind: 'tool',
        tool: name,
        text: oneLine(`Kirim pesan ke ${recipient || 'agen'}`, 120),
      });
      return;
    }

    if (name === 'manage_subagents') {
      const action = phpTrim(argStr(args, 'Action')).toLowerCase();
      const ids = argArray(args, 'ConversationIds', 'ConversationId', 'ids');
      if ((action === 'kill' || action === 'kill_all') && t) {
        pushBounded(s.stops, { action, ids, t }, MAX_STOPS);
      }
      pushEvent(s, {
        t,
        kind: 'tool',
        tool: name,
        text: oneLine(`Subagent: ${action || 'manage'}`, 120),
      });
      return;
    }

    const summary = phpTrim(argStr(args, 'toolSummary'));
    pushEvent(s, { t, kind: 'tool', tool: name, text: oneLine(summary || name, 120) });
  }

  _consumePlannerResponse(s, row, t, projectDir) {
    openSegment(s.segs, t, this._cooldownSec());

    const hasStepIdx = row.step_index !== undefined && row.step_index !== null && row.step_index !== '';
    const stepIdxStr = hasStepIdx ? String(row.step_index) : '';
    const stepKey = hasStepIdx ? `${t ?? ''}:${stepIdxStr}` : null;
    const statusStr = String(row.status ?? '');

    const inTok = toNonNegInt(row.input_tokens);
    const outTok = toNonNegInt(row.output_tokens);
    const cacheTok = toNonNegInt(row.cache_read_tokens);

    let alreadyProcessedTools = false;
    let alreadyProcessedFinal = false;

    if (stepKey !== null && s.lastStep && s.lastStep.key === stepKey) {
      applyStepTokenDelta(s, inTok, outTok, cacheTok);
      s.lastStep.status = statusStr;
      alreadyProcessedTools = Boolean(s.lastStep.processedTools);
      alreadyProcessedFinal = Boolean(s.lastStep.processedFinal);
    } else if (stepKey !== null && s.seenStepKeys.includes(stepKey)) {
      return;
    } else if (
      hasStepIdx &&
      s.lastStep &&
      s.lastStep.stepIdxStr === stepIdxStr &&
      s.lastStep.status !== '' &&
      s.lastStep.status !== 'DONE'
    ) {
      applyStepTokenDelta(s, inTok, outTok, cacheTok);
      alreadyProcessedTools = Boolean(s.lastStep.processedTools);
      alreadyProcessedFinal = Boolean(s.lastStep.processedFinal);

      s.lastStepKey = stepKey;
      pushBounded(s.seenStepKeys, stepKey, MAX_SEEN_STEPS);
      s.lastStep.key = stepKey;
      s.lastStep.status = statusStr;
    } else {
      s.tokens.input += inTok;
      s.tokens.output += outTok;
      s.tokens.cache_read += cacheTok;
      s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cache_read;

      if (stepKey !== null) {
        s.lastStepKey = stepKey;
        pushBounded(s.seenStepKeys, stepKey, MAX_SEEN_STEPS);
      }
      s.lastStep = {
        key: stepKey,
        stepIdxStr,
        status: statusStr,
        input: inTok,
        output: outTok,
        cache_read: cacheTok,
        processedTools: false,
        processedFinal: false,
      };
    }

    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const respRaw =
      typeof row.content === 'string' ? row.content : typeof row.text === 'string' ? row.text : '';
    const respTrimmed = phpTrim(respRaw);

    if (toolCalls.length > 0) {
      if (!alreadyProcessedTools) {
        if (!Array.isArray(s.pendingToolCalls)) s.pendingToolCalls = [];
        s.pendingToolCalls = toolCalls
          .map((tc) => (isPlainObj(tc) ? String(tc.name || tc.tool || '') : ''))
          .filter(Boolean)
          .slice(-MAX_PENDING_TOOLS);
        for (const tc of toolCalls) {
          this._consumeToolCall(s, tc, t, projectDir);
        }
        if (s.lastStep) s.lastStep.processedTools = true;
      }
      s.lastKind = 'tool';
    } else if (row.status === 'DONE' && respTrimmed !== '') {
      if (!alreadyProcessedFinal) {
        const text = safeLine(respTrimmed, 180);
        if (text) {
          pushEvent(s, { t, kind: 'text', text, tool: null });
        }
        if (s.lastStep) s.lastStep.processedFinal = true;
      }
      s.lastKind = 'final';
      closeSegment(s.segs, t);
    }
  }

  consume(s, row, projectDir) {
    if (!isPlainObj(row)) return;

    const rawT = typeof row.created_at === 'string' ? row.created_at : null;
    const tMsVal = rawT ? tsMs(rawT) : null;
    const t = tMsVal !== null ? rawT : null;

    if (t !== null) {
      if (!s.started) {
        s.started = t;
      }
      const updMs = s.updated ? tsMs(s.updated) : null;
      if (updMs === null || tMsVal >= updMs) {
        s.updated = t;
      }
    }

    if (row.type === 'USER_INPUT') {
      s.pendingSubagents = [];
      s.pendingToolCalls = [];
      openSegment(s.segs, t, this._cooldownSec());
      pushEvent(s, { t, kind: 'user', text: 'Instruksi dari user', tool: null });
      s.lastKind = 'user';
      return;
    }

    if (row.type === 'PLANNER_RESPONSE') {
      this._consumePlannerResponse(s, row, t, projectDir);
      return;
    }

    if (row.type === 'ERROR_MESSAGE') {
      const rawMsg =
        typeof row.error === 'string' && row.error.trim()
          ? row.error
          : typeof row.content === 'string' && row.content.trim()
            ? row.content
            : typeof row.message === 'string'
              ? row.message
              : '';
      const msg = phpTrim(rawMsg) || 'Error';

      if (LIMIT_RE.test(msg)) {
        s.limit = clip(redact(msg.replace(/[\t\r\n]+/g, ' ').trim()), 200);
        closeSegment(s.segs, t);
      } else {
        pushEvent(s, { t, kind: 'error', text: oneLine(msg, 180), tool: null });
      }
      s.lastKind = 'error';
      return;
    }

    if (RESULT_STEP_TYPES.has(row.type)) {
      const expectedTool = Array.isArray(s.pendingToolCalls) ? s.pendingToolCalls.shift() : undefined;
      if (row.type === 'GENERIC' && s.pendingSubagents.length > 0) {
        const childId = extractSpawnedConversationId(row);
        if (childId) {
          const pending = s.pendingSubagents.shift();
          s.spawned[childId] = {
            role: pending.role,
            model: pending.model,
            agentType: pending.agentType,
            prompt: pending.prompt,
            t: pending.t || t,
          };
        } else if (row.status === 'ERROR' || row.status === 'INVALID') {
          const errHint = `${row.error ?? ''} ${row.content ?? ''}`;
          if (expectedTool === 'invoke_subagent' || (!expectedTool && /subagent|invoke_subagent/i.test(errHint))) {
            s.pendingSubagents.shift();
          }
        }
      }
      if (row.status === 'ERROR') {
        s.lastKind = 'error';
      }
    }
  }

  summarize(file, projectDir = '') {
    if (typeof file !== 'string' || file === '') return freshSummary();
    const memoKey = this._memoKey(file);

    let st;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) {
        this.memo.delete(memoKey);
        return freshSummary();
      }
    } catch {
      this.memo.delete(memoKey);
      return freshSummary();
    }

    const size = st.size;
    const mtimeMs = st.mtimeMs;

    const memoEntry = this.memo.get(memoKey);
    if (memoEntry && memoEntry.size === size && memoEntry.mtimeMs === mtimeMs) {
      return memoEntry.s;
    }

    let s = memoEntry?.s ?? null;
    if (!s) {
      const cached = this._loadDiskCache(file);
      if (cached) {
        if (cached.size === size && cached.mtimeMs === mtimeMs) {
          this.memo.set(memoKey, { size, mtimeMs, head: cached.head, s: cached.s });
          return cached.s;
        }
        s = cached.s;
      }
    }

    if (!s || !isValidSummaryShape(s)) {
      s = freshSummary();
    }

    if (size === 0) {
      const empty = freshSummary();
      this.memo.set(memoKey, { size: 0, mtimeMs, head: '', s: empty });
      return empty;
    }

    let fd;
    try {
      fd = fs.openSync(file, 'r');

      if (s.offset > size || (s.headLen > 0 && size < s.headLen)) {
        s = freshSummary();
      } else if (s.headLen > 0) {
        const prefixBuf = readBytesAt(fd, 0, s.headLen);
        if (prefixBuf.length !== s.headLen || md5Hex(prefixBuf) !== s.head) {
          s = freshSummary();
        }
      }

      if (size > s.offset) {
        const chunkBuf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, size - s.offset));
        let pos = s.offset;
        let carry = Buffer.alloc(0);

        while (pos < size) {
          const toRead = Math.min(chunkBuf.length, size - pos);
          const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, pos);
          if (bytesRead <= 0) break;
          pos += bytesRead;

          const slice = chunkBuf.subarray(0, bytesRead);
          const combined = carry.length > 0 ? Buffer.concat([carry, slice]) : slice;
          const lastNl = combined.lastIndexOf(0x0a);

          if (lastNl !== -1) {
            let textBlock = combined.subarray(0, lastNl).toString('utf8');
            if (textBlock.charCodeAt(0) === 0xfeff) {
              textBlock = textBlock.slice(1);
            }
            const lines = textBlock.split('\n');
            for (let line of lines) {
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line) continue;
              try {
                const row = JSON.parse(line);
                this.consume(s, row, projectDir);
              } catch {}
            }
            s.offset += lastNl + 1;
            const remLen = combined.length - (lastNl + 1);
            carry = remLen > 0 ? Buffer.from(combined.subarray(lastNl + 1)) : Buffer.alloc(0);
          } else {
            carry = combined === slice ? Buffer.from(combined) : combined;
          }
        }
      }

      const targetHeadLen = Math.min(size, HEAD_MAX);
      if (targetHeadLen > 0 && (s.headLen !== targetHeadLen || !s.head)) {
        const headBuf = readBytesAt(fd, 0, targetHeadLen);
        s.headLen = headBuf.length;
        s.head = headBuf.length > 0 ? md5Hex(headBuf) : '';
      }
    } catch {
      return freshSummary();
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }

    this.memo.set(memoKey, { size, mtimeMs, head: s.head, s });
    this._saveDiskCache(file, size, mtimeMs, s);
    return s;
  }

  scan(projectDir, nowSec = Math.floor(Date.now() / 1000), roots) {
    const convRes = scanConversations(projectDir, this.cfg, nowSec, roots);
    if (!convRes.exists) {
      return {
        exists: false,
        mains: [],
        runs: [],
        allProjectConvIds: new Set(),
        cliSessions: [],
        roots: convRes.roots,
      };
    }

    const summariesById = new Map();
    for (const row of convRes.mains) {
      const s = row.transcriptPath ? this.summarize(row.transcriptPath, projectDir) : freshSummary();
      summariesById.set(row.conversation_id, s);
    }
    for (const row of convRes.subagents) {
      const s = row.transcriptPath ? this.summarize(row.transcriptPath, projectDir) : freshSummary();
      summariesById.set(row.conversation_id, s);
    }

    const mains = [];
    const cliSessions = [];
    for (const row of convRes.mains) {
      const s = summariesById.get(row.conversation_id) ?? freshSummary();
      const title = row.title ? oneLine(row.title, 120) : '';
      const updated = s.updated || (row.effective_sec > 0 ? isoMs(row.effective_sec * 1000) : null);

      const mainEntry = {
        id: row.conversation_id,
        conversation_id: row.conversation_id,
        title,
        status: row.status,
        source: row.source,
        app_data_dir: row.app_data_dir,
        dbRoot: row.dbRoot,
        brainDir: row.brainDir,
        transcriptPath: row.transcriptPath,
        effective_sec: row.effective_sec,
        mtime: row.effective_sec,
        not_fully_idle: row.not_fully_idle,
        killed: Boolean(row.killed),
        step_count: row.step_count,
        started: s.started,
        updated,
        lastKind: s.lastKind,
        tokens: { ...s.tokens },
        segs: s.segs.map(([a, b]) => [a, b]),
        events: s.events.slice(),
        files: s.files.slice(),
        spawned: { ...s.spawned },
        resumes: s.resumes.slice(),
        stops: s.stops.slice(),
        limit: s.limit,
      };
      mains.push(mainEntry);

      if (isCliMain(row)) {
        cliSessions.push({
          id: row.conversation_id,
          title,
          updated,
          status: row.status,
          dbRoot: row.dbRoot,
        });
      }
    }

    const cooldownSec = this._cooldownSec();
    const runs = [];
    for (const row of convRes.subagents) {
      const childId = row.conversation_id;
      const s = summariesById.get(childId) ?? freshSummary();

      let spawnParentId = row.parent_conversation_id || '';
      let spawnMeta = spawnParentId ? summariesById.get(spawnParentId)?.spawned?.[childId] ?? null : null;
      if (!spawnMeta) {
        for (const [candParentId, candSummary] of summariesById.entries()) {
          if (candSummary.spawned?.[childId]) {
            spawnMeta = candSummary.spawned[childId];
            if (!spawnParentId) spawnParentId = candParentId;
            break;
          }
        }
      }

      const role =
        spawnMeta?.role ||
        (row.agent_name ? safeLine(row.agent_name, 60) : null) ||
        (row.title ? safeLine(row.title, 60) : null);
      const model = spawnMeta?.model ?? null;
      const agentType =
        spawnMeta?.agentType ||
        clip(redact(phpTrim(String(row.agent_name || '').replace(/[\x00-\x1f\x7f]+/g, ' '))), 40);
      const description =
        spawnMeta?.prompt ||
        (row.title ? safeLine(row.title, 140) : '') ||
        (row.agent_name ? safeLine(row.agent_name, 140) : '');

      const resumeSet = new Set();
      const stopSet = new Set();
      for (const [candParentId, candSummary] of summariesById.entries()) {
        for (const r of candSummary.resumes) {
          if (r.recipient === childId && r.t) resumeSet.add(r.t);
        }
        const isChildOfCand =
          (row.parent_conversation_id && row.parent_conversation_id === candParentId) ||
          Boolean(candSummary.spawned?.[childId]);
        for (const st of candSummary.stops) {
          if (st.action === 'kill' && st.ids.includes(childId) && st.t) {
            stopSet.add(st.t);
          } else if (st.action === 'kill_all' && isChildOfCand && st.t) {
            stopSet.add(st.t);
          }
        }
      }

      const sortByMs = (a, b) => (tsMs(a) ?? 0) - (tsMs(b) ?? 0);
      const resumeTimes = Array.from(resumeSet).sort(sortByMs);
      const stopTimes = Array.from(stopSet).sort(sortByMs);
      const segs = mergeResumesAndStops(s.segs, resumeTimes, stopTimes, cooldownSec);

      let latestUpdated = s.updated || (row.effective_sec > 0 ? isoMs(row.effective_sec * 1000) : null);
      let latestMs = latestUpdated ? tsMs(latestUpdated) ?? 0 : 0;
      for (const extraT of [...resumeTimes, ...stopTimes]) {
        const ms = tsMs(extraT);
        if (ms !== null && ms > latestMs) {
          latestMs = ms;
          latestUpdated = extraT;
        }
      }

      runs.push({
        id: childId,
        conversation_id: childId,
        parentId: spawnParentId,
        parent_conversation_id: spawnParentId,
        nesting_depth: row.nesting_depth,
        title: row.title ? oneLine(row.title, 120) : '',
        role,
        model,
        agentType,
        description,
        task: description,
        status: row.status,
        source: row.source,
        app_data_dir: row.app_data_dir,
        dbRoot: row.dbRoot,
        brainDir: row.brainDir,
        transcriptPath: row.transcriptPath,
        effective_sec: row.effective_sec,
        mtime: row.effective_sec,
        not_fully_idle: row.not_fully_idle,
        killed: Boolean(row.killed),
        started: s.started ?? spawnMeta?.t ?? null,
        updated: latestUpdated,
        lastKind: s.lastKind,
        tokens: { ...s.tokens },
        segs,
        events: s.events.slice(),
        files: s.files.slice(),
        resumes: resumeTimes,
        stops: stopTimes,
        limit: s.limit,
      });
    }

    return {
      exists: true,
      mains,
      runs,
      allProjectConvIds: convRes.allIds,
      cliSessions,
      roots: convRes.roots,
    };
  }
}
