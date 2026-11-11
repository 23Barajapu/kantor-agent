import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  discoverSurfaceRoots,
  resolveBrainDir,
  scanConversations,
} from '../skills/kantor-agent/runtime/lib/antigravity.mjs';
import { normalizeWorkspacePath } from '../skills/kantor-agent/runtime/lib/util.mjs';

const FULL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    preview TEXT DEFAULT '',
    step_count INTEGER DEFAULT 0,
    last_modified_time TEXT,
    workspace_uris TEXT,
    status TEXT DEFAULT '',
    source TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    agent_name TEXT DEFAULT '',
    parent_conversation_id TEXT DEFAULT '',
    nesting_depth INTEGER DEFAULT 0,
    battle_id TEXT DEFAULT '',
    winning_conversation_id TEXT DEFAULT '',
    not_fully_idle INTEGER DEFAULT 0,
    killed INTEGER DEFAULT 0,
    last_user_input_time TEXT,
    last_user_input_step_index INTEGER DEFAULT -1,
    app_data_dir TEXT DEFAULT '',
    raw_summary BLOB,
    group_id TEXT DEFAULT ''
  );
`;

function createSummaryDb(dbPath, rows = [], schemaSql = FULL_SCHEMA_SQL) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(schemaSql);
    if (rows.length > 0) {
      const insert = db.prepare(`
        INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, agent_name, parent_conversation_id,
          nesting_depth, not_fully_idle, killed, last_user_input_time, app_data_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of rows) {
        insert.run(
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
    }
  } finally {
    db.close();
  }
}

function makeTranscript(rootDir, convId, mtimeSecValue = null) {
  const logsDir = path.join(rootDir, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(filePath, '{"type":"USER_INPUT"}\n', 'utf8');
  if (typeof mtimeSecValue === 'number') {
    const dt = new Date(mtimeSecValue * 1000);
    fs.utimesSync(filePath, dt, dt);
  }
  return filePath;
}

describe('antigravity.mjs', () => {
  describe('discoverSurfaceRoots', () => {
    it('collects existing surface directories in canonical order', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-roots-'));
      const prevEnv = process.env.ANTIGRAVITY_HOME;
      delete process.env.ANTIGRAVITY_HOME;

      try {
        const geminiDir = path.join(tmpHome, '.gemini');
        const cliDir = path.join(geminiDir, 'antigravity-cli');
        const mainDir = path.join(geminiDir, 'antigravity');
        const ideFile = path.join(geminiDir, 'antigravity-ide');

        fs.mkdirSync(cliDir, { recursive: true });
        fs.mkdirSync(mainDir, { recursive: true });
        // antigravity-ide berupa file biasa, bukan direktori → harus diabaikan
        fs.writeFileSync(ideFile, 'not a dir', 'utf8');

        const roots = discoverSurfaceRoots(tmpHome);
        assert.deepEqual(roots, [mainDir, cliDir]);
      } finally {
        if (prevEnv !== undefined) process.env.ANTIGRAVITY_HOME = prevEnv;
        else delete process.env.ANTIGRAVITY_HOME;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it('uses [ANTIGRAVITY_HOME] when set and exists, or [] if missing', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-envhome-'));
      const customRoot = path.join(tmpHome, 'custom-antigravity');
      const geminiMain = path.join(tmpHome, '.gemini', 'antigravity');
      const prevEnv = process.env.ANTIGRAVITY_HOME;

      try {
        fs.mkdirSync(customRoot, { recursive: true });
        fs.mkdirSync(geminiMain, { recursive: true });

        process.env.ANTIGRAVITY_HOME = customRoot;
        assert.deepEqual(discoverSurfaceRoots(tmpHome), [customRoot]);

        process.env.ANTIGRAVITY_HOME = path.join(tmpHome, 'does-not-exist');
        assert.deepEqual(discoverSurfaceRoots(tmpHome), []);

        // String kosong diabaikan → kembali memindai homeDir
        process.env.ANTIGRAVITY_HOME = '   ';
        assert.deepEqual(discoverSurfaceRoots(tmpHome), [geminiMain]);
      } finally {
        if (prevEnv !== undefined) process.env.ANTIGRAVITY_HOME = prevEnv;
        else delete process.env.ANTIGRAVITY_HOME;
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  describe('resolveBrainDir', () => {
    it('rejects invalid or path-traversal conversationIds', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-brain-sec-'));
      try {
        fs.mkdirSync(path.join(tmpRoot, 'brain', 'valid-id-123'), { recursive: true });

        assert.equal(resolveBrainDir('', [tmpRoot]), null);
        assert.equal(resolveBrainDir('   ', [tmpRoot]), null);
        assert.equal(resolveBrainDir(null, [tmpRoot]), null);
        assert.equal(resolveBrainDir('..', [tmpRoot]), null);
        assert.equal(resolveBrainDir('.', [tmpRoot]), null);
        assert.equal(resolveBrainDir('../etc', [tmpRoot]), null);
        assert.equal(resolveBrainDir('a/b', [tmpRoot]), null);
        assert.equal(resolveBrainDir('a\\b', [tmpRoot]), null);
        assert.equal(resolveBrainDir('valid-id..123', [tmpRoot]), null);
        assert.equal(resolveBrainDir('valid-id\0', [tmpRoot]), null);
        assert.equal(resolveBrainDir('C:drive', [tmpRoot]), null);
        assert.equal(resolveBrainDir(' valid-id-123 ', [tmpRoot]), null);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('searches brain/<id> across roots in order and returns first existing dir', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-brain-order-'));
      try {
        const root1 = path.join(tmpDir, 'antigravity');
        const root2 = path.join(tmpDir, 'antigravity-ide');
        const root3 = path.join(tmpDir, 'antigravity-cli');
        fs.mkdirSync(root1, { recursive: true });
        fs.mkdirSync(root2, { recursive: true });
        fs.mkdirSync(root3, { recursive: true });

        // Hanya ada di root3
        const cliBrain = path.join(root3, 'brain', 'conv-cli');
        fs.mkdirSync(cliBrain, { recursive: true });
        assert.equal(resolveBrainDir('conv-cli', [root1, root2, root3]), cliBrain);

        // Ada di root1 dan root3 → root1 menang
        const mainBrain1 = path.join(root1, 'brain', 'conv-both');
        const mainBrain3 = path.join(root3, 'brain', 'conv-both');
        fs.mkdirSync(mainBrain1, { recursive: true });
        fs.mkdirSync(mainBrain3, { recursive: true });
        assert.equal(resolveBrainDir('conv-both', [root1, root2, root3]), mainBrain1);

        // Bila berupa file biasa bukan folder → diabaikan
        fs.mkdirSync(path.join(root1, 'brain'), { recursive: true });
        fs.writeFileSync(path.join(root1, 'brain', 'conv-file'), 'file', 'utf8');
        assert.equal(resolveBrainDir('conv-file', [root1, root2, root3]), null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('scanConversations', () => {
    it('matches encoded file:///c%3A/... workspace_uris against Windows path', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-ws-match-'));
      try {
        const root = path.join(tmpDir, 'antigravity');
        const nowSec = 1_794_450_000; // 2026-11-11ish

        // Uji kecocokan langsung representasi Windows + file:// URI dari spec
        const windowsStyleProj = 'C:\\Users\\test\\proj';
        const encodedWindowsUri = '["file:///c%3A/Users/test/proj"]';

        // Uji juga real temp dir via pathToFileURL
        const realProj = path.join(tmpDir, 'My Project');
        fs.mkdirSync(realProj, { recursive: true });
        const realProjUri = JSON.stringify([pathToFileURL(realProj).href]);

        createSummaryDb(path.join(root, 'conversation_summaries.db'), [
          {
            conversation_id: 'win-uri-conv',
            title: 'Win URI Task',
            last_modified_time: '2026-11-11T03:00:00Z',
            workspace_uris: encodedWindowsUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
            parent_conversation_id: '',
          },
          {
            conversation_id: 'real-uri-conv',
            title: 'Real Dir Task',
            last_modified_time: '2026-11-11 03:00:00.1234567+00:00',
            workspace_uris: realProjUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
            parent_conversation_id: '',
          },
          {
            conversation_id: 'other-proj-conv',
            title: 'Other Project',
            last_modified_time: '2026-11-11T03:00:00Z',
            workspace_uris: '["file:///c%3A/Users/test/other"]',
            nesting_depth: 0,
          },
        ]);

        const scanNow = Math.floor(Date.parse('2026-11-11T04:00:00Z') / 1000);
        if (process.platform === 'win32') {
          const resWin = scanConversations(windowsStyleProj, { window_days: 7 }, scanNow, [root]);
          assert.equal(resWin.exists, true);
          assert.equal(resWin.mains.length, 1);
          assert.equal(resWin.mains[0].conversation_id, 'win-uri-conv');
          assert.equal(normalizeWorkspacePath(windowsStyleProj), normalizeWorkspacePath('file:///c%3A/Users/test/proj'));
        }

        const resReal = scanConversations(realProj, { window_days: 7 }, scanNow, [root]);
        assert.equal(resReal.exists, true);
        assert.equal(resReal.mains.length, 1);
        assert.equal(resReal.mains[0].conversation_id, 'real-uri-conv');
        assert.equal(resReal.mains[0].dbRoot, root);
        assert.ok(resReal.allIds.has('real-uri-conv'));
        assert.ok(!resReal.allIds.has('other-proj-conv'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('Review Focus #1: reads CLI row in main DB with sentinel 0001 timestamp and brain in antigravity-cli', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-rf1-'));
      try {
        const projDir = path.join(tmpDir, 'workspace-proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);

        const mainRoot = path.join(tmpDir, '.gemini', 'antigravity');
        const ideRoot = path.join(tmpDir, '.gemini', 'antigravity-ide');
        const cliRoot = path.join(tmpDir, '.gemini', 'antigravity-cli');
        fs.mkdirSync(mainRoot, { recursive: true });
        fs.mkdirSync(ideRoot, { recursive: true });
        fs.mkdirSync(cliRoot, { recursive: true });

        const nowSec = Math.floor(Date.parse('2026-11-11T04:00:00Z') / 1000);
        const recentTranscriptSec = nowSec - 120;
        const cliConvId = 'cli-session-5598c8cb';

        // Baris CLI tercatat di DB utama dengan timestamp sentinel 0001-01-01
        createSummaryDb(path.join(mainRoot, 'conversation_summaries.db'), [
          {
            conversation_id: cliConvId,
            title: 'CLI Sentinel Session',
            step_count: 12,
            last_modified_time: '0001-01-01 00:00:00+00:00',
            last_user_input_time: '0001-01-01 00:00:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
            app_data_dir: 'antigravity',
            nesting_depth: 0,
            parent_conversation_id: '',
          },
          {
            // Sentinel tanpa transcript.jsonl dan tidak RUNNING → harus tersaring keluar
            conversation_id: 'stale-sentinel-no-transcript',
            title: 'Dead Sentinel',
            last_modified_time: '0001-01-01 00:00:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            nesting_depth: 0,
          },
        ]);

        // Folder brain berada di antigravity-cli/brain/<id> dengan transcript.jsonl baru
        const transcriptFile = makeTranscript(cliRoot, cliConvId, recentTranscriptSec);

        const roots = [mainRoot, ideRoot, cliRoot];
        assert.equal(resolveBrainDir(cliConvId, roots), path.join(cliRoot, 'brain', cliConvId));

        const res = scanConversations(projDir, { window_days: 7, mains_max: 40 }, nowSec, roots);
        assert.equal(res.exists, true);
        assert.equal(res.mains.length, 1);
        assert.equal(res.mains[0].conversation_id, cliConvId);
        assert.equal(res.mains[0].source, 'CORTEX_TRAJECTORY_SOURCE_CLI');
        assert.equal(res.mains[0].dbRoot, mainRoot);
        assert.equal(res.mains[0].brainDir, path.join(cliRoot, 'brain', cliConvId));
        assert.equal(res.mains[0].transcriptPath, transcriptFile);
        assert.equal(res.mains[0].effective_sec, recentTranscriptSec);
        assert.ok(res.allIds.has(cliConvId));
        assert.ok(!res.allIds.has('stale-sentinel-no-transcript'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('deduplicates conversation_id across DBs preferring RUNNING, else newest timestamp, else newest dbRoot', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-dedup-'));
      try {
        const projDir = path.join(tmpDir, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);

        const root1 = path.join(tmpDir, 'antigravity');
        const root2 = path.join(tmpDir, 'antigravity-cli');

        const nowSec = Math.floor(Date.parse('2026-11-11T04:00:00Z') / 1000);

        createSummaryDb(path.join(root1, 'conversation_summaries.db'), [
          {
            conversation_id: 'dup-by-time',
            title: 'Older in root1',
            last_modified_time: '2026-11-11 02:00:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
          {
            conversation_id: 'dup-running-wins',
            title: 'Running in root1',
            last_modified_time: '2026-11-11 01:00:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
          },
          {
            conversation_id: 'dup-tie-root',
            title: 'Tie root1',
            last_modified_time: '2026-11-11 03:30:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        ]);

        createSummaryDb(path.join(root2, 'conversation_summaries.db'), [
          {
            conversation_id: 'dup-by-time',
            title: 'Newer in root2',
            last_modified_time: '2026-11-11 03:45:00.500+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
          {
            conversation_id: 'dup-running-wins',
            title: 'Idle newer in root2',
            last_modified_time: '2026-11-11 03:55:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
          {
            conversation_id: 'dup-tie-root',
            title: 'Tie root2',
            last_modified_time: '2026-11-11 03:30:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
          },
        ]);

        const res = scanConversations(projDir, { window_days: 7 }, nowSec, [root1, root2]);
        assert.equal(res.exists, true);
        assert.equal(res.mains.length, 3);

        const byId = Object.fromEntries(res.mains.map((m) => [m.conversation_id, m]));
        assert.equal(byId['dup-by-time'].title, 'Newer in root2');
        assert.equal(byId['dup-by-time'].dbRoot, root2);

        assert.equal(byId['dup-running-wins'].title, 'Running in root1');
        assert.equal(byId['dup-running-wins'].status, 'CASCADE_RUN_STATUS_RUNNING');
        assert.equal(byId['dup-running-wins'].dbRoot, root1);

        assert.equal(byId['dup-tie-root'].title, 'Tie root2');
        assert.equal(byId['dup-tie-root'].dbRoot, root2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('classifies mains (sorted newest first, sliced to mains_max) and subagents (including parent-linked) within window_days', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-classify-'));
      try {
        const projDir = path.join(tmpDir, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);
        const root = path.join(tmpDir, 'antigravity');
        const nowSec = Math.floor(Date.parse('2026-11-11T12:00:00Z') / 1000);

        createSummaryDb(path.join(root, 'conversation_summaries.db'), [
          {
            conversation_id: 'main-1-older',
            title: 'Main Older',
            last_modified_time: '2026-11-10T10:00:00Z',
            workspace_uris: projUri,
            nesting_depth: 0,
            not_fully_idle: 1,
          },
          {
            conversation_id: 'main-2-newest',
            title: 'Main Newest',
            last_modified_time: '2026-11-11T11:00:00Z',
            workspace_uris: projUri,
            nesting_depth: 0,
          },
          {
            conversation_id: 'main-3-middle',
            title: 'Main Middle',
            last_modified_time: '2026-11-11T05:00:00Z',
            workspace_uris: projUri,
            nesting_depth: 0,
          },
          {
            conversation_id: 'main-expired',
            title: 'Too Old',
            last_modified_time: '2026-11-01T00:00:00Z',
            workspace_uris: projUri,
            nesting_depth: 0,
          },
          {
            conversation_id: 'sub-workspace',
            title: 'Subagent Workspace',
            last_modified_time: '2026-11-11T11:05:00Z',
            workspace_uris: projUri,
            nesting_depth: 1,
            parent_conversation_id: 'main-2-newest',
            agent_name: 'frontend-ui-dev',
          },
          {
            // Subagent dengan workspace_uris kosong tetapi parent adalah percakapan workspace
            conversation_id: 'sub-parent-linked',
            title: 'Subagent Linked',
            last_modified_time: '2026-11-11T11:10:00Z',
            workspace_uris: '',
            nesting_depth: 1,
            parent_conversation_id: 'main-2-newest',
            agent_name: 'qa-security-engineer',
          },
          {
            // Nested subagent tingkat 2 dari sub-parent-linked
            conversation_id: 'sub-nested-2',
            title: 'Nested Subagent',
            last_modified_time: '2026-11-11T11:15:00Z',
            workspace_uris: '[]',
            nesting_depth: 2,
            parent_conversation_id: 'sub-parent-linked',
          },
          {
            // Subagent milik proyek lain → tidak boleh ikut
            conversation_id: 'sub-foreign',
            title: 'Foreign Subagent',
            last_modified_time: '2026-11-11T11:20:00Z',
            workspace_uris: '',
            nesting_depth: 1,
            parent_conversation_id: 'foreign-main',
          },
        ]);

        const res = scanConversations(projDir, { window_days: 7, mains_max: 2 }, nowSec, [root]);
        assert.equal(res.exists, true);
        // mains_max = 2 → hanya 2 main terbaru
        assert.deepEqual(
          res.mains.map((m) => m.conversation_id),
          ['main-2-newest', 'main-3-middle']
        );
        assert.equal(res.subagents.length, 3);
        assert.ok(res.allIds.has('sub-workspace'));
        assert.ok(res.allIds.has('sub-parent-linked'));
        assert.ok(res.allIds.has('sub-nested-2'));
        assert.ok(!res.allIds.has('main-expired'));
        assert.ok(!res.allIds.has('sub-foreign'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles missing, empty, corrupt DBs and DBs missing optional columns without throwing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-resilient-'));
      try {
        const projDir = path.join(tmpDir, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);
        const nowSec = Math.floor(Date.parse('2026-11-11T12:00:00Z') / 1000);

        const missingRoot = path.join(tmpDir, 'missing');
        const emptyDbRoot = path.join(tmpDir, 'empty-db');
        const noTableRoot = path.join(tmpDir, 'no-table');
        const corruptDbRoot = path.join(tmpDir, 'corrupt-db');

        fs.mkdirSync(emptyDbRoot, { recursive: true });
        fs.writeFileSync(path.join(emptyDbRoot, 'conversation_summaries.db'), '');

        fs.mkdirSync(noTableRoot, { recursive: true });
        const noTableDb = new DatabaseSync(path.join(noTableRoot, 'conversation_summaries.db'));
        noTableDb.exec('CREATE TABLE other_table (id TEXT);');
        noTableDb.close();

        fs.mkdirSync(corruptDbRoot, { recursive: true });
        fs.writeFileSync(path.join(corruptDbRoot, 'conversation_summaries.db'), 'not-sqlite-bytes');

        const resEmpty = scanConversations(
          projDir,
          { window_days: 7 },
          nowSec,
          [missingRoot, emptyDbRoot, noTableRoot, corruptDbRoot]
        );
        assert.equal(resEmpty.exists, false);
        assert.deepEqual(resEmpty.mains, []);
        assert.deepEqual(resEmpty.subagents, []);
        assert.equal(resEmpty.allIds.size, 0);

        // DB dengan kolom minimal (tanpa not_fully_idle, killed, app_data_dir, agent_name, dll.)
        const minimalRoot = path.join(tmpDir, 'minimal-cols');
        fs.mkdirSync(minimalRoot, { recursive: true });
        const minDb = new DatabaseSync(path.join(minimalRoot, 'conversation_summaries.db'));
        minDb.exec(`
          CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            last_modified_time TEXT,
            workspace_uris TEXT
          );
        `);
        minDb
          .prepare('INSERT INTO conversation_summaries (conversation_id, last_modified_time, workspace_uris) VALUES (?, ?, ?)')
          .run('minimal-1', '2026-11-11T10:00:00Z', projUri);
        minDb.close();

        const resMin = scanConversations(projDir, { window_days: 7 }, nowSec, [minimalRoot]);
        assert.equal(resMin.exists, true);
        assert.equal(resMin.mains.length, 1);
        assert.equal(resMin.mains[0].conversation_id, 'minimal-1');
        assert.equal(resMin.mains[0].not_fully_idle, 0);
        assert.equal(resMin.mains[0].killed, 0);
        assert.equal(resMin.mains[0].nesting_depth, 0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to last known in-memory rows on transient SQLITE_BUSY lock', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-busy-'));
      let writerDb;
      try {
        const projDir = path.join(tmpDir, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);
        const root = path.join(tmpDir, 'antigravity');
        const dbPath = path.join(root, 'conversation_summaries.db');
        const nowSec = Math.floor(Date.parse('2026-11-11T12:00:00Z') / 1000);

        createSummaryDb(dbPath, [
          {
            conversation_id: 'cached-conv-1',
            title: 'Cached Session',
            last_modified_time: '2026-11-11T11:00:00Z',
            workspace_uris: projUri,
          },
        ]);

        // 1. Pembacaan normal mengisi cache per-DB
        const res1 = scanConversations(projDir, { window_days: 7 }, nowSec, [root]);
        assert.equal(res1.exists, true);
        assert.equal(res1.mains.length, 1);
        assert.equal(res1.mains[0].conversation_id, 'cached-conv-1');

        // 2. Kunci DB dengan transaksi EXCLUSIVE untuk memicu SQLITE_BUSY di pembaca
        writerDb = new DatabaseSync(dbPath);
        writerDb.exec('BEGIN EXCLUSIVE;');
        writerDb
          .prepare('INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris) VALUES (?, ?, ?, ?)')
          .run('new-conv-2', 'New Session', '2026-11-11T11:30:00Z', projUri);

        const resLocked = scanConversations(projDir, { window_days: 7 }, nowSec, [root]);
        assert.equal(resLocked.exists, true);
        assert.equal(resLocked.mains.length, 1);
        assert.equal(resLocked.mains[0].conversation_id, 'cached-conv-1');

        // 3. Commit kunci, pembacaan berikutnya mendapat data terbaru
        writerDb.exec('COMMIT;');
        writerDb.close();
        writerDb = null;

        const res3 = scanConversations(projDir, { window_days: 7 }, nowSec, [root]);
        assert.equal(res3.exists, true);
        assert.equal(res3.mains.length, 2);
        assert.deepEqual(
          res3.mains.map((m) => m.conversation_id),
          ['new-conv-2', 'cached-conv-1']
        );
      } finally {
        try { writerDb?.exec('ROLLBACK;'); } catch {}
        try { writerDb?.close(); } catch {}
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('preserves workspace_uris and metadata when winning duplicate DB row has empty fields, and handles RUNNING sentinel without transcript', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-merge-meta-'));
      try {
        const projDir = path.join(tmpDir, 'proj');
        fs.mkdirSync(projDir, { recursive: true });
        const projUri = JSON.stringify([pathToFileURL(projDir).href]);

        const root1 = path.join(tmpDir, 'antigravity');
        const root2 = path.join(tmpDir, 'antigravity-cli');
        const nowSec = Math.floor(Date.parse('2026-11-11T12:00:00Z') / 1000);

        createSummaryDb(path.join(root1, 'conversation_summaries.db'), [
          {
            conversation_id: 'shared-cli-conv',
            title: 'Rich Title',
            last_modified_time: '2026-11-11 10:00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_IDLE',
            source: 'CORTEX_TRAJECTORY_SOURCE_CLI',
          },
          {
            // Sesi yang baru dibuat dan masih RUNNING walaupun last_modified_time sentinel & belum ada transcript
            conversation_id: 'brand-new-running',
            title: 'Brand New Active',
            last_modified_time: '0001-01-01 00:00:00+00:00',
            workspace_uris: projUri,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            nesting_depth: 0,
          },
        ]);

        // Baris di root2 lebih baru, tetapi workspace_uris dan source kosong (seperti kadang terjadi di antigravity-cli)
        createSummaryDb(path.join(root2, 'conversation_summaries.db'), [
          {
            conversation_id: 'shared-cli-conv',
            title: '',
            last_modified_time: '2026-11-11t11:00:00.1234567890z',
            workspace_uris: '',
            status: '',
            source: '',
          },
        ]);

        const res = scanConversations(projDir, { window_days: 7 }, nowSec, [root1, root2]);
        assert.equal(res.exists, true);
        assert.equal(res.mains.length, 2);
        // brand-new-running diurutkan di depan karena sedang RUNNING (memakai effectiveNow untuk sort)
        assert.equal(res.mains[0].conversation_id, 'brand-new-running');

        const merged = res.mains.find((m) => m.conversation_id === 'shared-cli-conv');
        assert.ok(merged);
        assert.equal(merged.dbRoot, root2);
        assert.equal(merged.title, 'Rich Title');
        assert.equal(merged.source, 'CORTEX_TRAJECTORY_SOURCE_CLI');
        assert.equal(merged.effective_sec, Math.floor(Date.parse('2026-11-11T11:00:00Z') / 1000));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
