import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  scanArtifacts,
  extractTodos,
  readSafeArtifact,
} from '../skills/kantor-agent/runtime/lib/artifacts.mjs';

function makeTempDir(prefix = 'kantor-artifacts-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe('artifacts.mjs', () => {
  describe('scanArtifacts', () => {
    it('returns empty array when brainDir is missing, null, or not a directory', () => {
      assert.deepEqual(scanArtifacts('12345678-1234-1234-1234-123456789abc', null), []);
      assert.deepEqual(scanArtifacts('12345678-1234-1234-1234-123456789abc', undefined), []);
      assert.deepEqual(scanArtifacts('12345678-1234-1234-1234-123456789abc', 'C:\\non-existent-brain-dir-xyz'), []);
    });

    it('excludes .system_generated, .user_uploaded, scratch, dotfiles, *.metadata.json, and non-whitelisted files', () => {
      const tmp = makeTempDir();
      try {
        const convId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
        const brain = path.join(tmp, 'brain', convId);
        fs.mkdirSync(brain, { recursive: true });

        // Excluded folders & files
        fs.mkdirSync(path.join(brain, '.system_generated', 'logs'), { recursive: true });
        fs.writeFileSync(path.join(brain, '.system_generated', 'logs', 'transcript.jsonl'), '{"type":"GENERIC"}\n');

        fs.mkdirSync(path.join(brain, '.user_uploaded'), { recursive: true });
        fs.writeFileSync(path.join(brain, '.user_uploaded', 'raw.txt'), 'some uploaded text\n');

        fs.mkdirSync(path.join(brain, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(brain, 'scratch', 'temp.md'), '# scratch\n');

        fs.mkdirSync(path.join(brain, '.hidden_dir'), { recursive: true });
        fs.writeFileSync(path.join(brain, '.hidden_dir', 'hidden.md'), '# hidden\n');

        fs.writeFileSync(path.join(brain, '.DS_Store'), 'dummy');
        fs.writeFileSync(path.join(brain, '.dotfile.txt'), 'hidden file');

        // Non-whitelisted extension
        fs.writeFileSync(path.join(brain, 'script.py'), 'print("hello")\n');
        fs.writeFileSync(path.join(brain, 'data.csv'), 'a,b,c\n');
        fs.writeFileSync(path.join(brain, 'binary.exe'), 'mz\n');

        // Allowed files
        fs.writeFileSync(path.join(brain, 'task.md'), '# Task list\n- [ ] Todo item\n');
        fs.writeFileSync(path.join(brain, 'task.md.metadata.json'), JSON.stringify({
          summary: 'Daftar tugas utama project',
          updatedAt: '2026-11-11T09:00:00.000Z',
          userFacing: true,
        }));

        fs.mkdirSync(path.join(brain, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(brain, 'reports', 'summary.txt'), 'Report summary content');

        const items = scanArtifacts(convId, brain);
        assert.equal(items.length, 2);

        const names = items.map((x) => x.name);
        assert.ok(names.includes('task.md'));
        assert.ok(names.includes('reports/summary.txt'));

        const taskItem = items.find((x) => x.name === 'task.md');
        assert.equal(taskItem.conv_id, convId);
        assert.equal(taskItem.kind, 'md');
        assert.equal(taskItem.previewable, true);
        assert.equal(taskItem.summary, 'Daftar tugas utama project');
        assert.equal(taskItem.updated_at, '2026-11-11T09:00:00.000Z');
        assert.equal(taskItem.user_facing, true);

        const summaryItem = items.find((x) => x.name === 'reports/summary.txt');
        assert.equal(summaryItem.conv_id, convId);
        assert.equal(summaryItem.kind, 'txt');
        assert.equal(summaryItem.previewable, true);
        assert.equal(summaryItem.summary, '');
        assert.equal(summaryItem.user_facing, false);
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('redacts sensitive tokens in metadata summary and enforces safeLine clip limit', () => {
      const tmp = makeTempDir();
      try {
        const convId = 'b2c3d4e5-f6a7-8b9c-0d1e-2f3a4b5c6d7e';
        const brain = path.join(tmp, 'brain', convId);
        fs.mkdirSync(brain, { recursive: true });

        const longSummary = 'Kunci rahasia: token: secret12345 dan sk-abcdef1234567890 ' + 'A'.repeat(300);
        fs.writeFileSync(path.join(brain, 'spec.json'), '{"name":"api"}\n');
        fs.writeFileSync(path.join(brain, 'spec.json.metadata.json'), JSON.stringify({
          summary: longSummary,
          userFacing: true,
        }));

        const items = scanArtifacts(convId, brain);
        assert.equal(items.length, 1);
        const specItem = items[0];
        assert.equal(specItem.name, 'spec.json');
        assert.equal(specItem.kind, 'json');
        assert.equal(specItem.previewable, true);
        assert.ok(!specItem.summary.includes('secret12345'));
        assert.ok(!specItem.summary.includes('sk-abcdef1234567890'));
        assert.ok(specItem.summary.includes('token: •••'));
        assert.ok(specItem.summary.includes('sk-•••'));
        assert.ok(specItem.summary.length <= 200);
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('sorts newest updated_at / mtime first with deterministic tie-break and limits to 12 items', () => {
      const tmp = makeTempDir();
      try {
        const convId = 'c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f';
        const brain = path.join(tmp, 'brain', convId);
        fs.mkdirSync(brain, { recursive: true });

        // Create 15 artifact files
        for (let i = 1; i <= 15; i++) {
          const num = String(i).padStart(2, '0');
          const fileName = `doc-${num}.md`;
          const filePath = path.join(brain, fileName);
          fs.writeFileSync(filePath, `# Document ${num}\n`);

          const minute = String(i).padStart(2, '0');
          fs.writeFileSync(filePath + '.metadata.json', JSON.stringify({
            summary: `Doc ${num}`,
            updatedAt: `2026-11-11T10:${minute}:00.000Z`,
          }));
        }

        const items = scanArtifacts(convId, brain);
        assert.equal(items.length, 12);
        // Newest (doc-15) should be first, doc-04 should be 12th
        assert.equal(items[0].name, 'doc-15.md');
        assert.equal(items[1].name, 'doc-14.md');
        assert.equal(items[11].name, 'doc-04.md');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('ignores symlinks that point outside of brainDir', () => {
      const tmp = makeTempDir();
      try {
        const convId = 'd4e5f6a7-b89c-0d1e-2f3a-4b5c6d7e8f90';
        const brain = path.join(tmp, 'brain', convId);
        fs.mkdirSync(brain, { recursive: true });

        const outsideDir = path.join(tmp, 'outside');
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.writeFileSync(path.join(outsideDir, 'external-secret.md'), 'sensitive outer content\n');

        // Safe inside file
        fs.writeFileSync(path.join(brain, 'valid.md'), '# Valid inside\n');

        // Malicious symlink pointing outside
        try {
          fs.symlinkSync(
            path.join(outsideDir, 'external-secret.md'),
            path.join(brain, 'escaped-link.md'),
            'file',
          );
        } catch {
          // If OS forbids symlink, skip
        }

        const items = scanArtifacts(convId, brain);
        const names = items.map((x) => x.name);
        assert.ok(names.includes('valid.md'));
        assert.ok(!names.includes('escaped-link.md'));
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('identifies image and pdf kinds with previewable === true', () => {
      const tmp = makeTempDir();
      try {
        const convId = 'e5f6a7b8-9c0d-1e2f-3a4b-5c6d7e8f9012';
        const brain = path.join(tmp, 'brain', convId);
        fs.mkdirSync(brain, { recursive: true });

        fs.writeFileSync(path.join(brain, 'mock.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(path.join(brain, 'mock.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
        fs.writeFileSync(path.join(brain, 'mock.webp'), Buffer.from('RIFF....WEBP'));
        fs.writeFileSync(path.join(brain, 'mock.pdf'), Buffer.from('%PDF-1.4'));

        const items = scanArtifacts(convId, brain);
        assert.equal(items.length, 4);

        const png = items.find((x) => x.name === 'mock.png');
        assert.equal(png.kind, 'image');
        assert.equal(png.previewable, true);

        const pdf = items.find((x) => x.name === 'mock.pdf');
        assert.equal(pdf.kind, 'pdf');
        assert.equal(pdf.previewable, true);
      } finally {
        cleanTempDir(tmp);
      }
    });
  });

  describe('extractTodos', () => {
    it('returns null when brainDir is missing or contains no markdown files', () => {
      assert.equal(extractTodos(null), null);
      assert.equal(extractTodos(undefined), null);
      assert.equal(extractTodos('C:\\non-existent-brain-dir-xyz'), null);

      const tmp = makeTempDir();
      try {
        assert.equal(extractTodos(tmp), null);
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('prioritizes task.md at top level and parses checklist items with status mapping', () => {
      const tmp = makeTempDir();
      try {
        const content = [
          '# Task List',
          '',
          '- [ ] Siapkan skema database',
          '- [/] Implementasikan auth middleware',
          '- [x] Buat arsitektur backend',
          '- [X] Tulis unit test util.mjs',
          '* [ ] Gunakan tanda bintang untuk checklist',
          '1. [/] Gunakan penomoran untuk checklist',
          'Paragraf biasa bukan checklist',
          '> Quote bukan checklist',
          '- [ ]    ', // Kosong setelah dibersihkan, harus diskip
          '- [ ] Gunakan sk-live-secret-token-12345678 untuk API',
        ].join('\n');

        fs.writeFileSync(path.join(tmp, 'task.md'), content);
        fs.writeFileSync(path.join(tmp, 'task.md.metadata.json'), JSON.stringify({
          updatedAt: '2026-11-11T10:15:30.000Z',
        }));

        const result = extractTodos(tmp);
        assert.ok(result);
        assert.equal(result.source, 'task.md');
        assert.equal(result.at, '2026-11-11T10:15:30.000Z');
        assert.equal(result.items.length, 7);

        assert.deepEqual(result.items[0], {
          text: 'Siapkan skema database',
          status: 'pending',
        });
        assert.deepEqual(result.items[1], {
          text: 'Implementasikan auth middleware',
          status: 'in_progress',
        });
        assert.deepEqual(result.items[2], {
          text: 'Buat arsitektur backend',
          status: 'completed',
        });
        assert.deepEqual(result.items[3], {
          text: 'Tulis unit test util.mjs',
          status: 'completed',
        });
        assert.deepEqual(result.items[4], {
          text: 'Gunakan tanda bintang untuk checklist',
          status: 'pending',
        });
        assert.deepEqual(result.items[5], {
          text: 'Gunakan penomoran untuk checklist',
          status: 'in_progress',
        });
        // Sensitive token redacted
        assert.ok(!result.items[6].text.includes('sk-live-secret-token-12345678'));
        assert.ok(result.items[6].text.includes('sk-•••'));
        assert.equal(result.items[6].status, 'pending');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('caps extracted checklist items to maximum 40 items', () => {
      const tmp = makeTempDir();
      try {
        const lines = ['# Big Task List'];
        for (let i = 1; i <= 60; i++) {
          lines.push(`- [ ] Item tugas ke-${i}`);
        }
        fs.writeFileSync(path.join(tmp, 'task.md'), lines.join('\n'));

        const result = extractTodos(tmp);
        assert.ok(result);
        assert.equal(result.items.length, 40);
        assert.equal(result.items[0].text, 'Item tugas ke-1');
        assert.equal(result.items[39].text, 'Item tugas ke-40');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('falls back to newest .md containing checklist when task.md is absent or has no checklist', () => {
      const tmp = makeTempDir();
      try {
        // task.md exists but has no checklist
        fs.writeFileSync(path.join(tmp, 'task.md'), '# Just a header\nNo checklist here.\n');

        // sub/plan-old.md
        fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
        const oldFile = path.join(tmp, 'sub', 'plan-old.md');
        fs.writeFileSync(oldFile, '- [x] Old plan step\n');
        fs.writeFileSync(oldFile + '.metadata.json', JSON.stringify({
          updatedAt: '2026-11-10T10:00:00.000Z',
        }));

        // plan-new.md
        const newFile = path.join(tmp, 'plan-new.md');
        fs.writeFileSync(newFile, '- [/] New plan step 1\n- [ ] New plan step 2\n');
        fs.writeFileSync(newFile + '.metadata.json', JSON.stringify({
          updatedAt: '2026-11-11T12:00:00.000Z',
        }));

        const result = extractTodos(tmp);
        assert.ok(result);
        assert.equal(result.source, 'plan-new.md');
        assert.equal(result.at, '2026-11-11T12:00:00.000Z');
        assert.equal(result.items.length, 2);
        assert.equal(result.items[0].text, 'New plan step 1');
        assert.equal(result.items[0].status, 'in_progress');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('returns null if all markdown files contain no checklist items', () => {
      const tmp = makeTempDir();
      try {
        fs.writeFileSync(path.join(tmp, 'notes.md'), '# Just notes\nNo boxes here.\n');
        fs.writeFileSync(path.join(tmp, 'readme.md'), '# Readme\nStill no boxes.\n');
        assert.equal(extractTodos(tmp), null);
      } finally {
        cleanTempDir(tmp);
      }
    });
  });

  describe('readSafeArtifact (Review Focus #2b)', () => {
    const validConvId = 'f1a2b3c4-d5e6-4a7b-8c9d-0e1f2a3b4c5d';

    it('rejects invalid or unallowed convId with status 404', () => {
      const allowed = new Set([validConvId]);

      // Invalid UUID formats
      let res = readSafeArtifact({ convId: 'invalid-id', relPath: 'task.md', allowedConvIds: allowed });
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);
      assert.equal(res.error, 'Artifact tidak ditemukan');

      res = readSafeArtifact({ convId: '../../etc/passwd', relPath: 'task.md', allowedConvIds: allowed });
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);

      // Not in allowedConvIds
      const anotherConv = '11111111-2222-3333-4444-555555555555';
      res = readSafeArtifact({ convId: anotherConv, relPath: 'task.md', allowedConvIds: allowed });
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);
      assert.equal(res.error, 'Artifact tidak ditemukan');
    });

    it('returns 404 when brainDir cannot be resolved', () => {
      const allowed = new Set([validConvId]);
      const res = readSafeArtifact({
        convId: validConvId,
        relPath: 'task.md',
        allowedConvIds: allowed,
        roots: ['C:\\empty-test-roots-xyz'],
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 404);
      assert.equal(res.error, 'Direktori brain tidak ditemukan');
    });

    it('rejects path traversal, null bytes, absolute paths, and prohibited paths with status 403', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });
        fs.writeFileSync(path.join(brain, 'task.md'), '# Valid\n');

        const allowed = new Set([validConvId]);
        const testRoots = [root];

        const badPaths = [
          '',
          null,
          undefined,
          '../outside.txt',
          'sub/../../outside.txt',
          'task.md\0.txt',
          '/task.md',
          '\\task.md',
          'C:/Windows/win.ini',
          'D:\\something.txt',
          'file:stream.txt',
          '.system_generated/logs/transcript.jsonl',
          '.user_uploaded/document.pdf',
          'scratch/draft.md',
          '.hidden/file.md',
          'task.md.metadata.json',
          'unsupported.py',
          'binary.exe',
          'archive.zip',
        ];

        for (const bad of badPaths) {
          const res = readSafeArtifact({
            convId: validConvId,
            relPath: bad,
            allowedConvIds: allowed,
            roots: testRoots,
          });
          assert.equal(res.ok, false, `Expected failure for path: ${bad}`);
          assert.equal(res.status, 403, `Expected status 403 for path: ${bad}`);
          assert.equal(res.error, 'Akses artifact ditolak');
        }
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('rejects symlinks that escape brainDir with status 403', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });

        const outsideSecret = path.join(tmp, 'secret.md');
        fs.writeFileSync(outsideSecret, 'SUPER_SECRET_EXTERNAL_CONTENT\n');

        const symlinkPath = path.join(brain, 'escape.md');
        try {
          fs.symlinkSync(outsideSecret, symlinkPath, 'file');
        } catch {
          // If OS forbids symlink, skip
        }

        const allowed = new Set([validConvId]);
        const res = readSafeArtifact({
          convId: validConvId,
          relPath: 'escape.md',
          allowedConvIds: allowed,
          roots: [root],
        });

        assert.equal(res.ok, false);
        assert.equal(res.status, 403);
        assert.equal(res.error, 'Akses artifact ditolak');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('returns 404 when file does not exist in brainDir', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });

        const allowed = new Set([validConvId]);
        const res = readSafeArtifact({
          convId: validConvId,
          relPath: 'not-found.md',
          allowedConvIds: allowed,
          roots: [root],
        });

        assert.equal(res.ok, false);
        assert.equal(res.status, 404);
        assert.equal(res.error, 'Artifact tidak ditemukan');
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('enforces size limits: 256 KB text, 5 MB image, 10 MB PDF with status 413', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });

        const allowed = new Set([validConvId]);

        // Oversized text file (> 256 KB)
        const bigText = path.join(brain, 'big.txt');
        fs.writeFileSync(bigText, Buffer.alloc(256 * 1024 + 10, 'A'));

        let res = readSafeArtifact({
          convId: validConvId,
          relPath: 'big.txt',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, 413);
        assert.equal(res.error, 'Ukuran artifact melebihi batas');

        // Text file within limit (<= 256 KB)
        const okText = path.join(brain, 'ok.txt');
        fs.writeFileSync(okText, Buffer.alloc(1024, 'A'));
        res = readSafeArtifact({
          convId: validConvId,
          relPath: 'ok.txt',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(res.ok, true);
        assert.equal(res.status, 200);

        // Oversized image (> 5 MB)
        const bigImg = path.join(brain, 'big.png');
        fs.writeFileSync(bigImg, Buffer.alloc(5 * 1024 * 1024 + 10));
        res = readSafeArtifact({
          convId: validConvId,
          relPath: 'big.png',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, 413);

        // Oversized PDF (> 10 MB)
        const bigPdf = path.join(brain, 'big.pdf');
        fs.writeFileSync(bigPdf, Buffer.alloc(10 * 1024 * 1024 + 10));
        res = readSafeArtifact({
          convId: validConvId,
          relPath: 'big.pdf',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, 413);
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('redacts sensitive content in text/md files and sets local_path only when isLoopback is true', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });

        const rawContent = [
          '# Technical Specification',
          'API Key: sk-live-secret-super-key-998877',
          'Token: gh_token=ghp_123456789012345678901234567890',
          'Database: postgres://app:s3cretPassword@localhost:5432/db',
          'Admin contact: admin@example.com',
        ].join('\n');

        const filePath = path.join(brain, 'secret-doc.md');
        fs.writeFileSync(filePath, rawContent);
        fs.writeFileSync(filePath + '.metadata.json', JSON.stringify({
          summary: 'Dokumen arsitektur rahasia dengan sk-secret-token-12345678',
          updatedAt: '2026-11-11T11:00:00.000Z',
          userFacing: true,
        }));

        const allowed = new Set([validConvId]);

        // When isLoopback === true
        const loopbackRes = readSafeArtifact({
          convId: validConvId,
          relPath: 'secret-doc.md',
          allowedConvIds: allowed,
          roots: [root],
          isLoopback: true,
        });

        assert.equal(loopbackRes.ok, true);
        assert.equal(loopbackRes.status, 200);
        assert.equal(loopbackRes.kind, 'json');
        assert.equal(loopbackRes.contentType, 'application/json; charset=utf-8');

        const data1 = loopbackRes.data;
        assert.equal(data1.conv_id, validConvId);
        assert.equal(data1.name, 'secret-doc.md');
        assert.equal(data1.updated_at, '2026-11-11T11:00:00.000Z');
        assert.ok(data1.local_path !== null);
        assert.ok(typeof data1.local_path === 'string');
        assert.ok(data1.local_path.endsWith('secret-doc.md'));

        // Verify redaction in content
        assert.ok(!data1.content.includes('sk-live-secret-super-key-998877'));
        assert.ok(data1.content.includes('sk-•••'));
        assert.ok(!data1.content.includes('ghp_123456789012345678901234567890'));
        assert.ok(!data1.content.includes('s3cretPassword'));
        assert.ok(!data1.content.includes('admin@example.com'));

        // Verify redaction in summary
        assert.ok(!data1.summary.includes('sk-secret-token-12345678'));
        assert.ok(data1.summary.includes('sk-•••'));

        // When isLoopback === false
        const nonLoopbackRes = readSafeArtifact({
          convId: validConvId,
          relPath: 'secret-doc.md',
          allowedConvIds: allowed,
          roots: [root],
          isLoopback: false,
        });

        assert.equal(nonLoopbackRes.ok, true);
        assert.equal(nonLoopbackRes.data.local_path, null);
      } finally {
        cleanTempDir(tmp);
      }
    });

    it('returns raw binary buffer and correct contentType for image and PDF files', () => {
      const tmp = makeTempDir();
      try {
        const root = path.join(tmp, 'gemini-root');
        const brain = path.join(root, 'brain', validConvId);
        fs.mkdirSync(brain, { recursive: true });

        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        fs.writeFileSync(path.join(brain, 'image.png'), pngHeader);

        const pdfHeader = Buffer.from('%PDF-1.7 mock document body');
        fs.writeFileSync(path.join(brain, 'document.pdf'), pdfHeader);

        const allowed = new Set([validConvId]);

        // PNG test
        const pngRes = readSafeArtifact({
          convId: validConvId,
          relPath: 'image.png',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(pngRes.ok, true);
        assert.equal(pngRes.kind, 'file');
        assert.equal(pngRes.contentType, 'image/png');
        assert.ok(Buffer.isBuffer(pngRes.data));
        assert.deepEqual(pngRes.data, pngHeader);

        // PDF test
        const pdfRes = readSafeArtifact({
          convId: validConvId,
          relPath: 'document.pdf',
          allowedConvIds: allowed,
          roots: [root],
        });
        assert.equal(pdfRes.ok, true);
        assert.equal(pdfRes.kind, 'file');
        assert.equal(pdfRes.contentType, 'application/pdf');
        assert.ok(Buffer.isBuffer(pdfRes.data));
        assert.deepEqual(pdfRes.data, pdfHeader);
      } finally {
        cleanTempDir(tmp);
      }
    });
  });
});
