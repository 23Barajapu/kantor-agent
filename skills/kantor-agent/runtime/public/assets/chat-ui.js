// Helper UI untuk Kantor Agent: perender Markdown aman (anti-XSS), koleksi & modal pratinjau artifact,
// serta laci Chat Ketua terhubung ke endpoint /kerja/api/chat/* dan SSE /kerja/api/chat/stream.

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const DEFAULT_COLORS = Object.freeze({
  ketua: '#6a55c9',
  team: ['#3f6fd1', '#2f9a6d', '#d9772f', '#c2417a'],
  freelancers: ['#0f8fa3', '#9a7418', '#4f7d3a', '#8a4fa8', '#3d7f9e', '#b8452f'],
});

export function normalizeColors(rawColors) {
  const src = rawColors && typeof rawColors === 'object' && !Array.isArray(rawColors) ? rawColors : {};
  const ketua =
    typeof src.ketua === 'string' && src.ketua.trim() !== ''
      ? src.ketua.trim()
      : DEFAULT_COLORS.ketua;

  const rawTeam = Array.isArray(src.team) ? src.team : [];
  const team = DEFAULT_COLORS.team.map((def, i) =>
    typeof rawTeam[i] === 'string' && rawTeam[i].trim() !== '' ? rawTeam[i].trim() : def
  );

  const rawFl = Array.isArray(src.freelancers)
    ? src.freelancers.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
    : [];
  const freelancers = rawFl.length > 0 ? rawFl : [...DEFAULT_COLORS.freelancers];

  return { ketua, team, freelancers };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

export function clip(s, n) {
  const arr = Array.from(String(s ?? ''));
  return arr.length > n ? `${arr.slice(0, Math.max(0, n - 1)).join('')}…` : arr.join('');
}

export function formatRoleModel(role, model, fallback = '') {
  const r = typeof role === 'string' ? role.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  const parts = [];
  if (r) parts.push(r);
  if (m) parts.push(m);
  const combined = parts.join(' · ') || fallback;
  return combined ? clip(combined, 26) : '';
}

export function formatModelOptionLabel(model) {
  if (!model) return '';
  const id = model.id ? String(model.id).trim() : '';
  const name = model.name ? String(model.name).trim() : '';
  if (!id) return name;
  if (!name || name === id) return id;
  return `${name} · ${id}`;
}

export function resolveModelSelectionState(statusModel, models = [], modelsFetched = false, userCustomSelected = false) {
  const normModel = statusModel ? String(statusModel).trim() : null;
  if (userCustomSelected) {
    return {
      selectValue: '__custom__',
      showCustom: true,
      customValue: normModel || '',
      tempOptionId: null,
    };
  }
  if (!normModel) {
    return {
      selectValue: '',
      showCustom: false,
      customValue: '',
      tempOptionId: null,
    };
  }
  const found = Array.isArray(models) && models.some((m) => m && m.id === normModel);
  if (found) {
    return {
      selectValue: normModel,
      showCustom: false,
      customValue: '',
      tempOptionId: null,
    };
  }
  if (!modelsFetched) {
    return {
      selectValue: normModel,
      showCustom: false,
      customValue: '',
      tempOptionId: normModel,
    };
  }
  return {
    selectValue: '__custom__',
    showCustom: true,
    customValue: normModel,
    tempOptionId: null,
  };
}

export function isSafeHref(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || /[\x00-\x1f\x7f\s]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function formatInlineEscaped(escapedText) {
  let out = escapedText;
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

function renderInlineSafe(rawLine) {
  const clean = String(rawLine ?? '').replace(/\0/g, '');
  const tokens = [];
  const restoreTokens = (str) => str.replace(/\0TK(\d+)\0/g, (_, i) => tokens[Number(i)] ?? '');

  let work = clean.replace(/`([^`]+)`/g, (_, code) => {
    const idx = tokens.length;
    tokens.push(`<code>${esc(code)}</code>`);
    return `\0TK${idx}\0`;
  });

  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, rawHref) => {
    const idx = tokens.length;
    const safeHref = isSafeHref(rawHref);
    const labelHtml = restoreTokens(formatInlineEscaped(esc(label)));
    if (safeHref) {
      tokens.push(`<a href="${esc(safeHref)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`);
    } else {
      tokens.push(labelHtml);
    }
    return `\0TK${idx}\0`;
  });

  const html = formatInlineEscaped(esc(work));
  return restoreTokens(html);
}

function renderMarkdownProse(blockText) {
  const lines = blockText.split('\n');
  const out = [];
  let listType = null;
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length > 0) {
      out.push(`<p>${paraLines.map(renderInlineSafe).join('<br>')}</p>`);
      paraLines = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushPara();
      closeList();
      const lvl = Math.min(4, headingMatch[1].length);
      out.push(`<h${lvl}>${renderInlineSafe(headingMatch[2])}</h${lvl}>`);
      continue;
    }

    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushPara();
      closeList();
      out.push(`<blockquote>${renderInlineSafe(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushPara();
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        out.push('<ul>');
      }
      out.push(`<li>${renderInlineSafe(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (olMatch) {
      flushPara();
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${renderInlineSafe(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    paraLines.push(line);
  }

  flushPara();
  closeList();
  return out.join('');
}

export function renderSafeMarkdown(md) {
  const normalized = String(md ?? '').replace(/\0/g, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';

  const parts = [];
  const fenceRe = /```([A-Za-z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match;
  while ((match = fenceRe.exec(normalized)) !== null) {
    if (match.index > lastIdx) {
      parts.push(renderMarkdownProse(normalized.slice(lastIdx, match.index)));
    }
    const lang = match[1] ? ` data-lang="${esc(match[1])}"` : '';
    parts.push(`<pre><code${lang}>${esc(match[2].replace(/\n$/, ''))}</code></pre>`);
    lastIdx = fenceRe.lastIndex;
  }
  if (lastIdx < normalized.length) {
    parts.push(renderMarkdownProse(normalized.slice(lastIdx)));
  }
  return parts.join('');
}

export function collectArtifacts(state) {
  if (!state || typeof state !== 'object') return [];
  const map = new Map();
  const addItems = (items, owner, division, color) => {
    if (!Array.isArray(items)) return;
    for (const art of items) {
      if (!art || typeof art.conv_id !== 'string' || typeof art.name !== 'string') continue;
      const key = `${art.conv_id}::${art.name}`;
      if (!map.has(key)) {
        map.set(key, {
          ...art,
          owner: owner || 'Agent',
          division: division || '',
          color: color || '#6a55c9',
        });
      }
    }
  };

  if (state.ketua) {
    addItems(state.ketua.artifacts, state.ketua.name, state.ketua.role || 'Lead Architect', state.ketua.color);
  }
  for (const r of state.runs || []) {
    addItems(r.artifacts, r.label || r.name, r.division || '', r.color);
  }
  for (const m of state.team || []) {
    if (m.run) addItems(m.run.artifacts, m.name, m.division || m.run.division || '', m.color);
  }
  for (const f of state.freelancers || []) {
    if (f.run) addItems(f.run.artifacts, f.label || f.name, f.run.division || '', f.color);
  }

  return Array.from(map.values()).sort((a, b) => {
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (tb !== ta) return tb - ta;
    return String(a.name).localeCompare(String(b.name));
  });
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export function createArtifactModal({ $, fmtDate, ago }) {
  const modal = $('artModal');
  const titleEl = $('artTitle');
  const metaEl = $('artMeta');
  const sumEl = $('artSummary');
  const copyBtn = $('artCopyPath');
  const closeBtn = $('artClose');
  const bodyEl = $('artBody');

  let prevFocus = null;
  let activeBlobUrl = null;
  let activeLocalPath = null;
  let activeSeq = 0;

  const revokeBlob = () => {
    if (activeBlobUrl) {
      URL.revokeObjectURL(activeBlobUrl);
      activeBlobUrl = null;
    }
  };

  const close = () => {
    if (modal.hidden) return;
    activeSeq += 1;
    revokeBlob();
    activeLocalPath = null;
    copyBtn.hidden = true;
    modal.hidden = true;
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch {}
    }
    prevFocus = null;
  };

  const open = async ({ convId, file, owner = '', division = '', summary = '', updatedAt = '' }) => {
    if (!convId || !file) return;
    const mySeq = ++activeSeq;
    prevFocus = document.activeElement;
    revokeBlob();
    activeLocalPath = null;
    copyBtn.hidden = true;
    copyBtn.textContent = 'Salin path';

    titleEl.textContent = file;
    const metaParts = [];
    if (owner) metaParts.push(owner);
    if (division) metaParts.push(division);
    if (updatedAt) metaParts.push(`${fmtDate.format(new Date(updatedAt))} (${ago(updatedAt)})`);
    metaEl.textContent = metaParts.join(' · ');

    if (summary) {
      sumEl.textContent = summary;
      sumEl.hidden = false;
    } else {
      sumEl.textContent = '';
      sumEl.hidden = true;
    }

    bodyEl.innerHTML = '<div class="empty">Memuat pratinjau artifact…</div>';
    modal.hidden = false;
    closeBtn.focus();

    const url = `/kerja/api/artifact?conv=${encodeURIComponent(convId)}&file=${encodeURIComponent(file)}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (mySeq !== activeSeq) return;
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(errJson?.error || `Gagal memuat artifact (HTTP ${res.status})`);
      }

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.startsWith('image/')) {
        const blob = await res.blob();
        if (mySeq !== activeSeq) return;
        activeBlobUrl = URL.createObjectURL(blob);
        bodyEl.innerHTML = `<img class="art-img" src="${esc(activeBlobUrl)}" alt="${esc(file)}">`;
        return;
      }

      if (ct.startsWith('application/pdf')) {
        const baseName = file.split('/').pop() || 'artifact.pdf';
        bodyEl.innerHTML = `<div class="art-pdf-card"><div><strong>Dokumen PDF</strong><div class="modal-meta">${esc(file)}</div></div><div class="art-pdf-actions"><a class="modal-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Buka PDF</a><a class="modal-btn" href="${esc(url)}" download="${esc(baseName)}">Unduh</a></div></div>`;
        return;
      }

      const data = await res.json();
      if (mySeq !== activeSeq) return;

      titleEl.textContent = data.name || file;
      const updatedStr = data.updated_at ? `${fmtDate.format(new Date(data.updated_at))} (${ago(data.updated_at)})` : '';
      const freshMeta = [owner, division, updatedStr].filter(Boolean).join(' · ');
      if (freshMeta) metaEl.textContent = freshMeta;

      if (data.summary) {
        sumEl.textContent = data.summary;
        sumEl.hidden = false;
      }

      if (typeof data.local_path === 'string' && data.local_path.length > 0) {
        activeLocalPath = data.local_path;
        copyBtn.hidden = false;
      }

      const ext = file.toLowerCase().split('.').pop();
      const rawContent = String(data.content ?? '');
      if (ext === 'json') {
        let pretty = rawContent;
        try {
          pretty = JSON.stringify(JSON.parse(rawContent), null, 2);
        } catch {}
        bodyEl.innerHTML = `<pre class="art-pre">${esc(pretty)}</pre>`;
      } else if (ext === 'txt') {
        bodyEl.innerHTML = `<pre class="art-pre">${esc(rawContent)}</pre>`;
      } else {
        bodyEl.innerHTML = `<div class="art-md">${renderSafeMarkdown(rawContent) || '<div class="empty">Berkas kosong.</div>'}</div>`;
      }
    } catch (err) {
      if (mySeq !== activeSeq) return;
      bodyEl.innerHTML = `<div class="art-error">${esc(err?.message || 'Gagal membuka artifact')}</div>`;
    }
  };

  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) close();
  });
  copyBtn.addEventListener('click', async () => {
    if (!activeLocalPath) return;
    try {
      await copyText(activeLocalPath);
      copyBtn.textContent = 'Tersalin!';
      setTimeout(() => {
        if (!modal.hidden) copyBtn.textContent = 'Salin path';
      }, 1800);
    } catch {
      copyBtn.textContent = 'Gagal salin';
    }
  });

  return {
    open,
    close,
    isOpen: () => !modal.hidden,
  };
}

export function filterDisplayHistory(rawHistory) {
  return Array.isArray(rawHistory)
    ? rawHistory.filter((h) => !(h?.type === 'permission' && h?.status === 'pending'))
    : [];
}

export function appendUniqueEntry(list, entry) {
  if (!Array.isArray(list) || !entry || typeof entry !== 'object') return false;
  if (entry.id && list.some((m) => m?.id === entry.id)) return false;
  list.push(entry);
  return true;
}

export async function handleStreamErrorEvent(ev, { onServerError, onDisconnect } = {}) {
  if (typeof ev?.data === 'string' && ev.data.trim() !== '') {
    let data = null;
    try {
      data = JSON.parse(ev.data);
    } catch {}
    if (typeof onServerError === 'function') {
      onServerError(data, ev.data);
    }
    return 'server_error';
  }
  if (typeof onDisconnect === 'function') {
    await onDisconnect(ev);
  }
  return 'disconnect';
}

export function createChatDrawer({ $, cfg, ketuaName, ago, clip: clipFn }) {
  const drawer = $('chatDrawer');
  const toggleBtn = $('toggleChat');
  const topDot = $('chatTopDot');
  const topPermPill = $('chatTopPerm');
  const titleEl = $('chatTitle');
  const sandboxBadge = $('chatSandboxBadge');
  const connChip = $('chatConnChip');
  const connText = $('chatConnText');
  const closeBtn = $('chatClose');

  const sessionSelect = $('chatSessionSelect');
  const sessionBtn = $('chatSessionBtn');
  const modeSelect = $('chatModeSelect');
  const modelSelect = $('chatModelSelect');
  const customModelRow = $('chatCustomModelRow');
  const modelCustomInput = $('chatModelCustom');

  const authBox = $('chatAuthBox');
  const authForm = $('chatAuthForm');
  const authMsg = $('chatAuthMsg');
  const tokenInput = $('chatTokenInput');

  const noticeEl = $('chatNotice');
  const msgsEl = $('chatMessages');
  const permsEl = $('chatPerms');

  const formEl = $('chatForm');
  const inputEl = $('chatInput');
  const sendBtn = $('chatSendBtn');
  const cancelBtn = $('chatCancelBtn');

  titleEl.textContent = `Chat Ketua · ${ketuaName}`;

  let enabled = cfg?.chat?.enabled !== false;
  let authorized = false;
  let needsAuth = false;
  let es = null;
  let reconnectTimer = null;
  let backoffMs = 1000;
  let seq = 0;
  let prevFocus = null;
  let permCountdownTimer = null;

  let status = {
    connected: false,
    busy: false,
    sessionId: null,
    mode: cfg?.chat?.default_mode || 'accept-edits',
    model: cfg?.chat?.default_model ?? null,
    sandbox: Boolean(cfg?.chat?.sandbox),
    pendingPermissionCount: 0,
    lastError: null,
  };
  let sessionsList = [];
  let lastSessionsSig = '';
  let modelsList = [];
  let modelsFetched = false;
  let modelsFetching = false;
  let customMode = false;
  let lastModelsSig = '';
  let messages = [];
  const pendingPerms = new Map();

  const setNotice = (msg, kind = 'error') => {
    if (!msg) {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
      return;
    }
    noticeEl.textContent = msg;
    noticeEl.className = `chat-notice${kind === 'info' ? ' info' : ''}`;
    noticeEl.hidden = false;
  };

  const syncModelOptions = (tempOptionId = null) => {
    if (!modelSelect) return;
    const sig = JSON.stringify([modelsList.map((m) => [m.id, m.name]), tempOptionId]);
    if (sig === lastModelsSig) return;
    lastModelsSig = sig;

    const prevVal = modelSelect.value;
    modelSelect.innerHTML = '';

    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Default (ikuti CLI)';
    modelSelect.appendChild(defOpt);

    for (const m of modelsList) {
      if (!m || !m.id) continue;
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = formatModelOptionLabel(m);
      modelSelect.appendChild(opt);
    }

    if (tempOptionId && !modelsList.some((m) => m && m.id === tempOptionId)) {
      const tempOpt = document.createElement('option');
      tempOpt.value = tempOptionId;
      tempOpt.textContent = tempOptionId;
      modelSelect.appendChild(tempOpt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Model custom\u2026';
    modelSelect.appendChild(customOpt);

    if (prevVal) {
      modelSelect.value = prevVal;
    }
  };

  const loadModels = async ({ force = false } = {}) => {
    if (modelsFetching) return;
    if (modelsFetched && !force && modelsList.length > 0) return;
    modelsFetching = true;
    try {
      const url = force ? '/kerja/api/chat/models?refresh=1' : '/kerja/api/chat/models';
      const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && Array.isArray(data.models)) {
          modelsList = data.models;
          modelsFetched = true;
        }
        if (data?.degraded && data?.error && modelsList.length === 0) {
          setNotice(data.error, 'info');
        } else if (!data?.degraded && modelsList.length > 0 && noticeEl.classList.contains('info')) {
          setNotice('');
        }
      }
    } catch {
      // Degraded / network error silently handled
    } finally {
      modelsFetching = false;
      renderStatus();
    }
  };

  const syncControlsDisabled = () => {
    const off = !enabled || needsAuth;
    sessionSelect.disabled = off || status.busy;
    sessionBtn.disabled = off || status.busy;
    modeSelect.disabled = off || status.busy;
    if (modelSelect) modelSelect.disabled = off || status.busy;
    if (modelCustomInput) modelCustomInput.disabled = off || status.busy;
    inputEl.disabled = !enabled || needsAuth;
    sendBtn.disabled = off || status.busy || inputEl.value.trim() === '';
    cancelBtn.hidden = !status.busy;
    cancelBtn.disabled = !enabled || needsAuth || !status.busy;
  };

  const renderStatus = () => {
    sandboxBadge.hidden = !status.sandbox;
    if (!enabled) {
      connChip.style.color = '#8a8378';
      connText.textContent = 'Nonaktif';
      topDot.className = 'dot off';
      setNotice('Chat Ketua dinonaktifkan oleh konfigurasi server.', 'info');
    } else if (needsAuth && !authorized) {
      connChip.style.color = '#c46a1c';
      connText.textContent = 'Perlu token';
      topDot.className = 'dot off';
    } else if (status.busy) {
      connChip.style.color = '#d9772f';
      connText.textContent = 'Memproses…';
      topDot.className = 'dot busy';
    } else if (status.connected) {
      connChip.style.color = '#1f9d57';
      connText.textContent = 'Terhubung';
      topDot.className = 'dot';
    } else if (authorized) {
      connChip.style.color = '#0f7f8f';
      connText.textContent = 'Siap (ACP)';
      topDot.className = 'dot';
    } else {
      connChip.style.color = '#8a8378';
      connText.textContent = 'Menghubungkan';
      topDot.className = 'dot off';
    }

    if (modeSelect.value !== status.mode && ['accept-edits', 'plan', 'auto'].includes(status.mode)) {
      modeSelect.value = status.mode;
    }

    if (modelSelect && modelSelect.value === '__custom__') {
      // Pertahankan customMode saat pengguna sedang mengisi input model custom
    } else if (status.model && Array.isArray(modelsList) && modelsList.some((m) => m && m.id === status.model)) {
      customMode = false;
    } else if (!status.model) {
      customMode = false;
    }

    const resolved = resolveModelSelectionState(status.model, modelsList, modelsFetched, customMode);
    if (resolved.showCustom) {
      customMode = true;
    }
    syncModelOptions(resolved.tempOptionId);
    if (modelSelect && document.activeElement !== modelSelect) {
      modelSelect.value = resolved.selectValue;
    }
    if (customModelRow) {
      customModelRow.hidden = !resolved.showCustom;
    }
    if (modelCustomInput && resolved.showCustom && document.activeElement !== modelCustomInput) {
      modelCustomInput.value = resolved.customValue || '';
    }

    const pCount = pendingPerms.size || Number(status.pendingPermissionCount) || 0;
    topPermPill.hidden = pCount <= 0;
    topPermPill.textContent = String(pCount);

    syncControlsDisabled();
  };

  const renderSessionOptions = () => {
    const sig = JSON.stringify([status.sessionId, sessionsList.map((s) => [s.id, s.title, s.updated, s.status])]);
    if (sig === lastSessionsSig) {
      sessionBtn.textContent = sessionSelect.value === '__new__' ? 'Baru' : 'Muat';
      return;
    }
    lastSessionsSig = sig;
    const prevVal = sessionSelect.value;
    const opts = ['<option value="__new__">Sesi Baru (ACP)</option>'];
    const seen = new Set();
    for (const s of sessionsList) {
      if (!s?.id || seen.has(s.id)) continue;
      seen.add(s.id);
      const label = `${clipFn(s.title || s.id.slice(0, 8), 32)}${s.updated ? ` · ${ago(s.updated)}` : ''}`;
      opts.push(`<option value="${esc(s.id)}">${esc(label)}</option>`);
    }
    if (status.sessionId && !seen.has(status.sessionId)) {
      opts.push(`<option value="${esc(status.sessionId)}">${esc(`Sesi aktif (${status.sessionId.slice(0, 8)})`)}</option>`);
    }
    sessionSelect.innerHTML = opts.join('');
    if (status.sessionId && (seen.has(status.sessionId) || status.sessionId)) {
      sessionSelect.value = status.sessionId;
    } else if (prevVal && (prevVal === '__new__' || seen.has(prevVal))) {
      sessionSelect.value = prevVal;
    }
    sessionBtn.textContent = sessionSelect.value === '__new__' ? 'Baru' : 'Muat';
  };

  const renderMessages = () => {
    if (!messages.length) {
      msgsEl.innerHTML = `<div class="empty">Mulai percakapan dengan ${esc(ketuaName)} atau muat sesi CLI yang ada.</div>`;
      return;
    }
    const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 64;
    msgsEl.innerHTML = messages.map((m) => {
      if (m.type === 'message') {
        if (m.role === 'user') {
          return `<div class="chat-msg user">${esc(m.text)}</div>`;
        }
        const cls = `chat-msg assistant${m._streaming ? ' streaming' : ''}`;
        return `<div class="${cls}">${renderSafeMarkdown(m.text) || esc(m.text)}</div>`;
      }
      if (m.type === 'tool') {
        const label = m.title || m.kind || 'Alat';
        const st = m.status ? ` · ${m.status}` : '';
        return `<div class="chat-tool">⚙ ${esc(label)}${esc(st)}</div>`;
      }
      if (m.type === 'session') {
        const act = m.action === 'load' ? 'Sesi dimuat' : 'Sesi baru';
        const sid = m.sessionId ? ` (${m.sessionId.slice(0, 8)})` : '';
        return `<div class="chat-sys">${esc(act + sid)}</div>`;
      }
      if (m.type === 'error') {
        return `<div class="chat-err-item">${esc(m.error || 'Kesalahan chat')}</div>`;
      }
      if (m.type === 'notice') {
        return `<div class="chat-sys">${esc(m.text)}</div>`;
      }
      return '';
    }).join('');
    if (nearBottom || status.busy) {
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  };

  const normalizePermOptions = (perm) => {
    const raw = Array.isArray(perm?.options) && perm.options.length ? perm.options : [
      { optionId: 'allow_once', name: 'Izinkan Sekali' },
      { optionId: 'allow_always', name: 'Selalu Izinkan' },
      { optionId: 'reject', name: 'Tolak' },
    ];
    const labelMap = {
      allow_once: 'Izinkan Sekali',
      allow_always: 'Selalu Izinkan',
      reject: 'Tolak',
    };
    return raw.map((o) => ({
      optionId: String(o.optionId || ''),
      label: labelMap[o.optionId] || o.name || o.optionId,
      cls: o.optionId === 'reject' || o.kind?.startsWith('reject') ? 'danger' : o.optionId === 'allow_once' ? 'primary' : '',
    })).filter((o) => o.optionId);
  };

  const renderPermissions = () => {
    if (permCountdownTimer) {
      clearInterval(permCountdownTimer);
      permCountdownTimer = null;
    }
    if (pendingPerms.size === 0) {
      permsEl.hidden = true;
      permsEl.innerHTML = '';
      renderStatus();
      return;
    }
    permsEl.hidden = false;
    permsEl.innerHTML = Array.from(pendingPerms.values()).map((p) => {
      const title = p.toolCall?.title || p.toolCall?.kind || 'Permintaan izin alat';
      const remSec = p.expiresAt ? Math.max(0, Math.ceil((Date.parse(p.expiresAt) - Date.now()) / 1000)) : null;
      const btns = normalizePermOptions(p).map((opt) =>
        `<button type="button" class="chat-btn ${opt.cls}" data-perm-req="${esc(p.requestId)}" data-perm-opt="${esc(opt.optionId)}">${esc(opt.label)}</button>`
      ).join('');
      return `<div class="perm-card"><div class="perm-head"><span>Izin: ${esc(title)}</span>${remSec !== null ? `<span class="perm-ttl" data-exp="${esc(p.expiresAt)}">${remSec} dtk</span>` : ''}</div><div class="perm-actions">${btns}</div></div>`;
    }).join('');
    permCountdownTimer = setInterval(() => {
      if (pendingPerms.size === 0) {
        clearInterval(permCountdownTimer);
        permCountdownTimer = null;
        return;
      }
      permsEl.querySelectorAll('.perm-ttl[data-exp]').forEach((el) => {
        const rem = Math.max(0, Math.ceil((Date.parse(el.dataset.exp) - Date.now()) / 1000));
        el.textContent = `${rem} dtk`;
      });
    }, 1000);
    renderStatus();
  };

  const finalizeStreaming = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]._streaming) messages[i]._streaming = false;
    }
  };

  const parseJsonEvent = (ev) => {
    try { return JSON.parse(ev.data); } catch { return null; }
  };

  const closeStream = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
  };

  const scheduleReconnect = () => {
    if (!enabled || !authorized || reconnectTimer) return;
    const wait = backoffMs;
    backoffMs = Math.min(10000, backoffMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, wait);
  };

  const connectStream = () => {
    if (!enabled || !authorized) return;
    closeStream();
    let streamOpened = false;
    const stream = new EventSource('/kerja/api/chat/stream');
    es = stream;

    stream.addEventListener('init', (ev) => {
      streamOpened = true;
      backoffMs = 1000;
      const data = parseJsonEvent(ev);
      if (!data) return;
      if (data.status) status = { ...status, ...data.status };
      messages = filterDisplayHistory(data.history);
      pendingPerms.clear();
      for (const p of data.pendingPermissions || []) {
        if (p?.requestId) pendingPerms.set(String(p.requestId), p);
      }
      status.pendingPermissionCount = pendingPerms.size;
      setNotice('');
      renderSessionOptions();
      renderMessages();
      renderPermissions();
    });

    stream.addEventListener('status', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data) return;
      status = { ...status, ...data };
      if (!status.busy) finalizeStreaming();
      renderSessionOptions();
      renderStatus();
    });

    stream.addEventListener('session', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data) return;
      const entryId = data.id || `s-${++seq}`;
      appendUniqueEntry(messages, { ...data, id: entryId, type: 'session' });
      if (data.sessionId) status.sessionId = data.sessionId;
      if (data.mode) status.mode = data.mode;
      if ('model' in data) status.model = data.model;
      renderSessionOptions();
      renderMessages();
      renderStatus();
      if (modelsList.length === 0) {
        loadModels();
      }
    });

    stream.addEventListener('message', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data) return;
      if (appendUniqueEntry(messages, data)) {
        renderMessages();
      }
    });

    const onUpdate = (ev) => {
      const data = parseJsonEvent(ev);
      if (!data) return;
      const kind = data.kind || 'update';
      const u = data.update || {};
      if (kind === 'agent_message_chunk' || kind === 'agent_message') {
        if (data.text) {
          const last = messages[messages.length - 1];
          if (last && last.type === 'message' && last.role === 'assistant' && last.sessionId === data.sessionId && last._streaming) {
            last.text += data.text;
          } else {
            messages.push({
              id: `st-${++seq}`,
              type: 'message',
              role: 'assistant',
              text: data.text,
              sessionId: data.sessionId,
              ts: data.ts,
              _streaming: true,
            });
          }
          renderMessages();
        }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        finalizeStreaming();
        messages.push({
          id: `tl-${++seq}`,
          type: 'tool',
          toolCallId: u.toolCallId ?? null,
          title: u.title || '',
          kind: u.kind || kind,
          status: u.status || '',
          text: data.text || '',
          sessionId: data.sessionId,
        });
        renderMessages();
      } else if (kind === 'current_mode_update' && typeof u.currentModeId === 'string') {
        status.mode = u.currentModeId;
        renderStatus();
      }
    };
    stream.addEventListener('session_update', onUpdate);
    stream.addEventListener('update', onUpdate);

    stream.addEventListener('permission_request', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data?.requestId) return;
      pendingPerms.set(String(data.requestId), data);
      status.pendingPermissionCount = pendingPerms.size;
      renderPermissions();
    });

    stream.addEventListener('permission_resolved', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data?.requestId) return;
      pendingPerms.delete(String(data.requestId));
      status.pendingPermissionCount = pendingPerms.size;
      renderPermissions();
    });

    stream.addEventListener('permission_timeout', (ev) => {
      const data = parseJsonEvent(ev);
      if (!data?.requestId) return;
      pendingPerms.delete(String(data.requestId));
      status.pendingPermissionCount = pendingPerms.size;
      messages.push({ id: `pt-${++seq}`, type: 'notice', text: 'Permintaan izin kedaluwarsa.' });
      renderMessages();
      renderPermissions();
    });

    stream.addEventListener('turn_done', (ev) => {
      const data = parseJsonEvent(ev);
      finalizeStreaming();
      if (data?.status) status = { ...status, ...data.status };
      else status.busy = false;
      renderMessages();
      renderStatus();
    });

    stream.addEventListener('turn_error', (ev) => {
      const data = parseJsonEvent(ev);
      finalizeStreaming();
      if (data?.status) status = { ...status, ...data.status };
      else status.busy = false;
      const errText = data?.error || 'Giliran chat gagal';
      messages.push({ id: `te-${++seq}`, type: 'error', error: errText });
      setNotice(errText);
      renderMessages();
      renderStatus();
    });

    stream.addEventListener('turn_cancelled', (ev) => {
      const data = parseJsonEvent(ev);
      finalizeStreaming();
      if (data?.status) status = { ...status, ...data.status };
      else status.busy = false;
      messages.push({ id: `tc-${++seq}`, type: 'notice', text: 'Giliran dibatalkan.' });
      renderMessages();
      renderStatus();
    });

    stream.addEventListener('error', (ev) =>
      handleStreamErrorEvent(ev, {
        onServerError: (data) => {
          if (data?.error) setNotice(data.error);
        },
        onDisconnect: async () => {
          if (es !== stream) return;
          closeStream();
          if (!streamOpened) {
            try {
              const probe = await fetch('/kerja/api/chat/auth', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              if (probe.status === 401) {
                authorized = false;
                needsAuth = true;
                authBox.hidden = false;
                authMsg.textContent = 'Sesi auth chat berakhir. Masukkan chat-token.';
                renderStatus();
                return;
              }
              if (probe.status === 503) {
                enabled = false;
                renderStatus();
                return;
              }
            } catch {}
          }
          setNotice('Koneksi stream chat terputus, mencoba menghubungkan ulang…', 'info');
          scheduleReconnect();
        },
      })
    );
  };

  const apiPost = async (endpoint, payload = {}) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      authorized = false;
      needsAuth = true;
      closeStream();
      authBox.hidden = false;
      authMsg.textContent = data.error || 'Autentikasi chat diperlukan. Masukkan chat-token.';
      renderStatus();
      throw new Error(data.error || 'Token chat diperlukan');
    }
    if (!res.ok) {
      throw new Error(data.error || `Permintaan gagal (HTTP ${res.status})`);
    }
    return data;
  };

  const bootstrapAuth = async (manualToken = null) => {
    if (!enabled) {
      renderStatus();
      return false;
    }
    let token = manualToken;
    if (token === null) {
      const url = new URL(window.location.href);
      const qTok = url.searchParams.get('token');
      if (qTok) {
        token = qTok;
        url.searchParams.delete('token');
        history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''));
      }
    }

    try {
      const res = await fetch('/kerja/api/chat/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { token } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        enabled = false;
        renderStatus();
        return false;
      }
      if (res.status === 401) {
        authorized = false;
        needsAuth = true;
        authBox.hidden = false;
        authMsg.textContent = token
          ? (data.error || 'Token tidak valid. Periksa chat-token di terminal server.')
          : 'Masukkan token chat dari output terminal server.';
        renderStatus();
        return false;
      }
      if (!res.ok) {
        setNotice(data.error || `Gagal autentikasi (${res.status})`);
        return false;
      }
      authorized = true;
      needsAuth = false;
      authBox.hidden = true;
      tokenInput.value = '';
      setNotice('');
      renderStatus();
      connectStream();
      loadModels();
      return true;
    } catch (err) {
      setNotice(err?.message || 'Gagal menghubungi endpoint auth chat');
      return false;
    }
  };

  const currentModelValue = () => {
    if (customMode || (modelSelect && modelSelect.value === '__custom__')) {
      const raw = modelCustomInput ? modelCustomInput.value.trim() : '';
      return raw || null;
    }
    const val = modelSelect ? modelSelect.value.trim() : '';
    if (!val || val.toLowerCase() === 'default') return null;
    return val;
  };

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tok = tokenInput.value.trim();
    if (!tok) return;
    await bootstrapAuth(tok);
  });

  sessionSelect.addEventListener('change', () => {
    sessionBtn.textContent = sessionSelect.value === '__new__' ? 'Baru' : 'Muat';
  });

  sessionBtn.addEventListener('click', async () => {
    setNotice('');
    try {
      const val = sessionSelect.value;
      const body = val === '__new__'
        ? { action: 'new', mode: modeSelect.value, model: currentModelValue() }
        : { sessionId: val, mode: modeSelect.value, model: currentModelValue() };
      const data = await apiPost('/kerja/api/chat/session', body);
      if (data.status) status = { ...status, ...data.status };
      if (Array.isArray(data.history)) messages = filterDisplayHistory(data.history);
      renderSessionOptions();
      renderMessages();
      renderStatus();
    } catch (err) {
      setNotice(err.message);
    }
  });

  const applyModeOrModelIfActive = async () => {
    const nextMode = modeSelect.value;
    const nextModel = currentModelValue();
    status.mode = nextMode;
    status.model = nextModel;
    if (!status.sessionId || !authorized) return;
    setNotice('');
    try {
      const data = await apiPost('/kerja/api/chat/session', { mode: nextMode, model: nextModel });
      if (data.status) status = { ...status, ...data.status };
      renderStatus();
    } catch (err) {
      setNotice(err.message);
    }
  };

  modeSelect.addEventListener('change', applyModeOrModelIfActive);
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      if (modelSelect.value === '__custom__') {
        customMode = true;
        if (customModelRow) customModelRow.hidden = false;
        if (modelCustomInput) {
          modelCustomInput.focus();
        }
        syncControlsDisabled();
      } else {
        customMode = false;
        if (customModelRow) customModelRow.hidden = true;
        applyModeOrModelIfActive();
      }
    });
  }
  if (modelCustomInput) {
    modelCustomInput.addEventListener('change', () => {
      const off = !enabled || needsAuth;
      if (!off && !status.busy) {
        applyModeOrModelIfActive();
      }
    });
    modelCustomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const off = !enabled || needsAuth;
        if (!off && !status.busy) {
          applyModeOrModelIfActive();
        }
      }
    });
  }

  inputEl.addEventListener('input', syncControlsDisabled);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || !enabled || needsAuth || status.busy) return;
    setNotice('');
    try {
      inputEl.value = '';
      syncControlsDisabled();
      const data = await apiPost('/kerja/api/chat/send', {
        text,
        mode: modeSelect.value,
        model: currentModelValue(),
      });
      if (data.status) status = { ...status, ...data.status };
      else status.busy = true;
      renderStatus();
    } catch (err) {
      inputEl.value = text;
      setNotice(err.message);
      syncControlsDisabled();
    }
  });

  cancelBtn.addEventListener('click', async () => {
    setNotice('');
    try {
      await apiPost('/kerja/api/chat/cancel', {});
    } catch (err) {
      setNotice(err.message);
    }
  });

  permsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-perm-req]');
    if (!btn) return;
    const requestId = btn.dataset.permReq;
    const optionId = btn.dataset.permOpt;
    const card = btn.closest('.perm-card');
    card?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await apiPost('/kerja/api/chat/permission', { requestId, optionId });
      pendingPerms.delete(requestId);
      status.pendingPermissionCount = pendingPerms.size;
      renderPermissions();
    } catch (err) {
      card?.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      setNotice(err.message);
    }
  });

  const open = () => {
    if (!drawer.hidden) return;
    prevFocus = document.activeElement;
    drawer.hidden = false;
    toggleBtn.setAttribute('aria-expanded', 'true');
    if (enabled && !authorized && !needsAuth) {
      bootstrapAuth();
    } else if (authorized && (!modelsFetched || modelsList.length === 0)) {
      loadModels();
    }
    if (needsAuth && !authBox.hidden) tokenInput.focus();
    else inputEl.focus();
  };

  const close = () => {
    if (drawer.hidden) return;
    drawer.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'false');
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch {}
    }
    prevFocus = null;
  };

  const toggle = (force) => {
    const next = typeof force === 'boolean' ? force : drawer.hidden;
    if (next) open();
    else close();
  };

  toggleBtn.addEventListener('click', () => toggle());
  closeBtn.addEventListener('click', close);

  const syncState = (state) => {
    const c = state?.chat;
    if (!c) return;
    const prevEnabled = enabled;
    enabled = c.enabled !== false;
    status.sandbox = Boolean(c.sandbox);
    if (!es || !authorized) {
      status.connected = Boolean(c.connected);
      status.busy = Boolean(c.busy);
      status.sessionId = c.session_id ?? status.sessionId;
      if (c.mode) status.mode = c.mode;
      if ('model' in c && c.model !== undefined) status.model = c.model;
      status.pendingPermissionCount = Number(c.pending_permission_count) || 0;
    }
    sessionsList = Array.isArray(c.sessions) ? c.sessions : [];
    renderSessionOptions();
    renderStatus();
    if (!prevEnabled && enabled && !authorized) {
      bootstrapAuth();
    } else if (!enabled) {
      closeStream();
    }
  };

  renderMessages();
  renderSessionOptions();
  renderStatus();

  return {
    init: () => bootstrapAuth(),
    syncState,
    open,
    close,
    toggle,
    isOpen: () => !drawer.hidden,
  };
}
