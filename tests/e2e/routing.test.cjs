'use strict';

// Tracer for per-worker routing: `--profile` in the /neat:do argument text ->
// state.json -> `brief` route line (line 2) -> worker model/effort in state,
// exercised through the INSTALLED helper (`bin/install.cjs --local`).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');

let proj;
let env;
let helper;

before(() => {
  proj = makeTempDir('neat-route-');
  env = childEnv({ NEAT_PROJECT_DIR: proj });
  const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
  assert.equal(res.status, 0, res.stderr);
  helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
});

after(() => removeDir(proj));

function neat(args, input) {
  return runNode([helper, ...args], { cwd: proj, env, input });
}

function newRun(taskText) {
  const res = neat(['run', 'new', '--stdin'], taskText);
  assert.equal(res.status, 0, res.stderr);
  const first = res.stdout.split('\n')[0];
  assert.match(first, /^id=\S+ mode=(gate|auto|step) dir=\S+$/);
  const id = first.match(/^id=(\S+)/)[1];
  return { id, dir: path.join(proj, '.neat', 'runs', id) };
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function briefRoute(id, worker) {
  const res = neat(['brief', id, worker]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  assert.equal(lines.length, 3, res.stdout);
  assert.ok(path.isAbsolute(lines[0]), lines[0]);
  assert.ok(fs.existsSync(lines[0]), lines[0]);
  return lines[1];
}

function workerEntry(dir, worker) {
  return readState(dir).workers.find((w) => w.name === worker);
}

test('--profile budget: state keeps the profile and the explorer brief prints the exact route line', () => {
  const { id, dir } = newRun('--profile budget fix typo\n');
  assert.equal(readState(dir).profile, 'budget');
  assert.equal(
    briefRoute(id, 'explorer'),
    'route worker=explorer model=haiku effort=low profile=budget complexity=normal usage=unknown stepdown=no hard=no ctx=unknown',
  );
  const w = workerEntry(dir, 'explorer');
  assert.equal(w.status, 'running');
  assert.equal(w.model, 'haiku');
  assert.equal(w.effort, 'low');
});

test('worker model and effort survive a later run worker done', () => {
  const { id, dir } = newRun('--profile budget keep fields\n');
  briefRoute(id, 'reviewer');
  const res = neat(['run', 'worker', id, 'reviewer', 'done']);
  assert.equal(res.status, 0, res.stderr);
  const w = workerEntry(dir, 'reviewer');
  assert.deepEqual([w.status, w.model, w.effort], ['done', 'sonnet', 'medium']);
});

test('without --profile the run stores null and routes adaptive at complexity normal', () => {
  const { id, dir } = newRun('add a feature\n');
  assert.equal(readState(dir).profile, null);
  assert.match(briefRoute(id, 'explorer'), /^route worker=explorer model=haiku effort=medium profile=adaptive complexity=normal /);
  assert.match(briefRoute(id, 'reviewer'), /^route worker=reviewer model=opus effort=medium profile=adaptive /);
  assert.match(briefRoute(id, 'tester'), /^route worker=tester model=haiku effort=medium profile=adaptive /);
});

test('--profile quality routes the reviewer to opus/high', () => {
  const { id } = newRun('harden it --profile quality\n');
  assert.match(briefRoute(id, 'reviewer'), /^route worker=reviewer model=opus effort=high profile=quality /);
});

test('--profile inherit routes every worker to inherit/none', () => {
  const { id, dir } = newRun('--profile=inherit use the session model\n');
  for (const worker of ['explorer', 'reviewer', 'tester']) {
    assert.match(briefRoute(id, worker), new RegExp(`^route worker=${worker} model=inherit effort=none profile=inherit `));
    const w = workerEntry(dir, worker);
    assert.deepEqual([w.model, w.effort], ['inherit', 'none']);
  }
});

test('an invalid --profile exits 2 and creates no run', () => {
  const res = neat(['run', 'new', '--stdin'], '--profile wizard x\n');
  assert.equal(res.status, 2);
  assert.equal(res.stderr, "neat: invalid --profile 'wizard' (use adaptive|quality|balanced|budget|inherit)\n");
});

test('the installed do.md passes the routed model and effort to the Agent call', () => {
  const text = fs.readFileSync(path.join(proj, '.claude', 'commands', 'neat', 'do.md'), 'utf8');
  assert.ok(text.includes('effort'), 'do.md must mention effort');
  assert.ok(text.includes('inherit'), 'do.md must mention inherit');
  assert.ok(text.includes('--profile'), 'do.md must mention --profile');
  assert.ok(text.includes('rejects `effort`'), 'do.md must give the effort fallback');
});
