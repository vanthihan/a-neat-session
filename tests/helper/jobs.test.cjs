'use strict';

// Job records (ids, lookup, liveness with the PID-reuse guard) and the capped
// result builder for failed, cancelled and oversized Codex jobs.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const jobs = require(path.join(LIB, 'jobs.cjs'));
const codexResult = require(path.join(LIB, 'codex-result.cjs'));
const { countWords, checkReport } = require(path.join(LIB, 'report-check.cjs'));
const { UsageError } = require(path.join(LIB, 'cli-args.cjs'));

const RUN_A = '20260501-120000-alpha';
const RUN_B = '20260501-120000-beta';

let root;

before(() => {
  root = makeTempDir('neat-jobs-');
  for (const id of [RUN_A, RUN_B]) fs.mkdirSync(path.join(root, '.neat', 'runs', id), { recursive: true });
});

after(() => removeDir(root));

function record(runId, id, extra = {}) {
  const jobsDir = path.join(root, '.neat', 'runs', runId, 'jobs');
  return {
    id, runId, worker: 'reviewer', pid: null, pgid: null, status: 'running', exitCode: null,
    outputPath: path.join(root, '.neat', 'runs', runId, 'codex-reviewer.md'),
    logPath: path.join(jobsDir, `${id}.log`),
    promptPath: path.join(jobsDir, `${id}.prompt.md`),
    ...extra,
  };
}

function exitedPid() {
  const res = spawnSync(process.execPath, ['-e', '']);
  return res.pid;
}

describe('ids and lookup', () => {
  test('ids are validated before any path is built', () => {
    for (const bad of ['../x', 'A-1', 'ab', 'a/b', '', 'x'.repeat(65)]) {
      assert.throws(() => jobs.findJob(root, bad), (err) => err instanceof UsageError && /invalid job id/.test(err.message), bad);
      assert.throws(() => jobs.jobFile(root, RUN_A, bad), UsageError, bad);
    }
    assert.throws(() => jobs.jobsDir(root, '../evil'), UsageError);
  });

  test('makeJobId is <worker>-<4 hex>', () => {
    assert.match(jobs.makeJobId(root, RUN_A, 'implementer-T2'), /^implementer-t2-[0-9a-f]{4}$/);
  });

  test('write/read round trip; findJob scans runs newest first; unknown ids are not found', () => {
    jobs.writeJob(root, record(RUN_A, 'reviewer-aaaa'));
    jobs.writeJob(root, record(RUN_B, 'reviewer-bbbb', { status: 'done' }));
    assert.equal(jobs.readJob(root, RUN_A, 'reviewer-aaaa').status, 'running');
    assert.equal(jobs.findJob(root, 'reviewer-aaaa').runId, RUN_A);
    assert.equal(jobs.findJob(root, 'reviewer-bbbb').runId, RUN_B);
    assert.throws(() => jobs.findJob(root, 'reviewer-cccc'), /job not found: reviewer-cccc/);
    assert.equal(jobs.latestJob(root).id, 'reviewer-bbbb');
    assert.deepEqual(jobs.listJobs(root).map((r) => r.id), ['reviewer-bbbb', 'reviewer-aaaa']);
  });
});

describe('isAlive', () => {
  let child;

  after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  test('an exited pid is not alive', () => {
    assert.equal(jobs.isAlive(record(RUN_A, 'reviewer-dead', { pid: exitedPid() })), false);
    assert.equal(jobs.isAlive(record(RUN_A, 'reviewer-none', { pid: null })), false);
  });

  test('a live pid whose cmdline lacks the job id is not alive (pid reuse guard)', () => {
    const r = record(RUN_A, 'reviewer-zzzz', { pid: process.pid });
    if (fs.existsSync('/proc/self/cmdline')) assert.equal(jobs.isAlive(r), false);
    assert.equal(jobs.isAlive(r, { procDir: path.join(root, 'no-proc') }), true, 'without /proc only kill -0 decides');
  });

  test('a live pid whose cmdline carries the job id is alive', async () => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'reviewer-live'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('spawn', resolve));
    assert.equal(jobs.isAlive(record(RUN_A, 'reviewer-live', { pid: child.pid })), true);
    child.kill('SIGKILL');
  });
});

describe('result builder', () => {
  const PROMPT = '# Brief: reviewer\nTask: fix ERROR: secret prompt words\n';

  function failed(extra = {}) {
    return record(RUN_A, 'reviewer-fail', { status: 'failed', exitCode: 1, ...extra });
  }

  function findings(text) {
    return text.split('## Findings\n')[1].split('\n## Decisions')[0].trim().split('\n');
  }

  test('auth failure: at most 5 error lines of at most 160 chars plus the login hint', () => {
    const noise = Array.from({ length: 8 }, (_, i) => `ERROR: reconnecting ${i} ${'x'.repeat(300)}`);
    const log = [PROMPT, 'hook: SessionStart', ...noise, 'ERROR: unexpected status 401 Unauthorized'].join('\n');
    const { text } = codexResult.buildResult(failed(), { logText: log, promptText: PROMPT });
    assert.ok(checkReport(text).ok, checkReport(text).errors.join('; '));
    assert.match(text, /^## Status\nfailed\n/);
    const lines = findings(text);
    const errors = lines.filter((l) => /ERROR/.test(l));
    assert.ok(errors.length <= 5, lines.join('\n'));
    assert.ok(errors.every((l) => l.length <= 162), 'each error line is cut to 160 chars');
    assert.ok(lines.includes('- hint: run codex login'), lines.join('\n'));
    assert.ok(!text.includes('secret prompt words'), 'prompt text never reaches the report');
    assert.ok(!text.includes('SessionStart'));
    assert.ok(countWords(text) <= 300);
  });

  test('usage limit wording gives the limit hint', () => {
    for (const msg of ['ERROR: usage limit reached', 'ERROR: rate limit hit', 'error: status 429', 'ERROR: quota exceeded']) {
      const { text } = codexResult.buildResult(failed(), { logText: msg, promptText: '' });
      assert.ok(text.includes('- hint: Codex usage limit reached'), msg);
    }
  });

  test('a cancelled job reports failed with job cancelled', () => {
    const { text } = codexResult.buildResult(failed({ status: 'cancelled', exitCode: null }), { logText: '', promptText: '' });
    assert.match(text, /^## Status\nfailed\n/);
    assert.ok(findings(text).includes('- job cancelled'));
  });

  test('a 2 MB output file is read only up to 1 MB and the report stays capped', () => {
    const file = path.join(root, 'big.md');
    fs.writeFileSync(file, 'word '.repeat(2 * 1024 * 1024 / 5));
    const text = codexResult.readCapped(file);
    assert.equal(Buffer.byteLength(text), codexResult.MAX_READ_BYTES);
    const built = codexResult.buildResult(record(RUN_A, 'reviewer-big', { status: 'done', exitCode: 0 }), { outputText: text });
    assert.ok(countWords(built.text) <= 300);
    assert.ok(checkReport(built.text).ok);
  });
});
