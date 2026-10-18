'use strict';

// Replays the exact helper call order that payload/commands/neat/do.md
// prescribes, against the INSTALLED helper (`bin/install.cjs --local`) in
// throwaway git repos. The test stands in for the workers by writing their
// files and reports directly. The user's global/system git config is
// disabled so hooks and signing never apply.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const OWNED = ['README.md', 'src/a.js', 'src/b.js'];
const PLAN = [
  'Plan for: add greeting',
  '',
  '## T1: Greet from a',
  'worker: implementer',
  'owns: src/a.js',
  'do: Export a greet() function from src/a.js.',
  '',
  '## T2: Add b',
  'worker: implementer',
  'owns: src/b.js',
  'do: Create src/b.js that re-exports greet.',
  '',
  '## D1: Document greeting',
  'worker: docs',
  'owns: README.md',
  'do: Describe greet() in the README.',
  '',
].join('\n');

let scratch;
const dirs = [];

before(() => {
  scratch = makeTempDir('neat-pipecfg-');
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

// Temp git repo with one commit holding the installed .claude/ tree and the
// starting project files. `.neat/` is left untracked (not ignored).
function makeProject() {
  const dir = makeTempDir('neat-pipe-');
  dirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Neat Test']);
  git(dir, ['config', 'user.email', 'neat@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  const res = runNode([INSTALLER, '--local'], { cwd: dir, env: envFor(dir) });
  assert.equal(res.status, 0, res.stderr);
  write(dir, 'src/a.js', 'module.exports = {};\n');
  write(dir, 'other.js', 'module.exports = 1;\n');
  write(dir, 'README.md', '# demo\n');
  write(dir, 'package.json', '{ "name": "demo", "scripts": { "test": "node -e 0" } }\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return { dir, helper: path.join(dir, '.claude', 'neat', 'bin', 'neat.cjs') };
}

function neat(project, args, input) {
  return runNode([project.helper, ...args], { cwd: project.dir, env: envFor(project.dir), input });
}

function ok(project, args, input) {
  const res = neat(project, args, input);
  assert.equal(res.status, 0, `neat ${args.join(' ')}\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

function report({ status = 'done', findings = '- none', artifacts = '- none' } = {}) {
  return [
    '## Status', status,
    '## Findings', findings,
    '## Decisions', '- none',
    '## Open questions', '- none',
    '## Artifacts', artifacts,
    '',
  ].join('\n');
}

function briefLine(file, key) {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}: `));
  assert.ok(line, `${key}: missing from ${file}`);
  return line.slice(key.length + 2);
}

// Brief -> (stand-in work) -> report via `write` -> report check -> worker done.
function runWorker(project, id, worker, { notes, work, reportText, route } = {}) {
  const args = notes ? ['brief', id, worker, '--stdin'] : ['brief', id, worker];
  const [briefPath, routeLine] = ok(project, args, notes).split('\n');
  if (route) assert.match(routeLine, route);
  assert.ok(path.isAbsolute(briefPath), briefPath);
  assert.ok(fs.readFileSync(briefPath, 'utf8').startsWith(`# Brief: ${worker}`));
  if (work) work(briefPath);
  const reportPath = briefLine(briefPath, 'Report');
  if (worker.startsWith('docs-')) {
    fs.writeFileSync(reportPath, reportText || report()); // docs saves with the Write tool
  } else {
    const out = ok(project, ['write', id, `report-${worker}.md`, '--stdin'], reportText || report());
    assert.match(out, /report ok/);
  }
  assert.match(ok(project, ['report', 'check', reportPath]), /report ok/);
  ok(project, ['run', 'worker', id, worker, 'done']);
  return briefPath;
}

function guard(project, id, tasks) {
  return neat(project, tasks ? ['run', 'guard', id, '--tasks', tasks] : ['run', 'guard', id]);
}

function startRun(project, mode) {
  const out = ok(project, ['run', 'new', '--stdin'], `add greeting --mode ${mode}\n`);
  const m = /^id=(\S+) mode=(\S+) dir=(.+)$/m.exec(out);
  assert.ok(m, out);
  assert.equal(m[2], mode);
  return { id: m[1], dir: m[3] };
}

function explore(project, id) {
  ok(project, ['run', 'stage', id, 'explore']);
  runWorker(project, id, 'explorer', {
    work: () => ok(project, ['write', id, 'explore-map.md', '--stdin'], 'src/a.js:1 - module entry\n'),
    reportText: report({ findings: '- src/a.js:1 - module entry\n- test command: npm test', artifacts: '- explore-map.md' }),
  });
  assert.equal(guard(project, id).status, 0);
}

function plan(project, id) {
  ok(project, ['run', 'stage', id, 'plan']);
  ok(project, ['write', id, 'plan.md', '--stdin'], PLAN);
  const line = ok(project, ['plan', 'check', id]);
  assert.ok(line.includes('implement=[T1,T2]'), line);
  assert.ok(line.includes('docs=[D1]'), line);
}

function implement(project, id) {
  ok(project, ['run', 'stage', id, 'implement']);
  runWorker(project, id, 'implementer-T1', {
    work: () => write(project.dir, 'src/a.js', 'exports.greet = () => "hi";\n'),
    reportText: report({ findings: '- src/a.js:1 - greet()' }),
  });
  runWorker(project, id, 'implementer-T2', {
    work: () => write(project.dir, 'src/b.js', 'module.exports = require("./a");\n'),
    reportText: report({ findings: '- src/b.js:1 - re-export' }),
  });
}

function reviewAndTest(project, id) {
  ok(project, ['run', 'stage', id, 'review']);
  const diffOut = ok(project, ['run', 'diff', id]);
  const diff = fs.readFileSync(path.join(project.dir, '.neat', 'runs', id, 'diff.patch'), 'utf8');
  assert.ok(diff.includes('src/a.js') && diff.includes('src/b.js'), diffOut);
  runWorker(project, id, 'reviewer', {
    work: (briefPath) => {
      assert.ok(fs.readFileSync(briefPath, 'utf8').includes('Diff: '));
      ok(project, ['write', id, 'review.md', '--stdin'], 'none\n');
    },
    reportText: report({ artifacts: '- review.md' }),
  });
  assert.equal(guard(project, id).status, 0);

  ok(project, ['run', 'stage', id, 'test']);
  runWorker(project, id, 'tester', {
    notes: 'test command: npm test\n',
    work: (briefPath) => {
      assert.ok(fs.readFileSync(briefPath, 'utf8').includes('test command: npm test'));
      ok(project, ['write', id, 'test-log.txt', '--stdin'], 'all tests passed\n');
    },
    reportText: report({ artifacts: '- test-log.txt' }),
  });
  assert.equal(guard(project, id).status, 0);
}

function docs(project, id) {
  ok(project, ['run', 'stage', id, 'docs']);
  runWorker(project, id, 'docs-D1', {
    work: () => write(project.dir, 'README.md', '# demo\n\nCall `greet()` to say hi.\n'),
    reportText: report({ findings: '- README.md:3 - greet usage' }),
  });
  assert.equal(guard(project, id, 'D1').status, 0);
}

function newCommits(project) {
  return git(project.dir, ['log', '--format=%s']).trim().split('\n').filter((s) => s !== 'init');
}

function committedFiles(project, rev) {
  return git(project.dir, ['show', '--name-only', '--format=', rev]).trim().split('\n').sort();
}

function assertFinished(project, run, reportCount = 6, untracked = []) {
  const porcelain = git(project.dir, ['status', '--porcelain']).split('\n').filter(Boolean);
  assert.deepEqual(porcelain.filter((l) => l !== '?? .neat/'), untracked);
  const runs = JSON.parse(ok(project, ['status', '--json']));
  const entry = runs.find((r) => r.id === run.id);
  assert.ok(entry, 'run missing from status --json');
  assert.equal(entry.stage, 'done');
  assert.deepEqual(entry.activeWorkers, []);
  const reports = fs.readdirSync(run.dir).filter((f) => /^report-.*\.md$/.test(f));
  assert.equal(reports.length, reportCount, reports.join(', '));
  for (const f of reports) assert.match(ok(project, ['report', 'check', path.join(run.dir, f)]), /report ok/);
}

describe('gate mode: one commit per run', () => {
  test('full stage sequence ends done with one commit of exactly the owned files', () => {
    const project = makeProject();
    const run = startRun(project, 'gate');
    explore(project, run.id);
    plan(project, run.id);
    implement(project, run.id);
    const implGuard = guard(project, run.id, 'T1,T2');
    assert.equal(implGuard.status, 0, implGuard.stdout);
    assert.match(implGuard.stdout, /guard ok new=2/);
    reviewAndTest(project, run.id);
    docs(project, run.id);
    assert.match(ok(project, ['run', 'commit', run.id]), /^committed [0-9a-f]{7} files=3/);
    ok(project, ['run', 'stage', run.id, 'done']);

    const commits = newCommits(project);
    assert.equal(commits.length, 1, commits.join('\n'));
    assert.ok(commits[0].startsWith('neat: '), commits[0]);
    assert.deepEqual(committedFiles(project, 'HEAD'), OWNED);
    assertFinished(project, run);
  });
});

describe('step mode: commits after implement and after docs', () => {
  test('two neat commits, src files first and README.md second', () => {
    const project = makeProject();
    const run = startRun(project, 'step');
    explore(project, run.id);
    plan(project, run.id);
    implement(project, run.id);
    assert.equal(guard(project, run.id, 'T1,T2').status, 0);
    assert.match(ok(project, ['run', 'commit', run.id]), /^committed [0-9a-f]{7} files=2/);
    reviewAndTest(project, run.id);
    docs(project, run.id);
    assert.match(ok(project, ['run', 'commit', run.id]), /^committed [0-9a-f]{7} files=1/);
    ok(project, ['run', 'stage', run.id, 'done']);

    const commits = newCommits(project);
    assert.equal(commits.length, 2, commits.join('\n'));
    assert.ok(commits.every((s) => s.startsWith('neat: ')), commits.join('\n'));
    assert.deepEqual(committedFiles(project, 'HEAD~1'), ['src/a.js', 'src/b.js']);
    assert.deepEqual(committedFiles(project, 'HEAD'), ['README.md']);
    assertFinished(project, run);
  });
});

describe('violations are caught by run guard', () => {
  test('an unowned edit and a worker commit during implement both fail the guard', () => {
    const project = makeProject();
    const run = startRun(project, 'gate');
    explore(project, run.id);
    plan(project, run.id);
    implement(project, run.id);
    write(project.dir, 'other.js', 'module.exports = 2;\n'); // stand-in strays outside its files

    const unowned = guard(project, run.id, 'T1,T2');
    assert.equal(unowned.status, 1);
    assert.match(unowned.stdout, /guard violation: other\.js not owned by T1,T2/);

    git(project.dir, ['add', 'src/a.js']); // stand-in commits on its own
    git(project.dir, ['commit', '-q', '-m', 'worker commit']);
    const moved = guard(project, run.id, 'T1,T2');
    assert.equal(moved.status, 1);
    assert.match(moved.stdout, /guard violation: HEAD moved/);

    const commit = neat(project, ['run', 'commit', run.id]);
    assert.equal(commit.status, 1);
    assert.match(commit.stdout, /commit refused: HEAD moved/);
  });
});

const SMALL_PLAN = [
  'stages explore,plan,implement,test type=small-fix propose=yes',
  '',
  '## T1: Greet from a',
  'worker: implementer',
  'owns: src/a.js',
  'do: Export a greet() function from src/a.js.',
  '',
].join('\n');

function stageStatuses(run) {
  const state = JSON.parse(fs.readFileSync(path.join(run.dir, 'state.json'), 'utf8'));
  return Object.fromEntries(state.stages.map((s) => [s.name, s.status]));
}

describe('gate mode small fix: only explore, plan, implement and test run', () => {
  test('review and docs are skipped and the one commit holds only src/a.js', () => {
    const project = makeProject();
    const run = startRun(project, 'gate');
    explore(project, run.id);
    assert.equal(ok(project, ['run', 'classify', run.id, 'trivial']), 'complexity trivial\n');
    assert.equal(ok(project, ['stages', run.id, '--type', 'small-fix']),
      'stages explore,plan,implement,test type=small-fix propose=yes\n');

    ok(project, ['run', 'stage', run.id, 'plan']);
    ok(project, ['write', run.id, 'plan.md', '--stdin'], SMALL_PLAN);
    assert.equal(ok(project, ['plan', 'check', run.id]),
      'plan ok tasks=1 stages=explore,plan,implement,test implement=[T1] docs=none\n');

    ok(project, ['run', 'stage', run.id, 'implement']);
    runWorker(project, run.id, 'implementer-T1', {
      route: /^route worker=implementer-T1 model=haiku effort=low .*complexity=trivial /,
      work: () => write(project.dir, 'src/a.js', 'exports.greet = () => "hi";\n'),
      reportText: report({ findings: '- src/a.js:1 - greet()' }),
    });
    const implGuard = guard(project, run.id, 'T1');
    assert.equal(implGuard.status, 0, implGuard.stdout);

    assert.equal(ok(project, ['run', 'stage', run.id, 'review']), 'stage review skipped\n');
    ok(project, ['run', 'stage', run.id, 'test']);
    runWorker(project, run.id, 'tester', {
      work: () => {
        ok(project, ['write', run.id, 'test-log.txt', '--stdin'], 'all tests passed\n');
        write(project.dir, 'coverage/lcov.info', 'TN:\n'); // the test run leaves a report behind
      },
      reportText: report({ artifacts: '- test-log.txt' }),
    });
    const testGuard = guard(project, run.id);
    assert.equal(testGuard.status, 0, testGuard.stdout);
    assert.match(testGuard.stdout, /^note: test created 1 untracked files \(not committed\): coverage\/lcov\.info$/m);
    assert.match(testGuard.stdout, /^guard ok new=0$/m);
    assert.equal(ok(project, ['run', 'stage', run.id, 'docs']), 'stage docs skipped\n');

    assert.match(ok(project, ['run', 'commit', run.id]), /^committed [0-9a-f]{7} files=1/);
    ok(project, ['run', 'stage', run.id, 'done']);

    const commits = newCommits(project);
    assert.equal(commits.length, 1, commits.join('\n'));
    assert.ok(commits[0].startsWith('neat: '), commits[0]);
    assert.deepEqual(committedFiles(project, 'HEAD'), ['src/a.js']);
    assertFinished(project, run, 3, ['?? coverage/']);
    const reports = fs.readdirSync(run.dir).filter((f) => /^report-.*\.md$/.test(f)).sort();
    assert.deepEqual(reports, ['report-explorer.md', 'report-implementer-T1.md', 'report-tester.md']);
    const statuses = stageStatuses(run);
    for (const name of ['research', 'review', 'docs']) assert.equal(statuses[name], 'skipped', name);
    for (const name of ['explore', 'plan', 'implement', 'test']) assert.equal(statuses[name], 'done', name);
  });
});
