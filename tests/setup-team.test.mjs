import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WORKTREE_ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_DIR = path.join(WORKTREE_ROOT, 'skills', 'kantor-agent', 'runtime');
const KANTOR_BIN = path.join(RUNTIME_DIR, 'bin', 'kantor.mjs');
const AGENTS_RESOURCES_DIR = path.join(WORKTREE_ROOT, 'skills', 'kantor-agent', 'resources', 'agents');
const RULES_AGENTS_PATH = path.join(WORKTREE_ROOT, 'rules', 'AGENTS.md');
const SKILL_MD_PATH = path.join(WORKTREE_ROOT, 'skills', 'kantor-agent', 'SKILL.md');
const README_PATH = path.join(WORKTREE_ROOT, 'README.md');

const EXPECTED_AGENT_FILES = [
  'backend-architect.md',
  'frontend-ui-dev.md',
  'product-ops-researcher.md',
  'qa-security-engineer.md',
];

function makeTempDir(prefix = 'kantor-setup-team-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function parseYamlFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const rawYaml = m[1];
  const body = m[2];
  const fields = {};
  const lines = rawYaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '>-' || val === '>' || val === '|-' || val === '|') {
      const blockLines = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        blockLines.push(lines[i].trim());
      }
      val = blockLines.join(' ').trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  return { fields, body };
}

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function runKantorCli(args, envOverrides = {}, cwd = WORKTREE_ROOT) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return execFileAsync(process.execPath, [KANTOR_BIN, ...args], {
    cwd,
    env,
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function killPidBestEffort(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {}
  }
}

describe('Task 9: rules/AGENTS.md, IT specialist templates, setupTeam, and CLI lifecycle', () => {
  it('Review Focus #5: rules/AGENTS.md exists, is <= 6000 UTF-8 bytes, and defines all 4 IT divisions + key installed skills + fallback rules', () => {
    assert.ok(fs.existsSync(RULES_AGENTS_PATH), 'rules/AGENTS.md must exist');
    const buf = fs.readFileSync(RULES_AGENTS_PATH);
    assert.ok(buf.byteLength > 500, 'rules/AGENTS.md must not be trivial/empty');
    assert.ok(buf.byteLength <= 6000, `rules/AGENTS.md must be <= 6000 bytes (got ${buf.byteLength})`);

    const content = buf.toString('utf8');

    // Ketua + 4 specialist desks & TypeNames
    for (const token of [
      'Joko',
      'Frontend & UI',
      'frontend-ui-dev',
      'Budi',
      'Backend & AI',
      'backend-architect',
      'Sari',
      'QA & Security',
      'qa-security-engineer',
      'browser',
      'Agus',
      'Product',
      'product-ops-researcher',
      'research',
      'Rina',
    ]) {
      assert.ok(content.includes(token), `rules/AGENTS.md must mention "${token}"`);
    }

    // Representative installed Antigravity skills across all 4 divisions
    for (const skill of [
      'frontend-ui-engineering',
      'antislop-ui',
      'emil-design-eng',
      'figma-',
      'api-and-interface-design',
      'codebase-design',
      'gemini-api-dev',
      'google-antigravity-sdk',
      'tdd',
      'systematic-debugging',
      'chrome-devtools',
      'security-audit',
      'verification-before-completion',
      'brainstorming',
      'spec-driven-development',
      'ci-cd-and-automation',
      'git-workflow-and-versioning',
    ]) {
      assert.ok(content.includes(skill), `rules/AGENTS.md must mention skill "${skill}"`);
    }

    // Delegation, strict isolation, fallback, security & task.md checklists
    for (const ruleToken of [
      'invoke_subagent',
      'SKILL.md',
      'Freelancer',
      'define_subagent',
      '[Frontend]',
      '[Backend]',
      '[QA]',
      '[Product/Ops]',
      'chat-token',
      'task.md',
    ]) {
      assert.ok(content.includes(ruleToken), `rules/AGENTS.md must mention "${ruleToken}"`);
    }
  });

  it('4 specialist agent templates exist with valid YAML frontmatter and division skill inventories', () => {
    const expectedSpecs = [
      {
        file: 'frontend-ui-dev.md',
        name: 'frontend-ui-dev',
        requiredSkills: ['frontend-ui-engineering', 'antislop-ui', 'figma-', 'a11y-debugging'],
      },
      {
        file: 'backend-architect.md',
        name: 'backend-architect',
        requiredSkills: ['api-and-interface-design', 'codebase-design', 'gemini-api-dev', 'google-antigravity-sdk'],
      },
      {
        file: 'qa-security-engineer.md',
        name: 'qa-security-engineer',
        requiredSkills: ['tdd', 'systematic-debugging', 'security-audit', 'verification-before-completion'],
      },
      {
        file: 'product-ops-researcher.md',
        name: 'product-ops-researcher',
        requiredSkills: ['brainstorming', 'spec-driven-development', 'ci-cd-and-automation', 'git-workflow-and-versioning'],
      },
    ];

    for (const spec of expectedSpecs) {
      const fullPath = path.join(AGENTS_RESOURCES_DIR, spec.file);
      assert.ok(fs.existsSync(fullPath), `${spec.file} must exist`);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = parseYamlFrontmatter(raw);
      assert.ok(parsed, `${spec.file} must have valid YAML frontmatter`);
      assert.equal(parsed.fields.name, spec.name);
      assert.ok(typeof parsed.fields.description === 'string' && parsed.fields.description.length > 20, `${spec.file} description must be informative`);
      assert.equal(parsed.fields.model, 'inherit', `${spec.file} model must be inherit`);
      assert.equal(parsed.fields.workspace, 'inherit', `${spec.file} workspace must be inherit`);
      assert.ok(/Bahasa Indonesia/i.test(parsed.body), `${spec.file} must remind specialist to communicate in Bahasa Indonesia`);

      for (const sk of spec.requiredSkills) {
        assert.ok(parsed.body.includes(sk), `${spec.file} must include skill "${sk}"`);
      }
    }
  });

  it('SKILL.md and README.md exist with required Antigravity plugin & setup-team documentation', () => {
    assert.ok(fs.existsSync(SKILL_MD_PATH), 'skills/kantor-agent/SKILL.md must exist');
    const skillRaw = fs.readFileSync(SKILL_MD_PATH, 'utf8');
    const skillParsed = parseYamlFrontmatter(skillRaw);
    assert.ok(skillParsed, 'SKILL.md must have valid YAML frontmatter');
    assert.equal(skillParsed.fields.name, 'kantor-agent');
    assert.ok(skillParsed.fields.description && skillParsed.fields.description.length > 20);
    assert.ok(skillRaw.includes('kantor.mjs'));
    assert.ok(skillRaw.includes('setup-team'));
    assert.ok(skillRaw.includes('.agents/kantor-agent.json'));

    assert.ok(fs.existsSync(README_PATH), 'README.md must exist');
    const readmeRaw = fs.readFileSync(README_PATH, 'utf8');
    assert.ok(readmeRaw.includes('Kantor Agent'));
    assert.ok(readmeRaw.includes('humaedihume/kantor-agent'));
    assert.ok(readmeRaw.includes('MIT'));
    assert.ok(readmeRaw.includes('setup-team'));
  });

  it('setupTeam() copies 4 templates idempotently to ANTIGRAVITY_CONFIG_DIR and respects force flag', async () => {
    const mod = await import('../skills/kantor-agent/runtime/bin/kantor.mjs');
    assert.equal(typeof mod.setupTeam, 'function', 'kantor.mjs must export setupTeam');

    const tmpRoot = makeTempDir();
    const prevEnv = process.env.ANTIGRAVITY_CONFIG_DIR;
    try {
      const configDir = path.join(tmpRoot, 'agy-config');

      // 1. Initial copy
      const res1 = mod.setupTeam({ configDir, resourcesDir: AGENTS_RESOURCES_DIR, force: false });
      assert.equal(res1.configDir, configDir);
      assert.equal(res1.agentsDir, path.join(configDir, 'agents'));
      assert.deepEqual(res1.copied, EXPECTED_AGENT_FILES);
      assert.deepEqual(res1.skipped, []);

      for (const f of EXPECTED_AGENT_FILES) {
        const dest = path.join(res1.agentsDir, f);
        assert.ok(fs.existsSync(dest), `${dest} should exist after setupTeam`);
      }

      // 2. Simulate user modification and re-run without force
      const targetFile = path.join(res1.agentsDir, 'frontend-ui-dev.md');
      const customContent = fs.readFileSync(targetFile, 'utf8') + '\n<!-- CUSTOM USER MODIFICATION -->\n';
      fs.writeFileSync(targetFile, customContent, 'utf8');

      const res2 = mod.setupTeam({ configDir, resourcesDir: AGENTS_RESOURCES_DIR, force: false });
      assert.deepEqual(res2.copied, []);
      assert.deepEqual(res2.skipped, EXPECTED_AGENT_FILES);
      assert.equal(fs.readFileSync(targetFile, 'utf8'), customContent, 'existing user modification must not be overwritten without force');

      // 3. Re-run with force: true
      const res3 = mod.setupTeam({ configDir, resourcesDir: AGENTS_RESOURCES_DIR, force: true });
      assert.deepEqual(res3.copied, EXPECTED_AGENT_FILES);
      assert.deepEqual(res3.skipped, []);
      assert.equal(
        fs.readFileSync(targetFile, 'utf8'),
        fs.readFileSync(path.join(AGENTS_RESOURCES_DIR, 'frontend-ui-dev.md'), 'utf8'),
        'force: true must overwrite user modification with canonical template'
      );

      // 4. Default configDir respects ANTIGRAVITY_CONFIG_DIR env var
      const envConfigDir = path.join(tmpRoot, 'env-config');
      process.env.ANTIGRAVITY_CONFIG_DIR = envConfigDir;
      const res4 = mod.setupTeam({});
      assert.equal(res4.configDir, envConfigDir);
      assert.deepEqual(res4.copied, EXPECTED_AGENT_FILES);
    } finally {
      if (prevEnv === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = prevEnv;
      cleanDir(tmpRoot);
    }
  });

  it('CLI setup-team, detect --json, and autostart behave safely in temp directories', async () => {
    const tmpRoot = makeTempDir('kantor-cli-env-');
    const configDir = path.join(tmpRoot, 'config');
    const agyHome = path.join(tmpRoot, 'agy-home');
    const projectDir = path.join(tmpRoot, 'proj');
    const storageDir = path.join(tmpRoot, 'storage');
    fs.mkdirSync(agyHome, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    try {
      // setup-team via CLI
      const { stdout: setupOut1 } = await runKantorCli(['setup-team'], {
        ANTIGRAVITY_CONFIG_DIR: configDir,
      });
      assert.match(setupOut1, /frontend-ui-dev\.md/);
      assert.ok(fs.existsSync(path.join(configDir, 'agents', 'qa-security-engineer.md')));

      // modify one file & re-run without --force
      const modTarget = path.join(configDir, 'agents', 'backend-architect.md');
      fs.writeFileSync(modTarget, '# custom user\n', 'utf8');
      await runKantorCli(['setup-team'], { ANTIGRAVITY_CONFIG_DIR: configDir });
      assert.equal(fs.readFileSync(modTarget, 'utf8'), '# custom user\n');

      // --force restores template
      await runKantorCli(['setup-team', '--force'], { ANTIGRAVITY_CONFIG_DIR: configDir });
      assert.notEqual(fs.readFileSync(modTarget, 'utf8'), '# custom user\n');

      // detect --json
      const { stdout: detectOut } = await runKantorCli(['detect', '--json'], {
        ANTIGRAVITY_CONFIG_DIR: configDir,
        ANTIGRAVITY_HOME: agyHome,
      });
      const info = JSON.parse(detectOut);
      assert.equal(info.nodeOk, true);
      assert.ok(Array.isArray(info.surfaceRoots));
      assert.equal(info.surfaceRoots.length, 1);
      assert.equal(info.teamTemplates.installed, true);
      assert.equal(info.teamTemplates.count, 4);

      // autostart exits 0 quietly when autostart disabled
      const { stdout: autoOut } = await runKantorCli(
        ['autostart', '--project', projectDir, '--storage', storageDir],
        { KANTOR_AUTOSTART: '' }
      );
      assert.equal(autoOut.trim(), '');
      assert.equal(fs.existsSync(path.join(storageDir, 'server.json')), false);
    } finally {
      cleanDir(tmpRoot);
    }
  });

  it('CLI lifecycle: start -> idempotent start -> status -> url -> token -> HTTP /kerja/api/ping -> stop', async () => {
    const tmpRoot = makeTempDir('kantor-lifecycle-');
    const projectDir = path.join(tmpRoot, 'demo-project');
    const storageDir = path.join(tmpRoot, 'storage');
    const agyHome = path.join(tmpRoot, 'agy-home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });

    const port = await findFreePort('127.0.0.1');
    const env = {
      KANTOR_STORAGE: storageDir,
      ANTIGRAVITY_HOME: agyHome,
    };

    try {
      // 1. start
      const startRes = await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--port', String(port)],
        env
      );
      assert.ok(
        startRes.stdout.includes(`http://127.0.0.1:${port}/kerja`),
        `start output should include URL on port ${port}, got: ${startRes.stdout}`
      );

      const serverJsonPath = path.join(storageDir, 'server.json');
      assert.ok(fs.existsSync(serverJsonPath), 'server.json must be created by start');
      const serverMeta = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      assert.equal(serverMeta.port, port);
      assert.ok(Number.isInteger(serverMeta.pid) && serverMeta.pid > 0);

      // 2. HTTP /kerja/api/ping 200
      const pingRes = await fetch(`http://127.0.0.1:${port}/kerja/api/ping`, {
        headers: { Connection: 'close' },
      });
      assert.equal(pingRes.status, 200);
      const pingJson = await pingRes.json();
      assert.equal(pingJson.ok, true);
      assert.equal(pingJson.app, 'kantor-agent');

      // 3. Idempotent second start
      const startAgain = await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--port', String(port)],
        env
      );
      assert.ok(startAgain.stdout.includes(`http://127.0.0.1:${port}/kerja`));
      const serverMetaAgain = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      assert.equal(serverMetaAgain.pid, serverMeta.pid, 'idempotent start must keep existing live PID');

      // 4. status
      const statusRes = await runKantorCli(
        ['status', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.match(statusRes.stdout, new RegExp(String(port)));
      assert.match(statusRes.stdout, /aktif|berjalan/i);

      // 5. url
      const urlRes = await runKantorCli(
        ['url', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.equal(urlRes.stdout.trim(), `http://127.0.0.1:${port}/kerja`);

      // 6. token
      const tokenRes = await runKantorCli(
        ['token', '--project', projectDir, '--storage', storageDir],
        env
      );
      const cliToken = tokenRes.stdout.trim();
      assert.match(cliToken, /^[a-f0-9]{64}$/);
      assert.equal(fs.readFileSync(path.join(storageDir, 'chat-token'), 'utf8').trim(), cliToken);

      // 7. restart spawns a fresh server PID and serves /kerja/api/ping
      const restartRes = await runKantorCli(
        ['restart', '--project', projectDir, '--storage', storageDir, '--port', String(port)],
        env
      );
      assert.ok(restartRes.stdout.includes(`http://127.0.0.1:${port}/kerja`));
      const serverMetaRestart = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      assert.notEqual(serverMetaRestart.pid, serverMeta.pid, 'restart should launch a new server PID');

      // 8. stop
      const stopRes = await runKantorCli(
        ['stop', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.match(stopRes.stdout, /dihentikan|berhenti/i);
      assert.equal(fs.existsSync(serverJsonPath), false, 'server.json must be removed after stop');

      await assert.rejects(
        () => fetch(`http://127.0.0.1:${port}/kerja/api/ping`, { headers: { Connection: 'close' } }),
        (err) => Boolean(err)
      );

      // 9. status & tunnel-stop & tunnel error when stopped
      const stoppedStatus = await runKantorCli(
        ['status', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.match(stoppedStatus.stdout, /tidak berjalan|berhenti/i);

      const tunnelStopRes = await runKantorCli(
        ['tunnel-stop', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.match(tunnelStopRes.stdout, /tidak ada tunnel/i);

      await assert.rejects(
        () => runKantorCli(['tunnel', '--project', projectDir, '--storage', storageDir], env),
        (err) => err && err.code === 1
      );
    } finally {
      // Defensive cleanup even if an assertion failed
      try {
        await runKantorCli(['stop', '--project', projectDir, '--storage', storageDir], env);
      } catch {}
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
        killPidBestEffort(meta?.pid);
      } catch {}
      cleanDir(tmpRoot);
    }
  });

  it('scans next free port in [basePort..basePort+20] when basePort is occupied and exports pure CLI helpers', async () => {
    const mod = await import('../skills/kantor-agent/runtime/bin/kantor.mjs');
    const parsed = mod.parseLauncherArgs([
      'start',
      '--project', './proj',
      '--storage', './st',
      '--bind=0.0.0.0',
      '--port=9000',
      '--sandbox',
      '--force',
      '--quiet',
      '--json',
    ]);
    assert.equal(parsed.command, 'start');
    assert.equal(parsed.project, './proj');
    assert.equal(parsed.storage, './st');
    assert.equal(parsed.bind, '0.0.0.0');
    assert.equal(parsed.port, 9000);
    assert.equal(parsed.sandbox, true);
    assert.equal(parsed.force, true);
    assert.equal(parsed.quiet, true);
    assert.equal(parsed.json, true);
    assert.throws(() => mod.parseLauncherArgs(['start', '--port', '99999']), /rentang/i);

    const sDir = mod.defaultStorageDir(path.join(os.tmpdir(), 'My Kantor Project'));
    assert.match(path.basename(sDir), /^my-kantor-project-[a-f0-9]{12}$/);

    // Hold a port with a dummy server and confirm `start` advances to a free port in [basePort..basePort+20]
    const tmpRoot = makeTempDir('kantor-portscan-');
    const projectDir = path.join(tmpRoot, 'proj');
    const storageDir = path.join(tmpRoot, 'storage');
    const agyHome = path.join(tmpRoot, 'agy-home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });

    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve);
    });
    const blockedPort = blocker.address().port;
    const env = { KANTOR_STORAGE: storageDir, ANTIGRAVITY_HOME: agyHome };

    try {
      const res = await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--port', String(blockedPort)],
        env
      );
      const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
      assert.ok(
        meta.port > blockedPort && meta.port <= blockedPort + 20,
        `expected port in (${blockedPort}..${blockedPort + 20}], got ${meta.port}`
      );
      assert.ok(res.stdout.includes(`http://127.0.0.1:${meta.port}/kerja`));
    } finally {
      try {
        await runKantorCli(['stop', '--project', projectDir, '--storage', storageDir], env);
      } catch {}
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
        killPidBestEffort(meta?.pid);
      } catch {}
      await new Promise((resolve) => blocker.close(() => resolve()));
      cleanDir(tmpRoot);
    }
  });

  it('redacts chat-token on non-loopback start, warns on sandbox flag mismatch, and returns token via token subcommand', async () => {
    const tmpRoot = makeTempDir('kantor-nonloopback-');
    const projectDir = path.join(tmpRoot, 'proj');
    const storageDir = path.join(tmpRoot, 'storage');
    const agyHome = path.join(tmpRoot, 'agy-home');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });

    const port = await findFreePort('127.0.0.1');
    const env = { KANTOR_STORAGE: storageDir, ANTIGRAVITY_HOME: agyHome };

    try {
      // 1. Start with --bind 0.0.0.0
      const start1 = await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--bind', '0.0.0.0', '--port', String(port)],
        env
      );
      const tokenPath = path.join(storageDir, 'chat-token');
      assert.ok(fs.existsSync(tokenPath), 'chat-token file must be created');
      const rawToken = fs.readFileSync(tokenPath, 'utf8').trim();
      assert.match(rawToken, /^[a-f0-9]{64}$/);

      // Must NOT print raw token or ?token= to stdout
      assert.equal(start1.stdout.includes(rawToken), false, 'start stdout must not print raw chat-token');
      assert.equal(start1.stdout.includes('?token='), false, 'start stdout must not print ?token=');
      assert.ok(start1.stdout.includes(tokenPath), 'start stdout must print chat-token file path');
      assert.match(start1.stdout, /\btoken\b/);

      const meta1 = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
      assert.equal(meta1.bind, '0.0.0.0');
      assert.equal(meta1.sandbox, false);

      // 2. Idempotent start with mismatched --sandbox flag keeps PID and prints restart warning without leaking token
      const start2 = await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--bind', '0.0.0.0', '--sandbox', '--port', String(port)],
        env
      );
      const meta2 = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
      assert.equal(meta2.pid, meta1.pid, 'idempotent start must preserve PID');
      assert.equal(start2.stdout.includes(rawToken), false, 'idempotent start stdout must not print raw chat-token');
      assert.equal(start2.stdout.includes('?token='), false, 'idempotent start stdout must not print ?token=');
      assert.match(start2.stdout, /--sandbox=true/);
      assert.match(start2.stdout, /restart/i);

      // 3. Dedicated `token` command still prints the exact 64-hex token
      const tokenRes = await runKantorCli(
        ['token', '--project', projectDir, '--storage', storageDir],
        env
      );
      assert.equal(tokenRes.stdout.trim(), rawToken);
    } finally {
      try {
        await runKantorCli(['stop', '--project', projectDir, '--storage', storageDir], env);
      } catch {}
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
        killPidBestEffort(meta?.pid);
      } catch {}
      cleanDir(tmpRoot);
    }
  });

  it('autostart exits 0 quietly when disabled or when CWD is plugin root without explicit project', async () => {
    const mod = await import('../skills/kantor-agent/runtime/bin/kantor.mjs');
    const skillRoot = path.resolve(WORKTREE_ROOT, 'skills', 'kantor-agent');

    // Unit test resolveAutostartProject precedence and plugin-root guard
    const prevAgy = process.env.ANTIGRAVITY_PROJECT_DIR;
    const prevProj = process.env.PROJECT_DIR;
    const prevWs = process.env.WORKSPACE_FOLDER;
    try {
      delete process.env.ANTIGRAVITY_PROJECT_DIR;
      delete process.env.PROJECT_DIR;
      delete process.env.WORKSPACE_FOLDER;
      assert.deepEqual(mod.resolveAutostartProject({}, WORKTREE_ROOT), { skip: true, reason: 'plugin-root' });
      assert.deepEqual(mod.resolveAutostartProject({}, skillRoot), { skip: true, reason: 'plugin-root' });

      process.env.WORKSPACE_FOLDER = os.tmpdir();
      const wsRes = mod.resolveAutostartProject({}, WORKTREE_ROOT);
      assert.equal(wsRes.skip, false);
      assert.equal(wsRes.projectDir, path.resolve(os.tmpdir()));

      process.env.PROJECT_DIR = path.join(os.tmpdir(), 'pdir');
      assert.equal(mod.resolveAutostartProject({}, WORKTREE_ROOT).projectDir, path.resolve(os.tmpdir(), 'pdir'));

      process.env.ANTIGRAVITY_PROJECT_DIR = path.join(os.tmpdir(), 'agyproj');
      assert.equal(mod.resolveAutostartProject({}, WORKTREE_ROOT).projectDir, path.resolve(os.tmpdir(), 'agyproj'));
    } finally {
      if (prevAgy === undefined) delete process.env.ANTIGRAVITY_PROJECT_DIR;
      else process.env.ANTIGRAVITY_PROJECT_DIR = prevAgy;
      if (prevProj === undefined) delete process.env.PROJECT_DIR;
      else process.env.PROJECT_DIR = prevProj;
      if (prevWs === undefined) delete process.env.WORKSPACE_FOLDER;
      else process.env.WORKSPACE_FOLDER = prevWs;
    }

    // CLI test: autostart from plugin root (WORKTREE_ROOT) with KANTOR_AUTOSTART=1 and no --project/env skips cleanly!
    const tmpRoot = makeTempDir('kantor-autostart-');
    const storageDir = path.join(tmpRoot, 'storage');
    const projDir = path.join(tmpRoot, 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    try {
      const pluginRootRes = await runKantorCli(
        ['autostart', '--storage', storageDir],
        {
          KANTOR_AUTOSTART: '1',
          KANTOR_STORAGE: storageDir,
          ANTIGRAVITY_PROJECT_DIR: '',
          PROJECT_DIR: '',
          WORKSPACE_FOLDER: '',
        },
        WORKTREE_ROOT
      );
      assert.equal(pluginRootRes.stdout.trim(), '');
      assert.equal(fs.existsSync(storageDir), false, 'autostart in plugin root must not create storage or spawn server');

      // Also verify autostart: false in a regular project directory exits 0 quietly without spawning
      const disabledRes = await runKantorCli(
        ['autostart', '--project', projDir, '--storage', storageDir],
        { KANTOR_AUTOSTART: '' }
      );
      assert.equal(disabledRes.stdout.trim(), '');
      assert.equal(fs.existsSync(path.join(storageDir, 'server.json')), false);
    } finally {
      cleanDir(tmpRoot);
    }
  });

  it('connectHostForBind & buildTunnelTargetUrl support IPv4/wildcard/IPv6, and tunnel redacts token & cleans up fast on early exit', async () => {
    const mod = await import('../skills/kantor-agent/runtime/bin/kantor.mjs');
    assert.equal(mod.connectHostForBind('0.0.0.0'), '127.0.0.1');
    assert.equal(mod.connectHostForBind('::'), '::1');
    assert.equal(mod.connectHostForBind('[::]'), '::1');
    assert.equal(mod.connectHostForBind('192.168.1.10'), '192.168.1.10');
    assert.equal(mod.buildTunnelTargetUrl({ bind: '0.0.0.0', port: 8788 }), 'http://127.0.0.1:8788');
    assert.equal(mod.buildTunnelTargetUrl({ bind: '::', port: 8788 }), 'http://[::1]:8788');
    assert.equal(mod.buildTunnelTargetUrl({ bind: '::1', port: 8790 }), 'http://[::1]:8790');
    assert.equal(mod.buildTunnelTargetUrl({ bind: '10.0.0.5', port: 8791 }), 'http://10.0.0.5:8791');

    // End-to-end tunnel test using a fake cloudflared shim in temp PATH
    const tmpRoot = makeTempDir('kantor-tunnel-');
    const projectDir = path.join(tmpRoot, 'proj');
    const storageDir = path.join(tmpRoot, 'storage');
    const agyHome = path.join(tmpRoot, 'agy-home');
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(agyHome, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });

    const port = await findFreePort('127.0.0.1');
    const fakeScript = path.join(fakeBinDir, 'fake-cloudflared.mjs');
    fs.writeFileSync(
      fakeScript,
      [
        'const mode = process.env.FAKE_CF_MODE || "crash";',
        'if (mode === "crash") {',
        '  console.error("simulated early cloudflared crash");',
        '  process.exit(1);',
        '}',
        'console.error("ARGS=" + JSON.stringify(process.argv.slice(2)));',
        'console.error("INF | Your quick Tunnel has been created! Visit it at:");',
        'console.error("INF | https://kantor-demo-tunnel.trycloudflare.com");',
        'setTimeout(() => process.exit(0), 15000);',
      ].join('\n'),
      'utf8'
    );

    const baseEnv = {
      KANTOR_STORAGE: storageDir,
      ANTIGRAVITY_HOME: agyHome,
      KANTOR_CLOUDFLARED_BIN: fakeScript,
    };

    try {
      await runKantorCli(
        ['start', '--project', projectDir, '--storage', storageDir, '--port', String(port)],
        baseEnv
      );
      const rawToken = fs.readFileSync(path.join(storageDir, 'chat-token'), 'utf8').trim();

      // 1. Crash mode must fail fast (< 4s, not 12s) and leave no tunnel.json or tunnel-url.txt
      const t0 = Date.now();
      await assert.rejects(
        () => runKantorCli(['tunnel', '--project', projectDir, '--storage', storageDir], { ...baseEnv, FAKE_CF_MODE: 'crash' }),
        (err) => err && err.code === 1 && /simulated early cloudflared crash/i.test(err.stderr || '')
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 4000, `tunnel early-exit crash should fail fast, took ${elapsed}ms`);
      assert.equal(fs.existsSync(path.join(storageDir, 'tunnel.json')), false);
      assert.equal(fs.existsSync(path.join(storageDir, 'tunnel-url.txt')), false);

      // 2. Success mode prints public URL + token file path without printing raw token or ?token=
      const tunOk = await runKantorCli(
        ['tunnel', '--project', projectDir, '--storage', storageDir],
        { ...baseEnv, FAKE_CF_MODE: 'ok' }
      );
      assert.ok(tunOk.stdout.includes('https://kantor-demo-tunnel.trycloudflare.com/kerja'));
      assert.ok(tunOk.stdout.includes(path.join(storageDir, 'chat-token')));
      assert.equal(tunOk.stdout.includes(rawToken), false, 'tunnel stdout must not print raw chat-token');
      assert.equal(tunOk.stdout.includes('?token='), false, 'tunnel stdout must not print ?token=');
      assert.equal(
        fs.readFileSync(path.join(storageDir, 'tunnel-url.txt'), 'utf8').trim(),
        'https://kantor-demo-tunnel.trycloudflare.com/kerja'
      );

      // 3. tunnel-stop cleans up tunnel process and files
      await runKantorCli(['tunnel-stop', '--project', projectDir, '--storage', storageDir], baseEnv);
      assert.equal(fs.existsSync(path.join(storageDir, 'tunnel.json')), false);
      assert.equal(fs.existsSync(path.join(storageDir, 'tunnel-url.txt')), false);
    } finally {
      try {
        await runKantorCli(['stop', '--project', projectDir, '--storage', storageDir], baseEnv);
      } catch {}
      try {
        const tMeta = JSON.parse(fs.readFileSync(path.join(storageDir, 'tunnel.json'), 'utf8'));
        killPidBestEffort(tMeta?.pid);
      } catch {}
      try {
        const sMeta = JSON.parse(fs.readFileSync(path.join(storageDir, 'server.json'), 'utf8'));
        killPidBestEffort(sMeta?.pid);
      } catch {}
      cleanDir(tmpRoot);
    }
  });
});
