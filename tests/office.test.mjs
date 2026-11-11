import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../skills/kantor-agent/runtime/lib/config.mjs';
import { hash } from '../skills/kantor-agent/runtime/lib/util.mjs';
import { classifyDivision, buildState } from '../skills/kantor-agent/runtime/lib/office.mjs';

const RUNTIME_DIR = path.resolve(import.meta.dirname, '..', 'skills', 'kantor-agent', 'runtime');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    preview TEXT DEFAULT '',
    step_count INTEGER DEFAULT 0,
    last_modified_time TEXT,
    workspace_uris TEXT,
    status TEXT DEFAULT '',
    source TEXT DEFAULT '',
    agent_name TEXT DEFAULT '',
    parent_conversation_id TEXT DEFAULT '',
    nesting_depth INTEGER DEFAULT 0,
    not_fully_idle INTEGER DEFAULT 0,
    killed INTEGER DEFAULT 0,
    last_user_input_time TEXT,
    app_data_dir TEXT DEFAULT ''
  );
`;

function createDb(dbPath, rows = []) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA_SQL);
    const ins = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, agent_name, parent_conversation_id,
        nesting_depth, not_fully_idle, killed, last_user_input_time, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      ins.run(
        r.conversation_id,
        r.title ?? '',
        r.preview ?? '',
        r.step_count ?? 0,
        r.last_modified_time ?? null,
        r.workspace_uris ?? null,
        r.status ?? '',
        r.source ?? '',
        r.agent_name ?? '',
        r.parent_conversation_id ?? '',
        r.nesting_depth ?? 0,
        r.not_fully_idle ?? 0,
        r.killed ?? 0,
        r.last_user_input_time ?? null,
        r.app_data_dir ?? ''
      );
    }
  } finally {
    db.close();
  }
}

function writeJsonl(rootDir, convId, lines) {
  const filePath = path.join(rootDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}

function writeBrainFile(rootDir, convId, relPath, content, metadata = null) {
  const filePath = path.join(rootDir, 'brain', convId, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  if (metadata) {
    fs.writeFileSync(`${filePath}.metadata.json`, JSON.stringify(metadata), 'utf8');
  }
  return filePath;
}

function withEnvHome(antigravityHome, fn) {
  const prev = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = antigravityHome;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = prev;
  }
}

function makeEnv(prefix = 'kantor-office-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agHome = path.join(tmpDir, 'antigravity');
  const projDir = path.join(tmpDir, 'project');
  const storageDir = path.join(tmpDir, 'storage');
  fs.mkdirSync(agHome, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  const cfg = loadConfig(RUNTIME_DIR, projDir);
  const projUri = JSON.stringify([pathToFileURL(projDir).href]);
  return {
    tmpDir,
    agHome,
    projDir,
    storageDir,
    cfg,
    projUri,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe('office.mjs', () => {
  describe('classifyDivision()', () => {
    const tmpCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-office-cfg-'));
    const cfg = loadConfig(RUNTIME_DIR, tmpCfgDir);
    fs.rmSync(tmpCfgDir, { recursive: true, force: true });
    const divisions = cfg.divisions;

    it('maps exact agentType (case-insensitive) to the 4 IT divisions', () => {
      assert.deepEqual(classifyDivision({ agentType: 'frontend-ui-dev' }, divisions), {
        idx: 0,
        id: 'frontend',
        label: 'Frontend & UI',
      });
      assert.deepEqual(classifyDivision({ agentType: 'BACKEND-ARCHITECT' }, divisions), {
        idx: 1,
        id: 'backend',
        label: 'Backend & AI',
      });
      assert.deepEqual(classifyDivision({ agentType: 'qa-security-engineer' }, divisions), {
        idx: 2,
        id: 'qa',
        label: 'QA & Security',
      });
      assert.deepEqual(classifyDivision({ agentType: 'browser' }, divisions), {
        idx: 2,
        id: 'qa',
        label: 'QA & Security',
      });
      assert.deepEqual(classifyDivision({ agentType: 'product-ops-researcher' }, divisions), {
        idx: 3,
        id: 'product_ops',
        label: 'Product & Ops',
      });
      assert.deepEqual(classifyDivision({ agentType: 'Research' }, divisions), {
        idx: 3,
        id: 'product_ops',
        label: 'Product & Ops',
      });
    });

    it('scores match_keywords on role + task + description for agentType "self" and picks highest score with lowest idx tie-break', () => {
      // Skor tertinggi Backend (api, schema, migration = 3) vs 0 lainnya
      assert.deepEqual(
        classifyDivision(
          {
            agentType: 'self',
            role: 'API Helper',
            task: 'Build PostgreSQL schema migration',
          },
          divisions
        ),
        { idx: 1, id: 'backend', label: 'Backend & AI' }
      );

      // Stem / camelCase matching: animation -> animat, TailwindCSS -> tailwind + css
      assert.deepEqual(
        classifyDivision(
          {
            agentType: 'self',
            role: null,
            task: 'Polish TailwindCSS animations',
          },
          divisions
        ),
        { idx: 0, id: 'frontend', label: 'Frontend & UI' }
      );

      // Seri (1 keyword Frontend: react, 1 keyword Product & Ops: docs) -> menang idx terkecil (0)
      assert.deepEqual(
        classifyDivision(
          {
            agentType: 'self',
            role: 'Helper',
            task: 'Update React docs',
          },
          divisions
        ),
        { idx: 0, id: 'frontend', label: 'Frontend & UI' }
      );
    });

    it('returns null for unclassified tasks (including false-friend words like build, project, explain, inspect, latest, preview)', () => {
      assert.equal(classifyDivision({ agentType: 'self', role: 'Helper', task: 'Clean up temporary files' }, divisions), null);
      assert.equal(
        classifyDivision(
          {
            agentType: 'self',
            role: 'Generalist',
            task: 'Build generic project helper and explain latest inspect preview',
            description: 'Build generic project helper and explain latest inspect preview',
          },
          divisions
        ),
        null
      );
      assert.equal(classifyDivision(null, divisions), null);
      assert.equal(classifyDivision({ agentType: 'self' }, []), null);
    });
  });

  describe('buildState() — Empty & Strict Specialist IT-Team Mode', () => {
    it('returns clean empty state with 4 santai specialists and chat config summary when no DB exists', () => {
      const env = makeEnv('kantor-off-empty-');
      try {
        const now = Date.parse('2026-11-11T05:00:00Z');
        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        assert.equal(state.app, 'kantor-agent');
        assert.equal(state.transcripts, false);
        assert.equal(state.names, 'Joko|Budi|Sari|Agus|Rina');
        assert.equal(state.ketua.state, 'santai');
        assert.equal(state.ketua.role, 'Lead Architect');
        assert.deepEqual(state.ketua.artifacts, []);
        assert.equal(state.ketua.todos, null);
        assert.equal(state.team.length, 4);
        assert.deepEqual(
          state.team.map((m) => [m.key, m.name, m.division, m.state, m.desk, m.run]),
          [
            ['tim-0', 'Budi', 'Frontend & UI', 'santai', 0, null],
            ['tim-1', 'Sari', 'Backend & AI', 'santai', 1, null],
            ['tim-2', 'Agus', 'QA & Security', 'santai', 2, null],
            ['tim-3', 'Rina', 'Product & Ops', 'santai', 3, null],
          ]
        );
        assert.deepEqual(state.freelancers, []);
        assert.deepEqual(state.runs, []);
        assert.deepEqual(state.feed, []);
        assert.deepEqual(state.chat, {
          enabled: true,
          connected: false,
          busy: false,
          session_id: null,
          mode: 'accept-edits',
          model: null,
          sandbox: false,
          pending_permission_count: 0,
          sessions: [],
        });
      } finally {
        env.cleanup();
      }
    });

    it('enforces Strict Specialist Mode: parallel same-division & cooldown & unclassified tasks go to freelancers (never borrow idle team desks)', () => {
      const env = makeEnv('kantor-off-strict-');
      try {
        const now = Date.parse('2026-11-11T05:10:00Z');
        const mainId = '11111111-1111-4111-8111-111111111111';
        const subFe1 = '22222222-2222-4222-8222-222222222221';
        const subFe2 = '22222222-2222-4222-8222-222222222222';
        const subBeDone = '33333333-3333-4333-8333-333333333331';
        const subBeCool = '33333333-3333-4333-8333-333333333332';
        const subUnclass = '44444444-4444-4444-8444-444444444441';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: mainId,
            title: 'Orkestrasi Fitur',
            last_modified_time: '2026-11-11T05:09:50Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            not_fully_idle: 1,
            nesting_depth: 0,
          },
          {
            conversation_id: subFe1,
            title: 'Frontend 1',
            last_modified_time: '2026-11-11T05:09:40Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subFe2,
            title: 'Frontend 2 Paralel',
            last_modified_time: '2026-11-11T05:09:45Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subBeDone,
            title: 'Backend 1 Selesai',
            last_modified_time: '2026-11-11T05:09:30Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subBeCool,
            title: 'Backend 2 Dalam Cooldown',
            last_modified_time: '2026-11-11T05:09:50Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subUnclass,
            title: 'Tugas Umum',
            last_modified_time: '2026-11-11T05:09:55Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
        ]);

        writeJsonl(env.agHome, mainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:08:00Z', step_index: 0, content: 'Kerjakan paralel' },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:08:05Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: { Role: 'UI Builder', Model: 'gemini-2.5-pro', TypeName: 'frontend-ui-dev', Prompt: 'Buat komponen header' },
              },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:08:06Z',
            step_index: 2,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subFe1}"}`,
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:08:10Z',
            step_index: 3,
            status: 'DONE',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: { Role: 'UI Card', Model: 'gemini-2.5-flash', TypeName: 'frontend-ui-dev', Prompt: 'Buat kartu statistik' },
              },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:08:11Z',
            step_index: 4,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subFe2}"}`,
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:00Z',
            step_index: 5,
            status: 'DONE',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: { Role: 'API Dev', Model: 'gemini-2.5-pro', TypeName: 'backend-architect', Prompt: 'Buat schema API' },
              },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:09:01Z',
            step_index: 6,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subBeDone}"}`,
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:40Z',
            step_index: 7,
            status: 'DONE',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: { Role: 'Service Dev', Model: 'gemini-2.5-flash', TypeName: 'backend-architect', Prompt: 'Optimasi endpoint' },
              },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:09:41Z',
            step_index: 8,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subBeCool}"}`,
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:45Z',
            step_index: 9,
            status: 'DONE',
            tool_calls: [
              {
                name: 'invoke_subagent',
                args: { Role: 'Helper', Model: 'flash', TypeName: 'self', Prompt: 'Rapikan file sementara' },
              },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:09:46Z',
            step_index: 10,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subUnclass}"}`,
          },
        ]);

        writeJsonl(env.agHome, subFe1, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:08:07Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:40Z',
            step_index: 1,
            status: 'DONE',
            input_tokens: 100,
            output_tokens: 40,
            cache_read_tokens: 10,
            tool_calls: [{ name: 'write_file', args: { Path: path.join(env.projDir, 'Header.jsx') } }],
          },
        ]);
        writeBrainFile(
          env.agHome,
          subFe1,
          'wireframe.md',
          '# Wireframe\nToken api_key=secret123',
          { summary: 'Wireframe utama dengan sk-1234567890abcd', updatedAt: '2026-11-11T05:09:41Z', userFacing: true }
        );

        writeJsonl(env.agHome, subFe2, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:08:12Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:45Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [{ name: 'edit_file', args: { Path: path.join(env.projDir, 'Card.jsx') } }],
          },
        ]);

        // Backend 1 selesai di 05:09:30 (baru 10 detik sebelum Backend 2 mulai di 05:09:40 -> masih dalam cooldown 60s!)
        writeJsonl(env.agHome, subBeDone, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:09:02Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:09:30Z',
            step_index: 1,
            status: 'DONE',
            content: 'Schema API selesai.',
            tool_calls: [],
          },
        ]);

        writeJsonl(env.agHome, subBeCool, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:09:42Z', step_index: 0 },
        ]);

        writeJsonl(env.agHome, subUnclass, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:09:47Z', step_index: 0 },
        ]);

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        // Budi (slot 0) menangani subFe1
        assert.equal(state.team[0].name, 'Budi');
        assert.equal(state.team[0].division, 'Frontend & UI');
        assert.equal(state.team[0].state, 'bekerja');
        assert.equal(state.team[0].run.id, subFe1);
        assert.equal(state.team[0].run.division, 'Frontend & UI');
        assert.equal(state.team[0].run.role, 'UI Builder');
        assert.equal(state.team[0].run.model, 'gemini-2.5-pro');
        assert.equal(state.team[0].run.tokens, 150);
        assert.equal(state.team[0].run.tools, 1);
        assert.equal(state.team[0].run.artifacts.length, 1);
        assert.ok(!state.team[0].run.artifacts[0].summary.includes('sk-1234567890abcd'));

        // Sari (slot 1) masih memegang subBeDone ('selesai' < 60s), subBeCool tidak bisa memakai meja Agus/Rina
        assert.equal(state.team[1].name, 'Sari');
        assert.equal(state.team[1].state, 'selesai');
        assert.equal(state.team[1].run.id, subBeDone);

        // Agus (slot 2) dan Rina (slot 3) WAJIB tetap 'santai' — tidak meminjamkan meja ke Frontend/Backend/Unclassified!
        assert.equal(state.team[2].name, 'Agus');
        assert.equal(state.team[2].state, 'santai');
        assert.equal(state.team[2].run, null);
        assert.equal(state.team[3].name, 'Rina');
        assert.equal(state.team[3].state, 'santai');
        assert.equal(state.team[3].run, null);

        // subFe2, subBeCool, dan subUnclass semua dialihkan ke Freelancer
        assert.equal(state.freelancers.length, 3);
        const flFe2 = state.freelancers.find((f) => f.run.id === subFe2);
        const flBeCool = state.freelancers.find((f) => f.run.id === subBeCool);
        const flUnclass = state.freelancers.find((f) => f.run.id === subUnclass);
        assert.ok(flFe2);
        assert.equal(flFe2.desk, 0);
        assert.equal(flFe2.state, 'bekerja');
        assert.equal(flFe2.run.division, 'Frontend & UI');
        assert.equal(flFe2.name, env.cfg.freelancers[hash(subFe2) % env.cfg.freelancers.length]);

        assert.ok(flBeCool);
        assert.equal(flBeCool.desk, 1);
        assert.equal(flBeCool.run.division, 'Backend & AI');

        assert.ok(flUnclass);
        assert.equal(flUnclass.desk, 2);
        assert.equal(flUnclass.run.division, 'Umum');
        assert.equal(flUnclass.run.role, 'Helper');

        // Cek metadata lengkap pada runs[] history
        const histUnclass = state.runs.find((r) => r.id === subUnclass);
        assert.ok(histUnclass);
        assert.equal(histUnclass.division, 'Umum');
        assert.equal(histUnclass.kind, 'freelancer');
        assert.equal(histUnclass.role, 'Helper');
        assert.equal(histUnclass.model, 'flash');
        assert.deepEqual(histUnclass.artifacts, []);
      } finally {
        env.cleanup();
      }
    });

    it('maps browser -> Agus, research -> Rina, self+keywords -> matching specialist, and keeps send_message continuation on same character when free', () => {
      const env = makeEnv('kantor-off-resume-');
      try {
        const now = Date.parse('2026-11-11T05:15:00Z');
        const mainId = 'aaaa1111-1111-4111-8111-111111111111';
        const subBrowser = 'bbbb2222-2222-4222-8222-222222222221';
        const subResearch = 'bbbb2222-2222-4222-8222-222222222222';
        const subSelfBe = 'bbbb2222-2222-4222-8222-222222222223';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: mainId,
            title: 'Delegasi',
            last_modified_time: '2026-11-11T05:14:30Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
          {
            conversation_id: subBrowser,
            title: 'Browser QA',
            last_modified_time: '2026-11-11T05:14:20Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subResearch,
            title: 'Riset',
            last_modified_time: '2026-11-11T05:14:10Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subSelfBe,
            title: 'Self Backend',
            last_modified_time: '2026-11-11T05:14:05Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
        ]);

        writeJsonl(env.agHome, mainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:10:00Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:10:05Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [
              { name: 'invoke_subagent', args: { Role: 'E2E Runner', Model: 'flash', TypeName: 'browser', Prompt: 'Uji halaman' } },
              { name: 'invoke_subagent', args: { Role: 'Analyst', Model: 'pro', TypeName: 'research', Prompt: 'Bandingkan opsi' } },
              { name: 'invoke_subagent', args: { Role: '[Backend] Migrator', Model: 'pro', TypeName: 'self', Prompt: 'Refactor SQLite database' } },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:10:06Z',
            step_index: 2,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subBrowser}"}`,
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:10:07Z',
            step_index: 3,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subResearch}"}`,
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:10:08Z',
            step_index: 4,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subSelfBe}"}`,
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:13:00Z',
            step_index: 5,
            status: 'DONE',
            tool_calls: [
              { name: 'send_message', args: { Recipient: subBrowser, Message: 'Lanjutkan cek mobile viewport' } },
            ],
          },
        ]);

        // subBrowser selesai segmen 1 pada 05:11:00, lalu dibangunkan kembali oleh send_message di 05:13:00 (> cooldown 60s)
        writeJsonl(env.agHome, subBrowser, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:10:10Z', step_index: 0 },
          { type: 'PLANNER_RESPONSE', created_at: '2026-11-11T05:11:00Z', step_index: 1, status: 'DONE', content: 'Cek desktop selesai.', tool_calls: [] },
        ]);
        writeJsonl(env.agHome, subResearch, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:10:12Z', step_index: 0 },
          { type: 'PLANNER_RESPONSE', created_at: '2026-11-11T05:14:10Z', step_index: 1, status: 'DONE', content: 'Riset selesai.', tool_calls: [] },
        ]);
        writeJsonl(env.agHome, subSelfBe, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:10:15Z', step_index: 0 },
        ]);

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        assert.equal(state.team[1].name, 'Sari');
        assert.equal(state.team[1].run.id, subSelfBe);
        assert.equal(state.team[1].run.division, 'Backend & AI');

        assert.equal(state.team[2].name, 'Agus');
        assert.equal(state.team[2].state, 'bekerja');
        assert.equal(state.team[2].run.id, subBrowser);
        assert.equal(state.team[2].run.segment, 2);

        assert.equal(state.team[3].name, 'Rina');
        assert.equal(state.team[3].state, 'selesai');
        assert.equal(state.team[3].run.id, subResearch);

        assert.equal(state.freelancers.length, 0);
        assert.ok(state.feed.some((e) => e.kind === 'resume' && e.who === 'tim-2' && e.name === 'Agus'));
      } finally {
        env.cleanup();
      }
    });
  });

  describe('buildState() — Subagent Terminal States, Ketua 3-State Machine, acpStatus, & todos Fallback', () => {
    it('handles killed, rate-limit, inactive timeout, and not_fully_idle subagents accurately', () => {
      const env = makeEnv('kantor-off-substat-');
      try {
        const now = Date.parse('2026-11-11T06:00:00Z');
        const mainId = 'c0000000-0000-4000-8000-000000000001';
        const subKill = 'c0000000-0000-4000-8000-000000000002';
        const subLimit = 'c0000000-0000-4000-8000-000000000003';
        const subStale = 'c0000000-0000-4000-8000-000000000004';
        const subNotIdle = 'c0000000-0000-4000-8000-000000000005';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: mainId,
            title: 'Main',
            last_modified_time: '2026-11-11T05:59:50Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
          {
            conversation_id: subKill,
            title: 'Killed Subagent',
            last_modified_time: '2026-11-11T05:55:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            killed: 1,
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subLimit,
            title: 'Limit Subagent',
            last_modified_time: '2026-11-11T05:56:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subStale,
            title: 'Stale Subagent',
            last_modified_time: '2026-11-11T05:30:00Z', // 30m > 15m RW
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subNotIdle,
            title: 'Not Fully Idle Subagent',
            last_modified_time: '2026-11-11T05:30:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            not_fully_idle: 1,
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
        ]);

        writeJsonl(env.agHome, mainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:25:00Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:25:05Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [
              { name: 'invoke_subagent', args: { Role: 'FE', TypeName: 'frontend-ui-dev', Prompt: 'FE task' } },
              { name: 'invoke_subagent', args: { Role: 'BE', TypeName: 'backend-architect', Prompt: 'BE task' } },
              { name: 'invoke_subagent', args: { Role: 'QA', TypeName: 'qa-security-engineer', Prompt: 'QA task' } },
              { name: 'invoke_subagent', args: { Role: 'Ops', TypeName: 'product-ops-researcher', Prompt: 'Ops task' } },
            ],
          },
          { type: 'GENERIC', created_at: '2026-11-11T05:25:06Z', step_index: 2, status: 'DONE', content: `{"conversationId":"${subKill}"}` },
          { type: 'GENERIC', created_at: '2026-11-11T05:25:07Z', step_index: 3, status: 'DONE', content: `{"conversationId":"${subLimit}"}` },
          { type: 'GENERIC', created_at: '2026-11-11T05:25:08Z', step_index: 4, status: 'DONE', content: `{"conversationId":"${subStale}"}` },
          { type: 'GENERIC', created_at: '2026-11-11T05:25:09Z', step_index: 5, status: 'DONE', content: `{"conversationId":"${subNotIdle}"}` },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:59:50Z',
            step_index: 6,
            status: 'DONE',
            content: 'Selesai',
            tool_calls: [],
          },
        ]);

        writeJsonl(env.agHome, subKill, [{ type: 'USER_INPUT', created_at: '2026-11-11T05:26:00Z', step_index: 0 }]);
        writeJsonl(env.agHome, subLimit, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:26:00Z', step_index: 0 },
          { type: 'ERROR_MESSAGE', created_at: '2026-11-11T05:56:00Z', step_index: 1, error: 'Rate limit reached' },
        ]);
        writeJsonl(env.agHome, subStale, [{ type: 'USER_INPUT', created_at: '2026-11-11T05:30:00Z', step_index: 0 }]);
        writeJsonl(env.agHome, subNotIdle, [{ type: 'USER_INPUT', created_at: '2026-11-11T05:26:00Z', step_index: 0 }]);

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        const rKill = state.runs.find((r) => r.id === subKill);
        const rLimit = state.runs.find((r) => r.id === subLimit);
        const rStale = state.runs.find((r) => r.id === subStale);
        const rNotIdle = state.runs.find((r) => r.id === subNotIdle);

        assert.equal(rKill.status, 'terhenti');
        assert.equal(rLimit.status, 'limit');
        assert.equal(rStale.status, 'terhenti');
        assert.equal(rStale.ended, '2026-11-11T05:45:00.000Z');
        assert.equal(rNotIdle.status, 'bekerja');
        assert.equal(rNotIdle.ended, null);

        // Karena subNotIdle bekerja di parent mainId, Ketua berstatus bekerja + menunggu-tim!
        assert.equal(state.ketua.state, 'bekerja');
        assert.equal(state.ketua.activity, 'menunggu-tim');
        assert.equal(state.ketua.waiting_on, 1);

        assert.ok(state.feed.some((e) => e.kind === 'done' && e.text.includes('dihentikan:')));
        assert.ok(state.feed.some((e) => e.kind === 'done' && e.text.includes('limit pemakaian')));
        assert.ok(state.feed.some((e) => e.kind === 'done' && e.text.includes('tidak ada aktivitas 15 menit')));
      } finally {
        env.cleanup();
      }
    });

    it('covers Ketua 3 states (bekerja aktif/alat/menunggu-tim, selesai, santai) including CASCADE_RUN_STATUS_IDLE + not_fully_idle=1', () => {
      const env = makeEnv('kantor-off-ketua-');
      try {
        const mainId = 'd1111111-1111-4111-8111-111111111111';

        const runCase = (dbStatus, notFullyIdle, lines, nowIso) => {
          const dbFile = path.join(env.agHome, 'conversation_summaries.db');
          fs.rmSync(dbFile, { force: true });
          createDb(dbFile, [
            {
              conversation_id: mainId,
              title: 'Main Session',
              last_modified_time: lines[lines.length - 1].created_at,
              workspace_uris: env.projUri,
              status: dbStatus,
              not_fully_idle: notFullyIdle,
              nesting_depth: 0,
            },
          ]);
          writeJsonl(env.agHome, mainId, lines);
          return withEnvHome(env.agHome, () =>
            buildState({
              projectDir: env.projDir,
              storageDir: null,
              cfg: env.cfg,
              now: Date.parse(nowIso),
            })
          );
        };

        // 1. bekerja / aktif (non-final dalam main_active 90s)
        let s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          0,
          [{ type: 'USER_INPUT', created_at: '2026-11-11T05:00:00Z', step_index: 0 }],
          '2026-11-11T05:00:30Z'
        );
        assert.equal(s.ketua.state, 'bekerja');
        assert.equal(s.ketua.activity, 'aktif');

        // 2. bekerja / alat (lastKind='tool', age > 90s dan <= 900s)
        s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          0,
          [
            {
              type: 'PLANNER_RESPONSE',
              created_at: '2026-11-11T05:00:00Z',
              step_index: 1,
              status: 'DONE',
              tool_calls: [{ name: 'read_file', args: { Path: path.join(env.projDir, 'a.js') } }],
            },
          ],
          '2026-11-11T05:05:00Z'
        );
        assert.equal(s.ketua.state, 'bekerja');
        assert.equal(s.ketua.activity, 'alat');

        // 3. bekerja / menunggu-tim saat DB status = CASCADE_RUN_STATUS_IDLE dan not_fully_idle = 1 (walau lastKind='final')
        s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          1,
          [
            {
              type: 'PLANNER_RESPONSE',
              created_at: '2026-11-11T05:00:00Z',
              step_index: 1,
              status: 'DONE',
              content: 'Menunggu hasil subagent.',
              tool_calls: [],
            },
          ],
          '2026-11-11T05:05:00Z'
        );
        assert.equal(s.ketua.state, 'bekerja');
        assert.equal(s.ketua.activity, 'menunggu-tim');

        // 4. selesai (lastKind='final', not_fully_idle=0, age < cooldown 60s)
        s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          0,
          [
            {
              type: 'PLANNER_RESPONSE',
              created_at: '2026-11-11T05:00:00Z',
              step_index: 1,
              status: 'DONE',
              content: 'Semua tugas selesai.',
              tool_calls: [],
            },
          ],
          '2026-11-11T05:00:45Z'
        );
        assert.equal(s.ketua.state, 'selesai');
        assert.equal(s.ketua.activity, null);

        // 5. santai (lastKind='final', age >= cooldown 60s)
        s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          0,
          [
            {
              type: 'PLANNER_RESPONSE',
              created_at: '2026-11-11T05:00:00Z',
              step_index: 1,
              status: 'DONE',
              content: 'Semua tugas selesai.',
              tool_calls: [],
            },
          ],
          '2026-11-11T05:01:30Z'
        );
        assert.equal(s.ketua.state, 'santai');
        assert.equal(s.ketua.activity, null);

        // 6. bekerja / aktif saat lastKind='tool' dalam main_active 90s tanpa subagent aktif maupun not_fully_idle
        s = runCase(
          'CASCADE_RUN_STATUS_IDLE',
          0,
          [
            {
              type: 'PLANNER_RESPONSE',
              created_at: '2026-11-11T05:00:00Z',
              step_index: 1,
              status: 'DONE',
              tool_calls: [{ name: 'read_file', args: { Path: path.join(env.projDir, 'a.js') } }],
            },
          ],
          '2026-11-11T05:00:30Z'
        );
        assert.equal(s.ketua.state, 'bekerja');
        assert.equal(s.ketua.activity, 'aktif');

        // 7. bekerja / menunggu-tim saat lastKind='tool' (not_fully_idle=1) baik dalam 90s maupun 90s..900s
        for (const nowIso of ['2026-11-11T05:00:30Z', '2026-11-11T05:05:00Z']) {
          s = runCase(
            'CASCADE_RUN_STATUS_IDLE',
            1,
            [
              {
                type: 'PLANNER_RESPONSE',
                created_at: '2026-11-11T05:00:00Z',
                step_index: 1,
                status: 'DONE',
                tool_calls: [{ name: 'invoke_subagent', args: { Role: 'FE', TypeName: 'frontend-ui-dev', Prompt: 'Kerjakan UI' } }],
              },
            ],
            nowIso
          );
          assert.equal(s.ketua.state, 'bekerja');
          assert.equal(s.ketua.activity, 'menunggu-tim');
        }
      } finally {
        env.cleanup();
      }
    });

    it("resolves Ketua activity to 'menunggu-tim' (not 'aktif' or 'alat') when lastKind === 'tool' right after invoke_subagent with active subagent", () => {
      const env = makeEnv('kantor-off-wait-');
      try {
        const mainId = 'd2222222-2222-4222-8222-222222222221';
        const subId = 'd2222222-2222-4222-8222-222222222222';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: mainId,
            title: 'Delegasi Subagent',
            last_modified_time: '2026-11-11T05:00:01Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            not_fully_idle: 0,
            nesting_depth: 0,
          },
          {
            conversation_id: subId,
            title: 'Subagent Aktif',
            last_modified_time: '2026-11-11T05:00:05Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
        ]);

        // Main memanggil invoke_subagent + GENERIC -> lastKind tetap 'tool'
        writeJsonl(env.agHome, mainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:00:00Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:00:01Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [
              { name: 'invoke_subagent', args: { Role: 'Backend', TypeName: 'backend-architect', Prompt: 'Bangun API' } },
            ],
          },
          {
            type: 'GENERIC',
            created_at: '2026-11-11T05:00:02Z',
            step_index: 2,
            status: 'DONE',
            content: `Created the following subagent:\n{"conversationId":"${subId}"}`,
          },
        ]);

        writeJsonl(env.agHome, subId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:00:03Z', step_index: 0 },
        ]);

        // Uji dalam jendela <= 90s (05:00:20Z) maupun 90s..900s (05:03:00Z): wajib 'menunggu-tim', bukan 'aktif' atau 'alat'
        for (const nowIso of ['2026-11-11T05:00:20Z', '2026-11-11T05:03:00Z']) {
          const state = withEnvHome(env.agHome, () =>
            buildState({
              projectDir: env.projDir,
              storageDir: null,
              cfg: env.cfg,
              now: Date.parse(nowIso),
            })
          );
          assert.equal(state.ketua.state, 'bekerja');
          assert.equal(state.ketua.activity, 'menunggu-tim');
          assert.equal(state.ketua.waiting_on, 1);
        }
      } finally {
        env.cleanup();
      }
    });

    it('prioritizes acpStatus.busy session as active Ketua, calculates other_sessions, falls back todos to newest other session, and builds feed/chat/tunnel', () => {
      const env = makeEnv('kantor-off-acp-');
      try {
        const now = Date.parse('2026-11-11T05:20:00Z');
        const ideMainId = 'e1111111-1111-4111-8111-111111111111';
        const acpMainId = 'e2222222-2222-4222-8222-222222222222';
        const oldTodoId = 'e3333333-3333-4333-8333-333333333333';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: ideMainId,
            title: 'IDE Session Aktif',
            last_modified_time: '2026-11-11T05:19:55Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            nesting_depth: 0,
          },
          {
            conversation_id: acpMainId,
            title: 'ACP Chat Session',
            last_modified_time: '2026-11-11T05:19:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
            nesting_depth: 0,
          },
          {
            conversation_id: oldTodoId,
            title: 'Previous Session With Task',
            last_modified_time: '2026-11-11T05:10:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
        ]);

        // ideMainId aktif tapi tidak punya task.md
        writeJsonl(env.agHome, ideMainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:19:50Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:19:55Z',
            step_index: 1,
            status: 'DONE',
            content: 'Rahasia jawaban teks utama tidak boleh ke feed',
            tool_calls: [],
          },
        ]);

        // acpMainId juga tidak punya task.md, tapi punya artifact plan.png
        writeJsonl(env.agHome, acpMainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:18:50Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T05:19:00Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [{ name: 'read_file', args: { Path: path.join(env.projDir, 'README.md') } }],
          },
        ]);
        writeBrainFile(env.agHome, acpMainId, 'diagram.png', 'PNGDATA', {
          summary: 'Diagram arsitektur',
          updatedAt: '2026-11-11T05:19:01Z',
          userFacing: true,
        });

        // oldTodoId adalah sesi lain terbaru yang memiliki task.md
        writeJsonl(env.agHome, oldTodoId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T05:09:00Z', step_index: 0 },
        ]);
        writeBrainFile(
          env.agHome,
          oldTodoId,
          'task.md',
          '- [x] Setup DB\n- [/] Implement office.mjs\n- [ ] Setup server\n',
          { updatedAt: '2026-11-11T05:10:00Z' }
        );

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
            acpStatus: {
              connected: true,
              busy: true,
              sessionId: acpMainId,
              mode: 'plan',
              model: 'gemini-2.5-pro',
              sandbox: true,
              pendingPermissionCount: 1,
            },
            tunnelUrl: 'https://demo-kantor.trycloudflare.com/kerja',
          })
        );

        // Ketua wajib memilih acpMainId karena acpStatus.busy === true
        assert.equal(state.ketua.session, acpMainId.slice(0, 8));
        assert.equal(state.ketua.state, 'bekerja');
        assert.equal(state.ketua.activity, 'aktif');
        // ideMainId juga berstatus 'bekerja' (CASCADE_RUN_STATUS_RUNNING) -> other_sessions = 1
        assert.equal(state.ketua.other_sessions, 1);
        assert.equal(state.ketua.sessions, 3);
        assert.equal(state.stats.sessions_active, 2);

        // todos fallback ke oldTodoId dengan penanda ' (sesi sebelumnya)'
        assert.ok(state.ketua.todos);
        assert.equal(state.ketua.todos.source, 'task.md (sesi sebelumnya)');
        assert.equal(state.ketua.todos.items.length, 3);
        assert.deepEqual(state.ketua.todos.items[1], { text: 'Implement office.mjs', status: 'in_progress' });

        // artifacts diambil dari acpMainId
        assert.equal(state.ketua.artifacts.length, 1);
        assert.equal(state.ketua.artifacts[0].name, 'diagram.png');

        // text event dari sesi utama tidak pernah bocor ke feed
        assert.ok(!state.feed.some((e) => e.text.includes('Rahasia jawaban teks utama')));
        assert.ok(state.feed.some((e) => e.tool === 'read_file'));

        // chat block & tunnelUrl
        assert.deepEqual(state.chat, {
          enabled: true,
          connected: true,
          busy: true,
          session_id: acpMainId,
          mode: 'plan',
          model: 'gemini-2.5-pro',
          sandbox: true,
          pending_permission_count: 1,
          sessions: [
            {
              id: acpMainId,
              title: 'ACP Chat Session',
              updated: '2026-11-11T05:19:00Z',
              status: 'CASCADE_RUN_STATUS_IDLE',
              dbRoot: env.agHome,
            },
          ],
        });
        assert.equal(state.public_url, 'https://demo-kantor.trycloudflare.com/kerja');
      } finally {
        env.cleanup();
      }
    });

    it('enforces feed quotas (60 life + 120 acts) sorted newest first', () => {
      const env = makeEnv('kantor-off-quota-');
      try {
        const now = Date.parse('2026-11-11T06:00:00Z');
        const mainId = 'f1111111-1111-4111-8111-111111111111';
        const rows = [
          {
            conversation_id: mainId,
            title: 'Many Events',
            last_modified_time: '2026-11-11T05:59:59Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
        ];

        // Buat 125 event di main (<= MAX_EVENTS 120 disimpan oleh transcripts, tambah 20 lagi dari subagent)
        const mainLines = [];
        for (let i = 0; i < 120; i++) {
          const ts = new Date(Date.parse('2026-11-11T05:00:00Z') + i * 1000).toISOString();
          mainLines.push({
            type: 'PLANNER_RESPONSE',
            created_at: ts,
            step_index: i + 1,
            status: 'DONE',
            tool_calls: [{ name: 'read_file', args: { Path: path.join(env.projDir, `f${i}.js`) } }],
          });
        }
        writeJsonl(env.agHome, mainId, mainLines);

        // Buat 35 subagent masing-masing punya 1 assign + 1 done = 70 life events (> 60 kuota life) dan 1 tool act
        for (let k = 0; k < 35; k++) {
          const sid = `f2222222-2222-4222-8222-${String(k).padStart(12, '0')}`;
          const tStart = new Date(Date.parse('2026-11-11T05:10:00Z') + k * 5000).toISOString();
          const tEnd = new Date(Date.parse('2026-11-11T05:10:03Z') + k * 5000).toISOString();
          rows.push({
            conversation_id: sid,
            title: `Sub ${k}`,
            last_modified_time: tEnd,
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          });
          writeJsonl(env.agHome, sid, [
            { type: 'USER_INPUT', created_at: tStart, step_index: 0 },
            {
              type: 'PLANNER_RESPONSE',
              created_at: new Date(Date.parse(tStart) + 1000).toISOString(),
              step_index: 1,
              status: 'DONE',
              tool_calls: [{ name: 'write_file', args: { Path: path.join(env.projDir, `s${k}.js`) } }],
            },
            {
              type: 'PLANNER_RESPONSE',
              created_at: tEnd,
              step_index: 2,
              status: 'DONE',
              content: 'OK',
              tool_calls: [],
            },
          ]);
        }

        createDb(path.join(env.agHome, 'conversation_summaries.db'), rows);

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        const lifeCount = state.feed.filter((e) => e.kind === 'assign' || e.kind === 'resume' || e.kind === 'done').length;
        const actsCount = state.feed.filter((e) => e.kind !== 'assign' && e.kind !== 'resume' && e.kind !== 'done').length;
        assert.equal(lifeCount, 60);
        assert.equal(actsCount, 120);
        assert.equal(state.feed.length, 180);

        // Urut terbaru dulu
        for (let i = 1; i < state.feed.length; i++) {
          assert.ok(Date.parse(state.feed[i - 1].t) >= Date.parse(state.feed[i].t));
        }
      } finally {
        env.cleanup();
      }
    });

    it('handles subagents without transcripts, manage_subagents kill stop, nested subagent assigner, and tunnel-url.txt fallback/validation', () => {
      const env = makeEnv('kantor-off-edge-');
      try {
        const now = Date.parse('2026-11-11T06:10:00Z');
        const mainId = 'a0000000-0000-4000-8000-000000000001';
        const subParentBe = 'a0000000-0000-4000-8000-000000000002';
        const subNestedQa = 'a0000000-0000-4000-8000-000000000003';
        const subNoTranscriptRun = 'a0000000-0000-4000-8000-000000000004';
        const subNoTranscriptIdle = 'a0000000-0000-4000-8000-000000000005';

        createDb(path.join(env.agHome, 'conversation_summaries.db'), [
          {
            conversation_id: mainId,
            title: 'Main',
            last_modified_time: '2026-11-11T06:09:00Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
          {
            conversation_id: subParentBe,
            title: 'Backend Parent',
            last_modified_time: '2026-11-11T06:09:30Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            conversation_id: subNestedQa,
            title: 'Nested QA',
            last_modified_time: '2026-11-11T06:09:40Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: subParentBe,
            nesting_depth: 2,
          },
          {
            // Subagent baru tanpa transcript dengan sentinel 0001-01-01 dan RUNNING
            conversation_id: subNoTranscriptRun,
            title: 'Frontend No Transcript Running',
            agent_name: 'frontend-ui-dev',
            last_modified_time: '0001-01-01 00:00:00+00:00',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
          {
            // Subagent selesai tanpa transcript -> status selesai (bukan terjebak bekerja)
            conversation_id: subNoTranscriptIdle,
            title: 'Docs No Transcript Idle',
            agent_name: 'research',
            last_modified_time: '2026-11-11T06:09:50Z',
            workspace_uris: env.projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            parent_conversation_id: mainId,
            nesting_depth: 1,
          },
        ]);

        writeJsonl(env.agHome, mainId, [
          { type: 'USER_INPUT', created_at: '2026-11-11T06:05:00Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T06:05:05Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Backend', TypeName: 'backend-architect', Prompt: 'Buat modul' } }],
          },
          { type: 'GENERIC', created_at: '2026-11-11T06:05:06Z', step_index: 2, status: 'DONE', content: `{"conversationId":"${subParentBe}"}` },
        ]);

        // subParentBe men-spawn subNestedQa lalu menghentikannya dengan manage_subagents Action="kill"
        writeJsonl(env.agHome, subParentBe, [
          { type: 'USER_INPUT', created_at: '2026-11-11T06:05:10Z', step_index: 0 },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T06:06:00Z',
            step_index: 1,
            status: 'DONE',
            tool_calls: [{ name: 'invoke_subagent', args: { Role: 'QA', TypeName: 'qa-security-engineer', Prompt: 'Cek lint' } }],
          },
          { type: 'GENERIC', created_at: '2026-11-11T06:06:01Z', step_index: 2, status: 'DONE', content: `{"conversationId":"${subNestedQa}"}` },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T06:08:00Z',
            step_index: 3,
            status: 'DONE',
            tool_calls: [{ name: 'manage_subagents', args: { Action: 'kill', ConversationIds: [subNestedQa] } }],
          },
        ]);

        writeJsonl(env.agHome, subNestedQa, [
          { type: 'USER_INPUT', created_at: '2026-11-11T06:06:02Z', step_index: 0 },
        ]);

        // Tulis tunnel-url.txt valid di storageDir dan uji fallback saat tunnelUrl=null
        fs.writeFileSync(path.join(env.storageDir, 'tunnel-url.txt'), 'https://fallback-tunnel.trycloudflare.com/kerja\n', 'utf8');

        const state = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
          })
        );

        // Nested subagent dihentikan oleh kill dari parent -> status 'terhenti', event 'assign' dari Sari (tim-1)
        const rNested = state.runs.find((r) => r.id === subNestedQa);
        assert.equal(rNested.status, 'terhenti');
        assert.ok(state.feed.some((e) => e.kind === 'assign' && e.who === 'tim-1' && e.name === 'Sari' && e.text.includes('Sari meminta Agus')));
        assert.ok(state.feed.some((e) => e.kind === 'done' && e.who === 'tim-2' && e.text.includes('dihentikan:')));

        // Subagent tanpa transkrip: RUNNING sentinel -> bekerja (fallback start isoMs(now)), IDLE -> selesai
        const rNoTrRun = state.runs.find((r) => r.id === subNoTranscriptRun);
        const rNoTrIdle = state.runs.find((r) => r.id === subNoTranscriptIdle);
        assert.equal(rNoTrRun.status, 'bekerja');
        assert.equal(rNoTrRun.started, '2026-11-11T06:10:00.000Z');
        assert.equal(rNoTrIdle.status, 'selesai');

        assert.equal(state.public_url, 'https://fallback-tunnel.trycloudflare.com/kerja');

        // Tolak tunnelUrl yang tidak valid (http / path bukan /kerja)
        const stateBadTunnel = withEnvHome(env.agHome, () =>
          buildState({
            projectDir: env.projDir,
            storageDir: env.storageDir,
            cfg: env.cfg,
            now,
            tunnelUrl: 'http://insecure.example.com/kerja',
          })
        );
        assert.equal(stateBadTunnel.public_url, null);
      } finally {
        env.cleanup();
      }
    });
  });
});
