import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDir, isFile, mtimeSec, normalizeWorkspacePath, strcmp, tsMs } from './util.mjs';

const SURFACE_NAMES = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const TRANSCRIPT_REL_PARTS = ['.system_generated', 'logs', 'transcript.jsonl'];
const RUNNING_STATUS = 'CASCADE_RUN_STATUS_RUNNING';

const DESIRED_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'step_count',
  'last_modified_time',
  'workspace_uris',
  'status',
  'source',
  'app_data_dir',
  'agent_name',
  'parent_conversation_id',
  'nesting_depth',
  'not_fully_idle',
  'killed',
  'last_user_input_time',
];

const MAX_DB_CACHE_ENTRIES = 64;
const dbRowCache = new Map();

function setDbCache(cacheKey, rows) {
  if (dbRowCache.has(cacheKey)) {
    dbRowCache.delete(cacheKey);
  } else if (dbRowCache.size >= MAX_DB_CACHE_ENTRIES) {
    const oldestKey = dbRowCache.keys().next().value;
    if (oldestKey !== undefined) dbRowCache.delete(oldestKey);
  }
  dbRowCache.set(cacheKey, rows);
}

function isValidConversationId(conversationId) {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return false;
  if (conversationId.trim() !== conversationId) return false;
  if (conversationId === '.' || conversationId === '..' || conversationId.includes('..')) return false;
  if (/[\x00-\x1f\x7f/\\:]/.test(conversationId)) return false;
  if (path.isAbsolute(conversationId) || path.basename(conversationId) !== conversationId) return false;
  return true;
}

function isSqliteBusyError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') return true;
  if (typeof err.errcode === 'number') {
    const baseCode = err.errcode & 0xff;
    if (baseCode === 5 || baseCode === 6) return true;
  }
  const msg = `${err.errstr ?? ''} ${err.message ?? ''}`;
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
}

/**
 * Mengurai string timestamp dari SQLite Antigravity (ISO 8601 maupun space-separated UTC)
 * menjadi epoch detik UTC. Mengabaikan tanggal sentinel (tahun < 1970, mis. '0001-...').
 */
function parseSqliteTimestampSec(raw) {
  if (typeof raw !== 'string') return 0;
  const s = raw.trim();
  if (!s) return 0;

  const yearMatch = /^(\d{4})-/.exec(s);
  if (!yearMatch || Number(yearMatch[1]) < 1970) return 0;

  let norm = s.replace(/^(\d{4}-\d{2}-\d{2})[ tT](\d{2}:\d{2}:\d{2})/, '$1T$2');
  norm = norm.replace(/\.(\d{9})\d+/, '.$1');
  norm = norm.replace(/z$/i, 'Z');
  norm = norm.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  norm = norm.replace(/([+-]\d{2})$/, '$1:00');
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(norm)) {
    norm += 'Z';
  }

  const ms = tsMs(norm);
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 1000);
}

function parseWorkspaceUris(raw) {
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const norm = normalizeWorkspacePath(item);
      if (norm) out.push(norm);
    }
    return out;
  } catch {
    return [];
  }
}

function readDbRows(dbPath) {
  const cacheKey = path.resolve(dbPath);
  if (!isFile(dbPath)) return [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
      .get();
    if (!tableExists) {
      setDbCache(cacheKey, []);
      return [];
    }

    const colInfos = db.prepare('PRAGMA table_info(conversation_summaries)').all();
    const availableCols = new Set(colInfos.map((c) => c.name));
    if (!availableCols.has('conversation_id')) {
      setDbCache(cacheKey, []);
      return [];
    }

    const selectCols = DESIRED_COLUMNS.filter((c) => availableCols.has(c));
    const rawRows = db.prepare(`SELECT ${selectCols.join(', ')} FROM conversation_summaries`).all();

    const rows = [];
    for (const r of rawRows) {
      if (!isValidConversationId(r.conversation_id)) continue;
      rows.push({
        conversation_id: r.conversation_id,
        title: typeof r.title === 'string' ? r.title : '',
        preview: typeof r.preview === 'string' ? r.preview : '',
        step_count: Number.isFinite(Number(r.step_count)) ? Number(r.step_count) : 0,
        last_modified_time: typeof r.last_modified_time === 'string' ? r.last_modified_time : '',
        workspace_uris: typeof r.workspace_uris === 'string' ? r.workspace_uris : '',
        status: typeof r.status === 'string' ? r.status : '',
        source: typeof r.source === 'string' ? r.source : '',
        app_data_dir: typeof r.app_data_dir === 'string' ? r.app_data_dir : '',
        agent_name: typeof r.agent_name === 'string' ? r.agent_name : '',
        parent_conversation_id:
          typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id.trim() : '',
        nesting_depth: Number.isFinite(Number(r.nesting_depth)) ? Number(r.nesting_depth) : 0,
        not_fully_idle: Number(r.not_fully_idle) ? 1 : 0,
        killed: Number(r.killed) ? 1 : 0,
        last_user_input_time: typeof r.last_user_input_time === 'string' ? r.last_user_input_time : '',
      });
    }

    setDbCache(cacheKey, rows);
    return rows;
  } catch (err) {
    if (isSqliteBusyError(err)) {
      return dbRowCache.get(cacheKey) ?? [];
    }
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function mergeDedupMetadata(winner, other) {
  if (!other) return winner;
  const mergedUris = Array.from(new Set([...winner._normalizedUris, ...other._normalizedUris]));
  return {
    ...winner,
    title: winner.title || other.title,
    preview: winner.preview || other.preview,
    source: winner.source || other.source,
    app_data_dir: winner.app_data_dir || other.app_data_dir,
    agent_name: winner.agent_name || other.agent_name,
    parent_conversation_id: winner.parent_conversation_id || other.parent_conversation_id,
    workspace_uris: winner.workspace_uris || other.workspace_uris,
    _normalizedUris: mergedUris,
  };
}

function pickBetterRow(existing, candidate) {
  if (!existing) return candidate;

  const existingRunning = existing.status === RUNNING_STATUS;
  const candidateRunning = candidate.status === RUNNING_STATUS;
  if (candidateRunning !== existingRunning) {
    return candidateRunning ? mergeDedupMetadata(candidate, existing) : mergeDedupMetadata(existing, candidate);
  }

  if (candidate.effective_sec !== existing.effective_sec) {
    return candidate.effective_sec > existing.effective_sec
      ? mergeDedupMetadata(candidate, existing)
      : mergeDedupMetadata(existing, candidate);
  }

  if (Boolean(candidate.status) !== Boolean(existing.status)) {
    return candidate.status ? mergeDedupMetadata(candidate, existing) : mergeDedupMetadata(existing, candidate);
  }

  return candidate._rootIndex >= existing._rootIndex
    ? mergeDedupMetadata(candidate, existing)
    : mergeDedupMetadata(existing, candidate);
}

function toPublicRow(row) {
  const { _normalizedUris, _rootIndex, ...publicRow } = row;
  return publicRow;
}

/**
 * Menemukan direktori surface Antigravity yang tersedia secara berurutan:
 * `[ANTIGRAVITY_HOME]` bila env diset non-kosong, atau `<homeDir>/.gemini/{antigravity,antigravity-ide,antigravity-cli}`.
 */
export function discoverSurfaceRoots(homeDir) {
  const envHome = typeof process.env.ANTIGRAVITY_HOME === 'string' ? process.env.ANTIGRAVITY_HOME.trim() : '';
  if (envHome !== '') {
    return isDir(envHome) ? [envHome] : [];
  }

  const baseHome = typeof homeDir === 'string' && homeDir.trim() !== '' ? homeDir : os.homedir();
  const geminiDir = path.join(baseHome, '.gemini');
  const roots = [];
  for (const name of SURFACE_NAMES) {
    const candidate = path.join(geminiDir, name);
    if (isDir(candidate)) {
      roots.push(candidate);
    }
  }
  return roots;
}

/**
 * Mencari direktori `<root>/brain/<conversationId>` secara berurutan lintas surface roots.
 * Menolak `conversationId` tidak valid atau berpotensi path traversal.
 */
export function resolveBrainDir(conversationId, roots) {
  if (!isValidConversationId(conversationId)) return null;
  const searchRoots = roots === undefined ? discoverSurfaceRoots() : Array.isArray(roots) ? roots : [];

  for (const root of searchRoots) {
    if (typeof root !== 'string' || root.trim() === '') continue;
    const candidate = path.join(root, 'brain', conversationId);
    if (isDir(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Memindai `conversation_summaries.db` lintas surface roots secara read-only,
 * mencocokkan workspace proyek, mendeduplikasi per `conversation_id`,
 * memfilter ke jendela `cfg.window_days`, dan memisahkan `mains` vs `subagents`.
 */
export function scanConversations(projectDir, cfg = {}, nowSec = Math.floor(Date.now() / 1000), roots) {
  const surfaceRoots = Array.isArray(roots) ? roots : discoverSurfaceRoots();
  const emptyResult = () => ({
    exists: false,
    mains: [],
    subagents: [],
    allIds: new Set(),
    roots: surfaceRoots,
  });

  const targetNorm = normalizeWorkspacePath(projectDir);
  if (!targetNorm || surfaceRoots.length === 0) {
    return emptyResult();
  }

  const effectiveNow = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  const windowDays = Number.isFinite(cfg?.window_days) && cfg.window_days > 0 ? cfg.window_days : 7;
  const mainsMax = Number.isInteger(cfg?.mains_max) && cfg.mains_max > 0 ? cfg.mains_max : 40;
  const cutoff = effectiveNow - windowDays * 86400;

  const rowsById = new Map();

  for (let rootIndex = 0; rootIndex < surfaceRoots.length; rootIndex++) {
    const dbRoot = surfaceRoots[rootIndex];
    if (typeof dbRoot !== 'string' || dbRoot.trim() === '') continue;

    const dbPath = path.join(dbRoot, 'conversation_summaries.db');
    const rawRows = readDbRows(dbPath);

    for (const raw of rawRows) {
      const normalizedUris = parseWorkspaceUris(raw.workspace_uris);
      const entry = {
        ...raw,
        dbRoot,
        _normalizedUris: normalizedUris,
        _rootIndex: rootIndex,
      };
      let list = rowsById.get(raw.conversation_id);
      if (!list) {
        list = [];
        rowsById.set(raw.conversation_id, list);
      }
      list.push(entry);
    }
  }

  if (rowsById.size === 0) {
    return emptyResult();
  }

  // Kumpulkan ID kandidat proyek (cocok workspace_uris + closure parent_conversation_id)
  // sebelum menyentuh filesystem brain/<id> agar baris proyek lain tidak memicu syscall stat.
  const candidateProjectIds = new Set();
  for (const [id, versions] of rowsById.entries()) {
    if (versions.some((v) => v._normalizedUris.includes(targetNorm))) {
      candidateProjectIds.add(id);
    }
  }

  let candidateExpanded = true;
  while (candidateExpanded) {
    candidateExpanded = false;
    for (const [id, versions] of rowsById.entries()) {
      if (candidateProjectIds.has(id)) continue;
      const linksToProject = versions.some(
        (v) =>
          v.parent_conversation_id &&
          candidateProjectIds.has(v.parent_conversation_id) &&
          (v._normalizedUris.length === 0 || v._normalizedUris.includes(targetNorm))
      );
      if (linksToProject) {
        candidateProjectIds.add(id);
        candidateExpanded = true;
      }
    }
  }

  if (candidateProjectIds.size === 0) {
    return emptyResult();
  }

  const deduped = new Map();
  for (const id of candidateProjectIds) {
    const versions = rowsById.get(id);
    if (!versions) continue;

    const brainDir = resolveBrainDir(id, surfaceRoots);
    const transcriptCandidate = brainDir ? path.join(brainDir, ...TRANSCRIPT_REL_PARTS) : null;
    const transcriptPath = transcriptCandidate && isFile(transcriptCandidate) ? transcriptCandidate : null;
    const transcriptMtime = transcriptPath ? mtimeSec(transcriptPath) : 0;

    let winner = null;
    for (const v of versions) {
      const lastModifiedSec = parseSqliteTimestampSec(v.last_modified_time);
      const lastUserInputSec = parseSqliteTimestampSec(v.last_user_input_time);
      const effectiveSec =
        lastModifiedSec > 0 ? lastModifiedSec : transcriptMtime > 0 ? transcriptMtime : lastUserInputSec;

      const candidate = {
        ...v,
        last_modified_sec: lastModifiedSec,
        effective_sec: effectiveSec,
        mtime: effectiveSec,
        brainDir,
        transcriptPath,
      };
      winner = pickBetterRow(winner, candidate);
    }

    if (winner) {
      deduped.set(id, winner);
    }
  }

  const isWithinWindow = (row) =>
    row.effective_sec >= cutoff || (row.effective_sec === 0 && row.status === RUNNING_STATUS);

  const sortNewestFirst = (a, b) => {
    const ta = a.effective_sec > 0 ? a.effective_sec : a.status === RUNNING_STATUS ? effectiveNow : 0;
    const tb = b.effective_sec > 0 ? b.effective_sec : b.status === RUNNING_STATUS ? effectiveNow : 0;
    if (tb !== ta) return tb - ta;
    return strcmp(a.conversation_id, b.conversation_id);
  };

  const isMainRow = (row) => row.nesting_depth === 0 && !row.parent_conversation_id;

  const inWindowRows = [];
  for (const row of deduped.values()) {
    if (isWithinWindow(row)) {
      inWindowRows.push(row);
    }
  }

  const workspaceRows = inWindowRows.filter((row) => row._normalizedUris.includes(targetNorm));
  const mainsRaw = workspaceRows.filter(isMainRow).sort(sortNewestFirst).slice(0, mainsMax);
  const subagentsRaw = workspaceRows.filter((row) => !isMainRow(row));

  // Sertakan subagent yang parent_conversation_id-nya milik workspace conversation di mains/subagents
  const activeProjectIds = new Set([
    ...mainsRaw.map((r) => r.conversation_id),
    ...subagentsRaw.map((r) => r.conversation_id),
  ]);

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of inWindowRows) {
      if (activeProjectIds.has(row.conversation_id)) continue;
      if (row.parent_conversation_id && activeProjectIds.has(row.parent_conversation_id)) {
        if (row._normalizedUris.length === 0 || row._normalizedUris.includes(targetNorm)) {
          activeProjectIds.add(row.conversation_id);
          subagentsRaw.push(row);
          expanded = true;
        }
      }
    }
  }

  const mains = mainsRaw.map(toPublicRow);
  const subagents = subagentsRaw.sort(sortNewestFirst).map(toPublicRow);

  const allIds = new Set();
  for (const r of mains) allIds.add(r.conversation_id);
  for (const r of subagents) allIds.add(r.conversation_id);

  return {
    exists: mains.length > 0 || subagents.length > 0,
    mains,
    subagents,
    allIds,
    roots: surfaceRoots,
  };
}
