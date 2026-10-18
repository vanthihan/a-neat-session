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

test('researcher brief names the notes file, owns nothing and saves with the Write tool', () => {
  const text = brief('researcher');
  assert.ok(text.includes(`Notes: ${RUN_DIR}/research-notes.md`));
  assert.ok(text.includes(`Report: ${RUN_DIR}/report-researcher.md`));
  assert.match(text, /## Files you own\n- none \(read-only role\)\n/);
  assert.match(text, /Orchestrator notes/);
  assert.match(text, /source URL or `path:line`/);
  assert.match(text, /Write tool/);
  assert.match(text, /Grep and Glob tools/);
  assert.match(text, /untrusted/);
  assert.match(text, /at most 8 web searches/);
  assert.match(text, /`source - finding`/);
  assert.match(text, /partial/);
  assert.ok(!text.includes('NEAT_EOF'));
  assert.ok(!text.includes('Findings as `path:line - note`'));
  for (const h of REPORT_HEADINGS) assert.ok(text.includes(h), h);
});

test('other roles keep `path:line - note` findings and no notes header', () => {
  for (const w of ['explorer', 'reviewer', 'tester', 'implementer-T1', 'docs-D1']) {
    const text = brief(w);
    assert.ok(text.includes('Findings as `path:line - note`'), w);
    assert.ok(!text.includes('Notes: '), w);
    assert.ok(!text.includes('untrusted'), w);
  }
});

test('context files list the researcher report and notes when present', () => {
  const names = ['/plan.md', '/report-explorer.md', '/report-researcher.md', '/research-notes.md'];
  const exists = (p) => names.some((n) => p.endsWith(n));
  for (const w of ['implementer-T1', 'reviewer', 'docs-D1']) {
    const text = brief(w, { exists });
    assert.ok(text.includes(`- ${RUN_DIR}/report-researcher.md`), w);
    assert.ok(text.includes(`- ${RUN_DIR}/research-notes.md`), w);
  }
  assert.ok(!brief('implementer-T1').includes('research-notes.md'));
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
  assert.equal(res.stdout, 'plan ok tasks=4 stages=explore,plan,implement,review,test,docs implement=[T1,T2] [T3] docs=[D1]\n');
  const state = readState(dir);
  assert.deepEqual(state.tasks.map((t) => [t.id, t.batch]), [['T1', 0], ['T2', 0], ['T3', 1], ['D1', 0]]);
  assert.deepEqual(Object.keys(state.tasks[0]).sort(), ['batch', 'do', 'id', 'owns', 'title', 'worker']);
});

// ---------- stage-aware plan check ----------

function typedRun(taskText, type) {
  const run = newRun(taskText);
  const res = neat(['stages', run.id, '--type', type]);
  assert.equal(res.status, 0, res.stderr);
  return run;
}

function checkWith(dir, id, ...parts) {
  fs.writeFileSync(path.join(dir, 'plan.md'), planOf(...parts));
  return neat(['plan', 'check', id]);
}

test('a small-fix plan needs no docs task and prints the selected stages', () => {
  const { id, dir } = typedRun('small fix plan', 'small-fix');
  const res = checkWith(dir, id, task('T1', 'src/a.js'));
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.stdout, 'plan ok tasks=1 stages=explore,plan,implement,test implement=[T1] docs=none\n');
});

test('tasks for an unselected stage are rejected', () => {
  const small = typedRun('small fix with docs', 'small-fix');
  let res = checkWith(small.dir, small.id, task('T1', 'src/a.js'), task('D1', 'README.md'));
  assert.equal(res.status, 1);
  assert.ok(res.stdout.split('\n').includes('D1: docs stage not selected'), res.stdout);
  const docs = typedRun('docs with code', 'docs');
  res = checkWith(docs.dir, docs.id, task('T1', 'src/a.js'), task('D1', 'README.md'));
  assert.equal(res.status, 1);
  assert.ok(res.stdout.split('\n').includes('T1: implement stage not selected'), res.stdout);
});

test('a docs plan needs only docs tasks', () => {
  const { id, dir } = typedRun('docs only', 'docs');
  const res = checkWith(dir, id, task('D1', 'README.md'));
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.stdout, 'plan ok tasks=1 stages=explore,plan,docs implement=none docs=[D1]\n');
});

test('a feature plan still needs implementer and docs tasks', () => {
  const a = typedRun('feature no docs', 'feature');
  let res = checkWith(a.dir, a.id, task('T1', 'src/a.js'));
  assert.equal(res.status, 1);
  assert.equal(res.stdout, 'plan needs at least one docs task (## D1: ...)\n');
  const b = typedRun('feature no code', 'feature');
  res = checkWith(b.dir, b.id, task('D1', 'README.md'));
  assert.equal(res.status, 1);
  assert.equal(res.stdout, 'plan needs at least one implementer task (## T1: ...)\n');
});

test('parsePlan with a selection checks task kinds against it', () => {
  const plan = planOf(task('T1', 'a.js'), task('D1', 'README.md'));
  assert.deepEqual(parsePlan(plan, ['explore', 'plan', 'implement', 'test']).errors, ['D1: docs stage not selected']);
  assert.deepEqual(parsePlan(plan, ['explore', 'plan', 'docs']).errors, ['T1: implement stage not selected']);
  assert.deepEqual(parsePlan(plan).errors, []);
});

test('brief explorer before any plan writes the file, prints its path and route line and marks the worker running', () => {
  const { id, dir } = newRun('explore first');
  const res = neat(['brief', id, 'explorer']);
  assert.equal(res.status, 0, res.stderr);
  const file = path.join(dir, 'brief-explorer.md');
  const lines = res.stdout.split('\n');
  assert.equal(lines.length, 3, res.stdout);
  assert.equal(lines[0], file);
  assert.ok(lines[1].startsWith('route worker=explorer '), lines[1]);
  assert.equal(lines[2], '');
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
  const text = fs.readFileSync(res.stdout.split('\n')[0], 'utf8');
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
  const text = fs.readFileSync(res.stdout.split('\n')[0], 'utf8');
  assert.match(text, /## Orchestrator notes\ntest command: npm test\n$/);
});

test('brief researcher routes on the mid tier and carries orchestrator questions', () => {
  const { id, dir } = newRun('--research how does the retry work');
  const res = neat(['brief', id, 'researcher', '--stdin'], 'research: retry backoff in fetch?\nresearch: max attempts?\n');
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  assert.equal(lines[0], path.join(dir, 'brief-researcher.md'));
  assert.ok(lines[1].startsWith('route worker=researcher model=sonnet effort=medium profile=adaptive '), lines[1]);
  const text = fs.readFileSync(lines[0], 'utf8');
  assert.ok(text.includes(`Notes: ${dir}/research-notes.md`));
  assert.match(text, /## Orchestrator notes\nresearch: retry backoff in fetch\?\nresearch: max attempts\?\n$/);
  assert.equal(readState(dir).workers.find((x) => x.name === 'researcher').status, 'running');
});

test('run worker accepts researcher; invalid names list it', () => {
  const { id, dir } = newRun('worker names');
  const ok = neat(['run', 'worker', id, 'researcher', 'done']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'worker researcher done\n');
  assert.equal(readState(dir).workers.find((x) => x.name === 'researcher').status, 'done');
  const bad = neat(['run', 'worker', id, 'wizard', 'done']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /explorer\|researcher\|reviewer/);
  const badBrief = neat(['brief', id, 'wizard']);
  assert.match(badBrief.stderr, /explorer\|researcher\|reviewer/);
});

test('an implementer brief lists researcher notes and report once they exist', () => {
  const { id, dir } = newRun('implement after research');
  fs.writeFileSync(path.join(dir, 'plan.md'), VALID_PLAN);
  assert.equal(neat(['plan', 'check', id]).status, 0);
  fs.writeFileSync(path.join(dir, 'research-notes.md'), 'https://example.com - retries\n');
  fs.writeFileSync(path.join(dir, 'report-researcher.md'), 'x\n');
  const res = neat(['brief', id, 'implementer-T1']);
  assert.equal(res.status, 0, res.stderr);
  const text = fs.readFileSync(res.stdout.split('\n')[0], 'utf8');
  assert.match(text, /## Context files\n(- .*\n)*- .*report-researcher\.md\n- .*research-notes\.md\n/);
});

test('reviewer-2 brief names its own review file and report, the shared diff and read-only rules', () => {
  const exists = (p) => p === `${RUN_DIR}/diff.patch`;
  const text = brief('reviewer-2', { exists });
  assert.match(text, /^# Brief: reviewer-2$/m);
  assert.ok(text.includes(`Report: ${RUN_DIR}/report-reviewer-2.md`));
  assert.ok(text.includes(`Review file: ${RUN_DIR}/review-2.md`));
  assert.ok(!text.includes(`${RUN_DIR}/review.md`));
  assert.ok(text.includes(`Diff: ${RUN_DIR}/diff.patch`));
  assert.match(text, /## Files you own\n- none \(read-only role\)\n/);
  assert.ok(text.includes('- Do not edit, create or delete project files.'));
  assert.ok(text.includes(`write ${STATE.id} report-reviewer-2.md --stdin`));
  assert.ok(brief('reviewer', { exists }).includes(`Review file: ${RUN_DIR}/review.md`));
});

test('run worker and brief accept reviewer-2; invalid names list it', () => {
  const { id, dir } = newRun('second reviewer');
  const ok = neat(['run', 'worker', id, 'reviewer-2', 'done']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, 'worker reviewer-2 done\n');
  assert.equal(readState(dir).workers.find((x) => x.name === 'reviewer-2').status, 'done');
  const res = neat(['brief', id, 'reviewer-2']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.split('\n')[0], path.join(dir, 'brief-reviewer-2.md'));
  assert.ok(res.stdout.split('\n')[1].startsWith('route worker=reviewer-2 model=sonnet effort=medium '), res.stdout);
  for (const args of [['run', 'worker', id, 'reviewer-3', 'done'], ['brief', id, 'reviewer2']]) {
    const bad = neat(args);
    assert.equal(bad.status, 2, args.join(' '));
    assert.match(bad.stderr, /\|reviewer\|reviewer-2\|/);
  }
});

// ---------- brief --fix ----------

function fixRun(taskText, review) {
  const run = newRun(taskText);
  fs.writeFileSync(path.join(run.dir, 'plan.md'), VALID_PLAN);
  assert.equal(neat(['plan', 'check', run.id]).status, 0);
  if (review !== undefined) {
    fs.writeFileSync(path.join(run.dir, 'review.md'), review);
    const merged = neat(['review', 'merge', run.id]);
    assert.equal(merged.status, 0, merged.stderr);
  }
  return run;
}

const FIX_REVIEW = [
  'a.js:3 - high - unchecked input reaches the query',
  'b.js:5 - medium - error from the parser is swallowed',
  'c.js:1 - low - naming only',
  'z.js:1 - high - file nobody owns',
  'a.js:40 - low - style nit',
].join('\n');

test('help lists brief --fix', () => {
  assert.match(neat(['help']).stdout, /^neat brief <run-id> <worker> \[--stdin\] \[--fix\]$/m);
});

test('brief --fix appends only the task\'s merged critical and warning lines as data', () => {
  const { id, dir } = fixRun('fix round', `${FIX_REVIEW}\n`);
  const res = neat(['brief', id, 'implementer-T1', '--fix']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  assert.equal(lines[0], path.join(dir, 'brief-implementer-T1.md'));
  assert.ok(lines[1].startsWith('route worker=implementer-T1 '), lines[1]);
  const text = fs.readFileSync(lines[0], 'utf8');
  const section = text.slice(text.indexOf('## Review findings to fix'));
  const body = section.trimEnd().split('\n');
  assert.equal(body[0], '## Review findings to fix');
  assert.match(body[1], /reviewer data/i);
  assert.match(body[1], /check/i);
  assert.deepEqual(body.slice(2), [
    'a.js:3 critical [claude] unchecked input reaches the query',
    'b.js:5 warning [claude] error from the parser is swallowed',
  ]);
  assert.ok(text.indexOf('## Rules') < text.indexOf('## Review findings to fix'));
  assert.equal(readState(dir).workers.find((x) => x.name === 'implementer-T1').status, 'running');
  const t3 = neat(['brief', id, 'implementer-T3', '--fix']);
  assert.equal(t3.status, 0, t3.stderr);
  const t3text = fs.readFileSync(t3.stdout.split('\n')[0], 'utf8');
  assert.match(t3text, /## Review findings to fix\n.*\nb\.js:5 warning \[claude\] error from the parser is swallowed\n$/);
});

test('brief --fix drops the review fix-round guard records, so each fix round needs its own Guard', () => {
  const { id, dir } = fixRun('fix guard reset', `${FIX_REVIEW}\n`);
  const file = path.join(dir, 'state.json');
  const state = readState(dir);
  fs.writeFileSync(file, JSON.stringify({ ...state, guarded: ['explore', 'implement:T1', 'review', 'review:T1,T3'] }));
  const res = neat(['brief', id, 'implementer-T1', '--fix']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readState(dir).guarded, ['explore', 'implement:T1', 'review']);
  assert.equal(readState(dir).review.inputs, null);
});

test('brief --fix combines with --stdin in either order, findings after the notes', () => {
  const { id } = fixRun('fix with notes', `${FIX_REVIEW}\n`);
  for (const args of [['--fix', '--stdin'], ['--stdin', '--fix']]) {
    const res = neat(['brief', id, 'implementer-T1', ...args], 'focus on the query\n');
    assert.equal(res.status, 0, res.stderr);
    const text = fs.readFileSync(res.stdout.split('\n')[0], 'utf8');
    assert.match(text, /## Orchestrator notes\nfocus on the query\n\n## Review findings to fix\n/);
  }
  for (const args of [['--fix', '--fix'], ['--stdin', '--stdin'], ['--fixx'], ['--fix', 'x']]) {
    assert.equal(neat(['brief', id, 'implementer-T1', ...args], 'n\n').status, 2, args.join(' '));
  }
});

test('brief --fix refuses tasks without findings, non-plan workers and runs without a merge', () => {
  const { id, dir } = fixRun('fix refusals', `${FIX_REVIEW}\n`);
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const t2 = neat(['brief', id, 'implementer-T2', '--fix']);
  assert.equal(t2.status, 2);
  assert.equal(t2.stderr, 'neat: no review findings for T2\n');
  const rev = neat(['brief', id, 'reviewer', '--fix']);
  assert.equal(rev.status, 2);
  assert.match(rev.stderr, /--fix/);
  assert.ok(!fs.existsSync(path.join(dir, 'brief-implementer-T2.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'brief-reviewer.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
  const fresh = fixRun('fix before merge');
  const early = neat(['brief', fresh.id, 'implementer-T1', '--fix']);
  assert.equal(early.status, 2);
  assert.equal(early.stderr, 'neat: run review merge first\n');
});

test('brief --fix keeps at most 30 lines of at most 300 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => `a.js:${i * 10 + 1} - medium - ${'w'.repeat(290)} ${i}`);
  const { id } = fixRun('fix many', `${many.join('\n')}\n`);
  const res = neat(['brief', id, 'implementer-T1', '--fix']);
  assert.equal(res.status, 0, res.stderr);
  const text = fs.readFileSync(res.stdout.split('\n')[0], 'utf8');
  const body = text.slice(text.indexOf('## Review findings to fix')).trimEnd().split('\n').slice(2);
  assert.equal(body.length, 30);
  assert.ok(body.every((l) => l.length <= 300 && l.startsWith('a.js:')), body.map((l) => l.length).join(','));
});
