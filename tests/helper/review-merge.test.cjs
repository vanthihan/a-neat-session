'use strict';

// Merging two independent reviews: tolerant finding parser, severity map,
// token similarity, +-3 line matching, ranking, source choice by mtime and
// the `neat review merge` command.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const rm = require(path.join(LIB, 'review-merge.cjs'));

function one(line, opts) {
  const found = rm.parseFindings(line, opts);
  assert.equal(found.length, 1, `expected one finding from: ${line}`);
  return found[0];
}

function f(pathName, line, severity, text) {
  return { path: pathName, line, severity, text };
}

describe('parseFindings', () => {
  test('reads the reviewer format and maps high to critical', () => {
    assert.deepEqual(one('src/a.js:12 - high - SQL built from input'), f('src/a.js', 12, 'critical', 'SQL built from input'));
  });

  test('reads bullets, backticks, line ranges and the `severity:` form', () => {
    assert.deepEqual(one('- `src/a.js:12` critical: x'), f('src/a.js', 12, 'critical', 'x'));
    assert.deepEqual(one('* ./src/a.js:12-14 warning - y'), f('src/a.js', 12, 'warning', 'y'));
    assert.deepEqual(one('src/a.js:3 - medium - z'), f('src/a.js', 3, 'warning', 'z'));
    assert.deepEqual(one('src/a.js:9:4 - low - column given'), f('src/a.js', 9, 'info', 'column given'));
  });

  test('maps every severity word and defaults to info', () => {
    for (const w of ['low', 'minor', 'nit', 'note', 'info']) assert.equal(one(`a.js:1 - ${w} - t`).severity, 'info', w);
    for (const w of ['blocker', 'error', 'critical', 'HIGH']) assert.equal(one(`a.js:1 - ${w} - t`).severity, 'critical', w);
    for (const w of ['major', 'warning', 'medium']) assert.equal(one(`a.js:1 - ${w} - t`).severity, 'warning', w);
    assert.deepEqual(one('src/a.js:7 - plain note'), f('src/a.js', 7, 'info', 'plain note'));
    assert.equal(rm.normalizeSeverity('bogus'), 'info');
    assert.equal(rm.normalizeSeverity('High'), 'critical');
  });

  test('ignores none, headings, prose and lines without a location', () => {
    const text = ['## Findings', 'none', 'The code looks fine overall.', '12:30 - high - a clock time', '## Status', 'done', ''].join('\n');
    assert.deepEqual(rm.parseFindings(text), []);
  });

  test('reads bold or italic locations, numbered lists and table rows', () => {
    assert.deepEqual(one('- **src/a.js:10** - high - SQL injection'), f('src/a.js', 10, 'critical', 'SQL injection'));
    assert.deepEqual(one('- *src/a.js:10* - high - x'), f('src/a.js', 10, 'critical', 'x'));
    assert.deepEqual(one('**`src/a.js:10`** - medium - y'), f('src/a.js', 10, 'warning', 'y'));
    assert.deepEqual(one('__tests__/a.test.js:4 - high - z'), f('__tests__/a.test.js', 4, 'critical', 'z'));
    assert.deepEqual(one('1. src/a.js:10 - high - x'), f('src/a.js', 10, 'critical', 'x'));
    assert.deepEqual(one('12) src/b.js:3 - low - y'), f('src/b.js', 3, 'info', 'y'));
    assert.deepEqual(one('| `src/a.js:10` | high | SQL injection |'), f('src/a.js', 10, 'critical', 'SQL injection'));
    assert.deepEqual(one('| src/a.js | 10 | medium | unchecked | input |'), f('src/a.js', 10, 'warning', 'unchecked - input'));
    assert.deepEqual(one('Makefile:3 - low - tab'), f('Makefile', 3, 'info', 'tab'));
    const table = ['| File | Line | Severity | Issue |', '|------|-----:|----------|-------|', '| src/c.js | 2 | low | z |'].join('\n');
    assert.deepEqual(rm.parseSource(table), { findings: [f('src/c.js', 2, 'info', 'z')], unparsed: 0 });
  });

  test('hosts and ports are not paths, and finding-like lines that do not parse are counted', () => {
    for (const host of ['localhost:3000 - error - boom', 'example.com:443 - high - x', '127.0.0.1:80 - high - y']) {
      assert.deepEqual(rm.parseFindings(host), [], host);
    }
    const text = ['## Findings', '- localhost:3000 - error - boom', '- src/a.js:1 - high - ok', 'Time: 12:30', 'none'].join('\n');
    const res = rm.parseSource(text);
    assert.equal(res.findings.length, 1);
    assert.equal(res.unparsed, 1);
  });

  test('normalises absolute paths under the root and a/ b/ diff prefixes', () => {
    const root = '/work/proj';
    assert.equal(one('/work/proj/src/a.js:5 - low - x', { root }).path, 'src/a.js');
    assert.equal(one('a/src/a.js:5 - low - x').path, 'src/a.js');
    assert.equal(one('b/src/a.js:5 - low - x').path, 'src/a.js');
    assert.equal(one('/elsewhere/a.js:5 - low - x', { root }).path, '/elsewhere/a.js');
  });

  test('keeps at most MAX_FINDINGS per source and strips control characters', () => {
    const many = Array.from({ length: 250 }, (_, i) => `a.js:${i + 1} - low - item ${i}`).join('\n');
    assert.equal(rm.parseFindings(many).length, rm.MAX_FINDINGS);
    assert.equal(rm.MAX_FINDINGS, 200);
    assert.equal(one('a.js:1 - high - bad\u001b[31m red\u0007 text').text, 'bad [31m red text');
  });
});

describe('similarity and matching', () => {
  test('reworded findings about the same issue score at least the threshold', () => {
    assert.ok(rm.similarity('unchecked input reaches the SQL query', 'input is not checked before the query') >= rm.DICE_MIN);
    assert.equal(rm.similarity('', ''), 0);
    assert.equal(rm.similarity('Missing null check', 'missing null check'), 1);
    assert.equal(rm.DICE_MIN, 0.25);
    assert.equal(rm.SAME_LINE_DICE_MIN, 0.1);
    assert.equal(rm.LINE_WINDOW, 3);
  });

  test('a reworded finding within 3 lines merges to both with the higher severity and longer text', () => {
    const a = [f('src/db.js', 40, 'warning', 'unchecked input reaches the SQL query')];
    const b = [f('src/db.js', 43, 'critical', 'input is not checked before the query is built')];
    const merged = rm.mergeFindings(a, b, { firstPresent: true, secondPresent: true });
    assert.equal(merged.length, 1);
    assert.deepEqual(
      [merged[0].source, merged[0].severity, merged[0].text, merged[0].disputed],
      ['both', 'critical', 'input is not checked before the query is built', false],
    );
  });

  test('line distance 4 never pairs, even with the same text', () => {
    const a = [f('src/db.js', 40, 'warning', 'unchecked input reaches the SQL query')];
    const b = [f('src/db.js', 44, 'warning', 'unchecked input reaches the SQL query')];
    const merged = rm.mergeFindings(a, b, { firstPresent: true, secondPresent: true });
    assert.deepEqual(merged.map((m) => m.source).sort(), ['claude', 'codex']);
  });

  test('the same line with a different issue stays apart; the same line with a weak overlap pairs', () => {
    const a = [f('src/a.js', 10, 'warning', 'SQL injection in query builder')];
    const b = [f('src/a.js', 10, 'warning', 'variable name unclear')];
    assert.equal(rm.mergeFindings(a, b, { firstPresent: true, secondPresent: true }).length, 2);
    const c = [f('src/a.js', 10, 'warning', 'retry loop never stops on timeout errors from fetch calls')];
    const d = [f('src/a.js', 10, 'info', 'timeout handling: consider logging and backing off between attempts here')];
    const score = rm.similarity(c[0].text, d[0].text);
    assert.ok(score >= rm.SAME_LINE_DICE_MIN && score < rm.DICE_MIN, `score ${score}`);
    assert.equal(rm.mergeFindings(c, d, { firstPresent: true, secondPresent: true }).length, 1);
    const e = [{ ...d[0], line: 11 }];
    assert.equal(rm.mergeFindings(c, e, { firstPresent: true, secondPresent: true }).length, 2);
  });

  test('greedy matching uses each finding once, best score first', () => {
    const a = [f('a.js', 5, 'warning', 'missing null check on user'), f('a.js', 6, 'warning', 'missing null check on user id')];
    const b = [f('a.js', 6, 'warning', 'missing null check on user id')];
    const merged = rm.mergeFindings(a, b, { firstPresent: true, secondPresent: true });
    assert.equal(merged.length, 2);
    const both = merged.find((m) => m.source === 'both');
    assert.equal(both.line, 6);
  });

  test('critical against info is disputed; an unanswered critical is disputed only when the other source exists', () => {
    const a = [f('a.js', 5, 'critical', 'token written to the log file')];
    const b = [f('a.js', 5, 'info', 'token written to the log file in debug mode')];
    const pair = rm.mergeFindings(a, b, { firstPresent: true, secondPresent: true });
    assert.deepEqual([pair.length, pair[0].source, pair[0].disputed], [1, 'both', true]);
    const alone = rm.mergeFindings(a, [], { firstPresent: true, secondPresent: true });
    assert.deepEqual([alone[0].source, alone[0].disputed], ['claude', true]);
    const absent = rm.mergeFindings(a, [], { firstPresent: true, secondPresent: false });
    assert.equal(absent[0].disputed, false);
    const labelled = rm.mergeFindings([], a, { firstPresent: false, secondPresent: true, secondLabel: 'claude-2' });
    assert.deepEqual([labelled[0].source, labelled[0].disputed], ['claude-2', false]);
  });

  test('ranking: agreements first, then disputed criticals, then single-source by severity; ties by path and line', () => {
    const a = [
      f('z.js', 1, 'info', 'only claude info'),
      f('b.js', 9, 'critical', 'only claude critical'),
      f('m.js', 20, 'warning', 'shared warning about caching'),
      f('a.js', 3, 'warning', 'only claude warning'),
    ];
    const b = [
      f('m.js', 21, 'warning', 'shared warning about the caching'),
      f('c.js', 2, 'info', 'shared info about naming'),
      f('c.js', 2, 'info', 'x'),
    ];
    const a2 = [...a, f('c.js', 2, 'info', 'shared info about naming here')];
    const merged = rm.mergeFindings(a2, b, { firstPresent: true, secondPresent: true });
    const lines = rm.formatMerged(merged).trimEnd().split('\n');
    assert.deepEqual(lines, [
      'm.js:20 warning [both] shared warning about the caching',
      'c.js:2 info [both] shared info about naming here',
      'b.js:9 critical [claude] only claude critical (disputed)',
      'a.js:3 warning [claude] only claude warning',
      'c.js:2 info [codex] x',
      'z.js:1 info [claude] only claude info',
    ]);
    assert.equal(rm.formatMerged([]), 'none\n');
  });

  test('saved lines never start with # and cut text to 300 characters', () => {
    const long = 'word '.repeat(100).trim();
    const merged = rm.mergeFindings([f('a.js', 1, 'info', long)], [], { firstPresent: true, secondPresent: false });
    const line = rm.formatMerged(merged).trimEnd();
    assert.ok(line.length <= 'a.js:1 info [claude] '.length + 300, `${line.length}`);
    assert.deepEqual(rm.parseFindings('#a.js:1 - high - x'), []);
  });
});

// ---------- source choice and CLI ----------

let proj;
let env;

before(() => {
  proj = makeTempDir('neat-merge-');
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

function put(dir, name, text, secondsAgo) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
}

describe('mergeRun sources', () => {
  test('the newer of the codex output and the review file wins; the report is the fallback', () => {
    const { id, dir } = newRun('pick sources');
    put(dir, 'review.md', 'src/a.js:1 - high - from claude review file\n', 100);
    put(dir, 'codex-reviewer.md', '## Findings\n- src/a.js:30 - low - from the old codex output\n', 200);
    put(dir, 'report-reviewer-2.md', '## Findings\n- src/b.js:2 - medium - from the second report\n', 50);
    let result = rm.mergeRun(proj, id, { env });
    assert.deepEqual(result.lines, [
      'src/a.js:1 critical [claude] from claude review file (disputed)',
      'src/b.js:2 warning [claude-2] from the second report',
    ]);
    put(dir, 'codex-reviewer.md', '## Findings\n- src/a.js:30 - low - from the new codex output\n', 10);
    put(dir, 'review-2.md', 'src/b.js:3 - low - from the second review file\n', 40);
    put(dir, 'codex-reviewer-2.md', 'src/b.js:9 - high - stale codex second\n', 300);
    result = rm.mergeRun(proj, id, { env });
    assert.deepEqual(result.lines, [
      'src/a.js:30 info [codex] from the new codex output',
      'src/b.js:3 info [claude-2] from the second review file',
    ]);
    assert.equal(result.file, path.join(dir, 'review-merged.md'));
    assert.deepEqual(result.counts, { critical: 0, warning: 0, info: 2, both: 0, disputed: 0 });
  });

  test('files older than the reviewer\'s brief are earlier rounds and never merged', () => {
    const { id, dir } = newRun('stale rounds');
    // reviewer: this round's codex job failed (no codex-reviewer.md), only last round's review.md is left.
    put(dir, 'review.md', 'src/a.js:1 - high - fixed last round\n', 300);
    put(dir, 'brief-reviewer.md', '# Brief: reviewer\n', 60);
    put(dir, 'report-reviewer.md', '## Findings\n- src/a.js:2 - low - stale report\n', 200);
    // reviewer-2: skipped this round, its brief was rewritten, its old review stays.
    put(dir, 'brief-reviewer-2.md', '# Brief: reviewer-2\n', 60);
    put(dir, 'review-2.md', 'src/b.js:1 - high - also from last round\n', 300);
    assert.deepEqual(rm.mergeRun(proj, id, { env }).lines, []);

    put(dir, 'review-2.md', 'src/b.js:1 - high - this round\n', 5);
    assert.deepEqual(rm.mergeRun(proj, id, { env }).lines, ['src/b.js:1 critical [claude-2] this round'],
      'a fresh critical is not disputed by an absent reviewer');
  });

  test('reads at most 1 MB of a source file', () => {
    const { id, dir } = newRun('big source');
    const filler = `${'x'.repeat(1023)}\n`.repeat(1024);
    put(dir, 'review.md', `${filler}src/late.js:1 - high - beyond the cap\n`, 10);
    assert.equal(rm.MAX_READ_BYTES, 1024 * 1024);
    assert.deepEqual(rm.mergeRun(proj, id, { env }).lines, []);
  });
});

describe('neat review merge', () => {
  test('help lists review merge', () => {
    assert.match(neat(['help']).stdout, /^neat review merge <run-id>$/m);
  });

  test('writes review-merged.md and prints counts, top 5 and the file', () => {
    const { id, dir } = newRun('merge cli');
    const claude = [
      'src/db.js:40 - medium - unchecked input reaches the SQL query',
      'src/a.js:1 - low - one', 'src/a.js:10 - low - two', 'src/a.js:20 - low - three',
      'src/a.js:30 - low - four', 'src/a.js:40 - low - five', `src/a.js:50 - low - ${'y'.repeat(400)}`,
    ].join('\n');
    put(dir, 'review.md', `${claude}\n`, 20);
    put(dir, 'codex-reviewer-2.md', '## Findings\n- src/db.js:43 - high - input is not checked before the query\n- src/z.js:1 - high - secret in code\n', 10);
    const res = neat(['review', 'merge', id]);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 12);
    assert.equal(lines[0], 'merged critical=2 warning=0 info=6 both=1 disputed=1 round=0/2 next=done');
    assert.equal(lines[1], 'unowned=src/db.js,src/z.js');
    assert.equal(lines[2], 'src/db.js:40 critical [both] unchecked input reaches the SQL query');
    assert.equal(lines[3], 'src/z.js:1 critical [codex] secret in code (disputed)');
    assert.equal(lines.length, 8);
    assert.equal(lines[7], `file: ${path.join(dir, 'review-merged.md')}`);
    const saved = fs.readFileSync(path.join(dir, 'review-merged.md'), 'utf8').trimEnd().split('\n');
    assert.equal(saved.length, 8);
    assert.ok(saved.every((l) => !l.startsWith('#')));
    const longSaved = saved.find((l) => l.startsWith('src/a.js:50'));
    assert.equal(longSaved, `src/a.js:50 info [claude] ${'y'.repeat(300)}`);
    for (const l of lines) assert.ok(l.length <= 200 + 'file: '.length + dir.length + 20, l);
  });

  test('cuts printed lines to 200 characters', () => {
    const { id, dir } = newRun('long line');
    put(dir, 'review.md', `src/a.js:1 - high - ${'z'.repeat(400)}\n`, 10);
    const res = neat(['review', 'merge', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.split('\n')[1], 'unowned=src/a.js');
    assert.equal(res.stdout.split('\n')[2].length, 200);
  });

  test('prints unparsed=N when finding-like lines could not be read', () => {
    const { id, dir } = newRun('unparsed lines');
    put(dir, 'review.md', '- localhost:3000 - error - boom\n- src/a.js:1 - low - fine\n', 10);
    const res = neat(['review', 'merge', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.split('\n')[1], 'unparsed=1');
  });

  test('no source files gives zero counts and none', () => {
    const { id, dir } = newRun('empty merge');
    const res = neat(['review', 'merge', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `merged critical=0 warning=0 info=0 both=0 disputed=0 round=0/2 next=done\nnone\nfile: ${path.join(dir, 'review-merged.md')}\n`);
    assert.equal(fs.readFileSync(path.join(dir, 'review-merged.md'), 'utf8'), 'none\n');
  });

  test('an unknown run or a missing id exits 2', () => {
    const res = neat(['review', 'merge', '20990101-000000-nope']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /run not found/);
    assert.equal(neat(['review', 'merge']).status, 2);
    assert.equal(neat(['review', 'merge', 'a', 'b']).status, 2);
  });
});

// ---------- bounded fix loop ----------

describe('fixFindings, reviewNext and setReview', () => {
  const tasks = [
    { id: 'T1', owns: ['src/a.js', 'src/b.js'] },
    { id: 'T2', owns: ['src/c.js'] },
    { id: 'T3', owns: ['src/b.js'] },
    { id: 'D1', owns: ['README.md'] },
  ];
  const m = (p, line, severity) => ({ path: p, line, severity, source: 'claude', text: `t ${p}`, disputed: false });

  test('critical and warning findings go to every owning task; info never; unowned paths are listed once', () => {
    const merged = [
      m('src/b.js', 1, 'warning'), m('src/a.js', 2, 'critical'), m('src/c.js', 3, 'info'),
      m('src/z.js', 4, 'warning'), m('src/z.js', 9, 'critical'), m('README.md', 1, 'warning'),
    ];
    const res = rm.fixFindings(merged, tasks);
    assert.deepEqual(res.fixTasks, ['T1', 'T3', 'D1']);
    assert.deepEqual(res.unowned, ['src/z.js']);
    assert.deepEqual(res.byTask.T1.map((x) => x.path), ['src/b.js', 'src/a.js']);
    assert.deepEqual(res.byTask.T3.map((x) => x.path), ['src/b.js']);
    assert.equal(res.byTask.T2, undefined);
    assert.deepEqual(rm.fixFindings([m('src/c.js', 1, 'info')], tasks), { fixTasks: [], unowned: [], byTask: {} });
    assert.deepEqual(rm.fixFindings([m('src/a.js', 1, 'critical')], undefined).unowned, ['src/a.js']);
  });

  test('reviewNext: done without fix tasks, fix below the bound, then ask (gate, step) or stop (auto)', () => {
    const next = (fixTasks, fixRounds, maxRounds, mode) => rm.reviewNext({ fixTasks, fixRounds, maxRounds, mode });
    assert.equal(next([], 0, 2, 'gate'), 'done');
    assert.equal(next([], 5, 2, 'auto'), 'done');
    assert.equal(next(['T1'], 0, 2, 'gate'), 'fix');
    assert.equal(next(['T1'], 1, 2, 'auto'), 'fix');
    assert.equal(next(['T1'], 2, 2, 'gate'), 'ask');
    assert.equal(next(['T1'], 2, 2, 'step'), 'ask');
    assert.equal(next(['T1'], 2, 2, 'auto'), 'stop');
    assert.equal(next(['T1'], 0, 0, 'gate'), 'ask');
    assert.equal(next(['T1'], 0, 0, 'auto'), 'stop');
  });

  test('setReview returns a new state and leaves the input untouched', () => {
    const state = Object.freeze({ id: 'x', mode: 'gate' });
    const review = { reviews: 1, fixTasks: ['T1'] };
    const next = rm.setReview(state, review);
    assert.notEqual(next, state);
    assert.equal(state.review, undefined);
    assert.deepEqual(next, { id: 'x', mode: 'gate', review: { reviews: 1, fixTasks: ['T1'] } });
    review.fixTasks.push('T2');
    assert.deepEqual(next.review.fixTasks, ['T1']);
  });
});

const LOOP_PLAN = [
  '## T1: Fix a', 'worker: implementer', 'owns: src/a.js', 'do: fix', '',
  '## D1: Docs', 'worker: docs', 'owns: README.md', 'do: doc', '',
].join('\n');

function plannedRun(taskText, runEnv = env, projDir = proj) {
  const run = (args, input) => runNode([HELPER, ...args], { cwd: projDir, env: runEnv, input });
  const res = run(['run', 'new', '--stdin'], taskText);
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  const dir = path.join(projDir, '.neat', 'runs', id);
  fs.writeFileSync(path.join(dir, 'plan.md'), LOOP_PLAN);
  const check = run(['plan', 'check', id]);
  assert.equal(check.status, 0, check.stdout);
  return { id, dir, merge: () => run(['review', 'merge', id]) };
}

function stateOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

function outLines(res) {
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trimEnd().split('\n');
}

describe('review merge rounds', () => {
  test('a gate run counts fix rounds, names the fix tasks and asks after the bound', () => {
    const { dir, merge } = plannedRun('loop gate');
    put(dir, 'review.md', 'src/a.js:3 - high - unchecked input reaches the query\n', 30);
    let lines = outLines(merge());
    assert.ok(lines[0].startsWith('merged critical=1 warning=0 info=0 '), lines[0]);
    assert.ok(lines[0].endsWith(' round=0/2 next=fix'), lines[0]);
    assert.equal(lines[1], 'fix=T1');
    assert.equal(lines[2], 'src/a.js:3 critical [claude] unchecked input reaches the query');
    const review = stateOf(dir).review;
    assert.match(review.inputs, /^[0-9a-f]{64}$/);
    assert.deepEqual({ ...review, inputs: 'x' }, {
      reviews: 1, fixRounds: 0, maxRounds: 2, critical: 1, warning: 0, info: 0,
      fixTasks: ['T1'], unowned: [], inputs: 'x',
    });
    const again = merge();
    assert.equal(again.stdout, merge().stdout);
    assert.deepEqual(outLines(again), lines);
    assert.equal(stateOf(dir).review.reviews, 1);
    put(dir, 'review.md', 'src/a.js:3 - high - input still unchecked before the query\n', 20);
    lines = outLines(merge());
    assert.ok(lines[0].endsWith(' round=1/2 next=fix'), lines[0]);
    put(dir, 'review.md', 'src/a.js:4 - medium - query input is still not validated\n', 10);
    lines = outLines(merge());
    assert.ok(lines[0].endsWith(' round=2/2 next=ask'), lines[0]);
    assert.equal(lines[1], 'fix=T1');
    assert.deepEqual([stateOf(dir).review.reviews, stateOf(dir).review.fixRounds], [3, 2]);
  });

  test('an auto run stops after the bound; a step run asks', () => {
    for (const [mode, last] of [['auto', 'stop'], ['step', 'ask']]) {
      const { dir, merge } = plannedRun(`--mode ${mode} loop ${mode}`);
      ['first wording', 'second wording', 'third wording'].forEach((w, i) => {
        put(dir, 'review.md', `src/a.js:3 - medium - ${w} of the issue\n`, 30 - i * 10);
        const lines = outLines(merge());
        const expected = i < 2 ? `round=${i}/2 next=fix` : `round=2/2 next=${last}`;
        assert.ok(lines[0].endsWith(` ${expected}`), `${mode}: ${lines[0]}`);
        assert.equal(lines[1], 'fix=T1');
      });
    }
  });

  test('info-only findings and unowned files give next=done without a fix line', () => {
    const info = plannedRun('loop info');
    put(info.dir, 'review.md', 'src/a.js:3 - low - naming\n', 10);
    let lines = outLines(info.merge());
    assert.ok(lines[0].endsWith(' round=0/2 next=done'), lines[0]);
    assert.ok(!lines.some((l) => l.startsWith('fix=')));
    assert.ok(!lines.some((l) => l.startsWith('unowned=')));
    const other = plannedRun('loop unowned');
    put(other.dir, 'review.md', 'src/z.js:1 - medium - not owned\nsrc/a.js:2 - low - naming\n', 10);
    lines = outLines(other.merge());
    assert.ok(lines[0].endsWith(' round=0/2 next=done'), lines[0]);
    assert.equal(lines[1], 'unowned=src/z.js');
    assert.deepEqual(stateOf(other.dir).review.unowned, ['src/z.js']);
    assert.deepEqual(stateOf(other.dir).review.fixTasks, []);
  });

  test('review.maxRounds 0 asks (gate) or stops (auto) on the first merge', () => {
    const proj0 = makeTempDir('neat-merge0-');
    try {
      fs.mkdirSync(path.join(proj0, '.neat'), { recursive: true });
      fs.writeFileSync(path.join(proj0, '.neat', 'config.json'), JSON.stringify({ review: { maxRounds: 0 } }));
      const env0 = childEnv({ NEAT_PROJECT_DIR: proj0, NEAT_NOW: '2026-10-18T12:34:56Z' });
      for (const [mode, last] of [['gate', 'ask'], ['auto', 'stop']]) {
        const { dir, merge } = plannedRun(`--mode ${mode} zero rounds ${mode}`, env0, proj0);
        put(dir, 'review.md', 'src/a.js:3 - high - bad\n', 10);
        const lines = outLines(merge());
        assert.ok(lines[0].endsWith(` round=0/0 next=${last}`), lines[0]);
        assert.equal(lines[1], 'fix=T1');
      }
    } finally {
      removeDir(proj0);
    }
  });

  test('stdout stays at most 12 lines in the order first line, fix=, unowned=, top lines, file:', () => {
    const { dir, merge } = plannedRun('loop many');
    const many = Array.from({ length: 20 }, (_, i) => `src/a.js:${i * 10 + 1} - high - issue number ${i}`);
    put(dir, 'review.md', `${many.join('\n')}\nsrc/q.js:1 - medium - elsewhere\n`, 10);
    const lines = outLines(merge());
    assert.ok(lines.length <= 12, `${lines.length}`);
    assert.equal(lines.length, 9);
    assert.ok(lines[0].endsWith(' round=0/2 next=fix'));
    assert.equal(lines[1], 'fix=T1');
    assert.equal(lines[2], 'unowned=src/q.js');
    assert.ok(lines[3].startsWith('src/a.js:'));
    assert.ok(lines[8].startsWith('file: '));
  });
});

describe('a fix pass always counts a round', () => {
  test('after brief --fix the next merge counts a round even when the reviews are byte-identical', () => {
    const { id, dir, merge } = plannedRun('loop identical');
    put(dir, 'review.md', 'src/a.js:3 - high - unchecked input reaches the query\n', 30);
    assert.ok(outLines(merge())[0].endsWith(' round=0/2 next=fix'));
    for (const expected of ['round=1/2 next=fix', 'round=2/2 next=ask']) {
      const fixBrief = neat(['brief', id, 'implementer-T1', '--fix']);
      assert.equal(fixBrief.status, 0, fixBrief.stderr);
      assert.equal(stateOf(dir).review.inputs, null);
      const lines = outLines(merge());
      assert.ok(lines[0].endsWith(` ${expected}`), lines[0]);
      assert.ok(outLines(merge())[0].endsWith(` ${expected}`), 'a repeated merge does not count again');
    }
  });
});
