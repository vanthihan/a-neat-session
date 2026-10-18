'use strict';

const DEFAULT_LIMIT = 10;
const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;

function activeWorkers(run) {
  const workers = Array.isArray(run.workers) ? run.workers : [];
  return workers.filter((w) => w.status === 'running').map((w) => w.name);
}

function jobSummary(job) {
  return { id: job.id, worker: job.worker || null, mode: job.mode || null, status: job.status, startedAt: job.startedAt || null };
}

function summary(run, jobs) {
  const runJobs = jobs.filter((j) => j.runId === run.id).map(jobSummary);
  if (run.error) return { id: run.id, error: run.error, jobs: runJobs };
  return {
    id: run.id,
    task: run.task,
    mode: run.mode,
    stage: run.stage,
    activeWorkers: activeWorkers(run),
    updatedAt: run.updatedAt,
    jobs: runJobs,
  };
}

function line(s) {
  if (s.error) return `${s.id}  ${s.error}`;
  const active = s.activeWorkers.length ? s.activeWorkers.join(',') : '-';
  return `${s.id}  mode=${s.mode}  stage=${s.stage}  active=${active}  updated=${s.updatedAt}`;
}

// Whole seconds, minutes or hours from `startedAt` to `now` (never negative).
function age(startedAt, now) {
  const ms = now.getTime() - Date.parse(startedAt);
  const s = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / SECOND_MS)) : 0;
  if (s < MINUTE_S) return `${s}s`;
  if (s < HOUR_S) return `${Math.floor(s / MINUTE_S)}m`;
  return `${Math.floor(s / HOUR_S)}h`;
}

function jobLine(job, now) {
  if (job.status === 'unreadable') return `${job.id}  run=${job.runId}  unreadable`;
  return `${job.id}  run=${job.runId}  worker=${job.worker}  mode=${job.mode}  status=${job.status}  age=${age(job.startedAt, now)}`;
}

function jobLines(jobs, limit, now) {
  if (jobs.length === 0) return [];
  const shown = jobs.slice(0, limit);
  return [`codex jobs: ${jobs.length} (showing ${shown.length})`, ...shown.map((j) => jobLine(j, now))];
}

// runs: newest first (see run-state listRuns). jobs: Codex job summaries
// { id, runId, worker, mode, status, startedAt }, newest first, with the
// display status already decided (`lost`, `unreadable`). Pure: returns text
// without a trailing newline.
function formatStatus(runs, { json = false, limit = DEFAULT_LIMIT, runsDir, jobs = [], now = new Date() } = {}) {
  const shown = runs.slice(0, limit).map((run) => summary(run, jobs));
  if (json) return JSON.stringify(shown, null, 2);
  if (runs.length === 0) return `no neat runs in ${runsDir}`;
  const header = `neat runs: ${runs.length} (showing ${shown.length}) in ${runsDir}`;
  return [header, ...shown.map(line), ...jobLines(jobs, limit, now)].join('\n');
}

module.exports = { formatStatus, DEFAULT_LIMIT };
