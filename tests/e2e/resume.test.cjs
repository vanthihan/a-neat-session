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
      { path: ['hooks', 'SessionStart'], value: hookEntryFor(helper) },
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
    assert.deepEqual(merged.hooks, { Stop: user.hooks.Stop, SessionStart: [hookEntryFor(helper)] });
    const res = runNode([INSTALLER, '--uninstall', '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readJson(settingsFile), user);
  });
});
