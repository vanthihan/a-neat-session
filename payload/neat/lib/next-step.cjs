'use strict';

// The next orchestrator step of a run, decided from its state and a few disk
// facts. nextStep is pure: every disk fact comes in through `facts`
// (runFacts). Lines hold only fixed text, ids, stage, section and worker
// names, never report, brief or plan text.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { selectedOf } = require('./stages.cjs');
const { computeBatches } = require('./plan-check.cjs');

// Pipeline stage -> section of the orchestrator procedure.
const SECTIONS = Object.freeze({
  explore: 'Explore',
  research: 'Research',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  test: 'Test',
  docs: 'Docs',
});

const TERMINAL = Object.freeze(['done', 'cancelled']);
const TASK_ID = /^[TD]\d{1,4}$/;
const HELPER = path.resolve(__dirname, '..', 'bin', 'neat.cjs');
// Stage -> the plan task worker it runs and that worker's name prefix.
const BATCH_KINDS = Object.freeze({
  implement: Object.freeze({ worker: 'implementer', prefix: 'implementer-' }),
  docs: Object.freeze({ worker: 'docs', prefix: 'docs-' }),
});
// Stages run by a single worker.
const SINGLE_WORKER = Object.freeze({ research: 'researcher', test: 'tester' });
const WORD = /^[a-z][a-z-]{0,31}$/;

function step(section, line) {
  return { section, line };
}

function workerStatus(state, name) {
  const list = Array.isArray(state.workers) ? state.workers : [];
  const entry = list.find((w) => w && w.name === name);
  return entry ? entry.status : null;
}

function stageStatus(state, name) {
  const list = Array.isArray(state.stages) ? state.stages : [];
  const entry = list.find((s) => s && s.name === name);
  return entry ? entry.status : null;
}

function hasReport(facts, worker) {
  return (facts.reports || []).includes(`report-${worker}.md`);
}

// Commit (gate and auto, nothing committed yet) or Finish.
function closing(state) {
  const commits = Array.isArray(state.commits) ? state.commits : [];
  if (commits.length === 0 && (state.mode === 'gate' || state.mode === 'auto')) {
    return step('Commit', `the Commit section (run commit ${state.id})`);
  }
  return step('Finish', `run stage ${state.id} done, then the Finish section`);
}

// The first selected stage after `current` that is neither done nor skipped.
function advance(state, current) {
  const selected = selectedOf(state);
  const later = runState.PIPELINE.slice(runState.PIPELINE.indexOf(current) + 1);
  const name = later.find((s) => selected.includes(s) && !['done', 'skipped'].includes(stageStatus(state, s)));
  if (!name) return closing(state);
  return step(SECTIONS[name], `run stage ${state.id} ${name}, then the ${SECTIONS[name]} section`);
}

// One worker's stage: null when the worker is done (the caller advances),
// else its Check step (report present) or a relaunch.
function singleWorker(state, facts, section, worker) {
  if (workerStatus(state, worker) === 'done') return null;
  if (hasReport(facts, worker)) return step(section, `Worker loop step 4 (Check) for ${worker}`);
  return step(section, `Worker loop for ${worker} (write a new brief and launch it again)`);
}

function exploreStep(state, facts) {
  const pending = singleWorker(state, facts, 'Explore', 'explorer');
  if (pending) return pending;
  if (!state.type) {
    const { id } = state;
    return step('Classify', `rate the task from report-explorer.md, run classify ${id} <level>, then stages ${id} --type <type>`);
  }
  return advance(state, 'explore');
}

function planStep(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  if (tasks.length === 0) return step('Plan', `write plan.md, then plan check ${state.id}`);
  if (state.mode === 'gate' || state.mode === 'step') {
    return step('Approve', 'ask for approval again; approval is not kept on disk');
  }
  return advance(state, 'plan');
}

// Recorded plan tasks with a well-formed id and owned file list.
function validTasks(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks.filter((t) => t && TASK_ID.test(t.id) && Array.isArray(t.owns));
}

// The first batch of `stage` (implement or docs) with an unfinished worker.
function batchStep(state, facts, stage) {
  const { worker, prefix } = BATCH_KINDS[stage];
  const batches = computeBatches(validTasks(state).filter((t) => t.worker === worker))[stage];
  for (const batch of batches) {
    const open = batch.map((id) => `${prefix}${id}`).filter((w) => workerStatus(state, w) !== 'done');
    if (open.length === 0) continue;
    const loop = open.every((w) => hasReport(facts, w)) ? 'Worker loop step 4 (Check)' : 'Worker loop';
    return step(SECTIONS[stage], `${loop} with W = ${open.join(' ')} and G = --tasks ${batch.join(',')}`);
  }
  return advance(state, stage);
}

function reviewStep(state, facts) {
  const review = state.review && typeof state.review === 'object' ? state.review : null;
  const reviewersDone = ['reviewer', 'reviewer-2'].every((w) => workerStatus(state, w) === 'done');
  const noFixes = review && Array.isArray(review.fixTasks) && review.fixTasks.length === 0;
  if (noFixes && reviewersDone) return advance(state, 'review');
  if (hasReport(facts, 'reviewer') && hasReport(facts, 'reviewer-2')) {
    return step('Review', `guide review step 3 (review merge ${state.id})`);
  }
  return step('Review', 'guide review from step 1');
}

function pipelineStep(state, facts) {
  const { stage } = state;
  if (stage === 'explore') return exploreStep(state, facts);
  if (stage === 'plan') return planStep(state);
  if (stage === 'implement' || stage === 'docs') return batchStep(state, facts, stage);
  if (stage === 'review') return reviewStep(state, facts);
  return singleWorker(state, facts, SECTIONS[stage], SINGLE_WORKER[stage]) || advance(state, stage);
}

// A running Codex job of the run must be waited for before anything else.
function withJobs(next, facts) {
  const jobs = facts.runningJobs || [];
  if (!next.section || jobs.length === 0) return next;
  const helper = facts.helper || HELPER;
  return step(next.section, `first run node ${helper} codex wait ${jobs.join(' ')}, then ${next.line}`);
}

// { section, line }; section is null when there is nothing to resume.
// `facts` is { reports, runningJobs, helper } from runFacts.
function nextStep(state, facts = {}) {
  const { id, stage } = state;
  if (TERMINAL.includes(stage)) return step(null, `run finished (stage=${stage}); nothing to resume`);
  if (stage === 'created') return step('Explore', `run stage ${id} explore, then the Worker loop with W = explorer`);
  if (!Object.prototype.hasOwnProperty.call(SECTIONS, stage)) {
    return step(null, `unknown stage; run status to check run ${id}`);
  }
  return withJobs(pipelineStep(state, facts), facts);
}

// The `next:` line printed by `run resume` and injected by the hooks.
function formatNext(next) {
  return next.section ? `next: ${next.section} - ${next.line}` : next.line;
}

// A state field shown as a plain lowercase word, or `unknown`.
function safeWord(value) {
  return typeof value === 'string' && WORD.test(value) ? value : 'unknown';
}

function workerNames(state, statuses) {
  const list = Array.isArray(state.workers) ? state.workers : [];
  const names = list
    .filter((w) => w && statuses.includes(w.status) && runState.WORKER_NAME.test(String(w.name)))
    .map((w) => w.name);
  return names.length > 0 ? names.join(',') : 'none';
}

// The lines `run resume` prints: run line, worker states, next step and,
// when there is something to resume, how to load the procedure.
function resumeLines(state, facts, dir) {
  const next = nextStep(state, facts);
  const type = state.type ? safeWord(state.type) : 'none';
  const lines = [
    `run=${state.id} mode=${safeWord(state.mode)} stage=${safeWord(state.stage)} type=${type} dir=${dir}`,
    `workers: done=${workerNames(state, ['done'])} running=${workerNames(state, ['running'])} `
      + `failed=${workerNames(state, ['failed', 'report-invalid'])}`,
    formatNext(next),
  ];
  if (next.section) {
    const helper = facts.helper || HELPER;
    lines.push(`procedure: run node ${helper} procedure once; skip Start (keep id, mode and dir above) and continue at ## ${next.section}`);
  }
  return lines;
}

function runFiles(root, id) {
  try {
    return fs.readdirSync(runState.runDir(root, id));
  } catch {
    return [];
  }
}

// Ids of this run's Codex jobs whose record says running. The job module is
// loaded only here, when a next step is actually computed.
function runningJobIds(root, id) {
  const jobs = require('./jobs.cjs');
  return jobs.listJobs(root).filter((r) => r.runId === id && r.status === 'running').map((r) => r.id);
}

// Disk facts nextStep needs: report file names, running Codex jobs, helper path.
function runFacts(root, state) {
  const reports = runFiles(root, state.id).filter((n) => /^report-[a-z0-9-]+\.md$/i.test(n)).sort();
  return { reports, runningJobs: runningJobIds(root, state.id), helper: HELPER };
}

module.exports = { SECTIONS, nextStep, formatNext, runFacts, resumeLines, safeWord };
