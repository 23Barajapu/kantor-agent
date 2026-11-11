import path from 'node:path';
import { TranscriptScanner } from './transcripts.mjs';
import { scanArtifacts, extractTodos } from './artifacts.mjs';
import { clip, cmpNum, hash, isoMs, phpTrim, readText, strcmp, tsMs } from './util.mjs';

const VERSION = '1.0.0';
const DEFAULT_TEAM = ['Budi', 'Sari', 'Agus', 'Rina'];
const DEFAULT_FREELANCERS = ['Yoga', 'Dewi', 'Rudi', 'Maya', 'Eko', 'Nina', 'Fajar', 'Wulan', 'Dimas', 'Lestari', 'Hendra', 'Tika'];
const DEFAULT_COLORS = {
  ketua: '#6a55c9',
  team: ['#3f6fd1', '#2f9a6d', '#d9772f', '#c2417a'],
  freelancers: ['#0f8fa3', '#9a7418', '#4f7d3a', '#8a4fa8', '#3d7f9e', '#b8452f'],
};
const LIFE_EVENT_KINDS = new Set(['assign', 'resume', 'done']);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(normalizedText, kw) {
  const escaped = escapeRegExp(kw);
  // Kata kunci singkat (<= 2 huruf seperti ui/ux/qa/ci/cd/pr) wajib utuh sebagai token agar tidak memicu substring (mis. "build" -> "ui")
  if (kw.length <= 2) {
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(normalizedText);
  }
  return new RegExp(`(?:^|[^a-z0-9])${escaped}`).test(normalizedText);
}

/**
 * Mengklasifikasikan subagent run ke salah satu dari 4 divisi Tim IT spesialis.
 * Prioritas 1: pencocokan exact (case-insensitive) `agentType` ke `match_types`.
 * Prioritas 2: skor kata kunci unik `match_keywords` pada `role + task + description` (seri -> indeks terkecil).
 * Mengembalikan `null` jika tidak ada divisi yang cocok (*unclassified*).
 *
 * @param {object|null} run
 * @param {Array<object>} divisions
 * @returns {{ idx: number, id: string, label: string } | null}
 */
export function classifyDivision(run, divisions) {
  if (!run || !Array.isArray(divisions) || divisions.length === 0) {
    return null;
  }

  const rawType =
    typeof run.agentType === 'string'
      ? run.agentType
      : typeof run.agent_type === 'string'
        ? run.agent_type
        : '';
  const typeNorm = rawType.trim().toLowerCase();

  if (typeNorm !== '') {
    for (let idx = 0; idx < divisions.length; idx++) {
      const div = divisions[idx];
      if (!div || !Array.isArray(div.match_types)) continue;
      if (div.match_types.some((t) => String(t).trim().toLowerCase() === typeNorm)) {
        return { idx, id: div.id, label: div.label };
      }
    }
  }

  const combinedRaw = `${run.role || ''} ${run.task || ''} ${run.description || ''}`;
  // Pisahkan batas camelCase/PascalCase sebelum lowercasing agar "TailwindCSS"/"UIBuilder"/"DevOps" tetap terdeteksi
  const normalizedText = combinedRaw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

  if (normalizedText.trim() === '') {
    return null;
  }

  let bestIdx = -1;
  let bestScore = 0;

  for (let idx = 0; idx < divisions.length; idx++) {
    const div = divisions[idx];
    if (!div || !Array.isArray(div.match_keywords)) continue;

    const seenKw = new Set();
    let score = 0;
    for (const rawKw of div.match_keywords) {
      const kw = String(rawKw ?? '').trim().toLowerCase();
      if (!kw || seenKw.has(kw)) continue;
      seenKw.add(kw);
      if (keywordMatches(normalizedText, kw)) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }

  if (bestIdx >= 0 && bestScore > 0) {
    const best = divisions[bestIdx];
    return { idx: bestIdx, id: best.id, label: best.label };
  }

  return null;
}

function totalTokens(tok) {
  if (typeof tok === 'number' && Number.isFinite(tok)) return tok;
  if (!tok || typeof tok !== 'object') return 0;
  if (typeof tok.total === 'number' && Number.isFinite(tok.total)) return tok.total;
  const input = Number(tok.input) || 0;
  const output = Number(tok.output) || 0;
  const cacheRead = Number(tok.cache_read ?? tok.cacheRead) || 0;
  return input + output + cacheRead;
}

function countTools(entry) {
  if (typeof entry?.tools === 'number' && Number.isFinite(entry.tools)) return entry.tools;
  const events = Array.isArray(entry?.events) ? entry.events : [];
  let n = 0;
  for (const e of events) {
    if (e?.kind === 'tool') n++;
  }
  return n;
}

function resolveRunSegments(rawRun, divisions, now, runningWindowMs) {
  const dbStatus = rawRun.status;
  const segs = [];
  for (const pair of Array.isArray(rawRun.segs) ? rawRun.segs : []) {
    if (!Array.isArray(pair) || pair.length < 1) continue;
    const startMs = tsMs(pair[0]);
    if (startMs === null) continue;
    const endRaw = pair[1] ?? null;
    const endMs = endRaw === null ? null : tsMs(endRaw);
    segs.push({
      start: startMs,
      startIso: pair[0],
      end: endMs,
      endIso: endMs === null ? null : endRaw,
    });
  }

  if (segs.length === 0) {
    const fb =
      (rawRun.started && tsMs(rawRun.started) !== null ? rawRun.started : null) ||
      (rawRun.updated && tsMs(rawRun.updated) !== null ? rawRun.updated : null) ||
      isoMs(now);
    segs.push({ start: tsMs(fb), startIso: fb, end: null, endIso: null });
  }

  const startedIso = (rawRun.started && tsMs(rawRun.started) !== null ? rawRun.started : null) || segs[0].startIso;
  const startedMs = tsMs(startedIso) ?? segs[0].start;
  const upd =
    (rawRun.updated && tsMs(rawRun.updated) !== null ? tsMs(rawRun.updated) : null) ?? segs[segs.length - 1].start;
  const stopTimesMs = (Array.isArray(rawRun.stops) ? rawRun.stops : []).map(tsMs).filter((ms) => ms !== null);

  let effStatus = rawRun.limit ? 'limit' : 'selesai';
  let reason = null;
  const last = segs[segs.length - 1];

  if (last.end === null) {
    const stopAfterStart = stopTimesMs.filter((ms) => ms >= last.start);
    if (rawRun.killed || stopAfterStart.length > 0) {
      last.end = stopAfterStart.length > 0 ? Math.min(...stopAfterStart) : Math.max(last.start, upd);
      effStatus = 'terhenti';
      reason = 'dihentikan';
    } else if (rawRun.limit) {
      last.end = Math.max(last.start, upd);
      effStatus = 'limit';
    } else if (
      dbStatus === 'CASCADE_RUN_STATUS_IDLE' &&
      !rawRun.not_fully_idle &&
      (rawRun.lastKind === 'final' || !rawRun.transcriptPath)
    ) {
      last.end = Math.max(last.start, upd);
      effStatus = 'selesai';
    } else if (
      dbStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
      rawRun.not_fully_idle === 1 ||
      (now - upd <= runningWindowMs && rawRun.lastKind !== 'final')
    ) {
      effStatus = 'bekerja';
    } else {
      last.end = Math.max(last.start, upd) + runningWindowMs;
      effStatus = 'terhenti';
      reason = 'tidak-aktif';
    }
    if (last.end !== null) {
      last.endIso = isoMs(last.end);
    }
  } else if (
    !rawRun.limit &&
    (stopTimesMs.some((ms) => ms >= last.start && ms === last.end) || (rawRun.killed && rawRun.lastKind !== 'final'))
  ) {
    effStatus = 'terhenti';
    reason = 'dihentikan';
  }

  const div = classifyDivision(rawRun, divisions);
  const artifacts = rawRun.brainDir ? scanArtifacts(rawRun.id, rawRun.brainDir) : [];

  return {
    ...rawRun,
    dbStatus,
    startedIso,
    startedMs,
    effSegs: segs,
    effStatus,
    reason,
    _div: div,
    _divisionLabel: div?.label ?? 'Umum',
    _artifacts: artifacts,
  };
}

function assignStrictSpecialists(jobs, teamNames, divisions, freelancerNames, cooldownMs) {
  const pool = teamNames.map((_, idx) => ({ job: null, idx, div: divisions[idx] ?? null }));
  const fl = [];
  const charOf = new Map();
  const free = (slot, start) => slot.job === null || (slot.job.end !== null && slot.job.end + cooldownMs <= start);

  for (const job of jobs) {
    const prev = charOf.get(job.run.id) ?? null;
    let pick = null;

    if (job.k > 0 && prev !== null) {
      const slot = prev.kind === 'pool' ? pool[prev.idx] : fl[prev.idx];
      if (slot && ((slot.job !== null && slot.job.run === job.run) || free(slot, job.start))) {
        pick = prev;
      }
    }

    if (pick === null) {
      const div = job.run._div;
      if (div !== null && div.idx >= 0 && div.idx < pool.length && free(pool[div.idx], job.start)) {
        pick = {
          kind: 'pool',
          idx: div.idx,
          name: teamNames[div.idx],
          division: div.label,
        };
      }
    }

    if (pick === null) {
      let j = fl.findIndex((s) => free(s, job.start));
      if (j < 0) {
        j = fl.length;
        fl.push({ job: null, name: null });
      }
      const used = new Set(fl.filter((s) => !free(s, job.start)).map((s) => s.name));
      let name = null;
      if (prev !== null && prev.kind === 'fl' && !used.has(prev.name)) {
        name = prev.name;
      } else {
        const L = freelancerNames.length;
        const base = hash(job.run.id) % L;
        for (let n = 0; n < L; n++) {
          const cand = freelancerNames[(base + n) % L];
          if (!used.has(cand)) {
            name = cand;
            break;
          }
        }
        if (name === null) {
          name = `${freelancerNames[base]} ${j + 1}`;
        }
      }
      pick = { kind: 'fl', idx: j, name };
    }

    if (pick.kind === 'pool') {
      pool[pick.idx].job = job;
    } else {
      fl[pick.idx].job = job;
      fl[pick.idx].name = pick.name;
    }
    job.who = pick;
    charOf.set(job.run.id, pick);
  }

  return { pool, fl, charOf };
}

function resolveKetuaState(scanMains, runs, acpStatus, now, maMs, rwMs, cdMs) {
  const kids = new Map();
  for (const r of runs) {
    if (r.effStatus === 'bekerja' && r.parentId) {
      kids.set(r.parentId, (kids.get(r.parentId) ?? 0) + 1);
    }
  }

  const isAcpBusySession = (m) => Boolean(acpStatus?.busy && acpStatus.sessionId && acpStatus.sessionId === m.id);

  const mains = scanMains
    .filter((m) => m.updated !== null || m.status === 'CASCADE_RUN_STATUS_RUNNING' || m.not_fully_idle === 1 || isAcpBusySession(m))
    .sort((a, b) => {
      const ta = (a.updated ? tsMs(a.updated) : null) ?? (a.status === 'CASCADE_RUN_STATUS_RUNNING' || isAcpBusySession(a) ? now : 0);
      const tb = (b.updated ? tsMs(b.updated) : null) ?? (b.status === 'CASCADE_RUN_STATUS_RUNNING' || isAcpBusySession(b) ? now : 0);
      return cmpNum(tb, ta) || strcmp(a.id, b.id);
    });

  const mainState = (m) => {
    const updMs = m.updated ? tsMs(m.updated) : null;
    const age =
      updMs !== null
        ? now - updMs
        : m.status === 'CASCADE_RUN_STATUS_RUNNING' || isAcpBusySession(m)
          ? 0
          : Number.POSITIVE_INFINITY;
    const activeKids = kids.get(m.id) ?? 0;

    if (
      (m.lastKind !== 'final' && age <= maMs) ||
      m.status === 'CASCADE_RUN_STATUS_RUNNING' ||
      isAcpBusySession(m)
    ) {
      return ['bekerja', 'aktif'];
    }
    if (m.lastKind === 'tool' && age <= rwMs) {
      return ['bekerja', 'alat'];
    }
    if (activeKids > 0 || m.not_fully_idle === 1) {
      return ['bekerja', 'menunggu-tim'];
    }
    if (m.lastKind === 'final' && age < cdMs) {
      return ['selesai', null];
    }
    return ['santai', null];
  };

  const states = mains.map(mainState);
  let di = -1;
  if (acpStatus?.busy && acpStatus.sessionId) {
    di = mains.findIndex((m) => m.id === acpStatus.sessionId);
  }
  if (di < 0) {
    di = states.findIndex((s) => s[0] === 'bekerja');
  }
  if (di < 0) {
    di = mains.length > 0 ? 0 : -1;
  }

  const dm = di >= 0 ? mains[di] : null;
  const activeMains = states.filter((s) => s[0] === 'bekerja').length;

  let todos = dm?.brainDir ? extractTodos(dm.brainDir) : null;
  if (todos === null && dm !== null) {
    for (const m of mains) {
      if (m === dm || !m.brainDir) continue;
      const cand = extractTodos(m.brainDir);
      if (cand !== null) {
        todos = { ...cand, source: `${cand.source} (sesi sebelumnya)` };
        break;
      }
    }
  }

  const artifacts = dm?.brainDir ? scanArtifacts(dm.id, dm.brainDir) : [];

  return {
    mains,
    dm,
    dmState: dm ? states[di] : ['santai', null],
    activeMains,
    kids,
    todos,
    artifacts,
  };
}

function buildFeed({ mains, runs, jobs, byId, charOf, jobsOf, charInfo, ketuaInfo, taskText, runningWindowSec, now }) {
  const feed = [];
  const add = (t, ms, who, kind, text, tool) => {
    if (ms === null) return;
    feed.push({
      ms,
      e: { t, who: who.key, name: who.label, color: who.color, kind, text, tool },
    });
  };

  for (const m of mains) {
    for (const e of m.events ?? []) {
      if (e.kind === 'text' || e.tool === 'invoke_subagent') continue;
      add(e.t, tsMs(e.t), ketuaInfo, e.kind, e.text, e.tool);
    }
  }

  for (const job of jobs) {
    const r = job.run;
    const who = charInfo(job.who, r);
    const labelTask = taskText(r);

    if (job.k === 0) {
      const parent = r.parentId && byId.has(r.parentId) ? byId.get(r.parentId) : null;
      const req = parent !== null ? charInfo(charOf.get(parent.id), parent) : ketuaInfo;
      add(job.startIso, job.start, req, 'assign', `${req.label} meminta ${who.label}: ${labelTask}`, null);
    } else {
      add(job.startIso, job.start, who, 'resume', `${who.label} melanjutkan: ${labelTask}`, null);
    }

    if (job.end !== null && job.end <= now) {
      const lastJob = r.effSegs.length - 1 === job.k;
      let text = `${who.label} selesai: ${labelTask}`;
      if (lastJob && r.effStatus === 'limit') {
        text = `${who.label} jeda — limit pemakaian`;
      } else if (lastJob && r.reason === 'dihentikan') {
        text = `${who.label} dihentikan: ${labelTask}`;
      } else if (lastJob && r.reason === 'tidak-aktif') {
        text = `${who.label} berhenti — tidak ada aktivitas ${Math.round(runningWindowSec / 60)} menit`;
      }
      add(job.endIso, job.end, who, 'done', text, null);
    }
  }

  for (const r of runs) {
    const js = jobsOf.get(r.id) ?? [];
    if (js.length === 0) continue;
    for (const e of r.events ?? []) {
      const ms = tsMs(e.t);
      if (ms === null) continue;
      let job = js[0];
      for (const j of js) {
        if (j.start <= ms) job = j;
      }
      add(e.t, ms, charInfo(job.who, r), e.kind, e.text, e.tool);
    }
  }

  const order = feed.map((f, i) => [f, i]);
  order.sort((a, b) => cmpNum(b[0].ms, a[0].ms) || cmpNum(a[1], b[1]));
  const life = order.filter((x) => LIFE_EVENT_KINDS.has(x[0].e.kind)).slice(0, 60);
  const acts = order.filter((x) => !LIFE_EVENT_KINDS.has(x[0].e.kind)).slice(0, 120);
  const merged = [...life, ...acts].sort((a, b) => cmpNum(b[0].ms, a[0].ms) || cmpNum(a[1], b[1]));

  return merged.map((x) => x[0].e);
}

/**
 * Membangun snapshot lengkap status kantor 3D, tim spesialis IT, freelancer, Ketua, feed, riwayat,
 * artifact, dan ringkasan chat ACP dari data lokal Antigravity.
 *
 * @param {object} params
 * @param {string} params.projectDir
 * @param {string|null} [params.storageDir]
 * @param {object} params.cfg
 * @param {number} [params.now]
 * @param {object|null} [params.acpStatus]
 * @param {string|null} [params.tunnelUrl]
 * @returns {object}
 */
export function buildState({ projectDir, storageDir = null, cfg = {}, now = Date.now(), acpStatus = null, tunnelUrl = null }) {
  const runningWindowSec = Number.isFinite(cfg?.running_window) && cfg.running_window > 0 ? cfg.running_window : 900;
  const cooldownSec = Number.isFinite(cfg?.cooldown) && cfg.cooldown > 0 ? cfg.cooldown : 60;
  const mainActiveSec = Number.isFinite(cfg?.main_active) && cfg.main_active > 0 ? cfg.main_active : 90;
  const spareDesks = Number.isInteger(cfg?.spare_desks) && cfg.spare_desks >= 0 ? cfg.spare_desks : 4;

  const RW = runningWindowSec * 1000;
  const CD = cooldownSec * 1000;
  const MA = mainActiveSec * 1000;

  const teamNames = Array.isArray(cfg?.team) && cfg.team.length ? cfg.team : DEFAULT_TEAM;
  const divisions = Array.isArray(cfg?.divisions) ? cfg.divisions : [];
  const freelancerNames = Array.isArray(cfg?.freelancers) && cfg.freelancers.length ? cfg.freelancers : DEFAULT_FREELANCERS;
  const ketuaName = cfg?.ketua || 'Joko';
  const ketuaColor = cfg?.colors?.ketua ?? DEFAULT_COLORS.ketua;
  const teamPal = Array.isArray(cfg?.colors?.team) && cfg.colors.team.length ? cfg.colors.team : DEFAULT_COLORS.team;
  const flPal = Array.isArray(cfg?.colors?.freelancers) && cfg.colors.freelancers.length ? cfg.colors.freelancers : DEFAULT_COLORS.freelancers;

  const nowSec = Math.floor(now / 1000);
  const scan = new TranscriptScanner(storageDir, cfg).scan(projectDir, nowSec);

  const runs = scan.runs
    .map((r) => resolveRunSegments(r, divisions, now, RW))
    .sort((a, b) => cmpNum(a.startedMs, b.startedMs) || strcmp(a.id, b.id));

  const byId = new Map();
  const jobs = [];
  for (const r of runs) {
    byId.set(r.id, r);
    r.effSegs.forEach((sg, k) => jobs.push({ run: r, k, ...sg, who: null }));
  }
  jobs.sort((a, b) => cmpNum(a.start, b.start) || strcmp(a.run.id, b.run.id) || cmpNum(a.k, b.k));

  const { pool, fl, charOf } = assignStrictSpecialists(jobs, teamNames, divisions, freelancerNames, CD);

  const charInfo = (who, run) =>
    who.kind === 'pool'
      ? {
          key: `tim-${who.idx}`,
          name: teamNames[who.idx],
          label: teamNames[who.idx],
          color: teamPal[who.idx % teamPal.length],
        }
      : {
          key: `fl-${run.id}`,
          name: who.name,
          label: `Freelancer · ${who.name}`,
          color: flPal[hash(who.name) % flPal.length],
        };

  const jobState = (job) => (job.end === null ? 'bekerja' : now - job.end < CD ? 'selesai' : 'santai');
  const taskText = (r) => {
    const raw =
      r.description && r.description !== ''
        ? r.description
        : r.task && r.task !== ''
          ? r.task
          : r.role && r.role !== ''
            ? r.role
            : r.agentType || 'subagent';
    return clip(raw, 140);
  };

  const runOut = (job) => {
    const r = job.run;
    const lastJob = r.effSegs.length - 1 === job.k;
    return {
      id: r.id,
      agent_type: r.agentType || '',
      division: r._divisionLabel,
      role: r.role ?? null,
      model: r.model ?? null,
      task: taskText(r),
      status: lastJob ? r.effStatus : 'selesai',
      reason: lastJob ? r.reason : null,
      segment: job.k + 1,
      started: job.startIso,
      ended: job.end === null ? null : job.endIso,
      updated: r.updated,
      last: [...(r.events ?? [])].reverse().slice(0, 8),
      files: (r.files ?? []).slice(-6),
      tools: countTools(r),
      tokens: totalTokens(r.tokens),
      artifacts: r._artifacts,
    };
  };

  const team = pool.map((slot, i) => {
    const info = charInfo({ kind: 'pool', idx: i }, null);
    return {
      ...info,
      division: divisions[i]?.label ?? '',
      kind: 'tim',
      slot: i,
      desk: i,
      state: slot.job ? jobState(slot.job) : 'santai',
      run: slot.job ? runOut(slot.job) : null,
    };
  });

  const freelancers = [];
  fl.forEach((slot, j) => {
    if (slot.job === null) return;
    const st = jobState(slot.job);
    if (st === 'santai') return;
    const info = charInfo({ kind: 'fl', idx: j, name: slot.name }, slot.job.run);
    freelancers.push({
      ...info,
      kind: 'freelancer',
      slot: j,
      desk: j < spareDesks ? j : null,
      state: st,
      run: runOut(slot.job),
    });
  });

  const ketuaData = resolveKetuaState(scan.mains, runs, acpStatus, now, MA, RW, CD);
  const { mains, dm, dmState, activeMains, kids, todos, artifacts } = ketuaData;

  const ketua = {
    key: 'ketua',
    name: ketuaName,
    label: ketuaName,
    role: cfg?.ketua_role || 'Lead Architect',
    kind: 'ketua',
    color: ketuaColor,
    state: dmState[0],
    activity: dmState[1],
    session: dm ? dm.id.slice(0, 8) : null,
    updated: dm ? dm.updated : null,
    last: dm
      ? [...(dm.events ?? [])]
          .reverse()
          .filter((e) => e.kind !== 'text' && e.tool !== 'invoke_subagent')
          .slice(0, 8)
      : [],
    tools: dm ? countTools(dm) : 0,
    tokens: dm ? totalTokens(dm.tokens) : 0,
    waiting_on: dm ? kids.get(dm.id) ?? 0 : 0,
    other_sessions: Math.max(0, activeMains - (dm && dmState[0] === 'bekerja' ? 1 : 0)),
    sessions: mains.length,
    todos,
    artifacts,
  };

  const jobsOf = new Map();
  for (const job of jobs) {
    if (!jobsOf.has(job.run.id)) jobsOf.set(job.run.id, []);
    jobsOf.get(job.run.id).push(job);
  }

  const ketuaInfo = { key: 'ketua', name: ketuaName, label: ketuaName, color: ketuaColor };
  const feed = buildFeed({
    mains,
    runs,
    jobs,
    byId,
    charOf,
    jobsOf,
    charInfo,
    ketuaInfo,
    taskText,
    runningWindowSec,
    now,
  });

  const hist = [...runs]
    .sort((a, b) => cmpNum(b.startedMs, a.startedMs) || strcmp(a.id, b.id))
    .slice(0, 40)
    .map((r) => {
      const js = jobsOf.get(r.id);
      const job = js[js.length - 1];
      const who = charInfo(job.who, r);
      return {
        id: r.id,
        who: who.key,
        name: who.name,
        label: who.label,
        color: who.color,
        kind: job.who.kind === 'pool' ? 'tim' : 'freelancer',
        agent_type: r.agentType || '',
        division: r._divisionLabel,
        role: r.role ?? null,
        model: r.model ?? null,
        task: taskText(r),
        status: r.effStatus,
        started: r.startedIso,
        ended: job.end === null ? null : job.endIso,
        tools: countTools(r),
        tokens: totalTokens(r.tokens),
        artifacts: r._artifacts,
      };
    });

  const recent = runs.filter((r) => now - r.startedMs <= 48 * 3600 * 1000).map((r) => r.startedIso);

  const rawTunnel =
    typeof tunnelUrl === 'string' && tunnelUrl.trim() !== ''
      ? tunnelUrl
      : storageDir
        ? readText(path.join(storageDir, 'tunnel-url.txt')) ?? ''
        : '';
  let tunnel = phpTrim(rawTunnel);
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/kerja$/.test(tunnel)) {
    tunnel = '';
  }

  const chat = {
    enabled: Boolean(cfg?.chat?.enabled),
    connected: Boolean(acpStatus?.connected),
    busy: Boolean(acpStatus?.busy),
    session_id: acpStatus?.sessionId ?? null,
    mode: acpStatus?.mode ?? cfg?.chat?.default_mode ?? 'accept-edits',
    model: acpStatus?.model ?? cfg?.chat?.default_model ?? null,
    sandbox: Boolean(acpStatus?.sandbox ?? cfg?.chat?.sandbox),
    pending_permission_count: acpStatus?.pendingPermissionCount ?? 0,
    sessions: scan.cliSessions,
  };

  return {
    app: 'kantor-agent',
    version: VERSION,
    now: isoMs(now),
    project: cfg?.title || path.basename(projectDir) || 'Project',
    names: [ketuaName, ...teamNames].join('|'),
    transcripts: scan.exists,
    ketua,
    team,
    freelancers,
    feed,
    runs: hist,
    stats: {
      active: runs.filter((r) => r.effStatus === 'bekerja').length,
      freelancers: freelancers.filter((f) => f.state === 'bekerja').length,
      total: runs.length,
      recent_starts: recent,
      sessions_active: activeMains,
    },
    spare_desks: spareDesks,
    public_url: tunnel !== '' ? tunnel : null,
    chat,
  };
}
