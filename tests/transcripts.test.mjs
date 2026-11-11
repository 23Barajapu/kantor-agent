import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { TranscriptScanner } from '../skills/kantor-agent/runtime/lib/transcripts.mjs';

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

function appendJsonl(filePath, lines) {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  fs.appendFileSync(filePath, text, 'utf8');
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

describe('transcripts.mjs (TranscriptScanner)', () => {
  it('returns empty state when no conversations exist for projectDir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-empty-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      const storageDir = path.join(tmpDir, 'storage');
      fs.mkdirSync(agHome, { recursive: true });
      fs.mkdirSync(projDir, { recursive: true });
      createDb(path.join(agHome, 'conversation_summaries.db'), []);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(storageDir, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000));
      });

      assert.equal(res.exists, false);
      assert.deepEqual(res.mains, []);
      assert.deepEqual(res.runs, []);
      assert.equal(res.allProjectConvIds.size, 0);
      assert.deepEqual(res.cliSessions, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads incrementally using byte-offset + HEAD_MAX (1024B MD5), persists cache v1, handles trailing partial line, and resets on truncation/replacement', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-incr-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      const storageDir = path.join(tmpDir, 'storage');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);
      const mainId = 'main-incr-001';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'Incremental Test',
          last_modified_time: '2026-11-11T04:30:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          nesting_depth: 0,
        },
      ]);

      // Tulis 1 baris lengkap + 1 baris belum selesai (tanpa trailing \n)
      const line1 = JSON.stringify({
        type: 'USER_INPUT',
        created_at: '2026-11-11T04:00:00Z',
        step_index: 0,
        content: 'Rahasia prompt user',
      });
      const line2 = JSON.stringify({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T04:00:05Z',
        step_index: 1,
        status: 'DONE',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 30,
        tool_calls: [{ name: 'read_file', args: { Path: path.join(projDir, 'src', 'a.js') } }],
      });
      const partialLine2 = line2.slice(0, 40);
      const tPath = path.join(agHome, 'brain', mainId, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(tPath), { recursive: true });
      fs.writeFileSync(tPath, `${line1}\n${partialLine2}`, 'utf8');

      withEnvHome(agHome, () => {
        const scanner1 = new TranscriptScanner(storageDir, { window_days: 7, cooldown: 60 });
        const res1 = scanner1.scan(projDir, nowSec);
        assert.equal(res1.mains.length, 1);
        assert.equal(res1.mains[0].events.length, 1);
        assert.equal(res1.mains[0].events[0].text, 'Instruksi dari user');
        assert.equal(res1.mains[0].tokens.total, 0);

        // Pastikan file cache v1 tercipta di storageDir/cache/ag-*.json
        const cacheDir = path.join(storageDir, 'cache');
        const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.startsWith('ag-') && f.endsWith('.json'));
        assert.equal(cacheFiles.length, 1);
        const cacheJson = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFiles[0]), 'utf8'));
        assert.equal(cacheJson.v, 1);
        assert.equal(cacheJson.s.offset, Buffer.byteLength(`${line1}\n`, 'utf8'));

        // Lengkapi baris ke-2 dan tambahkan padding > 1024 byte di baris ke-3
        const line3 = JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:00:10Z',
          step_index: 2,
          status: 'DONE',
          input_tokens: 50,
          output_tokens: 10,
          cache_read_tokens: 0,
          tool_calls: [{ name: 'write_file', args: { Path: path.join(projDir, 'src', 'b.js'), Content: 'x'.repeat(1400) } }],
        });
        fs.appendFileSync(tPath, `${line2.slice(40)}\n${line3}\n`, 'utf8');

        // Instance baru memuat cache disk dan melanjutkan secara inkremental
        const scanner2 = new TranscriptScanner(storageDir, { window_days: 7, cooldown: 60 });
        const res2 = scanner2.scan(projDir, nowSec);
        assert.equal(res2.mains[0].tokens.input, 150);
        assert.equal(res2.mains[0].tokens.output, 30);
        assert.equal(res2.mains[0].tokens.cache_read, 30);
        assert.equal(res2.mains[0].tokens.total, 210);
        assert.deepEqual(res2.mains[0].files, ['src/b.js']);

        // Append baris ke-4 setelah ukuran file > 1024 byte (uji kestabilan HEAD_MAX 1024B)
        appendJsonl(tPath, [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T04:00:20Z',
            step_index: 3,
            status: 'DONE',
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 5,
            content: 'Selesai merapikan file.',
            tool_calls: [],
          },
        ]);
        const res3 = scanner2.scan(projDir, nowSec);
        assert.equal(res3.mains[0].tokens.total, 230);
        assert.equal(res3.mains[0].lastKind, 'final');

        // Ganti seluruh isi file (ukuran >= offset lama tapi prefix 1024 byte berubah!) → wajib reset dari offset 0
        const replacedLines = [
          {
            type: 'USER_INPUT',
            created_at: '2026-11-11T04:10:00Z',
            step_index: 0,
            content: 'Sesi baru total',
          },
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T04:10:05Z',
            step_index: 1,
            status: 'DONE',
            input_tokens: 7,
            output_tokens: 3,
            cache_read_tokens: 0,
            content: 'x'.repeat(2200),
            tool_calls: [],
          },
        ];
        writeJsonl(agHome, mainId, replacedLines);
        const resReplaced = scanner2.scan(projDir, nowSec);
        assert.equal(resReplaced.mains[0].tokens.total, 10);
        assert.equal(resReplaced.mains[0].files.length, 0);
        assert.equal(resReplaced.mains[0].started, '2026-11-11T04:10:00Z');

        // Potong file (size < offset) → wajib reset dari offset 0
        writeJsonl(agHome, mainId, [
          {
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-11T04:20:00Z',
            step_index: 0,
            status: 'DONE',
            input_tokens: 2,
            output_tokens: 1,
            cache_read_tokens: 0,
            content: 'Pendek',
            tool_calls: [],
          },
        ]);
        const resTruncated = scanner2.scan(projDir, nowSec);
        assert.equal(resTruncated.mains[0].tokens.total, 3);
        assert.equal(resTruncated.mains[0].started, '2026-11-11T04:20:00Z');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('supports null storageDir (no disk cache) and deduplicates partial/duplicate step tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-dedup-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);
      const mainId = 'main-dedup-001';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'Token Dedup',
          last_modified_time: '2026-11-11T04:30:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
        },
      ]);

      writeJsonl(agHome, mainId, [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:00:01Z',
          step_index: 1,
          status: 'RUNNING',
          input_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 20,
          tool_calls: [],
        },
        {
          // Pembaruan step yang sama dari RUNNING -> DONE: hanya delta output (+30) yang bertambah
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:00:02Z',
          step_index: 1,
          status: 'DONE',
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 20,
          tool_calls: [{ name: 'list_dir', args: { DirectoryPath: projDir } }],
        },
        {
          // Duplikat persis (created_at + step_index sama) → tidak boleh dihitung ulang
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:00:02Z',
          step_index: 1,
          status: 'DONE',
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 20,
          tool_calls: [{ name: 'list_dir', args: { DirectoryPath: projDir } }],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      assert.equal(res.mains[0].tokens.input, 100);
      assert.equal(res.mains[0].tokens.output, 40);
      assert.equal(res.mains[0].tokens.cache_read, 20);
      assert.equal(res.mains[0].tokens.total, 160);
      // list_dir hanya tercatat sekali, tidak terduplikasi oleh baris duplikat
      assert.equal(res.mains[0].events.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('pairs parent invoke_subagent Role/Model/TypeName/Prompt with next GENERIC conversationId and falls back to DB agent_name/title when parent absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-sub-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      const storageDir = path.join(tmpDir, 'storage');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);

      const parentId = 'parent-main-1';
      const childPairedId = 'child-paired-uuid-1';
      const childFallbackId = 'child-fallback-uuid-2';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: parentId,
          title: 'Orchestrator',
          last_modified_time: '2026-11-11T04:40:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          nesting_depth: 0,
        },
        {
          conversation_id: childPairedId,
          title: 'DB Title Should Not Override Role',
          last_modified_time: '2026-11-11T04:41:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          agent_name: 'self',
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
        {
          conversation_id: childFallbackId,
          title: 'Audit endpoint auth',
          last_modified_time: '2026-11-11T04:42:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          agent_name: 'qa-security-engineer',
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
      ]);

      // Parent memiliki manage_subagents list (jangan sampai salah pair!) lalu invoke_subagent
      writeJsonl(agHome, parentId, [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:39:50Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [{ name: 'manage_subagents', args: { Action: '"list"' } }],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T04:39:51Z',
          step_index: 2,
          status: 'DONE',
          content: `Created At: 2026-11-11T04:39:51Z\nCompleted At: 2026-11-11T04:39:51Z\nYou have 1 active subagent(s):\n[{"conversationId":"${childFallbackId}","role":"Old"}]`,
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:40:00Z',
          step_index: 3,
          status: 'DONE',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: {
                // Uji string JSON-quoted seperti output protobuf Antigravity nyata
                Role: '"UI Polish Specialist"',
                Model: '"gemini-2.5-pro"',
                TypeName: '"frontend-ui-dev"',
                Prompt: '"# Perbaiki layout tombol\nGunakan grid responsif."',
              },
            },
          ],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T04:40:01Z',
          step_index: 4,
          status: 'DONE',
          content: `Created At: 2026-11-11T04:40:01Z\nCompleted At: 2026-11-11T04:40:01Z\nCreated the following subagent:\n{\n  "conversationId":  "${childPairedId}",\n  "workspaceUris":  []\n}`,
        },
      ]);

      writeJsonl(agHome, childPairedId, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T04:40:02Z',
          step_index: 0,
          content: 'Internal subagent prompt',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:40:30Z',
          step_index: 1,
          status: 'DONE',
          content: 'Layout tombol sudah dirapikan.',
          tool_calls: [],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(storageDir, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      assert.equal(res.runs.length, 2);

      const paired = res.runs.find((r) => r.id === childPairedId);
      assert.ok(paired);
      assert.equal(paired.role, 'UI Polish Specialist');
      assert.equal(paired.model, 'gemini-2.5-pro');
      assert.equal(paired.agentType, 'frontend-ui-dev');
      assert.equal(paired.description, 'Perbaiki layout tombol');
      assert.equal(paired.lastKind, 'final');
      assert.deepEqual(paired.segs, [['2026-11-11T04:40:02Z', '2026-11-11T04:40:30Z']]);

      const fallback = res.runs.find((r) => r.id === childFallbackId);
      assert.ok(fallback);
      assert.equal(fallback.agentType, 'qa-security-engineer');
      assert.equal(fallback.role, 'qa-security-engineer');
      assert.equal(fallback.model, null);
      assert.equal(fallback.description, 'Audit endpoint auth');

      // Event delegasi muncul di parent tanpa membocorkan isi GENERIC
      assert.ok(res.mains[0].events.some((e) => e.tool === 'invoke_subagent' && e.text.includes('Mendelegasikan: UI Polish Specialist')));
      assert.equal(JSON.stringify(res.mains[0].events).includes('Created the following subagent'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('captures send_message resumes (reopening/extending segs) and manage_subagents kill/kill_all stops', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-resumes-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      const storageDir = path.join(tmpDir, 'storage');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);

      const parentId = 'parent-ctrl';
      const childA = 'child-a';
      const childB = 'child-b';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: parentId,
          title: 'Controller',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
        {
          conversation_id: childA,
          title: 'Worker A',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
        {
          conversation_id: childB,
          title: 'Worker B',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
      ]);

      writeJsonl(agHome, childA, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T05:00:00Z',
          step_index: 0,
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:01:00Z',
          step_index: 1,
          status: 'DONE',
          content: 'Tahap 1 selesai.',
          tool_calls: [],
        },
      ]);

      writeJsonl(agHome, childB, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T05:02:00Z',
          step_index: 0,
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:02:30Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [{ name: 'read_file', args: { Path: 'a.txt' } }],
        },
      ]);

      writeJsonl(agHome, parentId, [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:05:00Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [
            {
              name: 'send_message',
              args: { Recipient: childA, Message: 'Lanjutkan dengan token=rahasia' },
            },
          ],
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:06:00Z',
          step_index: 2,
          status: 'DONE',
          tool_calls: [
            {
              name: 'manage_subagents',
              args: { Action: 'kill', ConversationIds: [childA] },
            },
          ],
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:07:00Z',
          step_index: 3,
          status: 'DONE',
          tool_calls: [
            {
              name: 'manage_subagents',
              args: { Action: '"kill_all"' },
            },
          ],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(storageDir, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const runA = res.runs.find((r) => r.id === childA);
      const runB = res.runs.find((r) => r.id === childB);
      assert.ok(runA);
      assert.ok(runB);

      // childA selesai di 05:01:00, lalu send_message di 05:05:00 (>60s cooldown) membuka segmen baru, lalu kill di 05:06:00 menutupnya
      assert.deepEqual(runA.resumes, ['2026-11-11T05:05:00Z']);
      assert.deepEqual(runA.stops, ['2026-11-11T05:06:00Z', '2026-11-11T05:07:00Z']);
      assert.deepEqual(runA.segs, [
        ['2026-11-11T05:00:00Z', '2026-11-11T05:01:00Z'],
        ['2026-11-11T05:05:00Z', '2026-11-11T05:06:00Z'],
      ]);

      // childB terbuka di 05:02:00 dan ditutup oleh kill_all di 05:07:00
      assert.deepEqual(runB.stops, ['2026-11-11T05:07:00Z']);
      assert.deepEqual(runB.segs, [['2026-11-11T05:02:00Z', '2026-11-11T05:07:00Z']]);

      // Tidak membocorkan isi Message dari send_message
      assert.equal(JSON.stringify(res).includes('rahasia'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Review Focus #2a: run_command only exposes toolSummary (never CommandLine) and GENERIC content never leaks to events', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-sec-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);
      const mainId = 'main-sec-001';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'Security Check',
          last_modified_time: '2026-11-11T04:50:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
      ]);

      writeJsonl(agHome, mainId, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T04:45:00Z',
          step_index: 0,
          content: 'PRIVATE_USER_PROMPT_DO_NOT_LEAK',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T04:45:05Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [
            {
              name: 'run_command',
              args: {
                CommandLine: 'curl -H "Authorization: Bearer secret123"',
                toolSummary: 'Check API status',
              },
            },
            {
              name: 'run_command',
              args: {
                // Tanpa toolSummary → fallback statis 'Jalankan perintah', CommandLine tidak pernah dibaca/dikeluarkan
                CommandLine: 'psql postgres://admin:superpass@db.internal:5432/prod -c "SELECT 1"',
              },
            },
            {
              name: 'run_command',
              args: {
                // unquoteArg gagal JSON.parse pada string dengan kutipan internal → pertahankan kutip apa adanya
                toolSummary: '"a" "b"',
              },
            },
            {
              name: 'call_mcp_tool',
              args: {
                ServerName: 'github',
                ToolName: 'list_issues',
                Arguments: '{"token":"ghp_secret_never_leak"}',
              },
            },
            {
              name: 'search_web',
              args: {
                query: 'node sqlite api_key=leak999',
              },
            },
          ],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T04:45:06Z',
          step_index: 2,
          status: 'DONE',
          content: 'RAW_GENERIC_TOOL_RESULT_sk-1234567890abcdef_NEVER_LEAK',
          tool_result: 'RAW_TOOL_RESULT_SECRET',
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const events = res.mains[0].events;
      const serialized = JSON.stringify(res);

      assert.ok(events.some((e) => e.tool === 'run_command' && e.text === 'Check API status'));
      assert.ok(events.some((e) => e.tool === 'run_command' && e.text === 'Jalankan perintah'));
      assert.ok(events.some((e) => e.tool === 'run_command' && e.text === '"a" "b"'));
      assert.ok(events.some((e) => e.tool === 'call_mcp_tool' && e.text.includes('github/list_issues')));
      assert.ok(events.some((e) => e.tool === 'search_web' && (e.text.includes('api key=•••') || e.text.includes('api_key=•••'))));

      for (const secret of [
        'Authorization',
        'Bearer',
        'secret123',
        'curl',
        'psql',
        'superpass',
        'db.internal',
        'SELECT 1',
        'PRIVATE_USER_PROMPT_DO_NOT_LEAK',
        'RAW_GENERIC_TOOL_RESULT',
        'RAW_TOOL_RESULT_SECRET',
        'ghp_secret_never_leak',
        'leak999',
      ]) {
        assert.equal(serialized.includes(secret), false, `Secret "${secret}" leaked in scan output`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('marks limit and closes open segment on rate/usage ERROR_MESSAGE, and records error on GENERIC ERROR', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-err-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);
      const mainLimitId = 'main-limit';
      const mainErrId = 'main-err';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainLimitId,
          title: 'Rate Limit Session',
          last_modified_time: '2026-11-11T04:50:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
        {
          conversation_id: mainErrId,
          title: 'Generic Error Session',
          last_modified_time: '2026-11-11T04:40:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
      ]);

      writeJsonl(agHome, mainLimitId, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T04:49:00Z',
          step_index: 0,
        },
        {
          type: 'ERROR_MESSAGE',
          created_at: '2026-11-11T04:49:15Z',
          step_index: 1,
          error: 'API rate limit reached with key sk-1234567890abcdef, resets in 30s',
          content: '',
        },
      ]);

      writeJsonl(agHome, mainErrId, [
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T04:39:00Z',
          step_index: 0,
        },
        {
          type: 'ERROR_MESSAGE',
          created_at: '2026-11-11T04:39:05Z',
          step_index: 1,
          error: 'Transient network EOF for api_key=abc123',
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T04:39:10Z',
          step_index: 2,
          status: 'ERROR',
          content: 'Secret stderr stack trace DO_NOT_EMIT',
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const limitMain = res.mains.find((m) => m.id === mainLimitId);
      assert.ok(limitMain);
      assert.ok(limitMain.limit && limitMain.limit.includes('rate limit reached'));
      assert.equal(limitMain.limit.includes('sk-1234567890abcdef'), false);
      assert.deepEqual(limitMain.segs, [['2026-11-11T04:49:00Z', '2026-11-11T04:49:15Z']]);

      const errMain = res.mains.find((m) => m.id === mainErrId);
      assert.ok(errMain);
      assert.equal(errMain.limit, null);
      assert.equal(errMain.lastKind, 'error');
      assert.ok(errMain.events.some((e) => e.kind === 'error' && e.text.includes('Transient network EOF') && !e.text.includes('abc123')));
      assert.equal(JSON.stringify(errMain.events).includes('DO_NOT_EMIT'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('builds cliSessions strictly for eligible CLI root sessions across multi-surface roots', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-cli-'));
    try {
      const mainRoot = path.join(tmpDir, 'antigravity');
      const cliRoot = path.join(tmpDir, 'antigravity-cli');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T05:00:00Z') / 1000);

      createDb(path.join(mainRoot, 'conversation_summaries.db'), [
        {
          conversation_id: 'cli-by-source',
          title: 'CLI via Source',
          last_modified_time: '2026-11-11T04:55:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
          app_data_dir: 'antigravity',
          nesting_depth: 0,
        },
        {
          conversation_id: 'desktop-main',
          title: 'Desktop Chat',
          last_modified_time: '2026-11-11T04:56:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          source: 'CORTEX_TRAJECTORY_SOURCE_IDE',
          app_data_dir: 'antigravity',
          nesting_depth: 0,
        },
        {
          conversation_id: 'cli-subagent-excluded',
          title: 'CLI Subagent',
          last_modified_time: '2026-11-11T04:57:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
          parent_conversation_id: 'cli-by-source',
          nesting_depth: 1,
        },
      ]);

      createDb(path.join(cliRoot, 'conversation_summaries.db'), [
        {
          conversation_id: 'cli-by-dbroot',
          title: 'CLI via DB Root',
          last_modified_time: '2026-11-11T04:58:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          source: '',
          app_data_dir: 'antigravity-cli',
          nesting_depth: 0,
        },
        {
          // dbRoot antigravity-cli namun app_data_dir === 'antigravity' dan source bukan CLI → tidak eligible
          conversation_id: 'excluded-appdatadir-ag',
          title: 'Desktop Row In CLI DB',
          last_modified_time: '2026-11-11T04:54:00Z',
          workspace_uris: projUri,
          status: 'CASCADE_RUN_STATUS_IDLE',
          source: 'CORTEX_TRAJECTORY_SOURCE_IDE',
          app_data_dir: 'antigravity',
          nesting_depth: 0,
        },
      ]);

      const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
      const res = scanner.scan(projDir, nowSec, [mainRoot, cliRoot]);

      assert.equal(res.exists, true);
      assert.equal(res.mains.length, 4);
      assert.equal(res.runs.length, 1);

      const cliIds = res.cliSessions.map((c) => c.id);
      assert.deepEqual(cliIds, ['cli-by-dbroot', 'cli-by-source']);
      assert.equal(res.cliSessions[0].dbRoot, cliRoot);
      assert.equal(res.cliSessions[0].status, 'CASCADE_RUN_STATUS_RUNNING');
      assert.equal(res.cliSessions[1].dbRoot, mainRoot);
      assert.ok(!cliIds.includes('desktop-main'));
      assert.ok(!cliIds.includes('cli-subagent-excluded'));
      assert.ok(!cliIds.includes('excluded-appdatadir-ag'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('streams >1MB files across 1MB chunks without corrupting multi-byte UTF-8 and caps modified files at 12', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-chunk-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);
      const mainId = 'main-large-chunk';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'Large Chunk Stream',
          last_modified_time: '2026-11-11T05:30:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
      ]);

      // Baris 1 hampir tepat 1 MB sehingga baris 2 (berisi emoji UTF-8 4-byte) melintasi batas chunk 1 MB
      const pad = 'a'.repeat(1024 * 1024 - 120);
      const lines = [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:00Z',
          step_index: 0,
          status: 'DONE',
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          tool_calls: [{ name: 'view_file', args: { AbsolutePath: path.join(projDir, 'README.md') } }],
          thinking: pad,
        },
      ];
      for (let i = 1; i <= 14; i++) {
        lines.push({
          type: 'PLANNER_RESPONSE',
          created_at: `2026-11-11T05:00:${String(i).padStart(2, '0')}Z`,
          step_index: i,
          status: 'DONE',
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          tool_calls: [
            { name: 'edit_file', args: { Path: path.join(projDir, `file-${i}.mjs`), Replacement: '🚀✨' } },
          ],
        });
      }
      lines.push({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T05:00:20Z',
        step_index: 15,
        status: 'DONE',
        input_tokens: 2,
        output_tokens: 3,
        cache_read_tokens: 0,
        tool_calls: [
          { name: 'mcp_github_get_pr', args: {} },
          { name: 'manage_task', args: { Action: 'list' } },
          { name: 'schedule', args: { toolSummary: 'Tunggu timer' } },
        ],
      });
      lines.push({
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T05:00:25Z',
        step_index: 16,
        status: 'DONE',
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 0,
        content: 'Selesai seluruh 🚀 tugas tanpa korup.',
        tool_calls: [],
      });

      writeJsonl(agHome, mainId, lines);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const main = res.mains[0];
      assert.equal(main.tokens.input, 10 + 14 + 2 + 1);
      assert.equal(main.tokens.output, 5 + 14 + 3 + 2);
      assert.equal(main.files.length, 12);
      assert.equal(main.files[0], 'file-3.mjs');
      assert.equal(main.files[11], 'file-14.mjs');
      assert.ok(main.events.some((e) => e.tool === 'view_file' && e.text.includes('README.md')));
      assert.ok(main.events.some((e) => e.tool === 'mcp_github_get_pr' && e.text.includes('MCP: github_get_pr')));
      assert.ok(main.events.some((e) => e.tool === 'manage_task' && e.text.includes('Tugas: list')));
      assert.ok(main.events.some((e) => e.tool === 'schedule' && e.text.includes('Jadwal: Tunggu timer')));
      assert.ok(main.events.some((e) => e.kind === 'text' && e.text === 'Selesai seluruh 🚀 tugas tanpa korup.'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reopens closed child segment when send_message arrives within cooldown window', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-cooldown-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: 'p1',
          title: 'Parent',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
        {
          conversation_id: 'c1',
          title: 'Child',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          parent_conversation_id: 'p1',
          nesting_depth: 1,
        },
      ]);

      writeJsonl(agHome, 'c1', [
        { type: 'USER_INPUT', created_at: '2026-11-11T05:00:00Z', step_index: 0 },
        { type: 'PLANNER_RESPONSE', created_at: '2026-11-11T05:01:00Z', step_index: 1, status: 'DONE', content: 'Ok', tool_calls: [] },
      ]);
      writeJsonl(agHome, 'p1', [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:01:30Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [{ name: 'send_message', args: { Recipient: 'c1', Message: 'Tambahan cepat' } }],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      assert.deepEqual(res.runs[0].segs, [['2026-11-11T05:00:00Z', null]]);
      assert.deepEqual(res.runs[0].resumes, ['2026-11-11T05:01:30Z']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('never reduces prior accumulated tokens when a streaming step completes with 0 tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-tok-zero-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);
      const mainId = 'main-tok-zero';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'Token Zero Edge',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
      ]);

      writeJsonl(agHome, mainId, [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:00Z',
          step_index: 1,
          status: 'DONE',
          input_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 0,
          tool_calls: [{ name: 'list_dir', args: { DirectoryPath: projDir } }],
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:05Z',
          step_index: 2,
          status: 'RUNNING',
          input_tokens: 50,
          output_tokens: 20,
          cache_read_tokens: 5,
          tool_calls: [],
        },
        {
          // Step 2 selesai/dibatalkan dengan angka token 0 pada created_at baru → tidak boleh mengurangi akumulasi sebelumnya
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:06Z',
          step_index: 2,
          status: 'DONE',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          content: 'Dibatalkan',
          tool_calls: [],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      assert.equal(res.mains[0].tokens.input, 150);
      assert.equal(res.mains[0].tokens.output, 30);
      assert.equal(res.mains[0].tokens.cache_read, 5);
      assert.equal(res.mains[0].tokens.total, 185);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips empty string arg keys in argStr and falls back to secondary keys', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-argstr-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);
      const mainId = 'main-argstr';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: mainId,
          title: 'ArgStr Fallback',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
      ]);

      writeJsonl(agHome, mainId, [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:00Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [
            {
              name: 'view_file',
              args: { Path: '""', AbsolutePath: path.join(projDir, 'src', 'fallback.mjs') },
            },
            {
              name: 'grep_search',
              args: { Query: '   ', Pattern: 'handleAuth' },
            },
          ],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const events = res.mains[0].events;
      assert.ok(events.some((e) => e.tool === 'view_file' && e.text === 'Baca src/fallback.mjs'));
      assert.ok(events.some((e) => e.tool === 'grep_search' && e.text === 'Cari: handleAuth'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('discards failed invoke_subagent from pendingSubagents and resets stale pending queue on USER_INPUT', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-fail-sub-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);

      const parentId = 'parent-fail-sub';
      const childGoodId = 'child-good-2';
      const childTurn2Id = 'child-turn-2';

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: parentId,
          title: 'Parent',
          last_modified_time: '2026-11-11T05:20:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
        {
          conversation_id: childGoodId,
          title: 'Child Good',
          last_modified_time: '2026-11-11T05:20:00Z',
          workspace_uris: projUri,
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
        {
          conversation_id: childTurn2Id,
          title: 'Child Turn 2',
          last_modified_time: '2026-11-11T05:21:00Z',
          workspace_uris: projUri,
          parent_conversation_id: parentId,
          nesting_depth: 1,
        },
      ]);

      writeJsonl(agHome, parentId, [
        {
          // invoke_subagent pertama gagal → GENERIC status ERROR tanpa conversationId
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:00Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Role: 'Failed Subagent', Model: 'flash', TypeName: 'frontend-ui-dev', Prompt: 'Should be discarded' },
            },
          ],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T05:00:01Z',
          step_index: 2,
          status: 'ERROR',
          error: 'Failed to launch subagent',
          content: '',
        },
        {
          // invoke_subagent kedua berhasil → wajib berpasangan dengan Role/Model panggilan kedua!
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:00:10Z',
          step_index: 3,
          status: 'DONE',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Role: 'Backend Architect', Model: 'gemini-2.5-pro', TypeName: 'backend-architect', Prompt: 'Design API' },
            },
          ],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T05:00:11Z',
          step_index: 4,
          status: 'DONE',
          content: `Created the following subagent:\n{"conversationId":"${childGoodId}"}`,
        },
        {
          // invoke_subagent tanpa GENERIC lalu USER_INPUT baru → entri stale dibersihkan
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:01:00Z',
          step_index: 5,
          status: 'DONE',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Role: 'Orphaned Subagent', Model: 'flash', TypeName: 'research', Prompt: 'Never completed' },
            },
          ],
        },
        {
          type: 'USER_INPUT',
          created_at: '2026-11-11T05:02:00Z',
          step_index: 6,
          content: 'Turn baru',
        },
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:02:05Z',
          step_index: 7,
          status: 'DONE',
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Role: 'QA Engineer', Model: 'pro', TypeName: 'qa-security-engineer', Prompt: 'Run tests' },
            },
          ],
        },
        {
          type: 'GENERIC',
          created_at: '2026-11-11T05:02:06Z',
          step_index: 8,
          status: 'DONE',
          content: `Created the following subagent:\n{"conversationId":"${childTurn2Id}"}`,
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      const runGood = res.runs.find((r) => r.id === childGoodId);
      assert.ok(runGood);
      assert.equal(runGood.role, 'Backend Architect');
      assert.equal(runGood.model, 'gemini-2.5-pro');
      assert.equal(runGood.agentType, 'backend-architect');
      assert.equal(runGood.description, 'Design API');

      const runTurn2 = res.runs.find((r) => r.id === childTurn2Id);
      assert.ok(runTurn2);
      assert.equal(runTurn2.role, 'QA Engineer');
      assert.equal(runTurn2.model, 'pro');
      assert.equal(runTurn2.agentType, 'qa-security-engineer');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('orders resume before stop on identical timestamps in mergeResumesAndStops', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-tr-tie-'));
    try {
      const agHome = path.join(tmpDir, 'antigravity');
      const projDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projDir, { recursive: true });
      const projUri = JSON.stringify([pathToFileURL(projDir).href]);
      const nowSec = Math.floor(Date.parse('2026-11-11T06:00:00Z') / 1000);

      createDb(path.join(agHome, 'conversation_summaries.db'), [
        {
          conversation_id: 'p-tie',
          title: 'Parent Tie',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          nesting_depth: 0,
        },
        {
          conversation_id: 'c-tie',
          title: 'Child Tie',
          last_modified_time: '2026-11-11T05:10:00Z',
          workspace_uris: projUri,
          parent_conversation_id: 'p-tie',
          nesting_depth: 1,
        },
      ]);

      writeJsonl(agHome, 'c-tie', [
        { type: 'USER_INPUT', created_at: '2026-11-11T05:00:00Z', step_index: 0 },
        { type: 'PLANNER_RESPONSE', created_at: '2026-11-11T05:01:00Z', step_index: 1, status: 'DONE', content: 'Done', tool_calls: [] },
      ]);
      writeJsonl(agHome, 'p-tie', [
        {
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-11T05:05:00Z',
          step_index: 1,
          status: 'DONE',
          tool_calls: [
            { name: 'send_message', args: { Recipient: 'c-tie', Message: 'Wake' } },
            { name: 'manage_subagents', args: { Action: 'kill', ConversationIds: ['c-tie'] } },
          ],
        },
      ]);

      const res = withEnvHome(agHome, () => {
        const scanner = new TranscriptScanner(null, { window_days: 7, cooldown: 60 });
        return scanner.scan(projDir, nowSec);
      });

      // Pada timestamp identik 05:05:00Z, resume membuka segmen lalu stop langsung menutupnya (tidak menggantung [T, null])
      assert.deepEqual(res.runs[0].segs, [
        ['2026-11-11T05:00:00Z', '2026-11-11T05:01:00Z'],
        ['2026-11-11T05:05:00Z', '2026-11-11T05:05:00Z'],
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
