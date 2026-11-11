---
name: kantor-agent
description: >-
  Use when the user asks to launch, inspect, stop, or expose the Kantor Agent 3D
  monitoring office and interactive ACP Ketua chat for Antigravity, or install the
  4 specialist IT team subagent templates via setup-team.
---

# Kantor Agent (Antigravity Edition · Windows Native Node.js >= 22.5)

Buka kantor 3D Three.js real-time untuk memantau **Ketua (Joko)**, **4 divisi Tim IT spesialis** (**Budi**, **Sari**, **Agus**, **Rina**), **Freelancer**, papan **Tugas Ketua** (`task.md`), pratinjau **Artifact**, serta **Laci Chat Ketua (`C`)** berbasis **`agy acp --stdio`** langsung dari browser. Berjalan murni di **Node.js `>= 22.5`** tanpa WSL, `bash`, atau dependensi `npm` eksternal.

## 1. Pemasangan & Launcher CLI (`kantor.mjs`)

### Pemasangan Plugin Antigravity
Plugin dapat dipasang ke Antigravity dari repositori lokal:

```powershell
# Klona dan pasang plugin
git clone https://github.com/23Barajapu/kantor-agent.git
agy plugin install ./kantor-agent
```

### Menjalankan CLI Langsung
Dari direktori skill ini (atau resolusi path `SKILL_DIR` plugin):

```powershell
# 1. Periksa prasyarat lingkungan (Node >= 22.5, agy CLI, surface DB, templat tim)
node "${SKILL_DIR}/runtime/bin/kantor.mjs" detect

# 2. Pasang 4 templat subagent spesialis ke ~/.gemini/config/agents/ (opsional, idempoten)
node "${SKILL_DIR}/runtime/bin/kantor.mjs" setup-team

# 3. Mulai server kantor 3D + jembatan chat ACP (default bind 127.0.0.1, port 8788..8808)
node "${SKILL_DIR}/runtime/bin/kantor.mjs" start --project "<WORKSPACE_DIR>"
```

Bila memanggil dari root repositori plugin:

```powershell
node ./skills/kantor-agent/runtime/bin/kantor.mjs start --project .
```

### Subperintah Tersedia

| Perintah | Fungsi |
|---|---|
| `setup-team [--force]` | Menyalin 4 templat subagent (`frontend-ui-dev.md`, `backend-architect.md`, `qa-security-engineer.md`, `product-ops-researcher.md`) ke `~/.gemini/config/agents/` tanpa menimpa modifikasi pengguna kecuali `--force`. |
| `detect [--json]` | Memeriksa Node `>= 22.5`, `node:sqlite`, lokasi/versi `agy`, `cloudflared`, surface Antigravity (`antigravity`, `antigravity-ide`, `antigravity-cli`), dan status 4 templat Tim IT. |
| `start` | Memindai port bebas (`8788..8808`), menjalankan `serve.mjs` secara detached (`windowsHide: true`), menyimpan `server.json` di `<storageDir>`, dan mencetak URL `/kerja` secara idempoten. |
| `status [--json]` | Memeriksa PID, port, jumlah subagent/sesi aktif, serta URL lokal/publik. |
| `url` | Mencetak URL aktif (lokal atau `public_url` tunnel). |
| `token` | Mencetak `chat-token` 32-byte dari `<storageDir>/chat-token` untuk otorisasi akses non-loopback/LAN/tunnel. |
| `stop` / `restart` | Menghentikan server + tunnel terkait secara bersih, atau memuat ulang server. |
| `tunnel` / `tunnel-stop` | Membuka/menutup tunnel HTTPS sementara `trycloudflare.com` via `cloudflared` (`winget install Cloudflare.cloudflared` di Windows). |

Opsi umum: `--project <dir>`, `--storage <dir>`, `--bind <ip>`, `--port <n>`, `--sandbox`, `--force`, `--quiet`, `--json`.

## 2. Mode Spesialis Ketat & 4 Divisi Tim IT

- **Ketua · Joko (`Lead Architect`)**: Mengorkestrasi rencana, memelihara `task.md` (`- [ ]`, `- [/]`, `- [x]`) agar panel **Tugas Ketua** tetap sinkron, dan mendelegasikan subagent lewat `invoke_subagent`.
- **Meja 0 · Budi (`Frontend & UI`)** ← `TypeName: "frontend-ui-dev"`: UI/UX, desain sistem, animasi, aksesibilitas, mobile, `figma-*`, `canva-*`, `remotion-*`.
- **Meja 1 · Sari (`Backend & AI`)** ← `TypeName: "backend-architect"`: Arsitektur modul, API, domain, database/migrasi, performa, observabilitas, `gemini-*`, `google-antigravity-sdk`.
- **Meja 2 · Agus (`QA & Security`)** ← `TypeName: "qa-security-engineer"` / `"browser"`: TDD, debugging, Chrome DevTools, LCP, cookie/memory audit, OWASP/security review, verifikasi akhir.
- **Meja 3 · Rina (`Product & Ops`)** ← `TypeName: "product-ops-researcher"` / `"research"`: Brainstorming, spesifikasi/PRD, riset primer, ADR/dokumen, CI/CD, Git/PR/triage, Google Docs/Sheets/Slides.
- **Freelancer (Meja Cadangan)**: Menangani tugas paralel saat spesialis divisi target sedang bekerja/cooldown atau tugas tak terklasifikasi; **tidak pernah** meminjam meja divisi lain.

## 3. Konfigurasi Proyek (`.agents/kantor-agent.json`)

Opsional, letakkan di root proyek untuk menimpa bawaan `defaults.json`:

```json
{
  "title": "Nama Proyek",
  "port": 8788,
  "bind": "127.0.0.1",
  "autostart": false,
  "names": {
    "ketua": "Joko",
    "team": ["Budi", "Sari", "Agus", "Rina"],
    "freelancers": ["Yoga", "Dewi", "Rudi", "Maya"]
  },
  "chat": {
    "enabled": true,
    "default_mode": "accept-edits",
    "default_model": null,
    "sandbox": false
  }
}
```

## 4. Keamanan & Chat ACP Ketua

- Default server hanya mengikat **`127.0.0.1`**; akses loopback lokal otomatis terotentikasi.
- Untuk akses **LAN (`--bind 0.0.0.0`)** atau **tunnel publik (`tunnel`)**, autentikasi chat ACP mewajibkan **`chat-token`** (`timingSafeEqual` + cookie `HttpOnly; SameSite=Strict` + validasi `Host` & `Origin`). **Jangan bagikan atau commit `chat-token`**.
- **Aturan kerahasiaan token bagi agen:** Saat menjalankan `start` atau `tunnel`, **jangan menjalankan `kantor.mjs token` dan jangan membaca/menyalin nilai `chat-token` ke percakapan** kecuali diminta secara eksplisit oleh pengguna. Arahkan pengguna mengambil token langsung lewat perintah `node "${SKILL_DIR}/runtime/bin/kantor.mjs" token` atau membaca file `chat-token` di direktori storage yang tercetak.
- Di browser, tekan **`C`** untuk membuka laci **Chat Ketua** (pilih sesi CLI/ACP, mode `accept-edits`/`plan`/`auto`, pemilih model dinamis terintegrasi `agy models` dengan input model kustom cadangan, kartu izin interaktif 120 detik), tekan **`H`** untuk tampilan kantor penuh, dan klik tab **Artifact** untuk pratinjau teredaksi.
