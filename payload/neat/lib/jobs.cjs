'use strict';

// Codex job records: one JSON file per job under <runDir>/jobs/, written
// atomically. Job ids are checked against JOB_ID before any path is built.
// The jobs dir sits inside the workspace a Codex worker may write, so a record
// is untrusted input: readJob drops a record whose id, run, worker, status,
// mode, sandbox, pids or tmux target do not fit the file it was read from,
// and replaces its root and file paths with the ones derived here. The codex
// binary and exec settings never come from a record (see job-runner).
// The terminal status is written by exactly one party: whoever first creates
// the job's `.end` marker (the wrapper, cancel, or a wait that found the job
// lost), so a cancelled job can never flip back to done or failed. The one
// exception is a claim left without a terminal status for several seconds
// (its owner died mid-write): a wait then records the job as lost.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { UsageError } = require('./cli-args.cjs');
const runState = require('./run-state.cjs');
const { SANDBOXES } = require('./codex.cjs');

const JOB_ID = /^[a-z0-9-]{3,64}$/;
const JOB_STATUSES = Object.freeze(['running', 'done', 'failed', 'cancelled']);
const TERMINAL = Object.freeze(['done', 'failed', 'cancelled']);
const ID_HEX_BYTES = 2;
const ID_SUFFIX = /^[0-9a-f]+$/;
const MODES = Object.freeze(['bg', 'tmux']);
const TMUX_WINDOW_ID = /^@\d+$/;
const PS_TIMEOUT_MS = 5000;

function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id)) throw new UsageError(`invalid job id: ${id}`);
}

function assertRun(runId) {
  if (!runState.isValidRunId(runId)) throw new UsageError(`invalid run id: ${runId}`);
}

function jobsDir(root, runId) {
  assertRun(runId);
  return path.join(runState.runDir(root, runId), 'jobs');
}

function jobFile(root, runId, jobId, suffix = '.json') {
  assertJobId(jobId);
  return path.join(jobsDir(root, runId), `${jobId}${suffix}`);
}

// The files of job `jobId` of `worker`: codex output, job log and prompt.
function jobPaths(root, runId, jobId, worker) {
  return {
    outputPath: path.join(runState.runDir(root, runId), `codex-${worker}.md`),
    logPath: jobFile(root, runId, jobId, '.log'),
    promptPath: jobFile(root, runId, jobId, '.prompt.md'),
  };
}

function randomSuffix() {
  return crypto.randomBytes(ID_HEX_BYTES).toString('hex');
}

// <worker>-<4 hex>, regenerated while any run has a record with that id, so
// an id names one job across all runs (findJob looks it up in every run).
function makeJobId(root, runId, worker, { randomHex = randomSuffix } = {}) {
  assertRun(runId);
  const runs = [runId, ...runIdsNewestFirst(root).filter((r) => r !== runId)];
  for (;;) {
    const id = `${String(worker).toLowerCase()}-${randomHex()}`;
    assertJobId(id);
    if (!runs.some((r) => fs.existsSync(jobFile(root, r, id)))) return id;
  }
}

function writeJob(root, record) {
  const file = jobFile(root, record.runId, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return record;
}

function isPidField(v) {
  return v === null || v === undefined || (Number.isInteger(v) && v > 1);
}

// True when `rec` can be the record of job `jobId` in run `runId`.
function fitsFile(rec, runId, jobId) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (rec.id !== jobId || rec.runId !== runId) return false;
  const { worker } = rec;
  if (typeof worker !== 'string' || !runState.WORKER_NAME.test(worker)) return false;
  const prefix = `${worker.toLowerCase()}-`;
  if (!jobId.startsWith(prefix) || !ID_SUFFIX.test(jobId.slice(prefix.length))) return false;
  if (!JOB_STATUSES.includes(rec.status) || !MODES.includes(rec.mode) || !SANDBOXES.includes(rec.sandbox)) return false;
  if (!isPidField(rec.pid) || !isPidField(rec.pgid)) return false;
  const target = rec.tmuxTarget;
  return target === null || target === undefined || (typeof target === 'string' && TMUX_WINDOW_ID.test(target));
}

// The record with its root and file paths derived from where it was read, or
// null when the file is missing, unreadable or does not fit (see fitsFile).
function readJob(root, runId, jobId) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(jobFile(root, runId, jobId), 'utf8'));
  } catch {
    return null;
  }
  if (!fitsFile(rec, runId, jobId)) return null;
  return { ...rec, root: path.resolve(root), ...jobPaths(root, runId, jobId, rec.worker) };
}

function runIdsNewestFirst(root) {
  const dir = runState.runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && runState.isValidRunId(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// Scans every run; throws a UsageError when no run has the job, or when more
// than one does (acting on the wrong run's job could cancel a live one).
function findJob(root, jobId) {
  assertJobId(jobId);
  const found = runIdsNewestFirst(root).map((runId) => readJob(root, runId, jobId)).filter(Boolean);
  if (found.length === 0) throw new UsageError(`job not found: ${jobId}`);
  if (found.length > 1) {
    throw new UsageError(`job id ${jobId} is in more than one run: ${found.map((r) => r.runId).join(', ')}`);
  }
  return found[0];
}

// Records of one run, newest first (by the prompt file's write time). With
// `unreadable`, a job file that cannot be parsed yields
// { id, runId, status: 'unreadable' } instead of being left out.
function runJobs(root, runId, { unreadable = false } = {}) {
  const dir = jobsDir(root, runId);
  if (!fs.existsSync(dir)) return [];
  const stamp = (r) => {
    try {
      return fs.statSync(jobFile(root, runId, r.id, '.prompt.md')).mtimeMs;
    } catch {
      return 0;
    }
  };
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && JOB_ID.test(name.slice(0, -5)))
    .map((name) => {
      const id = name.slice(0, -5);
      return readJob(root, runId, id) || (unreadable ? { id, runId, status: 'unreadable' } : null);
    })
    .filter(Boolean)
    .map((r) => ({ record: r, t: stamp(r) }))
    .sort((a, b) => b.t - a.t)
    .map((x) => x.record);
}

// Every job, newest run first (options as for runJobs).
function listJobs(root, options = {}) {
  return runIdsNewestFirst(root).flatMap((runId) => runJobs(root, runId, options));
}

// Newest job of the newest run that has jobs, or null.
function latestJob(root) {
  for (const runId of runIdsNewestFirst(root)) {
    const jobs = runJobs(root, runId);
    if (jobs.length > 0) return jobs[0];
  }
  return null;
}

function isTerminal(record) {
  return Boolean(record) && TERMINAL.includes(record.status);
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// True when `argv` is the job's wrapper: it holds `_exec <run id> <job id>`.
function isWrapperArgv(argv, record) {
  return argv.some((a, i) => a === '_exec' && argv[i + 1] === record.runId && argv[i + 2] === record.id);
}

// The command line of `pid` split on blanks, from `ps` (systems without
// /proc, such as macOS): [] when ps lists no such process, null when ps
// cannot run.
function psArgv(pid, psBin) {
  const res = spawnSync(psBin, ['-ww', '-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_TIMEOUT_MS,
  });
  if (res.error) return null;
  return res.status === 0 ? res.stdout.trim().split(/\s+/) : [];
}

// kill -0 on the recorded pid (EPERM still means the process exists), and the
// process must also have the job's wrapper command line: from
// /proc/<pid>/cmdline, or from `ps` where /proc is missing. So a reused pid,
// a zombie or another process that merely mentions the job id never reads as
// the job. Only when neither /proc nor ps is available does kill -0 decide
// alone. Only liveness is checked: a terminal status in the record wins over
// it (see isTerminal).
function isAlive(record, { procDir = '/proc', ps = 'ps' } = {}) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1) return false;
  if (!pidExists(record.pid)) return false;
  if (!fs.existsSync(procDir)) {
    const argv = psArgv(record.pid, ps);
    return argv === null ? true : isWrapperArgv(argv, record);
  }
  try {
    const argv = fs.readFileSync(path.join(procDir, String(record.pid), 'cmdline'), 'utf8').split('\0');
    return isWrapperArgv(argv, record);
  } catch {
    return false;
  }
}

// Creates the `.end` marker; true when this caller owns the terminal status.
function claimEnd(root, record) {
  try {
    fs.closeSync(fs.openSync(jobFile(root, record.runId, record.id, '.end'), 'wx'));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Milliseconds since the job's `.end` marker was created, or null without one.
function endAgeMs(root, record, now = Date.now()) {
  try {
    return now - fs.statSync(jobFile(root, record.runId, record.id, '.end')).mtimeMs;
  } catch {
    return null;
  }
}

// Writes the terminal `patch` when this caller wins the claim; returns the
// record now on disk.
function finishJob(root, record, patch) {
  if (!claimEnd(root, record)) return readJob(root, record.runId, record.id) || record;
  const current = readJob(root, record.runId, record.id) || record;
  return writeJob(root, { ...current, ...patch });
}

module.exports = {
  JOB_ID,
  JOB_STATUSES,
  TERMINAL,
  assertJobId,
  jobsDir,
  jobFile,
  jobPaths,
  makeJobId,
  writeJob,
  readJob,
  findJob,
  latestJob,
  listJobs,
  isTerminal,
  isAlive,
  claimEnd,
  endAgeMs,
  finishJob,
};
