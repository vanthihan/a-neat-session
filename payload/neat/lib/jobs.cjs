'use strict';

// Codex job records: one JSON file per job under <runDir>/jobs/, written
// atomically. Job ids are checked against JOB_ID before any path is built.
// The terminal status is written by exactly one party: whoever first creates
// the job's `.end` marker (the wrapper, cancel, or a wait that found the job
// lost), so a cancelled job can never flip back to done or failed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { UsageError } = require('./cli-args.cjs');
const runState = require('./run-state.cjs');

const JOB_ID = /^[a-z0-9-]{3,64}$/;
const JOB_STATUSES = Object.freeze(['running', 'done', 'failed', 'cancelled']);
const TERMINAL = Object.freeze(['done', 'failed', 'cancelled']);
const ID_HEX_BYTES = 2;

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

// <worker>-<4 hex>, regenerated while a record with that id exists.
function makeJobId(root, runId, worker) {
  for (;;) {
    const id = `${String(worker).toLowerCase()}-${crypto.randomBytes(ID_HEX_BYTES).toString('hex')}`;
    assertJobId(id);
    if (!fs.existsSync(jobFile(root, runId, id))) return id;
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

// The record, or null when the file is missing or unreadable.
function readJob(root, runId, jobId) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(root, runId, jobId), 'utf8'));
  } catch {
    return null;
  }
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

// Scans the runs newest first; throws a UsageError when no run has the job.
function findJob(root, jobId) {
  assertJobId(jobId);
  for (const runId of runIdsNewestFirst(root)) {
    const record = readJob(root, runId, jobId);
    if (record) return record;
  }
  throw new UsageError(`job not found: ${jobId}`);
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

// kill -0 on the recorded pid (EPERM still means the process exists). Where
// /proc exists, /proc/<pid>/cmdline must also carry the job id, so
// a reused pid or a zombie never reads as the job. Only liveness is checked:
// a terminal status in the record wins over it (see isTerminal).
function isAlive(record, { procDir = '/proc' } = {}) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 1) return false;
  if (!pidExists(record.pid)) return false;
  if (!fs.existsSync(procDir)) return true;
  try {
    const argv = fs.readFileSync(path.join(procDir, String(record.pid), 'cmdline'), 'utf8').split('\0');
    return argv.includes(record.id);
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
  makeJobId,
  writeJob,
  readJob,
  findJob,
  latestJob,
  listJobs,
  isTerminal,
  isAlive,
  claimEnd,
  finishJob,
};
