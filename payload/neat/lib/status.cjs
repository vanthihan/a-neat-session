'use strict';

const DEFAULT_LIMIT = 10;

function activeWorkers(run) {
  const workers = Array.isArray(run.workers) ? run.workers : [];
  return workers.filter((w) => w.status === 'running').map((w) => w.name);
}

function summary(run) {
  if (run.error) return { id: run.id, error: run.error };
  return {
    id: run.id,
    task: run.task,
    mode: run.mode,
    stage: run.stage,
    activeWorkers: activeWorkers(run),
    updatedAt: run.updatedAt,
  };
}

function line(s) {
  if (s.error) return `${s.id}  ${s.error}`;
  const active = s.activeWorkers.length ? s.activeWorkers.join(',') : '-';
  return `${s.id}  mode=${s.mode}  stage=${s.stage}  active=${active}  updated=${s.updatedAt}`;
}

// runs: newest first (see run-state listRuns). Returns text without a trailing newline.
function formatStatus(runs, { json = false, limit = DEFAULT_LIMIT, runsDir } = {}) {
  const shown = runs.slice(0, limit).map(summary);
  if (json) return JSON.stringify(shown, null, 2);
  if (runs.length === 0) return `no neat runs in ${runsDir}`;
  const header = `neat runs: ${runs.length} (showing ${shown.length}) in ${runsDir}`;
  return [header, ...shown.map(line)].join('\n');
}

module.exports = { formatStatus, DEFAULT_LIMIT };
