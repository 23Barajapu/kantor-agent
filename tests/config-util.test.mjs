import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  normalizeWorkspacePath,
  redact,
  safeLine,
  oneLine,
  firstLine,
  tsMs,
  isoMs,
  hash,
  strcmp,
  clip,
  mbLen,
  cmpNum,
  isObj,
  isPlainObj,
  values,
  phpTrim,
  phpLtrim,
  splitR,
  basename,
  isDir,
  isFile,
  mtimeSec,
  readText,
  globDir,
} from '../skills/kantor-agent/runtime/lib/util.mjs';

import {
  CONFIG_REL,
  cleanName,
  loadDefaults,
  loadConfig,
} from '../skills/kantor-agent/runtime/lib/config.mjs';

describe('util.mjs', () => {
  describe('normalizeWorkspacePath', () => {
    it('normalizes file:// URI and local path to the same canonical representation', () => {
      // Create a temporary directory to test realpath resolution
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-norm-'));
      try {
        const p1 = normalizeWorkspacePath(tmpDir);
        // file URL with mixed slashes / encoding
        const fileUrl = 'file:///' + tmpDir.replace(/\\/g, '/');
        const p2 = normalizeWorkspacePath(fileUrl);
        assert.equal(p1, p2);

        // Windows drive letter URI with percent encoding: file:///c%3A/...
        if (process.platform === 'win32') {
          const driveMatch = tmpDir.match(/^([a-zA-Z]):[\\/](.*)$/);
          if (driveMatch) {
            const encodedUrl = `file:///${driveMatch[1]}%3A/${driveMatch[2].replace(/\\/g, '/')}`;
            const p3 = normalizeWorkspacePath(encodedUrl);
            assert.equal(p1, p3);
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('matches brief requirements on Windows path normalization', () => {
      // Test the exact scenario from brief:
      // normalizeWorkspacePath('file:///c%3A/Laragon/www/kantor-agent/') === normalizeWorkspacePath('C:\\laragon\\www\\kantor-agent')
      const p1 = normalizeWorkspacePath('file:///c%3A/Laragon/www/kantor-agent/');
      const p2 = normalizeWorkspacePath('C:\\laragon\\www\\kantor-agent');
      if (process.platform === 'win32') {
        assert.equal(p1, p2);
        assert.ok(!p1.endsWith('/'), 'trailing slash should be stripped for non-root paths');
        assert.ok(!p1.includes('\\'), 'slashes should be forward slashes');
        assert.equal(p1, p1.toLowerCase(), 'on Windows, path should be lowercase');
      } else {
        // On POSIX, both will normalize slashes and strip trailing slashes
        assert.ok(!p1.endsWith('/'));
      }
    });

    it('handles non-existent paths gracefully without throwing', () => {
      const nonExistent = process.platform === 'win32'
        ? 'C:\\nonexistent_dir_12345\\subfolder\\'
        : '/tmp/nonexistent_dir_12345/subfolder/';
      assert.doesNotThrow(() => {
        const res = normalizeWorkspacePath(nonExistent);
        assert.ok(typeof res === 'string');
        assert.ok(!res.endsWith('/'));
      });
    });

    it('handles root drive and root path without removing required trailing slash', () => {
      if (process.platform === 'win32') {
        assert.equal(normalizeWorkspacePath('C:\\'), 'c:/');
        assert.equal(normalizeWorkspacePath('C:/'), 'c:/');
      } else {
        assert.equal(normalizeWorkspacePath('/'), '/');
      }
    });

    it('handles paths with spaces and encoded characters', () => {
      const uriWithSpace = 'file:///C:/My%20Workspaces/Project%201/';
      const resSpace = normalizeWorkspacePath(uriWithSpace);
      assert.ok(resSpace.includes('my workspaces/project 1'));
      assert.ok(!resSpace.endsWith('/'));
    });

    it('returns empty string for null, undefined, or empty input', () => {
      assert.equal(normalizeWorkspacePath(null), '');
      assert.equal(normalizeWorkspacePath(undefined), '');
      assert.equal(normalizeWorkspacePath(''), '');
      assert.equal(normalizeWorkspacePath('   '), '');
    });
  });

  describe('redact', () => {
    it('redacts api_key, passwords, and tokens', () => {
      assert.equal(redact('api_key=abcdef123456'), 'api_key=•••');
      assert.equal(redact('api-key: my-secret-key'), 'api-key: •••');
      assert.equal(redact('token: secret123'), 'token: •••');
      assert.equal(redact('password="secretpassword"'), 'password=•••');
      assert.equal(redact('sandi: rahasiaku'), 'sandi: •••');
    });

    it('redacts sk- keys, GitHub tokens, AWS keys, and long hashes', () => {
      assert.equal(redact('sk-1234567890abcdef'), 'sk-•••');
      assert.equal(redact('ghp_12345678901234567890'), '•••');
      assert.equal(redact('gho_abcdefghijklmnopqrstuvwx'), '•••');
      assert.equal(redact('AKIA1234567890123456'), '•••');
      // 40+ char hex hash
      const sha1 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      assert.equal(redact(`commit ${sha1}`), 'commit •••');
    });

    it('redacts email addresses and URLs with credentials', () => {
      assert.equal(redact('Contact user@example.com for info'), 'Contact •••@••• for info');
      assert.equal(redact('Clone https://user:pass@host.com/repo.git'), 'Clone https://•••@host.com/repo.git');
    });
  });

  describe('string and formatting helpers', () => {
    it('mbLen counts unicode code points correctly', () => {
      assert.equal(mbLen('hello'), 5);
      assert.equal(mbLen('café'), 4);
      assert.equal(mbLen('👋🌍'), 2);
    });

    it('clip truncates multibyte text with ellipsis', () => {
      assert.equal(clip('hello world', 5), 'hell…');
      assert.equal(clip('hello', 10), 'hello');
      assert.equal(clip('halo dunia', 4), 'hal…');
    });

    it('phpTrim and phpLtrim trim standard whitespace and control chars', () => {
      assert.equal(phpTrim('  abc  \n'), 'abc');
      assert.equal(phpLtrim('  abc  '), 'abc  ');
      assert.equal(phpTrim('//path//', '/'), 'path');
    });

    it('firstLine extracts first non-empty markdown-cleaned line', () => {
      assert.equal(firstLine('# Header 1\nBody text'), 'Header 1');
      assert.equal(firstLine('\n\n* Bullet item\nSecond line'), 'Bullet item');
    });

    it('safeLine cleans and redacts single line with clip length', () => {
      const res = safeLine('# Header with api_key=secret123\nSecond line', 30);
      assert.ok(res.includes('api key=•••') || res.includes('api_key=•••'));
      assert.ok(!res.includes('secret123'));
      assert.ok(!res.includes('#'));
    });

    it('oneLine preserves markdown chars but collapses whitespace and redacts', () => {
      const res = oneLine('`npm run` with token=xyz\nnext line', 40);
      assert.ok(res.includes('`npm run`'));
      assert.ok(res.includes('token=•••'));
    });

    it('splitR splits on various newline characters', () => {
      assert.deepEqual(splitR('a\r\nb\nc\rd'), ['a', 'b', 'c', 'd']);
    });

    it('basename extracts basename and strips suffix', () => {
      assert.equal(basename('path/to/file.txt'), 'file.txt');
      assert.equal(basename('path/to/file.txt', '.txt'), 'file');
      assert.equal(basename('path/to/.txt', '.txt'), '.txt');
    });

    it('strcmp performs byte-order comparison', () => {
      assert.equal(strcmp('a', 'b'), -1);
      assert.equal(strcmp('b', 'a'), 1);
      assert.equal(strcmp('a', 'a'), 0);
    });

    it('hash produces deterministic 32-bit unsigned integer', () => {
      const h1 = hash('test string');
      const h2 = hash('test string');
      assert.equal(h1, h2);
      assert.ok(Number.isInteger(h1));
      assert.ok(h1 >= 0 && h1 < 4294967296);
    });

    it('cmpNum compares numbers correctly', () => {
      assert.equal(cmpNum(1, 2), -1);
      assert.equal(cmpNum(2, 1), 1);
      assert.equal(cmpNum(2, 2), 0);
    });

    it('object helpers check types correctly', () => {
      assert.equal(isObj({}), true);
      assert.equal(isObj([]), true);
      assert.equal(isObj(null), false);
      assert.equal(isPlainObj({}), true);
      assert.equal(isPlainObj([]), false);
      assert.equal(isPlainObj(null), false);
      assert.deepEqual(values([1, 2, 3]), [1, 2, 3]);
      assert.deepEqual(values({ a: 1, b: 2 }), [1, 2]);
      assert.deepEqual(values(null), []);
    });
  });

  describe('time helpers', () => {
    it('tsMs converts ISO 8601 string to UTC epoch milliseconds', () => {
      const iso = '2026-09-29T03:04:05.678Z';
      const ms = tsMs(iso);
      assert.equal(typeof ms, 'number');
      assert.equal(isoMs(ms), iso);
    });

    it('tsMs returns null on invalid timestamp', () => {
      assert.equal(tsMs('invalid-date'), null);
      assert.equal(tsMs(12345), null);
      assert.equal(tsMs(null), null);
    });

    it('isoMs formats milliseconds to ISO string', () => {
      const ms = Date.UTC(2026, 8, 29, 3, 4, 5, 678);
      assert.equal(isoMs(ms), '2026-09-29T03:04:05.678Z');
    });
  });

  describe('fs helpers', () => {
    it('isFile and isDir detect filesystem entries', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-fs-'));
      const tmpFile = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(tmpFile, 'hello world', 'utf8');

      try {
        assert.equal(isDir(tmpDir), true);
        assert.equal(isFile(tmpDir), false);
        assert.equal(isFile(tmpFile), true);
        assert.equal(isDir(tmpFile), false);
        assert.equal(readText(tmpFile), 'hello world');
        assert.ok(mtimeSec(tmpFile) > 0);
        assert.equal(isFile(path.join(tmpDir, 'nonexistent.txt')), false);
        assert.equal(readText(path.join(tmpDir, 'nonexistent.txt')), null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('globDir returns sorted matching files excluding hidden entries', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-glob-'));
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
      fs.writeFileSync(path.join(tmpDir, '.hidden.txt'), 'h', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'c.md'), 'c', 'utf8');

      try {
        const matches = globDir(tmpDir, '.txt');
        assert.equal(matches.length, 2);
        assert.equal(path.basename(matches[0]), 'a.txt');
        assert.equal(path.basename(matches[1]), 'b.txt');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe('config.mjs', () => {
  const runtimeDir = path.resolve('skills/kantor-agent/runtime');

  it('exports CONFIG_REL pointing to .agents/kantor-agent.json', () => {
    assert.equal(CONFIG_REL, '.agents/kantor-agent.json');
  });

  it('cleanName strips control characters and trims', () => {
    assert.equal(cleanName('  Joko \x00\x1f '), 'Joko');
    assert.equal(cleanName(''), null);
    assert.equal(cleanName(123), null);
    assert.equal(cleanName('a'.repeat(30), 10), 'a'.repeat(10));
  });

  it('loadDefaults loads defaults.json correctly with 4 divisions and chat defaults', () => {
    const d = loadDefaults(runtimeDir);
    assert.equal(d.ketua, 'Joko');
    assert.equal(d.ketua_role, 'Lead Architect');
    assert.deepEqual(d.team, ['Budi', 'Sari', 'Agus', 'Rina']);
    assert.equal(d.bind, '127.0.0.1');
    assert.equal(Array.isArray(d.divisions), true);
    assert.equal(d.divisions.length, 4);

    const divIds = d.divisions.map((div) => div.id);
    assert.deepEqual(divIds, ['frontend', 'backend', 'qa', 'product_ops']);

    assert.equal(d.chat.enabled, true);
    assert.equal(d.chat.default_mode, 'accept-edits');
    assert.equal(d.chat.default_model, null);
    assert.equal(d.chat.sandbox, false);
  });

  it('loadConfig merges defaults with project config and resolves bind/sandbox priorities', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-proj-'));
    const agentsDir = path.join(tmpProject, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const overrideConfig = {
      title: 'Custom Kantor Project',
      bind: '192.168.1.100',
      names: {
        ketua: 'Boss',
        team: ['Alice', 'Bob'],
      },
      chat: {
        default_mode: 'plan',
        sandbox: true,
      },
    };
    fs.writeFileSync(
      path.join(tmpProject, CONFIG_REL),
      JSON.stringify(overrideConfig, null, 2),
      'utf8'
    );

    try {
      // 1. Without CLI opts or env: config.bind wins
      const cfg1 = loadConfig(runtimeDir, tmpProject);
      assert.equal(cfg1.title, 'Custom Kantor Project');
      assert.equal(cfg1.ketua, 'Boss');
      assert.equal(cfg1.team[0], 'Alice');
      assert.equal(cfg1.team[1], 'Bob');
      assert.equal(cfg1.team[2], 'Agus'); // fallback from defaults
      assert.equal(cfg1.team[3], 'Rina'); // fallback from defaults
      assert.equal(cfg1.bind, '192.168.1.100');
      assert.equal(cfg1.chat.default_mode, 'plan');
      assert.equal(cfg1.chat.sandbox, true);

      // 2. KANTOR_BIND env overrides config.bind
      process.env.KANTOR_BIND = '10.0.0.1';
      const cfg2 = loadConfig(runtimeDir, tmpProject);
      assert.equal(cfg2.bind, '10.0.0.1');

      // 3. CLI opts.bind overrides KANTOR_BIND
      const cfg3 = loadConfig(runtimeDir, tmpProject, { bind: '0.0.0.0' });
      assert.equal(cfg3.bind, '0.0.0.0');

      // 4. CLI opts.sandbox overrides config.chat.sandbox
      const cfg4 = loadConfig(runtimeDir, tmpProject, { sandbox: false });
      assert.equal(cfg4.chat.sandbox, false);
    } finally {
      delete process.env.KANTOR_BIND;
      delete process.env.KANTOR_SANDBOX;
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  it('loadConfig falls back to defaults when project config is missing or invalid', () => {
    const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-empty-'));
    try {
      const cfg = loadConfig(runtimeDir, tmpEmpty);
      assert.equal(cfg.ketua, 'Joko');
      assert.equal(cfg.ketua_role, 'Lead Architect');
      assert.deepEqual(cfg.team, ['Budi', 'Sari', 'Agus', 'Rina']);
      assert.equal(cfg.bind, '127.0.0.1');
      assert.equal(cfg.chat.enabled, true);
      assert.equal(cfg.chat.default_mode, 'accept-edits');
      assert.equal(cfg.chat.sandbox, false);
      assert.equal(cfg.title, path.basename(tmpEmpty));
    } finally {
      fs.rmSync(tmpEmpty, { recursive: true, force: true });
    }
  });
});
