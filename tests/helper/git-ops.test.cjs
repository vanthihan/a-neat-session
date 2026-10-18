'use strict';

// Every git operation here runs in a throwaway temp repository with the
// user's global/system git config disabled, so hooks and signing never apply.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const gitLib = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'git.cjs'));

const PLAN = [
  '## T1: Change the code',
  'worker: implementer',
  'owns: a.js, new.js, p.txt',
  'do: Edit a.js and add new.js.',
  '',
  '## D1: Document it',
  'worker: docs',
  'owns: README.md',
  'do: Update the readme.',
  '',
].join('\n');

let scratch;
const dirs = [];

before(() => {
  scratch = makeTempDir('neat-gitcfg-');
  fs.writeFileSync(path.join(scratch, 'empty-gitconfig'), '');
});

after(() => {
  dirs.forEach(removeDir);
  removeDir(scratch);
});

// Inherited GIT_* variables (for example from a commit hook) would point git
// at the wrong repository, so drop them all.
function envFor(dir) {
  const base = childEnv({ NEAT_PROJECT_DIR: dir });
  for (const key of Object.keys(base)) if (key.startsWith('GIT_')) delete base[key];
  return {
    ...base,
    GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(dir),
  };
}

function git(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, env: envFor(dir), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

function plainDir() {
  const dir = makeTempDir('neat-nogit-');
  dirs.push(dir);
  return dir;
}

// Repo with one commit (a.js, p.txt, README.md [, .gitignore]) and p.txt dirty.
function makeRepo({ gitignore } = {}) {
  const dir = plainDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Neat Test']);
  git(dir, ['config', 'user.email', 'neat@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  write(dir, 'a.js', 'one\n');
  write(dir, 'p.txt', 'p\n');
  write(dir, 'README.md', '# r\n');
  if (gitignore) write(dir, '.gitignore', gitignore);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  write(dir, 'p.txt', 'p dirty before the run\n');
  return dir;
}

function neat(dir, args, input) {
  return runNode([HELPER, ...args], { cwd: dir, env: envFor(dir), input });
}

function newRun(dir, taskText = 'change the code') {
  const res = neat(dir, ['run', 'new', taskText]);
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  return { id, runDir: path.join(dir, '.neat', 'runs', id), stdout: res.stdout };
}

function plannedRun(dir, plan = PLAN, taskText) {
  const run = newRun(dir, taskText);
  fs.writeFileSync(path.join(run.runDir, 'plan.md'), plan);
  const res = neat(dir, ['plan', 'check', run.id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return run;
}

function stateOf(run) {
  return JSON.parse(fs.readFileSync(path.join(run.runDir, 'state.json'), 'utf8'));
}

function head(dir) {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// ---------- git primitives ----------

test('porcelainPaths lists changed and untracked files, sorted, without .neat/', () => {
  const dir = makeRepo();
  write(dir, 'sub/new file.js', 'x\n');
  write(dir, '.neat/runs/x/state.json', '{}');
  assert.deepEqual(gitLib.porcelainPaths(dir), ['p.txt', 'sub/new file.js']);
  assert.equal(gitLib.isGitRepo(dir), true);
  assert.equal(gitLib.isGitRepo(plainDir()), false);
  assert.match(gitLib.headSha(dir), /^[0-9a-f]{40,64}$/);
});

// ---------- run new ----------

test('run new in a repo records base/head SHA and files dirty at start', () => {
  const dir = makeRepo();
  const run = newRun(dir);
  const state = stateOf(run);
  assert.equal(state.baseSha, head(dir));
  assert.equal(state.headSha, head(dir));
  assert.deepEqual(state.dirtyAtStart, ['p.txt']);
  for (const key of ['tasks', 'changed', 'unowned', 'violations', 'commits']) assert.deepEqual(state[key], [], key);
  const lines = run.stdout.trim().split('\n');
  assert.match(lines[0], /^id=/);
  assert.ok(lines.includes('warn: 1 files had uncommitted changes at start; neat will not commit them'), run.stdout);
  assert.ok(lines.includes('hint: add .neat/ to .gitignore'), run.stdout);
});

test('run new prints no hint when .gitignore lists .neat/', () => {
  const dir = makeRepo({ gitignore: '.neat/\n' });
  const run = newRun(dir);
  assert.ok(!run.stdout.includes('hint:'), run.stdout);
});

test('outside git: SHAs are null and guard/commit skip cleanly', () => {
  const dir = plainDir();
  const run = plannedRun(dir);
  const state = stateOf(run);
  assert.equal(state.baseSha, null);
  assert.equal(state.headSha, null);
  assert.deepEqual(state.dirtyAtStart, []);
  assert.ok(!run.stdout.includes('hint:'));
  const guard = neat(dir, ['run', 'guard', run.id]);
  assert.equal(guard.status, 0);
  assert.equal(guard.stdout.trim(), 'guard skip: not a git repository');
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.equal(commit.status, 0);
  assert.equal(commit.stdout.trim(), 'commit skip: not a git repository');
  const diff = neat(dir, ['run', 'diff', run.id]);
  assert.equal(diff.status, 0, diff.stderr);
  const patch = fs.readFileSync(path.join(run.runDir, 'diff.patch'), 'utf8');
  assert.match(patch, /not a git repository/);
  assert.match(patch, /a\.js/);
});

// ---------- guard ----------

test('guard accepts owned changes, notes dirty-at-start files and rejects unowned ones once', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);

  write(dir, 'a.js', 'two\n');
  let res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^guard ok new=1$/m);
  assert.match(res.stdout, /^note: p\.txt was modified before the run; neat will not commit it$/m);
  assert.deepEqual(stateOf(run).changed, ['a.js']);

  write(dir, 'z.js', 'unowned\n');
  res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: z\.js not owned by T1$/m);
  const state = stateOf(run);
  assert.equal(state.violations.length, 1);
  assert.deepEqual(state.unowned, ['z.js']);
  assert.ok(state.changed.every((p) => !p.startsWith('.neat/')));

  res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(res.status, 0, 'z.js must not be reported twice');
  assert.equal(stateOf(run).violations.length, 1);
});

test('guard without --tasks (read-only stage) fails on any new change', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  assert.equal(neat(dir, ['run', 'guard', run.id]).status, 0);
  write(dir, 'a.js', 'changed by a reader\n');
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: a\.js /m);
});

test('guard rejects unknown task ids', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  const res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T9']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown task T9/);
});

test('guard and commit refuse when HEAD moved', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  const before = head(dir);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  write(dir, 'other.txt', 'x\n');
  git(dir, ['add', 'other.txt']);
  git(dir, ['commit', '-q', '-m', 'worker commit']);
  const after = head(dir);
  const guard = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(guard.status, 1);
  assert.ok(
    guard.stdout.includes(`guard violation: HEAD moved (expected ${before.slice(0, 7)}, got ${after.slice(0, 7)})`),
    guard.stdout,
  );
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.equal(commit.status, 1);
  assert.equal(commit.stdout.trim(), 'commit refused: HEAD moved');
});

// ---------- diff ----------

test('diff before plan check exits 1', () => {
  const dir = makeRepo();
  const run = newRun(dir);
  const res = neat(dir, ['run', 'diff', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /run plan check first/);
});

test('diff covers modified tracked and new untracked owned files', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  write(dir, 'a.js', 'two\n');
  write(dir, 'new.js', 'brand new\n');
  write(dir, 'z.js', 'unowned\n');
  git(dir, ['checkout', '-q', '--', 'p.txt']);
  const res = neat(dir, ['run', 'diff', run.id]);
  assert.equal(res.status, 0, res.stderr);
  const file = path.join(run.runDir, 'diff.patch');
  const patch = fs.readFileSync(file, 'utf8');
  const lines = patch.split('\n').length - 1;
  assert.equal(res.stdout, `diff ${file} files=2 lines=${lines}\n`);
  assert.match(patch, /diff --git a\/a\.js b\/a\.js/);
  assert.match(patch, /^\+two$/m);
  assert.match(patch, /new file mode/);
  assert.match(patch, /^\+brand new$/m);
  assert.ok(!patch.includes('z.js'));
});

// ---------- commit ----------

test('commit stages exactly the guarded owned changes', () => {
  const dir = makeRepo();
  const run = plannedRun(dir, PLAN, 'change the code\nsecond line');
  write(dir, 'a.js', 'two\n');
  write(dir, 'new.js', 'brand new\n');
  write(dir, 'p.txt', 'p edited again\n');
  write(dir, 'z.js', 'unowned\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 1);

  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const sha = head(dir);
  assert.equal(res.stdout, `committed ${sha.slice(0, 7)} files=2\n`);
  const files = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['a.js', 'new.js']);
  const message = git(dir, ['log', '-1', '--format=%B']);
  assert.match(message, /^neat: change the code\n/);
  assert.ok(message.includes(`Run: ${run.id}`));
  const status = git(dir, ['status', '--porcelain']);
  assert.match(status, /p\.txt/);
  assert.match(status, /z\.js/);

  const state = stateOf(run);
  assert.equal(state.headSha, sha);
  assert.deepEqual(state.commits, [{ sha, stage: state.stage, files: ['a.js', 'new.js'] }]);
  assert.deepEqual(state.changed, []);
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const again = neat(dir, ['run', 'commit', run.id]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout.trim(), 'commit skip: no owned changes');
});

test('commit with nothing guarded skips', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), 'commit skip: no owned changes');
});

test('file names with spaces, $(x) and glob characters are handled literally', { skip: process.platform === 'win32' }, () => {
  const dir = makeRepo();
  const plan = PLAN.replace('owns: a.js, new.js, p.txt', 'owns: odd $(x) name.js, g*.js');
  const run = plannedRun(dir, plan);
  write(dir, 'odd $(x) name.js', 'odd\n');
  write(dir, 'g*.js', 'star\n');
  write(dir, 'gx.js', 'must not be swept by a glob\n');
  const guard = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.match(guard.stdout, /^guard violation: gx\.js not owned by T1$/m);
  assert.deepEqual(stateOf(run).changed, ['g*.js', 'odd $(x) name.js']);
  const diff = neat(dir, ['run', 'diff', run.id]);
  assert.match(diff.stdout, / files=2 /);
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const files = git(dir, ['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['g*.js', 'odd $(x) name.js']);
  assert.ok(!fs.existsSync(path.join(dir, 'x')));
  assert.match(git(dir, ['status', '--porcelain']), /gx\.js/);
});
