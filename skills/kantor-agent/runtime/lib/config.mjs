import path from 'node:path';
import { isFile, isPlainObj, phpTrim, readText, values } from './util.mjs';

export const CONFIG_REL = '.agents/kantor-agent.json';

// nama tampilan: string, tanpa karakter kontrol, maks 20 titik kode; selain itu null
export function cleanName(v, max = 20) {
  if (typeof v !== 'string') return null;
  const s = phpTrim(v.replace(/[\x00-\x1f\x7f]+/g, ' '));
  if (s === '') return null;
  return Array.from(s).slice(0, max).join('');
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

export function loadDefaults(runtimeDir) {
  const defaultsFile = path.join(runtimeDir, 'defaults.json');
  const d = JSON.parse(readText(defaultsFile) ?? 'null');
  if (!isPlainObj(d)) throw new Error(`defaults.json tidak valid: ${defaultsFile}`);
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

  // Prioritas sandbox: CLI opts.sandbox > env KANTOR_SANDBOX > config.chat.sandbox > defaults.chat.sandbox > false
  let sandbox = Boolean(d.chat?.sandbox ?? false);
  if (opts?.sandbox !== undefined) {
    sandbox = Boolean(opts.sandbox);
  } else if (process.env.KANTOR_SANDBOX !== undefined) {
    sandbox = process.env.KANTOR_SANDBOX === '1' || process.env.KANTOR_SANDBOX === 'true';
  } else if (typeof c.chat?.sandbox === 'boolean') {
    sandbox = c.chat.sandbox;
  }

  const dc = isPlainObj(d.chat) ? d.chat : {};
  const cc = isPlainObj(c.chat) ? c.chat : {};

  return {
    title: cleanName(c.title, 60) ?? (cleanName(path.basename(projectDir), 60) ?? 'Project'),
    ketua: cleanName(n.ketua) ?? d.ketua,
    ketua_role: cleanName(c.ketua_role ?? n.ketua_role) ?? (d.ketua_role ?? 'Lead Architect'),
    team: d.team.map((def, i) => cleanName(team[i]) ?? def),
    divisions: Array.isArray(c.divisions) && c.divisions.length > 0 ? c.divisions : d.divisions,
    freelancers: fl.length ? fl : d.freelancers,
    colors: isPlainObj(c.colors) ? c.colors : d.colors,
    bind,
    port: num(c.port, 8788),
    autostart: Boolean(c.autostart ?? d.autostart ?? false),
    window_days: num(c.window_days, num(d.window_days, 7)),
    running_window: num(c.running_window, num(d.running_window, 900)),
    main_active: num(c.main_active, num(d.main_active, 90)),
    cooldown: num(c.cooldown, num(d.cooldown, 60)),
    spare_desks: num(c.spare_desks, num(d.spare_desks, 4)),
    mains_max: num(c.mains_max, num(d.mains_max, 40)),
    chat: {
      enabled: typeof cc.enabled === 'boolean' ? cc.enabled : Boolean(dc.enabled ?? true),
      default_mode: typeof cc.default_mode === 'string' ? cc.default_mode : (dc.default_mode ?? 'accept-edits'),
      default_model: cc.default_model !== undefined ? cc.default_model : (dc.default_model ?? null),
      sandbox,
    },
  };
}
