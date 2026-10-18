'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const { parsePlan, computeBatches } = require(path.join(LIB, 'plan-check.cjs'));
const { buildBrief } = require(path.join(LIB, 'brief.cjs'));
const { REPORT_HEADINGS } = require(path.join(LIB, 'report-check.cjs'));

const VALID_PLAN = [
  'Free text before the first task is ignored.',
  '',
  '## T1: Add the parser',
  'worker: implementer',
  'owns: a.js, b.js',
  'do: Write the parser in a.js.',
  'Export it from b.js.',
  '',
  '## T2: Add the formatter',
  'worker: implementer',
  'owns: c.js',
  'do: Write the formatter.',
  '',
  '## T3: Wire both',
  'worker: implementer',
  'owns: b.js',
  'do: Call the parser from b.js.',
  '',
  '## D1: Document it',
  'worker: docs',
  'owns: README.md',
  'do: Describe the new flag.',
  '',
].join('\n');

function task(id, owns, extra = {}) {
  const worker = id.startsWith('T') ? 'implementer' : 'docs';
  return [`## ${id}: title ${id}`, `worker: ${extra.worker || worker}`, `owns: ${owns}`, `do: ${extra.do || 'work'}`].join('\n');
}

function planOf(...parts) {
  return `${parts.join('\n\n')}\n`;
}

function errorsOf(text) {
  return parsePlan(text).errors;
}

// ---------- parsePlan ----------

test('parsePlan reads four tasks with id, worker, title, owns and do', () => {
  const { tasks, errors } = parsePlan(VALID_PLAN);
  assert.deepEqual(errors, []);
  assert.deepEqual(tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'D1']);
  assert.equal(tasks[0].worker, 'implementer');
  assert.equal(tasks[0].title, 'Add the parser');
  assert.deepEqual(tasks[0].owns, ['a.js', 'b.js']);
  assert.equal(tasks[0].do, 'Write the parser in a.js.\nExport it from b.js.');
  assert.equal(tasks[3].worker, 'docs');
  assert.deepEqual(tasks[3].owns, ['README.md']);
});

test('parsePlan reports a missing owns: line', () => {
  const text = planOf(task('T1', 'a.js'), '## T2: x\nworker: implementer\ndo: y', task('D1', 'README.md'));
  assert.deepEqual(errorsOf(text), ['T2: missing owns:']);
});

test('parsePlan reports a missing do: line', () => {
  const text = planOf(task('T1', 'a.js'), '## T2: x\nworker: implementer\nowns: c.js', task('D1', 'README.md'));
  assert.deepEqual(errorsOf(text), ['T2: missing do:']);
});

test('parsePlan rejects absolute paths', () => {
  assert.deepEqual(errorsOf(planOf(task('T1', '/etc/x'), task('D1', 'README.md'))), ['T1: path must be relative: /etc/x']);
});

test('parsePlan rejects paths that escape the repo', () => {
  assert.deepEqual(errorsOf(planOf(task('T1', '../x'), task('D1', 'README.md'))), ['T1: path escapes repo: ../x']);
  assert.deepEqual(errorsOf(planOf(task('T1', 'a/../../x'), task('D1', 'README.md'))), ['T1: path escapes repo: a/../../x']);
});

test('parsePlan rejects .claude/ paths and .git or .neat segments at any depth', () => {
  for (const owned of [
    '.claude/neat/bin/neat.cjs', '.claude/settings.local.json', '.Claude/settings.json',
    'sub/.git/hooks/pre-commit', 'sub/.GIT/config', 'pkg/.neat/runs/x',
  ]) {
    assert.deepEqual(errorsOf(planOf(task('T1', owned), task('D1', 'README.md'))), [`T1: path not allowed: ${owned}`]);
  }
  assert.deepEqual(errorsOf(planOf(task('T1', 'docs/.claude/notes.md, a.gitignore'), task('D1', 'README.md'))), []);
});

test('parsePlan rejects paths under .neat/ and .git/', () => {
  assert.deepEqual(errorsOf(planOf(task('T1', '.neat/x'), task('D1', 'README.md'))), ['T1: path not allowed: .neat/x']);
  assert.deepEqual(errorsOf(planOf(task('T1', '.git/config'), task('D1', 'README.md'))), ['T1: path not allowed: .git/config']);
});

test('parsePlan rejects backslashes in paths', () => {
  const errors = errorsOf(planOf(task('T1', 'src\\a.js'), task('D1', 'README.md')));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^T1: path must use forward slashes: src\\a\.js$/);
});

test('parsePlan normalises ./ prefixes', () => {
  const { tasks, errors } = parsePlan(planOf(task('T1', './src/a.js'), task('D1', 'README.md')));
  assert.deepEqual(errors, []);
  assert.deepEqual(tasks[0].owns, ['src/a.js']);
});

test('parsePlan checks the worker matches the task id prefix', () => {
  assert.deepEqual(
    errorsOf(planOf(task('T1', 'a.js', { worker: 'docs' }), task('D1', 'README.md'))),
    ['T1: worker must be implementer'],
  );
  assert.deepEqual(
    errorsOf(planOf(task('T1', 'a.js'), task('D1', 'README.md', { worker: 'implementer' }))),
    ['D1: worker must be docs'],
  );
});

test('parsePlan reports duplicate task ids', () => {
  assert.deepEqual(errorsOf(planOf(task('T1', 'a.js'), task('T1', 'b.js'), task('D1', 'README.md'))), ['duplicate task id T1']);
});

test('parsePlan needs at least one implementer and one docs task', () => {
  assert.deepEqual(errorsOf(planOf(task('D1', 'README.md'))), ['plan needs at least one implementer task (## T1: ...)']);
  assert.deepEqual(errorsOf(planOf(task('T1', 'a.js'))), ['plan needs at least one docs task (## D1: ...)']);
});

// ---------- computeBatches ----------

test('computeBatches puts tasks sharing a file into later batches', () => {
  const { tasks } = parsePlan(VALID_PLAN);
  assert.deepEqual(computeBatches(tasks), { implement: [['T1', 'T2'], ['T3']], docs: [['D1']] });
});

test('computeBatches places a task after the highest earlier batch it overlaps', () => {
  const tasks = [
    { id: 'T1', worker: 'implementer', owns: ['a'] },
    { id: 'T2', worker: 'implementer', owns: ['a', 'b'] },
    { id: 'T3', worker: 'implementer', owns: ['b'] },
    { id: 'T4', worker: 'implementer', owns: ['c'] },
    { id: 'D1', worker: 'docs', owns: ['r'] },
    { id: 'D2', worker: 'docs', owns: ['r'] },
  ];
  assert.deepEqual(computeBatches(tasks), {
    implement: [['T1', 'T4'], ['T2'], ['T3']],
    docs: [['D1'], ['D2']],
  });
});

test('within every batch no two tasks own the same file', () => {
  const { tasks } = parsePlan(VALID_PLAN);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const { implement, docs } = computeBatches(tasks);
  for (const batch of [...implement, ...docs]) {
    const seen = new Set();
    for (const id of batch) {
      for (const file of byId.get(id).owns) {
        assert.ok(!seen.has(file), `${file} shared inside batch ${batch}`);
        seen.add(file);
      }
    }
  }
});

// ---------- buildBrief (pure) ----------

const STATE = {
  id: '20261018-123456-fix-bug',
  task: 'fix the bug',
  tasks: [
    { id: 'T1', worker: 'implementer', title: 'Add the parser', owns: ['a.js', 'b.js'], do: 'Write the parser in a.js.', batch: 0 },
    { id: 'D1', worker: 'docs', title: 'Document it', owns: ['README.md'], do: 'Describe the new flag.', batch: 0 },
  ],
};
const RUN_DIR = '/proj/.neat/runs/20261018-123456-fix-bug';
const HELPER_ABS = '/proj/.claude/neat/bin/neat.cjs';

function brief(worker, opts = {}) {
  return buildBrief(STATE, worker, {
    runDir: RUN_DIR,
    helperPath: HELPER_ABS,
    exists: opts.exists || (() => false),
    notes: opts.notes,
  });
}

test('implementer brief carries header lines, owned files, rules and report contract', () => {
  const text = brief('implementer-T1');
  assert.match(text, /^# Brief: implementer-T1$/m);
  assert.match(text, /^Task: fix the bug$/m);
  assert.match(text, /^Run id: 20261018-123456-fix-bug$/m);
  assert.ok(text.includes(`Run dir: ${RUN_DIR}`));
  assert.ok(text.includes(`Helper: node ${HELPER_ABS}`));
  assert.ok(text.includes(`Report: ${RUN_DIR}/report-implementer-T1.md`));
  assert.ok(text.includes('T1: Add the parser'));
  assert.ok(text.includes('Write the parser in a.js.'));
  assert.match(text, /## Files you own\n- a\.js\n- b\.js\n/);
  for (const h of REPORT_HEADINGS) assert.ok(text.includes(h), h);
  assert.ok(text.includes('300 words'));
  assert.ok(text.includes('SubagentHandback'));
  assert.ok(text.includes('NEAT_EOF'));
  assert.ok(text.split('\n').length < 70, `brief has ${text.split('\n').length} lines`);
});

test('buildBrief throws for an unknown plan task', () => {
  assert.throws(() => brief('implementer-T9'), /unknown task T9 \(run plan check first\)/);
  assert.throws(() => brief('docs-D7'), /unknown task D7 \(run plan check first\)/);
});

test('read-only roles own no files', () => {
  for (const role of ['explorer', 'reviewer', 'tester']) {
    assert.match(brief(role), /## Files you own\n- none \(read-only role\)\n/, role);
  }
});

test('explorer brief names the map file', () => {
  assert.ok(brief('explorer').includes(`Map: ${RUN_DIR}/explore-map.md`));
});

test('reviewer and docs briefs include the diff only when it exists', () => {
  const diff = `Diff: ${RUN_DIR}/diff.patch`;
  assert.ok(!brief('reviewer').includes(diff));
  assert.ok(!brief('docs-D1').includes(diff));
  const exists = (p) => p === `${RUN_DIR}/diff.patch`;
  assert.ok(brief('reviewer', { exists }).includes(diff));
  assert.ok(brief('docs-D1', { exists }).includes(diff));
  assert.ok(brief('reviewer').includes(`Review file: ${RUN_DIR}/review.md`));
});

test('tester brief names the test log', () => {
  assert.ok(brief('tester').includes(`Test log: ${RUN_DIR}/test-log.txt`));
});

test('docs brief tells the worker to save the report with the Write tool', () => {
  const text = brief('docs-D1');
  assert.match(text, /Write tool/);
  assert.match(text, /## Files you own\n- README\.md\n/);
  assert.ok(!text.includes(`node ${HELPER_ABS} write`));
});

test('context files list plan.md and the explorer report when present', () => {
  const exists = (p) => p.endsWith('/plan.md') || p.endsWith('/report-explorer.md');
  const text = brief('implementer-T1', { exists });
  assert.ok(text.includes(`- ${RUN_DIR}/plan.md`));
  assert.ok(text.includes(`- ${RUN_DIR}/report-explorer.md`));
});

test('orchestrator notes are appended as a final section', () => {
  const text = brief('tester', { notes: 'test command: npm test' });
  assert.match(text, /## Orchestrator notes\ntest command: npm test\n$/);
  assert.ok(!brief('tester').includes('## Orchestrator notes'));
});

// ---------- CLI ----------

let proj;
let env;

before(() => {
  proj = makeTempDir('neat-plan-');
  env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: '2026-10-18T12:34:56Z' });
});

after(() => removeDir(proj));

function neat(args, input) {
  return runNode([HELPER, ...args], { cwd: proj, env, input });
}

function newRun(taskText) {
  const res = neat(['run', 'new', '--stdin'], taskText);
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  return { id, dir: path.join(proj, '.neat', 'runs', id) };
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

test('help lists plan check and brief', () => {
  const res = neat(['help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^neat plan check/m);
  assert.match(res.stdout, /^neat brief/m);
});

test('plan check without plan.md exits 1', () => {
  const { id } = newRun('missing plan');
  const res = neat(['plan', 'check', id]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), 'plan.md not found');
});

test('plan check on errors exits 1 with at most 10 lines and leaves state unchanged', () => {
  const { id, dir } = newRun('bad plan');
  const parts = [];
  for (let i = 1; i <= 12; i += 1) parts.push(task(`T${i}`, `/abs${i}`));
  fs.writeFileSync(path.join(dir, 'plan.md'), planOf(...parts, task('D1', 'README.md')));
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const res = neat(['plan', 'check', id]);
  assert.equal(res.status, 1);
  const lines = res.stdout.trim().split('\n');
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  assert.equal(lines[0], 'T1: path must be relative: /abs1');
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
});

test('plan check on a valid plan prints batches and records tasks in state.json', () => {
  const { id, dir } = newRun('good plan');
  fs.writeFileSync(path.join(dir, 'plan.md'), VALID_PLAN);
  const res = neat(['plan', 'check', id]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'plan ok tasks=4 implement=[T1,T2] [T3] docs=[D1]\n');
  const state = readState(dir);
  assert.deepEqual(state.tasks.map((t) => [t.id, t.batch]), [['T1', 0], ['T2', 0], ['T3', 1], ['D1', 0]]);
  assert.deepEqual(Object.keys(state.tasks[0]).sort(), ['batch', 'do', 'id', 'owns', 'title', 'worker']);
});

test('brief explorer before any plan writes the file, prints only its path and marks the worker running', () => {
  const { id, dir } = newRun('explore first');
  const res = neat(['brief', id, 'explorer']);
  assert.equal(res.status, 0, res.stderr);
  const file = path.join(dir, 'brief-explorer.md');
  assert.equal(res.stdout, `${file}\n`);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.readFileSync(file, 'utf8').includes(`Helper: node ${HELPER}`));
  const w = readState(dir).workers.find((x) => x.name === 'explorer');
  assert.equal(w.status, 'running');
});

test('brief implementer-T1 after plan check embeds the absolute helper and report paths', () => {
  const { id, dir } = newRun('implement it');
  fs.writeFileSync(path.join(dir, 'plan.md'), VALID_PLAN);
  assert.equal(neat(['plan', 'check', id]).status, 0);
  const res = neat(['brief', id, 'implementer-T1']);
  assert.equal(res.status, 0, res.stderr);
  const text = fs.readFileSync(res.stdout.trim(), 'utf8');
  assert.ok(text.includes(`Helper: node ${HELPER}`));
  assert.ok(text.includes(`Report: ${dir}/report-implementer-T1.md`));
  assert.ok(text.includes(`- ${dir}/plan.md`));
  assert.match(text, /## Files you own\n- a\.js\n- b\.js\n/);
});

test('brief for an unknown task exits 1; an invalid worker exits 2', () => {
  const { id } = newRun('unknown worker');
  const unknown = neat(['brief', id, 'implementer-T9']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown task T9 \(run plan check first\)/);
  assert.equal(neat(['brief', id, 'wizard']).status, 2);
});

test('stdin text with a NEAT_EOF line is refused by run new, write and brief', () => {
  const message = 'neat: input must not contain a line NEAT_EOF\n';
  const task = neat(['run', 'new', '--stdin'], 'fix it\nNEAT_EOF\nrm -rf x\n');
  assert.equal(task.status, 2);
  assert.equal(task.stderr, message);
  const { id, dir } = newRun('heredoc guard');
  const plan = neat(['write', id, 'plan.md', '--stdin'], '## T1: x\n  NEAT_EOF \n');
  assert.equal(plan.status, 2);
  assert.equal(plan.stderr, message);
  assert.ok(!fs.existsSync(path.join(dir, 'plan.md')));
  const notes = neat(['brief', id, 'tester', '--stdin'], 'test command: x\r\nNEAT_EOF\r\n');
  assert.equal(notes.status, 2);
  assert.equal(notes.stderr, message);
  assert.equal(neat(['write', id, 'notes.md', '--stdin'], 'mentions NEAT_EOF inline\n').status, 0);
});

test('brief --stdin appends orchestrator notes', () => {
  const { id } = newRun('test it');
  const res = neat(['brief', id, 'tester', '--stdin'], 'test command: npm test\n');
  assert.equal(res.status, 0, res.stderr);
  const text = fs.readFileSync(res.stdout.trim(), 'utf8');
  assert.match(text, /## Orchestrator notes\ntest command: npm test\n$/);
});
