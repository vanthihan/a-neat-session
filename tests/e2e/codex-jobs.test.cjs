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

test('route lines: hard + codex -> target=codex, hard without codex -> pause, below hard -> claude', () => {
  const { id } = newRun('route targets');
  assert.match(briefLine(id, 'reviewer'), / usage=95% stepdown=yes hard=yes ctx=unknown target=codex action=run$/);
  const noCodex = briefLine(id, 'reviewer', { NEAT_CODEX_BIN: 'none' });
  assert.match(noCodex, / hard=yes ctx=unknown target=claude action=pause$/);
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

// --- failure, timeout, lost and cancel paths ---

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) Z /.test(stat); // a zombie is not running
  } catch {
    return true;
  }
}

// Waits until fn() is truthy or ms pass; returns the last value.
function until(fn, ms) {
  const deadline = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < deadline) {
    sleepMs(50);
    v = fn();
  }
  return v;
}

// pid of the fake codex started for the reviewer of run dir `dir`.
function codexPidFor(dir) {
  const out = path.join(dir, 'codex-reviewer.md');
  const call = until(() => calls().find((c) => c.argv[0] === 'exec' && c.argv.includes(out)), 3000);
  return call && call.pid;
}

test('wait on a lost job marks it failed with exit=none', () => {
  const { job, pid } = startReviewer('lost job', { FAKE_CODEX_DELAY_MS: '10000' });
  process.kill(-pid, 'SIGKILL');
  assert.ok(until(() => !alive(pid), 3000), 'wrapper must die');
  const waited = waitJob(job);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(waited.line, `job ${job} status=failed exit=none worker=reviewer`);
});

test('wait on several jobs prints one line per job in argument order; bad ids exit 2', () => {
  const a = startReviewer('first of two', { FAKE_CODEX_DELAY_MS: '200' });
  const b = startReviewer('second of two');
  const res = neat(['codex', 'wait', b.job, a.job]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.trim().split('\n'), [
    `job ${b.job} status=done exit=0 worker=reviewer`,
    `job ${a.job} status=done exit=0 worker=reviewer`,
  ]);
  const unknown = neat(['codex', 'wait', 'reviewer-ffff']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stderr, 'neat: job not found: reviewer-ffff\n');
  const evil = neat(['codex', 'wait', '../x']);
  assert.equal(evil.status, 2);
  assert.match(evil.stderr, /invalid job id/);
});

test('timeout, result while running, then cancel stops the whole group', () => {
  fs.rmSync(log, { force: true });
  const { dir, job, pid, record } = startReviewer('slow job', { FAKE_CODEX_DELAY_MS: '10000' });
  const t0 = Date.now();
  const waited = neat(['codex', 'wait', job, '--timeout', '1']);
  assert.ok(Date.now() - t0 < 3000, 'timeout must return within 3 s');
  assert.equal(waited.status, 3);
  assert.equal(waited.stdout, `job ${job} status=running exit=none worker=reviewer\n`);

  const early = neat(['codex', 'result', job]);
  assert.equal(early.status, 3);
  assert.equal(early.stdout, `job ${job} status=running\n`);
  assert.equal(fs.existsSync(path.join(dir, 'report-reviewer.md')), false);

  const twice = neat(['codex', 'run', path.basename(dir), 'reviewer']);
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, new RegExp(`job ${job} of reviewer is still running`));

  const codexPid = codexPidFor(dir);
  assert.ok(codexPid, 'fake codex must have started');
  const res = neat(['codex', 'cancel', job]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `job ${job} cancelled\n`);
  const rec = readJson(record);
  assert.equal(rec.status, 'cancelled');
  assert.ok(rec.endedAt);
  assert.ok(until(() => !alive(pid) && !alive(codexPid), 4000), 'wrapper and codex must stop');
  sleepMs(200);
  assert.equal(readJson(record).status, 'cancelled', 'the wrapper never overwrites cancelled');

  const result = neat(['codex', 'result', job]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## Status\nfailed\n/);
  assert.ok(result.stdout.includes('- job cancelled'));
  const again = neat(['codex', 'cancel', job]);
  assert.deepEqual([again.status, again.stdout], [0, `job ${job} already cancelled\n`]);
});

test('cancel kills a codex that ignores SIGTERM once the wrapper is gone', () => {
  fs.rmSync(log, { force: true });
  const extra = { FAKE_CODEX_DELAY_MS: '30000', FAKE_CODEX_IGNORE_TERM: '1' };
  const { dir, job, pid } = startReviewer('stubborn codex', extra);
  const codexPid = codexPidFor(dir);
  assert.ok(codexPid, 'fake codex must have started');
  try {
    const res = neat(['codex', 'cancel', job]);
    assert.deepEqual([res.status, res.stdout], [0, `job ${job} cancelled\n`]);
    assert.ok(until(() => !alive(pid) && !alive(codexPid), 2000), 'codex must not survive the cancel');
  } finally {
    if (alive(codexPid)) process.kill(codexPid, 'SIGKILL');
  }
});

test('cancel on a finished job sends nothing', () => {
  const { job } = startReviewer('finished job');
  assert.match(waitJob(job).line, /status=done/);
  const res = neat(['codex', 'cancel', job]);
  assert.deepEqual([res.status, res.stdout], [0, `job ${job} already done\n`]);
});

test('a failed login shows error lines and a hint, never the prompt', () => {
  const extra = { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'ERROR: unexpected status 401 Unauthorized' };
  const { dir, job } = startReviewer('fix ERROR: secret prompt words', extra);
  assert.match(waitJob(job).line, /status=failed exit=1/);
  const res = neat(['codex', 'result', job]);
  assert.equal(res.status, 0, res.stderr);
  const report = fs.readFileSync(path.join(dir, 'report-reviewer.md'), 'utf8');
  assert.ok(report.includes('- ERROR: unexpected status 401 Unauthorized'), report);
  assert.ok(report.includes('- hint: run codex login'));
  assert.ok(!report.includes('secret prompt words'));
  assert.ok(words(report) <= 300);
  assert.equal(neat(['report', 'check', path.join(dir, 'report-reviewer.md')]).status, 0);

  const limit = startReviewer('limit hit', { FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'ERROR: usage limit reached' });
  waitJob(limit.job);
  assert.ok(neat(['codex', 'result', limit.job]).stdout.includes('- hint: Codex usage limit reached'));
});

test('no id: result uses the newest job; cancel lists running jobs; --stdin reads the id', () => {
  const { job } = startReviewer('zzz newest run', { FAKE_CODEX_DELAY_MS: '10000' });
  try {
    const none = neat(['codex', 'cancel']);
    assert.equal(none.status, 2);
    assert.ok(none.stderr.includes(job), none.stderr);
    const latest = neat(['codex', 'result']);
    assert.deepEqual([latest.status, latest.stdout], [3, `job ${job} status=running\n`]);
    const viaStdin = neat(['codex', 'result', '--stdin'], {}, `\n${job}\n`);
    assert.deepEqual([viaStdin.status, viaStdin.stdout], [3, `job ${job} status=running\n`]);
    const empty = neat(['codex', 'result', '--stdin'], {}, '');
    assert.equal(empty.stdout, `job ${job} status=running\n`);
    const eof = neat(['codex', 'cancel', '--stdin'], {}, 'NEAT_EOF\n');
    assert.equal(eof.status, 2);
  } finally {
    const res = neat(['codex', 'cancel', '--stdin'], {}, `${job}\n`);
    assert.equal(res.stdout, `job ${job} cancelled\n`);
  }
});

test('result --stdin matches result <job>; a hostile id is refused and runs nothing', () => {
  const { job } = startReviewer('stdin result');
  assert.match(waitJob(job).line, /status=done/);
  const direct = neat(['codex', 'result', job]);
  assert.equal(direct.status, 0, direct.stderr);
  const viaStdin = neat(['codex', 'result', '--stdin'], {}, `${job}\n`);
  assert.deepEqual([viaStdin.status, viaStdin.stdout], [0, direct.stdout]);
  for (const verb of ['result', 'cancel']) {
    const evil = neat(['codex', verb, '--stdin'], {}, 'x; touch pwned\n');
    assert.equal(evil.status, 2, verb);
    assert.match(evil.stderr, /invalid job id/);
    assert.equal(fs.existsSync(path.join(proj, 'pwned')), false);
  }
});

test('status lists the job through the installed helper; cancel --stdin stops a running one', () => {
  const { id, job } = startReviewer('status and cancel', { FAKE_CODEX_DELAY_MS: '10000' });
  try {
    const shown = neat(['status']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.ok(
      shown.stdout.includes(`${job}  run=${id}  worker=reviewer  mode=bg  status=running  age=0s\n`),
      shown.stdout,
    );
  } finally {
    const res = neat(['codex', 'cancel', '--stdin'], {}, `${job}\n`);
    assert.deepEqual([res.status, res.stdout], [0, `job ${job} cancelled\n`]);
  }
  assert.ok(neat(['status']).stdout.includes(`${job}  run=${id}  worker=reviewer  mode=bg  status=cancelled  age=0s\n`));
});

test('reviewer-2: codex below hard, skipped at hard; its job runs read-only into its own -o file', () => {
  const { id, dir } = newRun('second reviewer on codex');
  assert.match(briefLine(id, 'reviewer-2'), / hard=yes ctx=unknown target=claude action=skip$/);
  const quiet = makeTempDir('neat-cdx-cfg-');
  try {
    const line = briefLine(id, 'reviewer-2', { CLAUDE_CONFIG_DIR: quiet });
    assert.match(line, /^route worker=reviewer-2 model=sonnet effort=medium .* hard=no ctx=unknown target=codex action=run$/);
  } finally {
    removeDir(quiet);
  }
  const refused = neat(['codex', 'run', id, 'reviewer-2', '--sandbox', 'workspace-write']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /read-only/);

  fs.rmSync(log, { force: true });
  const res = neat(['codex', 'run', id, 'reviewer-2']);
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.trim().match(/^job=(reviewer-2-[0-9a-f]{4}) worker=reviewer-2 mode=bg sandbox=read-only pid=\d+$/);
  assert.ok(m, res.stdout);
  assert.match(waitJob(m[1]).line, /status=done exit=0 worker=reviewer-2$/);
  const exec = calls().find((c) => c.argv[0] === 'exec');
  const out = path.join(dir, 'codex-reviewer-2.md');
  assert.deepEqual(exec.argv.slice(0, 3), ['exec', '-s', 'read-only']);
  assert.equal(exec.argv[exec.argv.indexOf('-o') + 1], out);
  assert.ok(exec.stdin.startsWith('# Brief: reviewer-2\n'));
  assert.ok(exec.stdin.includes(`Review file: ${path.join(dir, 'review-2.md')}`));
  assert.ok(exec.stdin.includes('`path:line - high|medium|low - issue`'));
  assert.ok(fs.existsSync(out));
});
