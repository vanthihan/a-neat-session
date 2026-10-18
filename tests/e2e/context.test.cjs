'use strict';

// Context warn/critical lines through the INSTALLED helper (`--local`):
// `run stage`, `brief` and `route` add one `context:` line for this session's
// capture at or above the thresholds, and stay silent for another session's
// capture, a stale capture or no capture. Each case has its own
// CLAUDE_CONFIG_DIR, so a capture never leaks into another case.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const NOW_ISO = '2026-05-01T12:00:00.000Z';
const NOW = new Date(NOW_ISO);
const STALE = new Date(NOW.getTime() - 20 * 60 * 1000);

let proj;
let helper;
const dirs = [];

before(() => {
  proj = makeTempDir('neat-ctx-e2e-');
  const res = runNode([INSTALLER, '--local'], { cwd: proj, env: childEnv({ NEAT_PROJECT_DIR: proj }) });
  assert.equal(res.status, 0, res.stderr);
  helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
});

after(() => {
  removeDir(proj);
  dirs.forEach(removeDir);
});

// A fresh config dir with an optional capture; returns the env for the helper.
function caseEnv({ pct, sessionId = 'sess-a', mtime = NOW } = {}) {
  const cfg = makeTempDir('neat-ctx-cfg-');
  dirs.push(cfg);
  if (pct !== undefined) {
    const file = path.join(cfg, 'neat', 'usage.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ session_id: 'sess-a', context_window: { used_percentage: pct } }));
    fs.utimesSync(file, mtime, mtime);
  }
  return childEnv({ NEAT_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg, NEAT_NOW: NOW_ISO, CLAUDE_CODE_SESSION_ID: sessionId });
}

function neat(args, env, input) {
  const res = runNode([helper, ...args], { cwd: proj, env, input });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  return res.stdout.trimEnd().split('\n');
}

function newRun(env) {
  const first = neat(['run', 'new', '--stdin'], env, 'context lines\n')[0];
  return first.match(/^id=(\S+)/)[1];
}

const warnLine = (id) => `context: 63% (warn 60%): keep going; at 75% stop for /clear and /neat:resume ${id}`;
const criticalLine = (id) =>
  `context: 78% (critical 75%): stop after this step and tell the user to run /clear, then /neat:resume ${id}`;

test('at warn: run stage, brief and route each add the warn line last', () => {
  const env = caseEnv({ pct: 63 });
  const id = newRun(env);
  assert.deepEqual(neat(['run', 'stage', id, 'explore'], env), ['stage explore', warnLine(id)]);
  const brief = neat(['brief', id, 'explorer'], env);
  assert.equal(brief.length, 3, brief.join('\n'));
  assert.ok(path.isAbsolute(brief[0]), brief[0]);
  assert.match(brief[1], /^route worker=explorer .* ctx=63% /);
  assert.equal(brief[2], warnLine(id));
  const route = neat(['route', id, 'explorer'], env);
  assert.equal(route.length, 2, route.join('\n'));
  assert.match(route[0], /^route worker=explorer .* ctx=63% /);
  assert.equal(route[1], warnLine(id));
});

test('at critical the line says stop and names /clear then /neat:resume <id>', () => {
  const env = caseEnv({ pct: 78 });
  const id = newRun(env);
  assert.deepEqual(neat(['run', 'stage', id, 'explore'], env), ['stage explore', criticalLine(id)]);
  assert.equal(neat(['brief', id, 'explorer'], env)[2], criticalLine(id));
  assert.equal(neat(['route', id, 'explorer'], env).at(-1), criticalLine(id));
});

test('a capture from another session prints no line and the route shows ctx=unknown', () => {
  const env = caseEnv({ pct: 90, sessionId: 'sess-b' });
  const id = newRun(env);
  assert.deepEqual(neat(['run', 'stage', id, 'explore'], env), ['stage explore']);
  const brief = neat(['brief', id, 'explorer'], env);
  assert.equal(brief.length, 2, brief.join('\n'));
  assert.match(brief[1], / ctx=unknown /);
  assert.deepEqual(neat(['route', id, 'explorer'], env).length, 1);
});

test('a capture older than 15 minutes prints no line', () => {
  const env = caseEnv({ pct: 90, mtime: STALE });
  const id = newRun(env);
  assert.deepEqual(neat(['run', 'stage', id, 'explore'], env), ['stage explore']);
  assert.equal(neat(['brief', id, 'explorer'], env).length, 2);
  assert.equal(neat(['route', id, 'explorer'], env).length, 1);
});

test('below warn or without a capture the outputs are unchanged', () => {
  for (const env of [caseEnv({ pct: 20 }), caseEnv()]) {
    const id = newRun(env);
    assert.deepEqual(neat(['run', 'stage', id, 'explore'], env), ['stage explore']);
    assert.equal(neat(['brief', id, 'explorer'], env).length, 2);
    assert.equal(neat(['route', id, 'explorer'], env).length, 1);
  }
});

test('project thresholds move the line; run stage skipped also carries it', () => {
  const env = caseEnv({ pct: 30 });
  fs.mkdirSync(path.join(proj, '.neat'), { recursive: true });
  const file = path.join(proj, '.neat', 'config.json');
  fs.writeFileSync(file, '{"context":{"warn":10,"critical":20}}');
  try {
    const id = newRun(env);
    const lines = neat(['run', 'stage', id, 'explore'], env);
    assert.match(lines[1], /^context: 30% \(critical 20%\): stop after this step/);
    neat(['stages', id, '--type', 'docs'], env);
    const skipped = neat(['run', 'stage', id, 'review'], env);
    assert.equal(skipped[0], 'stage review skipped');
    assert.match(skipped[1], /^context: 30% \(critical 20%\)/);
  } finally {
    fs.rmSync(file);
  }
});

test('done and cancelled print no context line, even at critical', () => {
  for (const pct of [63, 78]) {
    const env = caseEnv({ pct });
    const finished = newRun(env);
    neat(['run', 'stage', finished, 'explore'], env);
    assert.deepEqual(neat(['run', 'stage', finished, 'done'], env), ['stage done']);
    const cancelled = newRun(env);
    neat(['run', 'stage', cancelled, 'explore'], env);
    assert.deepEqual(neat(['run', 'stage', cancelled, 'cancelled'], env), ['stage cancelled']);
  }
});
