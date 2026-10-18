'use strict';

// Tracer for Codex background jobs through the INSTALLED helper: a worker at
// the hard usage threshold routes to Codex, `codex run` starts a detached job,
// `codex wait` blocks until it ends and `codex result` turns the -o output into
// a capped report. Codex is always the fake shim (NEAT_CODEX_BIN).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO_ROOT, childEnv, runNode, makeTempDir, removeDir, installFakeCodex,
} = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const NOW_ISO = '2026-05-01T12:00:00.000Z';
const FUTURE = Math.floor(Date.parse(NOW_ISO) / 1000) + 3600;
const JOB_LINE = /^job=(reviewer-[0-9a-f]{4}) worker=reviewer mode=bg sandbox=read-only pid=(\d+)$/;

let proj;
let cfg;
let binDir;
let shim;
let log;
let env;
let helper;

function writeCapture(dir, fiveHour) {
  fs.mkdirSync(path.join(dir, 'neat'), { recursive: true });
  const data = { rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: FUTURE } } };
  fs.writeFileSync(path.join(dir, 'neat', 'usage.json'), JSON.stringify(data));
}

before(() => {
  proj = makeTempDir('neat-cdx-');
  cfg = makeTempDir('neat-cdx-cfg-');
  binDir = makeTempDir('neat-cdx-bin-');
  shim = installFakeCodex(binDir);
  log = path.join(binDir, 'calls.jsonl');
  writeCapture(cfg, 95);
  env = childEnv({
    NEAT_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg, NEAT_NOW: NOW_ISO,
    NEAT_CODEX_BIN: shim, FAKE_CODEX_LOG: log,
  });
  const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
  assert.equal(res.status, 0, res.stderr);
  helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
});

after(() => {
  removeDir(proj);
  removeDir(cfg);
  removeDir(binDir);
});

function neat(args, extra = {}, input) {
  return runNode([helper, ...args], { cwd: proj, env: { ...env, ...extra }, input });
}

function newRun(task, extra = {}) {
  const res = neat(['run', 'new', '--stdin'], extra, `${task}\n`);
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  return { id, dir: path.join(proj, '.neat', 'runs', id) };
}

function briefLine(id, worker, extra = {}) {
  const res = neat(['brief', id, worker], extra);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split('\n')[1];
}

function calls() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function words(text) {
  return text.trim().split(/\s+/).length;
}

// run new -> brief reviewer -> codex run; returns the job id and its record path.
function startReviewer(task, extra = {}) {
  const run = newRun(task, extra);
  assert.match(briefLine(run.id, 'reviewer', extra), / target=codex action=run$/);
  const res = neat(['codex', 'run', run.id, 'reviewer'], extra);
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.trim().match(JOB_LINE);
  assert.ok(m, res.stdout);
  return { ...run, job: m[1], pid: Number(m[2]), record: path.join(run.dir, 'jobs', `${m[1]}.json`) };
}

function waitJob(job, extra = {}) {
  const res = neat(['codex', 'wait', job], extra);
  return { ...res, line: res.stdout.trim() };
}

test('codex detect reports the shim version, or codex=no with none', () => {
  const found = neat(['codex', 'detect']);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, 'codex=yes version=9.9.9\n');
  const none = neat(['codex', 'detect'], { NEAT_CODEX_BIN: 'none' });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, 'codex=no\n');
});

test('route lines: hard + codex -> target=codex, without codex or below hard -> claude', () => {
  const { id } = newRun('route targets');
  assert.match(briefLine(id, 'reviewer'), / usage=95% stepdown=yes hard=yes ctx=unknown target=codex action=run$/);
  const noCodex = briefLine(id, 'reviewer', { NEAT_CODEX_BIN: 'none' });
  assert.match(noCodex, / hard=yes ctx=unknown target=claude action=run$/);
  const quiet = makeTempDir('neat-cdx-cfg-');
  try {
    fs.rmSync(log, { force: true });
    const line = briefLine(id, 'reviewer', { CLAUDE_CONFIG_DIR: quiet });
    assert.match(line, / hard=no ctx=unknown target=claude action=run$/);
    assert.deepEqual(calls().filter((c) => c.argv[0] === '--version'), [], 'no detection below hard');
  } finally {
    removeDir(quiet);
  }
});

test('tracer: codex run returns at once, wait blocks until done, result passes report check', () => {
  fs.rmSync(log, { force: true });
  const extra = { FAKE_CODEX_DELAY_MS: '300' };
  const { id, dir, job, pid, record } = startReviewer('review the parser', extra);
  assert.equal(readJson(record).status, 'running', 'run must return while codex still runs');

  const waited = waitJob(job);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.line, `job ${job} status=done exit=0 worker=reviewer`);

  const rec = readJson(record);
  for (const key of ['id', 'runId', 'worker', 'pid', 'pgid', 'startedAt', 'endedAt', 'status', 'exitCode',
    'outputPath', 'logPath', 'promptPath', 'mode', 'sandbox', 'effort', 'codexPath']) {
    assert.ok(key in rec, `job record lacks ${key}`);
  }
  assert.deepEqual([rec.id, rec.runId, rec.worker, rec.status, rec.exitCode, rec.mode, rec.sandbox],
    [job, id, 'reviewer', 'done', 0, 'bg', 'read-only']);
  assert.equal(rec.pid, pid);
  assert.equal(rec.pgid, pid);
  assert.equal(rec.codexPath, shim);
  assert.equal(rec.outputPath, path.join(dir, 'codex-reviewer.md'));

  const execs = calls().filter((c) => c.argv[0] === 'exec');
  assert.equal(execs.length, 1);
  assert.deepEqual(execs[0].argv, ['exec', '-s', 'read-only', '-C', proj, '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=medium', '-o', path.join(dir, 'codex-reviewer.md'), '-']);
  assert.ok(execs[0].stdin.startsWith('# Brief: reviewer\n'), execs[0].stdin.slice(0, 80));
  assert.ok(execs[0].stdin.includes('\n## Codex rules\n'));
  assert.ok(execs[0].stdin.includes('final message'));

  const state = readJson(path.join(dir, 'state.json'));
  const w = state.workers.find((x) => x.name === 'reviewer');
  assert.deepEqual([w.engine, w.job], ['codex', job]);

  const result = neat(['codex', 'result', job]);
  assert.equal(result.status, 0, result.stderr);
  const reportFile = path.join(dir, 'report-reviewer.md');
  assert.ok(result.stdout.endsWith(`report: ${reportFile}\n`), result.stdout);
  const reportText = fs.readFileSync(reportFile, 'utf8');
  assert.ok(words(reportText) <= 300);
  assert.ok(result.stdout.startsWith(reportText.trimEnd()));
  const check = neat(['report', 'check', reportFile]);
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /^report ok/);
});

test('prompt text with shell syntax reaches codex stdin byte-exact and runs nothing', () => {
  fs.rmSync(log, { force: true });
  const task = 'check $(touch pwned) and `touch pwned2` with "double" and \'single\' quotes';
  const { job } = startReviewer(task);
  assert.match(waitJob(job).line, /status=done exit=0/);
  const exec = calls().find((c) => c.argv[0] === 'exec');
  assert.ok(exec.stdin.includes(`Task: ${task}\n`), exec.stdin.slice(0, 200));
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('pwned')) found.push(path.join(d, e.name));
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(proj);
  assert.deepEqual(found, []);
});

test('non-conforming output is wrapped: first 250 words under Findings plus the -o path', () => {
  const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
  const { dir, job } = startReviewer('wrap plain output', { FAKE_CODEX_OUTPUT: `# Title\n${text}\n` });
  assert.match(waitJob(job).line, /status=done exit=0/);
  const res = neat(['codex', 'result', job]);
  assert.equal(res.status, 0, res.stderr);
  const report = fs.readFileSync(path.join(dir, 'report-reviewer.md'), 'utf8');
  assert.match(report, /^## Status\ndone\n/);
  const findings = report.split('## Findings\n')[1].split('\n## Decisions')[0];
  assert.ok(findings.includes('w248'));
  assert.ok(!findings.includes('w249'), 'only the first 250 words');
  assert.ok(!/^#/m.test(findings), 'no heading survives inside Findings');
  assert.ok(report.includes(`## Artifacts\n- ${path.join(dir, 'codex-reviewer.md')}`));
  assert.ok(words(report) <= 300);
  const check = neat(['report', 'check', path.join(dir, 'report-reviewer.md')]);
  assert.equal(check.status, 0, check.stdout);
});

test('a failing codex gives status=failed and a failed report naming the log', () => {
  const { dir, job } = startReviewer('codex fails', { FAKE_CODEX_EXIT: '1' });
  const waited = waitJob(job);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.line, `job ${job} status=failed exit=1 worker=reviewer`);
  const res = neat(['codex', 'result', job]);
  assert.equal(res.status, 0, res.stderr);
  const report = fs.readFileSync(path.join(dir, 'report-reviewer.md'), 'utf8');
  assert.match(report, /^## Status\nfailed\n/);
  assert.ok(report.includes(`## Artifacts\n- ${path.join(dir, 'jobs', `${job}.log`)}`));
  const check = neat(['report', 'check', path.join(dir, 'report-reviewer.md')]);
  assert.equal(check.status, 0, check.stdout);
});
