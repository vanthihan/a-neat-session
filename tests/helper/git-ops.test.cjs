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

test('a passing guard records its stage and batch in state.guarded; a failing one does not', () => {
  const dir = makeRepo();
  const plan = PLAN.replace('## D1:', '## T2: Other code\nworker: implementer\nowns: b.js\ndo: Add b.js.\n\n## D1:');
  const run = plannedRun(dir, plan);
  assert.equal(neat(dir, ['run', 'stage', run.id, 'implement']).status, 0);
  write(dir, 'a.js', 'impl\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T2,T1']).status, 0);
  assert.deepEqual(stateOf(run).guarded, ['implement:T1,T2']);
  write(dir, 'z.js', 'unowned\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 1);
  assert.deepEqual(stateOf(run).guarded, ['implement:T1,T2']);
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  assert.deepEqual(stateOf(run).guarded, ['implement:T1', 'implement:T1,T2']);
  const plain = plainDir();
  const outside = plannedRun(plain);
  assert.equal(neat(plain, ['run', 'stage', outside.id, 'explore']).status, 0);
  assert.equal(neat(plain, ['run', 'guard', outside.id]).status, 0);
  assert.deepEqual(stateOf(outside).guarded, ['explore']);
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

test('guard catches a read-only edit of a file an earlier task already changed', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  write(dir, 'a.js', 'impl\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  write(dir, 'a.js', 'impl\nTESTER-TAMPER\n');
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^guard violation: a\.js changed during a read-only stage$/m);
  const state = stateOf(run);
  assert.deepEqual(state.changed, []);
  assert.deepEqual(state.unowned, ['a.js']);
  assert.equal(neat(dir, ['run', 'guard', run.id]).status, 0, 'an unchanged tampered file is reported once');
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.equal(commit.stdout.trim(), 'commit skip: no owned changes');
  assert.ok(!git(dir, ['show', 'HEAD:a.js']).includes('TESTER-TAMPER'));
});

test('guard catches a later batch editing a file it does not own', () => {
  const dir = makeRepo();
  const plan = PLAN.replace('## D1:', '## T2: Other code\nworker: implementer\nowns: b.js\ndo: Add b.js.\n\n## D1:');
  const run = plannedRun(dir, plan);
  write(dir, 'a.js', 'impl\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  write(dir, 'a.js', 'impl\nfrom T2\n');
  write(dir, 'b.js', 'b\n');
  const res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T2']);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^guard violation: a\.js not owned by T2$/m);
  assert.deepEqual(stateOf(run).changed, ['b.js']);
});

test('guard catches a reader editing a file that was dirty before the run', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  write(dir, 'p.txt', 'user work overwritten\n');
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^guard violation: p\.txt changed during a read-only stage$/m);
});

test('commit refuses a guarded file that changed after the last guard', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  write(dir, 'a.js', 'impl\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const before = head(dir);
  write(dir, 'a.js', 'impl\nunguarded\n');
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), 'commit refused: a.js changed since the last guard');
  assert.equal(head(dir), before);
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
  assert.equal(message.trim(), 'chore: change the code');
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

function commitSubject(dir, taskText, type) {
  const run = plannedRun(dir, PLAN, taskText);
  if (type) assert.equal(neat(dir, ['stages', run.id, '--type', type]).status, 0);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return git(dir, ['log', '-1', '--format=%B']).trim();
}

test('commit type follows the task type', () => {
  const cases = [
    ['small-fix', 'fix: handle an empty list'],
    ['feature', 'feat: handle an empty list'],
    ['refactor', 'refactor: handle an empty list'],
  ];
  for (const [type, expected] of cases) {
    assert.equal(commitSubject(makeRepo(), 'Handle an empty list.', type), expected, type);
  }
});

test('commit subject keeps acronyms and trims to one short line', () => {
  assert.equal(commitSubject(makeRepo(), 'README: add install steps\nmore detail', 'docs'), 'docs: README: add install steps');
  const long = commitSubject(makeRepo(), `add ${'x'.repeat(100)}`, 'feature');
  assert.equal(long.split('\n').length, 1);
  assert.ok(long.length <= 'feat: '.length + 60, long);
});

test('commit uses a plain subject when the repo history is not conventional', () => {
  const dir = makeRepo();
  for (const msg of ['Tweak a', 'Update readme', 'Bump p', 'More work']) {
    write(dir, 'README.md', `# ${msg}\n`);
    git(dir, ['commit', '-q', '-am', msg]);
  }
  write(dir, 'p.txt', 'p dirty before the run\n');
  assert.equal(commitSubject(dir, 'handle an empty list', 'feature'), 'Handle an empty list');
});

function failingHook(dir) {
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho rejected by hook >&2\nexit 1\n', { mode: 0o755 });
}

test('a commit rejected by a hook leaves the index as it was', { skip: process.platform === 'win32' }, () => {
  const dir = makeRepo();
  failingHook(dir);
  const run = plannedRun(dir);
  write(dir, 'a.js', 'two\n');
  write(dir, 'new.js', 'brand new\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const before = head(dir);
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^commit failed$/m);
  assert.equal(head(dir), before);
  assert.equal(git(dir, ['diff', '--cached', '--name-only']), '');
  assert.equal(fs.readFileSync(path.join(dir, 'new.js'), 'utf8'), 'brand new\n');
  assert.deepEqual(stateOf(run).changed, ['a.js', 'new.js']);
});

test('a rejected first commit on an unborn branch leaves the index empty', { skip: process.platform === 'win32' }, () => {
  const dir = plainDir();
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Neat Test']);
  git(dir, ['config', 'user.email', 'neat@example.invalid']);
  failingHook(dir);
  const run = plannedRun(dir);
  write(dir, 'a.js', 'first\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const res = neat(dir, ['run', 'commit', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^commit failed$/m);
  assert.equal(git(dir, ['ls-files', '--cached']), '');
  assert.ok(fs.existsSync(path.join(dir, 'a.js')));
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

// ---------- IN-11: files generated during the test stage ----------

test('porcelainEntries returns XY codes, untracked as ??, rename sources and no .neat/', () => {
  const dir = makeRepo();
  write(dir, 'sub/new.js', 'x\n');
  write(dir, '.neat/runs/x/state.json', '{}');
  git(dir, ['mv', 'README.md', 'DOCS.md']);
  assert.deepEqual(gitLib.porcelainEntries(dir), [
    { xy: 'R ', path: 'DOCS.md' },
    { xy: 'R ', path: 'README.md' },
    { xy: ' M', path: 'p.txt' },
    { xy: '??', path: 'sub/new.js' },
  ]);
  assert.deepEqual(gitLib.porcelainPaths(dir), ['DOCS.md', 'README.md', 'p.txt', 'sub/new.js']);
});

test('porcelainEntries maps paths relative to a subdirectory project root', () => {
  const dir = makeRepo();
  write(dir, 'pkg/x.js', 'x\n');
  write(dir, 'top.js', 'y\n');
  const sub = path.join(dir, 'pkg');
  assert.deepEqual(gitLib.porcelainEntries(sub), [
    { xy: '??', path: '../top.js' },
    { xy: ' M', path: '../p.txt' },
    { xy: '??', path: 'x.js' },
  ].sort((a, b) => (a.path < b.path ? -1 : 1)));
  assert.deepEqual(gitLib.porcelainPaths(sub), ['../p.txt', '../top.js', 'x.js']);
});

function testStageRun(dir) {
  const run = plannedRun(dir);
  assert.equal(neat(dir, ['run', 'stage', run.id, 'test']).status, 0);
  return run;
}

test('test stage: a new untracked file becomes generated, noted and not a violation', () => {
  const dir = makeRepo();
  const run = testStageRun(dir);
  write(dir, 'coverage/lcov.info', 'TN:\n');
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^note: test created 1 untracked files \(not committed\): coverage\/lcov\.info$/m);
  assert.match(res.stdout, /^guard ok new=0$/m);
  const state = stateOf(run);
  assert.deepEqual(state.generated, ['coverage/lcov.info']);
  assert.deepEqual(state.violations, []);
  assert.deepEqual(state.unowned, []);
  assert.deepEqual(state.changed, []);
});

test('test stage: the generated note names five files and counts the rest', () => {
  const dir = makeRepo();
  const run = testStageRun(dir);
  for (let i = 1; i <= 7; i += 1) write(dir, `out/f${i}.txt`, `${i}\n`);
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 0, res.stdout);
  const names = [1, 2, 3, 4, 5].map((i) => `out/f${i}.txt`).join(', ');
  assert.ok(res.stdout.split('\n').includes(`note: test created 7 untracked files (not committed): ${names} (+2 more)`), res.stdout);
  assert.equal(stateOf(run).generated.length, 7);
});

test('test stage: tracked edits and deletions stay violations', () => {
  const dir = makeRepo();
  let run = testStageRun(dir);
  write(dir, 'a.js', 'edited by the tester\n');
  let res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: a\.js changed during a read-only stage$/m);

  const dir2 = makeRepo();
  run = testStageRun(dir2);
  fs.rmSync(path.join(dir2, 'README.md'));
  res = neat(dir2, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: README\.md changed during a read-only stage$/m);
  assert.deepEqual(stateOf(run).generated, []);
});

test('test stage: a tracked file removed from the index and left untracked is a violation', () => {
  const dir = makeRepo();
  const run = testStageRun(dir);
  git(dir, ['rm', '-q', '--cached', 'a.js']);
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: a\.js changed during a read-only stage$/m);
});

test('test stage: new files under reserved paths, CI config and git control files stay violations', () => {
  const cases = ['.claude/settings.json', '.claude/agents/neat-implementer.md', '.github/workflows/x.yml', 'sub/.gitignore', '.gitattributes'];
  for (const file of cases) {
    const dir = makeRepo();
    const run = testStageRun(dir);
    write(dir, file, 'x\n');
    write(dir, 'coverage/lcov.info', 'TN:\n');
    const res = neat(dir, ['run', 'guard', run.id]);
    assert.equal(res.status, 1, `${file}: ${res.stdout}`);
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(res.stdout, new RegExp(`^guard violation: ${escaped} changed during a read-only stage$`, 'm'));
    assert.doesNotMatch(res.stdout, /^guard ok/m);
    const state = stateOf(run);
    assert.deepEqual(state.generated, ['coverage/lcov.info'], file);
    assert.ok(state.unowned.includes(file), file);
  }
});

test('review stage: a new untracked file is still a violation', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  neat(dir, ['run', 'stage', run.id, 'review']);
  write(dir, 'coverage/lcov.info', 'TN:\n');
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: coverage\/lcov\.info changed during a read-only stage$/m);
});

test('later guards ignore generated files and commit leaves them untracked', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  neat(dir, ['run', 'stage', run.id, 'implement']);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  neat(dir, ['run', 'stage', run.id, 'test']);
  write(dir, 'coverage/lcov.info', 'TN:\n');
  assert.equal(neat(dir, ['run', 'guard', run.id]).status, 0);

  neat(dir, ['run', 'stage', run.id, 'docs']);
  write(dir, 'README.md', '# r\n\nmore\n');
  const res = neat(dir, ['run', 'guard', run.id, '--tasks', 'D1']);
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /^guard ok new=1$/m);
  assert.ok(!res.stdout.includes('coverage'), res.stdout);

  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.match(commit.stdout, /^committed [0-9a-f]{7} files=2$/m);
  const files = git(dir, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(files, ['README.md', 'a.js']);
  assert.match(git(dir, ['status', '--porcelain']), /^\?\? coverage\/$/m);
});

// ---------- protected files outside the git status view ----------

function markerHook(dir, marker) {
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  return hook;
}

test('research stage: a git hook planted by a worker is a guard violation and blocks the commit', { skip: process.platform === 'win32' }, () => {
  const dir = makeRepo();
  const run = newRun(dir);
  assert.equal(neat(dir, ['stages', run.id, '--type', 'feature', '--research']).status, 0);
  assert.match(neat(dir, ['run', 'stage', run.id, 'research']).stdout, /^stage research$/m);
  const marker = path.join(plainDir(), 'hook-ran');
  const hook = markerHook(dir, marker);
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1, res.stdout);
  assert.ok(res.stdout.split('\n').includes(`guard violation: protected file changed: ${fs.realpathSync(hook)}`)
    || res.stdout.split('\n').includes(`guard violation: protected file changed: ${hook}`), res.stdout);
  // Reported once: the next guard compares against what the last guard saw.
  assert.equal(neat(dir, ['run', 'guard', run.id]).status, 0);

  fs.writeFileSync(path.join(run.runDir, 'plan.md'), PLAN);
  assert.equal(neat(dir, ['plan', 'check', run.id]).status, 0);
  neat(dir, ['run', 'stage', run.id, 'implement']);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  const before = head(dir);
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.equal(commit.status, 1);
  assert.match(commit.stdout, /^commit refused: .*pre-commit changed during the run$/m);
  assert.equal(head(dir), before);
  assert.equal(fs.existsSync(marker), false, 'the planted hook ran');
});

test('a git config change during the run is a violation and blocks the commit', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  git(dir, ['config', 'core.hooksPath', 'elsewhere']);
  const res = neat(dir, ['run', 'guard', run.id]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^guard violation: protected file changed: .*config$/m);
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.equal(commit.status, 1);
  assert.match(commit.stdout, /^commit refused: .*config changed during the run$/m);
});

test('an ignored permission settings file changed during the run is a violation but does not block the commit', () => {
  const dir = makeRepo({ gitignore: '.claude/\n' });
  const run = plannedRun(dir);
  write(dir, 'a.js', 'two\n');
  write(dir, '.claude/settings.local.json', '{"permissions":{"allow":["Bash(*)"]}}');
  const res = neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(res.status, 1);
  const settings = path.join(dir, '.claude', 'settings.local.json');
  assert.ok(res.stdout.split('\n').includes(`guard violation: protected file changed: ${settings}`), res.stdout);
  assert.equal(stateOf(run).violations.length, 1);
  const commit = neat(dir, ['run', 'commit', run.id]);
  assert.match(commit.stdout, /^committed [0-9a-f]{7} files=1$/m);
});

test('a run without a protected record skips the protected check', () => {
  const dir = makeRepo();
  const run = plannedRun(dir);
  const file = path.join(run.runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete state.protected;
  fs.writeFileSync(file, JSON.stringify(state));
  git(dir, ['config', 'core.hooksPath', 'elsewhere']);
  write(dir, 'a.js', 'two\n');
  assert.equal(neat(dir, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
  assert.match(neat(dir, ['run', 'commit', run.id]).stdout, /^committed [0-9a-f]{7} files=1$/m);
});

test('the protected snapshot covers git hooks and config, the helper, agents, commands, guides and settings', () => {
  const protect = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'protect.cjs'));
  const dir = makeRepo();
  failingHook(dir);
  // In-process git: isolate it from the developer's global config (core.hooksPath).
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
  let keys;
  try {
    keys = Object.keys(protect.snapshot(dir, { CLAUDE_CONFIG_DIR: scratch }));
  } finally {
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
      if (k in saved) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
  const payload = path.join(REPO_ROOT, 'payload');
  for (const p of [
    path.join(dir, '.git', 'config'),
    path.join(dir, '.git', 'hooks', 'pre-commit'),
    HELPER,
    path.join(payload, 'neat', 'lib', 'git-ops.cjs'),
    path.join(payload, 'agents', 'neat-researcher.md'),
    path.join(payload, 'commands', 'neat', 'do.md'),
    path.join(payload, 'neat', 'guides', 'codex.md'),
    path.join(payload, 'neat', 'guides', 'review.md'),
    path.join(dir, '.claude', 'settings.json'),
    path.join(dir, '.claude', 'settings.local.json'),
    path.join(scratch, 'settings.json'),
  ]) assert.ok(keys.includes(p), p);
});
