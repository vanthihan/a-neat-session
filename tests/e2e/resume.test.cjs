'use strict';

// Installed-helper tracer for resuming a run: install -> SessionStart hook
// entry in settings -> the hook command itself -> additionalContext ->
// `run resume` -> uninstall. Every helper and hook call uses a fixed clock.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const NOW = '2026-10-18T12:00:00.000Z';
const COMPACT = JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-a' });

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// The hook command exactly as written in settings, run without a shell: split
// on spaces, `node` replaced by this node binary.
function runHookCommand(command, { projectDir, input, env = {} }) {
  const [node, ...args] = command.split(' ');
  assert.equal(node, 'node');
  const res = spawnSync(process.execPath, args, {
    cwd: projectDir,
    env: childEnv({ CLAUDE_PROJECT_DIR: projectDir, NEAT_NOW: NOW, ...env }),
    input,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function hookEntryFor(helper) {
  return {
    matcher: 'compact|resume|clear',
    hooks: [{ type: 'command', command: `node ${helper} hook session-start`, timeout: 10 }],
  };
}

describe('SessionStart hook through a local install', () => {
  let tmp;
  let proj;
  let empty;
  let helper;
  let settingsFile;
  let env;
  let runId;
  let hookCommand;

  const helperRun = (args, input) => runNode([helper, ...args], { cwd: proj, env, input });
  const hook = (input, extra = {}) => runHookCommand(hookCommand, { projectDir: proj, input, ...extra });

  before(() => {
    tmp = makeTempDir('neat-resume-');
    proj = path.join(tmp, 'proj');
    empty = path.join(tmp, 'empty');
    fs.mkdirSync(proj);
    fs.mkdirSync(empty);
    helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    settingsFile = path.join(proj, '.claude', 'settings.local.json');
    env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: NOW });
  });

  after(() => removeDir(tmp));

  test('--local install writes exactly one SessionStart entry and records it', () => {
    const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    const settings = readJson(settingsFile);
    assert.deepEqual(settings.hooks.SessionStart, [hookEntryFor(helper)]);
    assert.ok(settings.permissions.allow.includes(`Bash(node ${helper} *)`));
    const manifest = readJson(path.join(proj, '.claude', 'neat', 'manifest.json'));
    assert.deepEqual(manifest.settings.added, [
      { path: ['permissions', 'allow'], value: `Bash(node ${helper} *)` },
      { path: ['permissions', 'allow'], value: 'Bash(set -o pipefail)' },
      { path: ['hooks', 'SessionStart'], value: hookEntryFor(helper) },
      {
        path: ['hooks', 'SubagentStop'],
        value: {
          matcher: 'neat-explorer|neat-researcher|neat-implementer|neat-reviewer|neat-tester|neat-docs',
          hooks: [{ type: 'command', command: `node ${helper} hook subagent-stop`, timeout: 30 }],
        },
      },
      {
        path: ['hooks', 'PreToolUse'],
        value: { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${helper} hook pre-bash`, timeout: 10 }] },
      },
    ]);
    hookCommand = settings.hooks.SessionStart[0].hooks[0].command;
  });

  test('a second install changes neither the settings nor the recorded additions', () => {
    const before2 = fs.readFileSync(settingsFile, 'utf8');
    const added = readJson(path.join(proj, '.claude', 'neat', 'manifest.json')).settings.added;
    const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), before2);
    assert.deepEqual(readJson(path.join(proj, '.claude', 'neat', 'manifest.json')).settings.added, added);
  });

  test('the hook prints nothing and exits 0 when the project has no runs', () => {
    for (const projectDir of [proj, empty]) {
      const res = runHookCommand(hookCommand, { projectDir, input: COMPACT });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
    }
  });

  test('after compact the hook injects the run id, mode, stage, next step and resume pointer', () => {
    const created = helperRun(['run', 'new', 'add a hello function']);
    assert.equal(created.status, 0, created.stderr);
    runId = /^id=(\S+)/.exec(created.stdout)[1];
    assert.equal(helperRun(['run', 'stage', runId, 'explore']).status, 0);

    const res = hook(COMPACT);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(`neat run ${runId} is active (mode=gate, stage=explore).`), ctx);
    assert.match(ctx, /^next: Explore - /m);
    assert.ok(ctx.includes(`/neat:resume ${runId}`), ctx);
    assert.ok(ctx.length <= 1500);
  });

  test('run resume <id> prints the run line and the same next line the hook injects', () => {
    const ctx = JSON.parse(hook(COMPACT).stdout).hookSpecificOutput.additionalContext;
    const injected = ctx.split('\n').find((l) => l.startsWith('next: '));
    const res = helperRun(['run', 'resume', runId]);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    const dir = path.join(proj, '.neat', 'runs', runId);
    assert.equal(lines[0], `run=${runId} mode=gate stage=explore type=none dir=${dir}`);
    assert.ok(lines.includes(injected), `${injected}\n${res.stdout}`);
  });

  test('unparseable or empty stdin, an unknown hook and startup print nothing', () => {
    const cases = [
      { input: 'not json' },
      { input: '' },
      { input: '[1,2]' },
      { input: JSON.stringify({ source: 'startup', session_id: 'sess-a' }) },
    ];
    for (const { input } of cases) {
      const res = hook(input);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '', input);
      assert.equal(res.stderr, '');
    }
    const unknown = runHookCommand(hookCommand.replace('session-start', 'no-such-hook'), { projectDir: proj, input: COMPACT });
    assert.equal(unknown.status, 0);
    assert.equal(unknown.stdout, '');
    assert.equal(unknown.stderr, '');
  });

  test('a finished run is not injected', () => {
    assert.equal(helperRun(['run', 'stage', runId, 'done']).status, 0);
    const res = hook(COMPACT);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  });

  test('--uninstall --local removes the entry and the settings file it created', () => {
    const res = runNode([INSTALLER, '--uninstall', '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(settingsFile));
  });
});

describe('SessionStart entry over existing local settings', () => {
  let proj;

  before(() => {
    proj = makeTempDir('neat-resume-user-');
  });

  after(() => removeDir(proj));

  test('uninstall keeps only the user keys of a pre-existing settings file', () => {
    const settingsFile = path.join(proj, '.claude', 'settings.local.json');
    const user = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    fs.mkdirSync(path.dirname(settingsFile));
    fs.writeFileSync(settingsFile, JSON.stringify(user));
    const env = childEnv({ NEAT_PROJECT_DIR: proj });
    assert.equal(runNode([INSTALLER, '--local'], { cwd: proj, env }).status, 0);
    const helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    const merged = readJson(settingsFile);
    assert.deepEqual(merged.hooks.Stop, user.hooks.Stop);
    assert.deepEqual(merged.hooks.SessionStart, [hookEntryFor(helper)]);
    const res = runNode([INSTALLER, '--uninstall', '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readJson(settingsFile), user);
  });
});

describe('run resume and procedure through the installed helper', () => {
  let tmp;
  let proj;
  let helper;
  let env;

  const helperRun = (args, { input, now = NOW } = {}) =>
    runNode([helper, ...args], { cwd: proj, env: { ...env, NEAT_NOW: now }, input });
  const newRun = (task, now) => /^id=(\S+)/.exec(helperRun(['run', 'new', task], { now }).stdout)[1];

  before(() => {
    tmp = makeTempDir('neat-resume-cli-');
    proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: NOW });
    const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
  });

  after(() => removeDir(tmp));

  test('with no unfinished run it says so and exits 0', () => {
    const res = helperRun(['run', 'resume']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `no unfinished neat run in ${proj}\n`);
  });

  test('with no id it picks the newest unfinished run of any age', () => {
    const old = newRun('old task', '2026-10-10T08:00:00.000Z');
    const finished = newRun('finished task', NOW);
    assert.equal(helperRun(['run', 'stage', finished, 'done']).status, 0);
    const res = helperRun(['run', 'resume']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`^run=${old} mode=gate stage=created type=none `));
    assert.equal(helperRun(['run', 'stage', old, 'cancelled']).status, 0);
  });

  test('prints the run line, worker states, next step and procedure line (at most 10 lines)', () => {
    const id = newRun('add a hello function', NOW);
    assert.equal(helperRun(['run', 'stage', id, 'explore']).status, 0);
    assert.equal(helperRun(['run', 'worker', id, 'explorer', 'running']).status, 0);
    const res = helperRun(['run', 'resume']);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 10, res.stdout);
    assert.deepEqual(lines, [
      `run=${id} mode=gate stage=explore type=none dir=${path.join(proj, '.neat', 'runs', id)}`,
      'workers: done=none running=explorer failed=none',
      'next: Explore - Worker loop for explorer (write a new brief and launch it again)',
      `procedure: run node ${helper} procedure once; skip Start (keep id, mode and dir above) and continue at ## Explore`,
    ]);
    for (const input of [`${id}\n`, `\n  ${id}  \n`, '', '\n\n']) {
      const viaStdin = helperRun(['run', 'resume', '--stdin'], { input });
      assert.equal(viaStdin.status, 0, viaStdin.stderr);
      assert.equal(viaStdin.stdout, res.stdout, JSON.stringify(input));
    }
    assert.equal(helperRun(['run', 'resume', id]).stdout, res.stdout);
  });

  test('a finished run prints nothing to resume and no procedure line', () => {
    const id = newRun('done already', NOW);
    assert.equal(helperRun(['run', 'stage', id, 'done']).status, 0);
    const res = helperRun(['run', 'resume', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /run finished \(stage=done\); nothing to resume/);
    assert.ok(!res.stdout.includes('procedure:'));
  });

  test('a malformed id exits 2 before any path is built; an unknown id exits 2', () => {
    for (const args of [['../x'], ['20261018-120000-a/../../b']]) {
      const res = helperRun(['run', 'resume', ...args]);
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stderr, /invalid run id/);
      assert.equal(res.stdout, '');
    }
    const viaStdin = helperRun(['run', 'resume', '--stdin'], { input: '../x\n' });
    assert.equal(viaStdin.status, 2);
    assert.match(viaStdin.stderr, /invalid run id/);
    const eof = helperRun(['run', 'resume', '--stdin'], { input: 'NEAT_EOF\n' });
    assert.equal(eof.status, 2);
    assert.match(eof.stderr, /must not contain a line NEAT_EOF/);
    const unknown = helperRun(['run', 'resume', '20200101-000000-nope']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /run not found/);
    assert.equal(helperRun(['run', 'resume', 'a', 'b']).status, 2);
  });

  test('procedure prints the installed /neat:do procedure with the installed helper path', () => {
    const res = helperRun(['procedure']);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.split('\n');
    assert.equal(lines[0], 'In Start, the task text replaces $ARGUMENTS.');
    assert.ok(lines.includes('## Worker loop'));
    assert.ok(res.stdout.includes(`node ${helper} run new --stdin`), res.stdout);
    assert.ok(!res.stdout.includes('{{NEAT_BIN}}'));
    assert.ok(!res.stdout.includes('disable-model-invocation'));
    assert.equal(helperRun(['procedure', 'extra']).status, 2);
  });

  test('procedure without its command file exits 2 and names the missing path', () => {
    const copy = path.join(tmp, 'copy');
    fs.cpSync(path.join(REPO_ROOT, 'payload', 'neat'), path.join(copy, 'neat'), { recursive: true });
    const res = runNode([path.join(copy, 'neat', 'bin', 'neat.cjs'), 'procedure'], { cwd: proj, env });
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes(`procedure not found: ${path.join(copy, 'commands', 'neat', 'do.md')}`), res.stderr);
  });
});

describe('which install answers the hook', () => {
  let tmp;
  let local;
  let plain;
  const REPO_HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

  const hookVia = (helperFile, projectDir, input = COMPACT) =>
    runHookCommand(`node ${helperFile} hook session-start`, { projectDir, input });
  const startRun = (projectDir, helperFile) => {
    const env = childEnv({ NEAT_PROJECT_DIR: projectDir, NEAT_NOW: NOW });
    const res = runNode([helperFile, 'run', 'new', 'hook owner'], { cwd: projectDir, env });
    assert.equal(res.status, 0, res.stderr);
    const id = /^id=(\S+)/.exec(res.stdout)[1];
    assert.equal(runNode([helperFile, 'run', 'stage', id, 'explore'], { cwd: projectDir, env }).status, 0);
    return id;
  };

  before(() => {
    tmp = makeTempDir('neat-resume-owner-');
    local = path.join(tmp, 'local');
    plain = path.join(tmp, 'plain');
    fs.mkdirSync(local);
    fs.mkdirSync(plain);
    const res = runNode([INSTALLER, '--local'], { cwd: local, env: childEnv({ NEAT_PROJECT_DIR: local }) });
    assert.equal(res.status, 0, res.stderr);
  });

  after(() => removeDir(tmp));

  test('a local install wins: another helper stays silent in that project', () => {
    const installed = path.join(local, '.claude', 'neat', 'bin', 'neat.cjs');
    const id = startRun(local, installed);
    const other = hookVia(REPO_HELPER, local);
    assert.equal(other.status, 0, other.stderr);
    assert.equal(other.stdout, '');
    const own = hookVia(installed, local);
    assert.equal(own.status, 0, own.stderr);
    assert.ok(JSON.parse(own.stdout).hookSpecificOutput.additionalContext.includes(id));
  });

  test('without a local install the other helper injects', () => {
    const id = startRun(plain, REPO_HELPER);
    const res = hookVia(REPO_HELPER, plain);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(JSON.parse(res.stdout).hookSpecificOutput.additionalContext.includes(`neat run ${id} is active`));
  });

  test('after /clear the hook prints a one-line pointer to the newest unfinished run', () => {
    const installed = path.join(local, '.claude', 'neat', 'bin', 'neat.cjs');
    const clear = JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sess-new' });
    const res = hookVia(installed, local, clear);
    assert.equal(res.status, 0, res.stderr);
    const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /^neat run \S+ is unfinished \(stage=explore\): run \/neat:resume \S+ to continue it\.$/);
  });
});
