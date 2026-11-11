# Kantor Agent untuk Antigravity

Pemantau kantor 3D *real-time* (Three.js r170) dan jembatan **Chat Ketua interaktif** (`agy acp --stdio`) untuk **Google Antigravity** (2.0 / IDE / CLI) — berjalan **native di Windows** (serta macOS/Linux) menggunakan satu runtime **Node.js `>= 22.5`** tanpa WSL, tanpa `bash`, dan tanpa dependensi `npm` eksternal.

> Adaptasi Antigravity ini di-port dari [humaedihume/kantor-agent](https://github.com/humaedihume/kantor-agent) di bawah **MIT License** (lihat [LICENSE](LICENSE) dan [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

---

## Fitur Utama

1. **Kantor 3D Real-Time Lintas Surface Antigravity:**
   - Memindai `conversation_summaries.db` secara *read-only* (`node:sqlite`) lintas root `~/.gemini/{antigravity,antigravity-ide,antigravity-cli}` dan membaca transkrip + artifact secara inkremental serta teredaksi.
   - Panel **Aktivitas langsung**, tab **Riwayat**, **Tugas Ketua** (`task.md`), dan tab **Artifact** lengkap dengan modal pratinjau teredaksi.
2. **Mode Spesialis Ketat untuk 4 Divisi Tim IT:**
   - **Ketua · Joko (`Lead Architect`)** mengorkestrasi tugas ke 4 meja spesialis tetap sesuai skill Antigravity terpasang:
     - **Budi (`Frontend & UI`)** — `frontend-ui-dev`
     - **Sari (`Backend & AI`)** — `backend-architect`
     - **Agus (`QA & Security`)** — `qa-security-engineer` / `browser`
     - **Rina (`Product & Ops`)** — `product-ops-researcher` / `research`
   - Tugas paralel di divisi yang sedang bekerja/cooldown atau tugas tak terklasifikasi otomatis dialihkan ke **Freelancer** di meja cadangan (tidak pernah meminjam meja divisi lain).
3. **Chat Browser Langsung ke Ketua (`agy acp --stdio`):**
   - Laci chat lipat (`C`) dengan pilihan sesi CLI/ACP, mode (`accept-edits`, `plan`, `auto`), model, streaming SSE, tombol batal, dan **Kartu Izin interaktif** (timeout aman 120 detik).
4. **Keamanan Lokal-Pertama:**
   - Default bind `127.0.0.1`, header keamanan ketat + CSP nonce per respons, validasi `Host` & `Origin`, redaksi kredensial otomatis, serta `chat-token` 32-byte (`0o600`) wajib untuk akses non-loopback/LAN/tunnel.

---

## Prasyarat

- **Node.js `>= 22.5`** (menggunakan modul bawaan `node:sqlite`, `node:http`, `node:crypto`, `node:child_process`).
- **Google Antigravity (`agy` CLI)** di `PATH` (atau set `KANTOR_AGY_BIN`) untuk fitur Chat ACP Ketua.
- *(Opsional)* **`cloudflared`** untuk membuka URL publik sementara (`winget install Cloudflare.cloudflared` di Windows).

---

## Pemasangan & Mulai Cepat

### 1. Periksa Lingkungan
```powershell
node skills/kantor-agent/runtime/bin/kantor.mjs detect
```

### 2. Pasang 4 Templat Subagent Spesialis (Opsional, Idempoten)
Menyalin 4 definisi agen (`frontend-ui-dev.md`, `backend-architect.md`, `qa-security-engineer.md`, `product-ops-researcher.md`) ke `~/.gemini/config/agents/` tanpa menimpa file pengguna yang sudah ada:

```powershell
node skills/kantor-agent/runtime/bin/kantor.mjs setup-team
# Gunakan --force bila ingin memperbarui templat yang sudah ada:
node skills/kantor-agent/runtime/bin/kantor.mjs setup-team --force
```

### 3. Jalankan Kantor Agent untuk Proyek Anda
```powershell
node skills/kantor-agent/runtime/bin/kantor.mjs start --project C:\path\ke\proyek
```

Buka URL yang dicetak di browser (default `http://127.0.0.1:8788/kerja`). Tekan **`C`** untuk membuka **Chat Ketua** atau **`H`** untuk mode kantor penuh.

---

## Referensi Perintah CLI (`kantor.mjs`)

| Perintah | Deskripsi |
|---|---|
| `detect [--json]` | Memeriksa Node.js `>= 22.5`, `node:sqlite`, biner `agy` & `cloudflared`, root DB Antigravity, serta status 4 templat Tim IT. |
| `setup-team [--force]` | Memasang 4 templat subagent spesialis ke `~/.gemini/config/agents/`. |
| `start` | Menjalankan `serve.mjs` di latar belakang pada port tersedia (`8788..8808`) dan menyimpan `server.json` di storage proyek. |
| `stop` | Menghentikan server & tunnel aktif dengan bersih serta menghapus `server.json`. |
| `restart` | Menjalankan `stop` lalu `start`. |
| `status [--json]` | Menampilkan status server, PID, port, subagent aktif, dan `public_url`. |
| `url` | Mencetak URL lokal (atau `public_url` bila tunnel aktif). |
| `token` | Mencetak `chat-token` rahasia dari `<storageDir>/chat-token`. |
| `tunnel` / `tunnel-stop` | Membuka / menutup tunnel publik sementara via `cloudflared`. |
| `autostart` | Hook `SessionStart` opt-in (hanya menyala bila `autostart: true` atau `KANTOR_AUTOSTART=1`). |

Flag yang didukung: `--project <dir>`, `--storage <dir>`, `--bind <ip>`, `--port <n>`, `--sandbox`, `--force`, `--quiet`, `--json`.

---

## Matriks 4 Divisi Tim IT & Skill Antigravity

| Karakter | `TypeName` & Divisi | Cakupan Skill Terpasang |
|---|---|---|
| **Joko** *(Ketua)* | `Lead Architect` | Orkestrasi tim, `task.md`, delegasi `invoke_subagent` |
| **Budi** *(Meja 0)* | `frontend-ui-dev` · **Frontend & UI** | `frontend-ui-engineering`, `antislop-ui`, `antislop-human`, `antislop-layoutmobile`, `emil-design-eng`, `apple-design`, `animate*`, `pick-ui-library`, `ask-sonner`, `break-ui`, `a11y-debugging`, `mobile-native`, `figma-*`, `canva-*`, `remotion-*`, `generative_ui` |
| **Sari** *(Meja 1)* | `backend-architect` · **Backend & AI** | `api-and-interface-design`, `codebase-design`, `domain-modeling`, `design-patterns`, `improve-codebase-architecture`, `setup-ts-deep-modules`, `constraint-driven-development`, `incremental-implementation`, `lean-build`, `implement*`, `safe-refactor`, `code-simplification`, `migration`, `observability-and-instrumentation`, `performance*`, `write-swift`, `gemini-api-dev`, `gemini-live-api-dev`, `gemini-omni-flash-api`, `google-antigravity-sdk` |
| **Agus** *(Meja 2)* | `qa-security-engineer` *(+ `browser`)* · **QA & Security** | `tdd`, `test-driven-development`, `tdd-rust`, `rtk-tdd`, `systematic-debugging`, `debugging-and-error-recovery`, `diagnosing-bugs`, `investigate-first`, `browser-testing-with-devtools`, `chrome-devtools*`, `cookie-debugging`, `memory-leak-debugging`, `debug-optimize-lcp`, `troubleshooting`, `security-audit`, `security-and-hardening`, `security-guardian`, `code-review*`, `pr-review`, `ponytail-review`, `ponytail-audit`, `quality-control`, `verification-before-completion`, `verify-and-stop`, `surgical-patch`, `doubt-driven-development`, `migrate-to-shoehorn` |
| **Rina** *(Meja 3)* | `product-ops-researcher` *(+ `research`)* · **Product & Ops** | `brainstorming`, `spec-driven-development`, `planning-and-task-breakdown`, `writing-plans`, `idea-refine`, `interview-me`, `grill-me`, `grilling`, `research`, `source-driven-development`, `graphify`, `documentation-and-adrs`, `writing-for-agents`, `antislop-copywriting`, `bahasa-indonesia`, `ci-cd-and-automation`, `git-workflow-and-versioning`, `git-guardrails-claude-code`, `setup-pre-commit`, `finishing-a-development-branch`, `ship`, `shipping-and-launch`, `pr`, `pr-triage`, `issue-triage`, `repo-recap`, `gdocs`, `gdrive`, `gsheets`, `gslides`, `automation`, `wizard` |

---

## Konfigurasi Proyek & Variabel Lingkungan

Penimpaan opsional per proyek dapat diletakkan di `<project>/.agents/kantor-agent.json`:

```json
{
  "title": "Proyek Saya",
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

Variabel lingkungan yang didukung:
- `KANTOR_STORAGE`: menimpa folder state/token/log (default `~/.cache/kantor-agent/<slug>-<hash12>`).
- `KANTOR_BIND`: menimpa alamat bind HTTP (prioritas di bawah flag `--bind`).
- `KANTOR_SANDBOX`: `1` atau `true` untuk menyalakan `--sandbox` ACP (prioritas di bawah `--sandbox`).
- `KANTOR_AGY_BIN`: path khusus ke biner `agy`.
- `KANTOR_AUTOSTART`: `1` atau `true` untuk mengaktifkan `autostart` hook.
- `KANTOR_ALLOWED_HOSTS`: daftar host tambahan dipisah koma yang diizinkan pada header `Host`.
- `ANTIGRAVITY_HOME`: mengarahkan pemindaian DB/brain ke satu direktori tertentu (berguna untuk pengujian).
- `ANTIGRAVITY_CONFIG_DIR`: direktori konfigurasi target bagi `setup-team` (default `~/.gemini/config`).

---

## Pengujian & Validasi Plugin

```powershell
# Jalankan seluruh unit & integration test
node --test tests/*.test.mjs

# Pemeriksaan smoke check terhadap server yang sedang berjalan
node skills/kantor-agent/runtime/bin/check.mjs http://127.0.0.1:8788

# Validasi struktur plugin Antigravity strict
agy plugin validate --strict .
```

---

## Kredit & Lisensi

- Dirancang dan di-port untuk Google Antigravity dari karya asli [humaedihume/kantor-agent](https://github.com/humaedihume/kantor-agent) (Copyright © 2026 humaedihume, **MIT License**).
- Memaketkan **three.js r170** (Copyright © 2010–2024 three.js authors, **MIT License**) di `skills/kantor-agent/runtime/public/assets/vendor/three/`.
- Lihat detail lengkap di [LICENSE](LICENSE) dan [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
