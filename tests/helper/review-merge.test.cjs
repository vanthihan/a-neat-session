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
    let result = rm.mergeRun(proj, id);
    assert.deepEqual(result.lines, [
      'src/a.js:1 critical [claude] from claude review file (disputed)',
      'src/b.js:2 warning [claude-2] from the second report',
    ]);
    put(dir, 'codex-reviewer.md', '## Findings\n- src/a.js:30 - low - from the new codex output\n', 10);
    put(dir, 'review-2.md', 'src/b.js:3 - low - from the second review file\n', 40);
    put(dir, 'codex-reviewer-2.md', 'src/b.js:9 - high - stale codex second\n', 300);
    result = rm.mergeRun(proj, id);
    assert.deepEqual(result.lines, [
      'src/a.js:30 info [codex] from the new codex output',
      'src/b.js:3 info [claude-2] from the second review file',
    ]);
    assert.equal(result.file, path.join(dir, 'review-merged.md'));
    assert.deepEqual(result.counts, { critical: 0, warning: 0, info: 2, both: 0, disputed: 0 });
  });

  test('reads at most 1 MB of a source file', () => {
    const { id, dir } = newRun('big source');
    const filler = `${'x'.repeat(1023)}\n`.repeat(1024);
    put(dir, 'review.md', `${filler}src/late.js:1 - high - beyond the cap\n`, 10);
    assert.equal(rm.MAX_READ_BYTES, 1024 * 1024);
    assert.deepEqual(rm.mergeRun(proj, id).lines, []);
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
    assert.equal(lines[0], 'merged critical=2 warning=0 info=6 both=1 disputed=1');
    assert.equal(lines[1], 'src/db.js:40 critical [both] unchecked input reaches the SQL query');
    assert.equal(lines[2], 'src/z.js:1 critical [codex] secret in code (disputed)');
    assert.equal(lines.length, 7);
    assert.equal(lines[6], `file: ${path.join(dir, 'review-merged.md')}`);
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
    assert.equal(res.stdout.split('\n')[1].length, 200);
  });

  test('no source files gives zero counts and none', () => {
    const { id, dir } = newRun('empty merge');
    const res = neat(['review', 'merge', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `merged critical=0 warning=0 info=0 both=0 disputed=0\nnone\nfile: ${path.join(dir, 'review-merged.md')}\n`);
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
