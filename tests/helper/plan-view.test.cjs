'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const { parsePlan } = require(path.join(LIB, 'plan-check.cjs'));
const { MAX_VIEW_LINES } = require(path.join(LIB, 'plan-view.cjs'));

const OVERVIEW = [
  '## Overview',
  'goal: Let users subtract numbers from the CLI.',
  'approach: Add a pure function first, then wire the flag and document it.',
  'key: risk: the CLI parser is shared with the add command',
  'key: decision: keep integers only for now',
  'key: assumption: no callers rely on the old exit code',
].join('\n');

const TASKS = [
  '## T1: Add subtract',
  'worker: implementer',
  'owns: src/math.js',
  'why: the CLI needs a tested pure function to call',
  'do: Add subtract(a, b) and export it.',
  '',
  '## T2: Wire the --sub flag',
  'worker: implementer',
  'owns: src/cli.js',
  'why: users reach the feature through the CLI',
  'do: Parse --sub and print the result.',
  '',
  '## D1: Document --sub',
  'worker: docs',
  'owns: README.md',
  'do: Add a usage example.',
].join('\n');

let proj;
let env;

before(() => {
  proj = makeTempDir('neat-view-');
  env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: '2026-10-21T09:00:00Z' });
});

after(() => removeDir(proj));

function neat(args, input) {
  return runNode([HELPER, ...args], { cwd: proj, env, input });
}

function checkedRun(planText) {
  const res = neat(['run', 'new', '--stdin'], 'add a subtract command');
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  fs.writeFileSync(path.join(proj, '.neat', 'runs', id, 'plan.md'), planText);
  const checked = neat(['plan', 'check', id]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  return id;
}

function view(id) {
  const res = neat(['plan', 'view', id]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return res.stdout;
}

describe('why lines', () => {
  test('parsePlan keeps an optional why line per task and keeps it out of do', () => {
    const { tasks, errors } = parsePlan(`${OVERVIEW}\n\n${TASKS}\n`);
    assert.deepEqual(errors, []);
    assert.equal(tasks[0].why, 'the CLI needs a tested pure function to call');
    assert.equal(tasks[0].do, 'Add subtract(a, b) and export it.');
    assert.equal(tasks[2].why, '');
  });

  test('a second why line is a duplicate key error', () => {
    const plan = TASKS.replace('why: users reach', 'why: one\nwhy: users reach');
    assert.ok(parsePlan(plan).errors.includes('T2: duplicate why:'), parsePlan(plan).errors.join('\n'));
  });
});

describe('neat plan view', () => {
  test('shows goal, approach, key points, stages, tasks with reasons and the run order', () => {
    const out = view(checkedRun(`${OVERVIEW}\n\n${TASKS}\n`));
    assert.match(out, /^Plan: add a subtract command$/m);
    assert.match(out, /^Goal {6}Let users subtract numbers from the CLI\.$/m);
    assert.match(out, /^Approach {2}Add a pure function first/m);
    assert.match(out, /^Key points$/m);
    assert.match(out, /^ {2}! Risk {8}the CLI parser is shared with the add command$/m);
    assert.match(out, /^ {2}\* Decision {4}keep integers only for now$/m);
    assert.match(out, /^ {2}\? Assumption {2}no callers rely on the old exit code$/m);
    assert.match(out, /^Stages {3}explore > plan > implement > review > test > docs$/m);
    assert.match(out, /^ {9}\(skipped: research\)$/m);
    assert.match(out, /^ {2}T1 {2}Add subtract {9}implementer$/m);
    assert.match(out, /^ {6}files {2}src\/math\.js$/m);
    assert.match(out, /^ {6}why {4}the CLI needs a tested pure function to call$/m);
    assert.match(out, /^ {2}D1 {2}Document --sub {7}docs$/m);
    assert.match(out, /^Run order {2}T1 \+ T2 in parallel, then D1$/m);
    assert.match(out, /^ {11}3 tasks, 3 files$/m);
    assert.ok(!/\*\*|^#|^\| /m.test(out), 'no markdown markup');
    assert.ok(!out.includes('\u001b'), 'no color unless asked');
    assert.ok(out.split('\n').every((l) => l.length <= 100), 'lines fit a terminal');
  });

  test('skipped stages are listed and a plan without an overview still shows its tasks', () => {
    const res = neat(['run', 'new', '--stdin'], 'fix the add rounding');
    const id = res.stdout.match(/^id=(\S+)/m)[1];
    assert.equal(neat(['stages', id, '--type', 'small-fix']).status, 0);
    fs.writeFileSync(path.join(proj, '.neat', 'runs', id, 'plan.md'), `${TASKS.split('\n\n')[0]}\n`);
    assert.equal(neat(['plan', 'check', id]).status, 0);
    const out = view(id);
    assert.match(out, /^Stages {3}explore > plan > implement > test$/m);
    assert.match(out, /^ {9}\(skipped: research, review, docs\)$/m);
    assert.match(out, /^\(no overview in plan\.md\)$/m);
    assert.match(out, /^ {2}T1 {2}Add subtract/m);
    assert.match(out, /^Run order {2}T1$/m);
  });

  test('untrusted text is cleaned: pipes escaped, control codes dropped, key points capped', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `key: note ${i}`).join('\n');
    const plan = `## Overview\ngoal: a | b \u001b[31mred\u001b[0m\n${keys}\n\n${TASKS.replace('owns: src/math.js', 'owns: src/a|b.js')}\n`;
    const out = view(checkedRun(plan));
    assert.ok(!out.includes('\u001b'), out);
    assert.match(out, /^Goal {6}a \| b red$/m);
    assert.match(out, /files {2}src\/a\|b\.js/);
    assert.equal((out.match(/^ {2}- Note {8}/gm) || []).length, 5);
    assert.match(out, /^ {2}… 3 more key points in plan\.md$/m);
    assert.ok(out.trimEnd().split('\n').length <= MAX_VIEW_LINES, out);
  });

  test('--color adds ANSI highlights over the same text', () => {
    const id = checkedRun(`${OVERVIEW}\n\n${TASKS}\n`);
    const plain = view(id);
    const res = neat(['plan', 'view', id, '--color']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('\u001b['), 'colored output');
    assert.equal(res.stdout.replace(/\u001b\[[0-9;]*m/g, ''), plain);
    assert.equal(neat(['plan', 'view', id, '--bogus']).status, 2);
  });

  test('--md renders styled markdown: headings, bold labels, code spans, colored markers, struck-out skipped stages', () => {
    const id = checkedRun(`${OVERVIEW}\n\n${TASKS}\n`);
    const res = neat(['plan', 'view', id, '--md']);
    assert.equal(res.status, 0, res.stderr);
    const out = res.stdout;
    assert.match(out, /^### 📋 Plan: add a subtract command$/m);
    assert.match(out, /^\*\*Goal:\*\* Let users subtract numbers from the CLI\.$/m);
    assert.match(out, /^- 🔴 \*\*Risk:\*\* the CLI parser is shared with the add command$/m);
    assert.match(out, /^- 🟢 \*\*Decision:\*\* keep integers only for now$/m);
    assert.match(out, /^- 🟡 \*\*Assumption:\*\* no callers rely on the old exit code$/m);
    assert.match(out, /^\*\*Stages:\*\* `explore` → `plan` → `implement` → `review` → `test` → `docs` · skipped: ~~research~~$/m);
    assert.match(out, /^- `T1` \*\*Add subtract\*\* · _implementer_$/m);
    assert.match(out, /^ {2}- files: `src\/math\.js`$/m);
    assert.match(out, /^ {2}- why: the CLI needs a tested pure function to call$/m);
    assert.match(out, /^\*\*Run order:\*\* `T1` \+ `T2` in parallel → `D1` · 3 tasks, 3 files$/m);
    assert.ok(!out.includes('\u001b'));
  });

  test('--md escapes markdown in untrusted plan text', () => {
    const plan = `## Overview\ngoal: **bold** _x_ [link](http://e) \`tick\` <b>\n\n${TASKS.replace('owns: src/math.js', 'owns: src/a`b.js')}\n`;
    const out = neat(['plan', 'view', checkedRun(plan), '--md']).stdout;
    assert.match(out, /^\*\*Goal:\*\* \\\*\\\*bold\\\*\\\* \\_x\\_ \\\[link\\\]\(http:\/\/e\) `tick` \\<b\\>$/m);
    assert.match(out, /files: `src\/a'b\.js`/);
    const odd = `## Overview\ngoal: one \` tick\n\n${TASKS}\n`;
    assert.match(neat(['plan', 'view', checkedRun(odd), '--md']).stdout, /^\*\*Goal:\*\* one ' tick$/m);
    assert.equal(neat(['plan', 'view', 'x', '--md', '--color']).status, 2);
  });

  test('a run without a checked plan fails with a hint; usage errors exit 2', () => {
    const res = neat(['run', 'new', '--stdin'], 'nothing planned');
    const id = res.stdout.match(/^id=(\S+)/m)[1];
    const viewed = neat(['plan', 'view', id]);
    assert.equal(viewed.status, 1);
    assert.equal(viewed.stdout, `no checked plan in run ${id}; run plan check ${id}\n`);
    assert.equal(neat(['plan', 'view']).status, 2);
  });
});
