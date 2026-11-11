import path from 'node:path';
import { isFile, isPlainObj, phpTrim, readText, values } from './util.mjs';

export const CONFIG_REL = '.agents/kantor-agent.json';

const VALID_MODES = new Set(['accept-edits', 'plan', 'auto']);

// nama tampilan: string, tanpa karakter kontrol, maks 20 titik kode; selain itu null
export function cleanName(v, max = 20) {
  if (typeof v !== 'string') return null;
  const s = phpTrim(v.replace(/[\x00-\x1f\x7f]+/g, ' '));
  if (s === '') return null;
  return Array.from(s).slice(0, max).join('');
}

function cleanMode(v, fallback = 'accept-edits') {
  if (typeof v === 'string' && VALID_MODES.has(v.trim())) {
    return v.trim();
  }
  return fallback;
}

function cleanModel(v, fallback = null) {
  if (v === null) return null;
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return fallback;
}

function mergeDivision(def, custom) {
  if (!isPlainObj(custom)) return def;
  const id = typeof custom.id === 'string' && custom.id.trim() !== '' ? custom.id.trim() : def.id;
  const label = cleanName(custom.label, 40) ?? def.label;
  const match_types =
    Array.isArray(custom.match_types) && custom.match_types.some((s) => typeof s === 'string' && s.trim() !== '')
      ? custom.match_types.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
      : def.match_types;
  const match_keywords =
    Array.isArray(custom.match_keywords) && custom.match_keywords.some((s) => typeof s === 'string' && s.trim() !== '')
      ? custom.match_keywords.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().toLowerCase())
      : def.match_keywords;

  return {
    id,
    label,
    match_types,
    match_keywords,
  };
}

function parse(file) {
  if (!isFile(file)) return {};
  try {
    const c = JSON.parse(readText(file) ?? '');
    return isPlainObj(c) ? c : {};
  } catch {
    return {};
  }
}

const num = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const cleanPort = (v, d = 8788) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? v : d);

function mergeColors(defColors, customColors) {
  const def = isPlainObj(defColors) ? defColors : {};
  const custom = isPlainObj(customColors) ? customColors : {};
  const ketua =
    typeof custom.ketua === 'string' && custom.ketua.trim() !== ''
      ? custom.ketua.trim()
      : def.ketua;
  const defTeam = Array.isArray(def.team) ? def.team : [];
  const rawTeam = Array.isArray(custom.team) ? custom.team : [];
  const team = defTeam.map((dVal, i) =>
    typeof rawTeam[i] === 'string' && rawTeam[i].trim() !== '' ? rawTeam[i].trim() : dVal
  );
  const rawFl = Array.isArray(custom.freelancers)
    ? custom.freelancers.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
    : [];
  const freelancers =
    rawFl.length > 0 ? rawFl : Array.isArray(def.freelancers) ? [...def.freelancers] : [];
  return { ketua, team, freelancers };
}

export function loadDefaults(runtimeDir) {
  const defaultsFile = path.join(runtimeDir, 'defaults.json');
  const d = JSON.parse(readText(defaultsFile) ?? 'null');
  if (!isPlainObj(d)) throw new Error(`defaults.json tidak valid: ${defaultsFile}`);

  if (!Array.isArray(d.team) || d.team.length !== 4 || !d.team.every((m) => typeof m === 'string' && m.trim() !== '')) {
    throw new Error(`defaults.json tidak valid: team harus berupa array dengan tepat 4 nama string`);
  }

  if (
    !Array.isArray(d.divisions) ||
    d.divisions.length !== 4 ||
    !d.divisions.every(
      (div) =>
        isPlainObj(div) &&
        typeof div.id === 'string' &&
        div.id.trim() !== '' &&
        typeof div.label === 'string' &&
        div.label.trim() !== '' &&
        Array.isArray(div.match_types) &&
        div.match_types.every((t) => typeof t === 'string' && t.trim() !== '') &&
        Array.isArray(div.match_keywords) &&
        div.match_keywords.every((k) => typeof k === 'string' && k.trim() !== '')
    )
  ) {
    throw new Error(`defaults.json tidak valid: divisions harus berupa array dengan tepat 4 objek divisi lengkap`);
  }

  return d;
}

export function loadConfig(runtimeDir, projectDir, opts = {}) {
  const d = loadDefaults(runtimeDir);
  const c = parse(path.join(projectDir, CONFIG_REL));
  const n = isPlainObj(c.names) ? c.names : {};
  const team = values(n.team);

  const fl = [];
  for (const v of values(n.freelancers)) {
    const s = cleanName(v);
    if (s !== null && !fl.includes(s)) fl.push(s);
  }

  // Prioritas bind: CLI opts.bind > env KANTOR_BIND > config.bind > defaults.bind > "127.0.0.1"
  let bind = '127.0.0.1';
  if (typeof opts?.bind === 'string' && opts.bind.trim() !== '') {
    bind = opts.bind.trim();
  } else if (typeof process.env.KANTOR_BIND === 'string' && process.env.KANTOR_BIND.trim() !== '') {
    bind = process.env.KANTOR_BIND.trim();
  } else if (typeof c.bind === 'string' && c.bind.trim() !== '') {
    bind = c.bind.trim();
  } else if (typeof d.bind === 'string' && d.bind.trim() !== '') {
    bind = d.bind.trim();
  }

  const dc = isPlainObj(d.chat) ? d.chat : {};
  const cc = isPlainObj(c.chat) ? c.chat : {};

  // Prioritas sandbox: CLI opts.sandbox > env KANTOR_SANDBOX > config.chat.sandbox > defaults.chat.sandbox > false
  let sandbox = Boolean(dc.sandbox ?? false);
  if (typeof cc.sandbox === 'boolean') {
    sandbox = cc.sandbox;
  }
  const rawSandboxEnv = typeof process.env.KANTOR_SANDBOX === 'string' ? process.env.KANTOR_SANDBOX.trim() : '';
  if (rawSandboxEnv !== '') {
    sandbox = rawSandboxEnv === '1' || rawSandboxEnv.toLowerCase() === 'true';
  }
  if (opts?.sandbox !== undefined) {
    sandbox = Boolean(opts.sandbox);
  }

  const customDivisions = values(c.divisions);
  const divisions = d.divisions.map((def, i) => mergeDivision(def, customDivisions[i]));

  const defaultModeFallback = cleanMode(dc.default_mode, 'accept-edits');
  const defaultMode = cleanMode(cc.default_mode, defaultModeFallback);

  const defaultModelFallback = cleanModel(dc.default_model, null);
  const defaultModel = cleanModel(cc.default_model, defaultModelFallback);

  return {
    title: cleanName(c.title, 60) ?? (cleanName(path.basename(projectDir), 60) ?? 'Project'),
    ketua: cleanName(n.ketua) ?? d.ketua,
    ketua_role: cleanName(c.ketua_role ?? n.ketua_role) ?? (d.ketua_role ?? 'Lead Architect'),
    team: d.team.map((def, i) => cleanName(team[i]) ?? def),
    divisions,
    freelancers: fl.length ? fl : d.freelancers,
    colors: mergeColors(d.colors, c.colors),
    bind,
    port: cleanPort(c.port, cleanPort(d.port, 8788)),
    autostart: Boolean(c.autostart ?? d.autostart ?? false),
    window_days: num(c.window_days, num(d.window_days, 7)),
    running_window: num(c.running_window, num(d.running_window, 900)),
    main_active: num(c.main_active, num(d.main_active, 90)),
    cooldown: num(c.cooldown, num(d.cooldown, 60)),
    spare_desks: num(c.spare_desks, num(d.spare_desks, 4)),
    mains_max: num(c.mains_max, num(d.mains_max, 40)),
    chat: {
      enabled: typeof cc.enabled === 'boolean' ? cc.enabled : Boolean(dc.enabled ?? true),
      default_mode: defaultMode,
      default_model: defaultModel,
      sandbox,
    },
  };
}
