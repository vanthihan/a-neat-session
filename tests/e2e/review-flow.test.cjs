'use strict';

// The review stage end to end through the INSTALLED helper, in throwaway git
// repos, following the helper calls that guides/review.md and guides/codex.md
// prescribe, in their order. The test stands in for the Claude workers by
// writing their files; Codex is always the fake shim (NEAT_CODEX_BIN), or
// absent (`none`). Every Codex job is waited for before its project is removed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO_ROOT, childEnv, runNode, makeTempDir, removeDir, installFakeCodex,
} = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const NOW_ISO = '2026-05-01T12:00:00.000Z';
const FUTURE = Math.floor(Date.parse(NOW_ISO) / 1000) + 3600;
const PLAN = [
  '## T1: Validate the query input',
  'worker: implementer',
  'owns: src/a.js',
  'do: Check the input before it reaches the query.',
  '',
  '## D1: Document it',
  'worker: docs',
  'owns: README.md',
  'do: Mention the validation.',
  '',
].join('\n');

let scratch;
let shim;
let quietCfg;
let hardCfg;
const dirs = [];

function writeCapture(dir, fiveHour) {
  fs.mkdirSync(path.join(dir, 'neat'), { recursive: true });
  const data = { rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: FUTURE } } };
  fs.writeFileSync(path.join(dir, 'neat', 'usage.json'), JSON.stringify(data));
}

before(() => {
  scratch = makeTempDir('neat-revflow-');
  fs.writeFileSync(path.join(scratch, 'empty-gitconfig'), '');
  shim = installFakeCodex(scratch);
  quietCfg = makeTempDir('neat-revflow-cfg-');
  hardCfg = makeTempDir('neat-revflow-hard-');
  writeCapture(hardCfg, 95);
});

after(() => {
  dirs.forEach(removeDir);
  [scratch, quietCfg, hardCfg].forEach(removeDir);
});

// Inherited GIT_* variables would point git at the wrong repository.
function envFor(project, extra = {}) {
  const base = childEnv({
    NEAT_PROJECT_DIR: project.dir, NEAT_NOW: NOW_ISO, CLAUDE_CONFIG_DIR: project.cfg, NEAT_CODEX_BIN: project.codex,
  });
  for (const key of Object.keys(base)) if (key.startsWith('GIT_')) delete base[key];
  return {
    ...base,
    GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(project.dir),
    ...extra,
  };
}

function git(project, args) {
  const res = spawnSync('git', args, { cwd: project.dir, env: envFor(project), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function write(project, rel, content) {
  fs.mkdirSync(path.dirname(path.join(project.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(project.dir, rel), content);
}

// Git repo with the installed .claude/ tree committed. `codex` is the shim
// path or `none`; `cfg` the CLAUDE_CONFIG_DIR (with or without a capture).
function makeProject({ codex = 'none', cfg = quietCfg } = {}) {
  const project = { dir: makeTempDir('neat-revflow-p-'), codex: codex === 'fake' ? shim : 'none', cfg };
  dirs.push(project.dir);
  git(project, ['init', '-q']);
  git(project, ['config', 'user.name', 'Neat Test']);
  git(project, ['config', 'user.email', 'neat@example.invalid']);
  git(project, ['config', 'commit.gpgsign', 'false']);
  const res = runNode([INSTALLER, '--local'], { cwd: project.dir, env: envFor(project) });
  assert.equal(res.status, 0, res.stderr);
  write(project, 'src/a.js', 'module.exports = (q) => q;\n');
  write(project, 'README.md', '# demo\n');
  git(project, ['add', '-A']);
  git(project, ['commit', '-q', '-m', 'init']);
  project.helper = path.join(project.dir, '.claude', 'neat', 'bin', 'neat.cjs');
  return project;
}

function neat(project, args, { input, extra } = {}) {
  return runNode([project.helper, ...args], { cwd: project.dir, env: envFor(project, extra), input });
}

function ok(project, args, opts) {
  const res = neat(project, args, opts);
  assert.equal(res.status, 0, `neat ${args.join(' ')}\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

function report(findings = '- none') {
  return ['## Status', 'done', '## Findings', findings, '## Decisions', '- none',
    '## Open questions', '- none', '## Artifacts', '- none', ''].join('\n');
}

// run new, plan, plan check and an implementer edit on src/a.js; returns { id, dir }.
function plannedRun(project, mode = 'gate') {
  const out = ok(project, ['run', 'new', '--stdin'], { input: `validate the query input --mode ${mode}\n` });
  const m = /^id=(\S+) mode=(\S+) dir=(.+)$/m.exec(out);
  assert.ok(m, out);
  const run = { id: m[1], dir: m[3] };
  ok(project, ['run', 'stage', run.id, 'plan']);
  ok(project, ['write', run.id, 'plan.md', '--stdin'], { input: PLAN });
  assert.match(ok(project, ['plan', 'check', run.id]), /^plan ok /);
  return run;
}

function implement(project, run) {
  ok(project, ['run', 'stage', run.id, 'implement']);
  ok(project, ['brief', run.id, 'implementer-T1']);
  write(project, 'src/a.js', 'module.exports = (q) => String(q);\n');
  claudeReport(project, run, 'implementer-T1');
  assert.equal(neat(project, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
}

// Brief -> route line (second line of the brief output).
function brief(project, run, worker, args = []) {
  const [file, routeLine] = ok(project, ['brief', run.id, worker, ...args]).split('\n');
  return { file, route: routeLine };
}

// A Claude worker's report through the helper, checked and marked done.
function claudeReport(project, run, worker, findings) {
  assert.match(ok(project, ['write', run.id, `report-${worker}.md`, '--stdin'], { input: report(findings) }), /report ok/);
  ok(project, ['run', 'worker', run.id, worker, 'done']);
}

// codex run -> codex wait -> codex result -> report check -> worker done.
function codexWorker(project, run, worker, extra) {
  const started = ok(project, ['codex', 'run', run.id, worker], { extra });
  const job = /^job=(\S+) /.exec(started)[1];
  assert.match(ok(project, ['codex', 'wait', job]), new RegExp(`status=done exit=0 worker=${worker}$`, 'm'));
  assert.match(ok(project, ['codex', 'result', job]), /report: /);
  assert.match(ok(project, ['report', 'check', path.join(run.dir, `report-${worker}.md`)]), /^report ok/);
  ok(project, ['run', 'worker', run.id, worker, 'done']);
  return job;
}

function codexOutput(findings) {
  return ['## Status', 'done', '', '## Findings', ...findings, '', '## Decisions', 'none', '',
    '## Open questions', 'none', '', '## Artifacts', 'none', ''].join('\n');
}

function merge(project, run) {
  return ok(project, ['review', 'merge', run.id]).trimEnd().split('\n');
}

function mergedFile(run) {
  return fs.readFileSync(path.join(run.dir, 'review-merged.md'), 'utf8').split('\n');
}

// One review round: run diff, both reviewers (reviewer-2 on Codex or Claude), merge.
function reviewRound(project, run, { claude, second, secondOnCodex }) {
  assert.match(ok(project, ['run', 'diff', run.id]), /^diff /);
  const first = brief(project, run, 'reviewer');
  const other = brief(project, run, 'reviewer-2');
  ok(project, ['write', run.id, 'review.md', '--stdin'], { input: `${claude}\n` });
  claudeReport(project, run, 'reviewer');
  if (secondOnCodex) {
    codexWorker(project, run, 'reviewer-2', { FAKE_CODEX_OUTPUT: codexOutput(second) });
  } else {
    ok(project, ['write', run.id, 'review-2.md', '--stdin'], { input: `${second.join('\n')}\n` });
    claudeReport(project, run, 'reviewer-2');
  }
  assert.equal(neat(project, ['run', 'guard', run.id]).status, 0);
  return { first, other, lines: merge(project, run) };
}

test('cross review with the fake Codex merges an agreement as both and one fix round ends at next=done', () => {
  const project = makeProject({ codex: 'fake' });
  const run = plannedRun(project);
  implement(project, run);
  ok(project, ['run', 'stage', run.id, 'review']);
  const round1 = reviewRound(project, run, {
    claude: 'src/a.js:3 - high - unchecked input reaches the query',
    second: ['- src/a.js:4 - high - input is not checked before the query', '- src/b.js:1 - low - naming'],
    secondOnCodex: true,
  });
  assert.match(round1.first.route, / target=claude action=run$/);
  assert.match(round1.other.route, / target=codex action=run$/);
  assert.match(round1.lines[0], /^merged critical=1 warning=0 info=1 both=1 disputed=0 round=0\/2 next=fix$/);
  assert.equal(round1.lines[1], 'fix=T1');
  const top = mergedFile(run)[0];
  assert.match(top, /^src\/a\.js:3 critical \[both\] /);

  const fixBrief = fs.readFileSync(brief(project, run, 'implementer-T1', ['--fix']).file, 'utf8');
  assert.ok(fixBrief.includes(`## Review findings to fix\n`), fixBrief);
  assert.ok(fixBrief.includes(`\n${top}\n`), fixBrief);
  write(project, 'src/a.js', 'module.exports = (q) => { if (typeof q !== "string") throw new TypeError("q"); return q; };\n');
  claudeReport(project, run, 'implementer-T1');
  assert.equal(neat(project, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);

  const round2 = reviewRound(project, run, { claude: 'none', second: ['none'], secondOnCodex: true });
  assert.equal(round2.lines[0], 'merged critical=0 warning=0 info=0 both=0 disputed=0 round=1/2 next=done');
  assert.ok(!round2.lines.some((l) => l.startsWith('fix=')));
});

test('the fix loop is bounded: after 2 fix rounds a gate run asks and an auto run stops', () => {
  for (const [mode, last] of [['gate', 'ask'], ['auto', 'stop']]) {
    const project = makeProject();
    const run = plannedRun(project, mode);
    implement(project, run);
    ok(project, ['run', 'stage', run.id, 'review']);
    const wordings = ['the query input is unchecked', 'query input still lacks a check', 'still no check of the query input'];
    wordings.forEach((w, i) => {
      const { lines } = reviewRound(project, run, {
        claude: `src/a.js:1 - high - ${w}`, second: [`src/a.js:1 - medium - ${w} here`], secondOnCodex: false,
      });
      const expected = i < 2 ? `round=${i}/2 next=fix` : `round=2/2 next=${last}`;
      assert.ok(lines[0].endsWith(` ${expected}`), `${mode} round ${i}: ${lines[0]}`);
      assert.equal(lines[1], 'fix=T1');
      if (i === 2) return;
      brief(project, run, 'implementer-T1', ['--fix']);
      write(project, 'src/a.js', `module.exports = (q) => String(q) + ${i};\n`);
      claudeReport(project, run, 'implementer-T1');
      assert.equal(neat(project, ['run', 'guard', run.id, '--tasks', 'T1']).status, 0);
    });
    if (mode === 'auto') assert.equal(ok(project, ['run', 'stage', run.id, 'cancelled']), 'stage cancelled\n');
  }
});

test('without Codex the second reviewer is a Claude reviewer on another model tagged claude-2', () => {
  const project = makeProject();
  const run = plannedRun(project);
  implement(project, run);
  ok(project, ['run', 'stage', run.id, 'review']);
  const { first, other, lines } = reviewRound(project, run, {
    claude: 'src/a.js:3 - medium - input is not validated before use',
    second: ['src/a.js:2 - medium - input is not validated', 'src/a.js:9 - low - consider a comment'],
    secondOnCodex: false,
  });
  assert.match(other.route, / target=claude action=run$/);
  const model = (line) => / model=(\S+) /.exec(line)[1];
  assert.notEqual(model(other.route), model(first.route));
  assert.ok(fs.readFileSync(other.file, 'utf8').includes(`Review file: ${path.join(run.dir, 'review-2.md')}`));
  const saved = mergedFile(run);
  assert.match(saved[0], /^src\/a\.js:3 warning \[both\] /);
  assert.match(saved[1], /^src\/a\.js:9 info \[claude-2\] consider a comment$/);
  assert.ok(lines[0].endsWith(' both=1 disputed=0 round=0/2 next=fix'), lines[0]);
});

test('at the hard threshold with the fake Codex the guard still catches a Codex implementer and the merge disputes nothing', () => {
  const project = makeProject({ codex: 'fake', cfg: hardCfg });
  const run = plannedRun(project);
  ok(project, ['run', 'stage', run.id, 'implement']);
  assert.match(brief(project, run, 'implementer-T1').route, / hard=yes .*target=codex action=run$/);
  codexWorker(project, run, 'implementer-T1', { FAKE_CODEX_TOUCH: 'src/a.js,src/c.js' });
  const guarded = neat(project, ['run', 'guard', run.id, '--tasks', 'T1']);
  assert.equal(guarded.status, 1, guarded.stdout);
  assert.match(guarded.stdout, /guard violation: .*src\/c\.js/);

  ok(project, ['run', 'stage', run.id, 'review']);
  ok(project, ['run', 'diff', run.id]);
  assert.match(brief(project, run, 'reviewer').route, / target=codex action=run$/);
  assert.match(brief(project, run, 'reviewer-2').route, / action=skip$/);
  codexWorker(project, run, 'reviewer', { FAKE_CODEX_OUTPUT: codexOutput(['- src/a.js:1 - high - input is unchecked']) });
  const lines = merge(project, run);
  assert.match(lines[0], /^merged critical=1 warning=0 info=0 both=0 disputed=0 round=0\/2 next=fix$/);
  assert.deepEqual(mergedFile(run).filter(Boolean), ['src/a.js:1 critical [codex] input is unchecked']);
});

test('at the hard threshold without Codex every worker gets action=pause', () => {
  const project = makeProject({ cfg: hardCfg });
  const run = plannedRun(project);
  for (const worker of ['explorer', 'implementer-T1', 'reviewer', 'reviewer-2']) {
    const line = ok(project, ['route', run.id, worker]).split('\n')[0];
    assert.match(line, new RegExp(`^route worker=${worker} .* hard=yes .*target=claude action=pause$`), line);
  }
});
