'use strict';

// The next orchestrator step of a run, decided from its state and a few disk
// facts. nextStep is pure: every disk fact comes in through `facts`
// (runFacts). Next lines hold only fixed text, ids, stage, section and worker
// names, never report, brief or plan text. `run resume` adds the task text
// and each report's status word, so a session that starts over after /clear
// has what the next section needs; report text comes only from
// `report show`.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { selectedOf } = require('./stages.cjs');
const { computeBatches, planBatchesLine } = require('./plan-check.cjs');
const { reportStatus } = require('./report-check.cjs');

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
const MAX_TASK_TEXT = 2000;
const MAX_REPORT_READ = 64 * 1024;
// ANSI escape sequences and control characters, removed from the task text.
const UNSAFE_TEXT = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

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
  return step('Finish', `run stage ${state.id} done, then the Finish section (report show ${state.id} <worker> for each report you have not seen)`);
}

// The first selected stage after `current` that is neither done nor skipped.
function advance(state, current) {
  const selected = selectedOf(state);
  const later = runState.PIPELINE.slice(runState.PIPELINE.indexOf(current) + 1);
  const name = later.find((s) => selected.includes(s) && !['done', 'skipped'].includes(stageStatus(state, s)));
  if (!name) return closing(state);
  return step(SECTIONS[name], `run stage ${state.id} ${name}, then the ${SECTIONS[name]} section`);
}

// True when `run guard` passed for `stage` (and the batch `taskIds`).
function guarded(state, stage, taskIds = []) {
  const list = Array.isArray(state.guarded) ? state.guarded : [];
  return list.includes(runState.guardKey(stage, taskIds));
}

// Step mode asks after every stage (Worker loop step 6). The answer is not
// kept on disk, so a resumed step-mode run asks again before `then`.
function askContinue(state, stage, then, onContinue = '') {
  if (state.mode !== 'step') return then;
  return step(then.section, `Worker loop step 6 (ask: Stage ${stage} finished. Continue?); on Continue ${onContinue}${then.line}`);
}

// One worker's stage: null when the worker is done and its Guard step passed
// (the caller advances), else its Guard step, its Check step (report
// present) or a relaunch.
function singleWorker(state, facts, section, worker, stage) {
  if (workerStatus(state, worker) === 'done') {
    return guarded(state, stage) ? null : step(section, `Worker loop step 5 (Guard) for ${worker}, with no G`);
  }
  if (hasReport(facts, worker)) return step(section, `Worker loop step 4 (Check) for ${worker}`);
  return step(section, `Worker loop for ${worker} (write a new brief and launch it again)`);
}

function exploreStep(state, facts) {
  // A recorded type means Classify ran, so Guard and the step question did too.
  if (state.type && workerStatus(state, 'explorer') === 'done') return advance(state, 'explore');
  const pending = singleWorker(state, facts, 'Explore', 'explorer', 'explore');
  if (pending) return pending;
  if (!state.type) {
    const { id } = state;
    const classify = step('Classify', `run report show ${id} explorer, rate the task from it, run classify ${id} <level>, then stages ${id} --type <type>`);
    return askContinue(state, 'explore', classify);
  }
  return advance(state, 'explore');
}

function planStep(state) {
  const { id } = state;
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  if (tasks.length === 0) {
    const shows = [`report show ${id} explorer`];
    if (workerStatus(state, 'researcher') === 'done') shows.push(`report show ${id} researcher`);
    return step('Plan', `run ${shows.join(' and ')}, write plan.md from the task text and those reports, then plan check ${id}`);
  }
  if (state.mode === 'gate' || state.mode === 'step') {
    return step('Approve', `run plan show ${id} and ask for approval again with its lines; approval is not kept on disk`);
  }
  return advance(state, 'plan');
}

// Recorded plan tasks with a well-formed id and owned file list.
function validTasks(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks.filter((t) => t && TASK_ID.test(t.id) && Array.isArray(t.owns));
}

function committedIn(state, stage) {
  return (Array.isArray(state.commits) ? state.commits : []).some((c) => c && c.stage === stage);
}

// The first batch of `stage` (implement or docs) with an unfinished worker or
// whose Guard step has not passed. After the last batch, step mode asks to
// continue and commits the stage unless that commit is already recorded.
function batchStep(state, facts, stage) {
  const { worker, prefix } = BATCH_KINDS[stage];
  const batches = computeBatches(validTasks(state).filter((t) => t.worker === worker))[stage];
  for (const batch of batches) {
    const open = batch.map((id) => `${prefix}${id}`).filter((w) => workerStatus(state, w) !== 'done');
    if (open.length === 0) {
      if (guarded(state, stage, batch)) continue;
      return step(SECTIONS[stage], `Worker loop step 5 (Guard) with G = --tasks ${batch.join(',')}`);
    }
    const loop = open.every((w) => hasReport(facts, w)) ? 'Worker loop step 4 (Check)' : 'Worker loop';
    return step(SECTIONS[stage], `${loop} with W = ${open.join(' ')} and G = --tasks ${batch.join(',')}`);
  }
  const then = advance(state, stage);
  return committedIn(state, stage) ? then : askContinue(state, stage, then, `run commit ${state.id}, then `);
}

function reviewStep(state, facts) {
  const review = state.review && typeof state.review === 'object' ? state.review : null;
  const reviewersDone = ['reviewer', 'reviewer-2'].every((w) => workerStatus(state, w) === 'done');
  const noFixes = review && Array.isArray(review.fixTasks) && review.fixTasks.length === 0;
  const merge = step('Review', `guide review step 3 (review merge ${state.id})`);
  if (noFixes && reviewersDone) {
    // A critical finding no task owns needs the user's decision (or stops an
    // auto run); that decision is not kept on disk, so merge again to get it.
    return Number(review.unownedCritical) > 0 ? merge : advance(state, 'review');
  }
  if (hasReport(facts, 'reviewer') && hasReport(facts, 'reviewer-2')) return merge;
  return step('Review', 'guide review from step 1');
}

function pipelineStep(state, facts) {
  const { stage } = state;
  if (stage === 'explore') return exploreStep(state, facts);
  if (stage === 'plan') return planStep(state);
  if (stage === 'implement' || stage === 'docs') return batchStep(state, facts, stage);
  if (stage === 'review') return reviewStep(state, facts);
  return singleWorker(state, facts, SECTIONS[stage], SINGLE_WORKER[stage], stage)
    || askContinue(state, stage, advance(state, stage));
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

// The run's task text on one line: escape sequences and control characters
// removed, lines joined with ' / ', at most MAX_TASK_TEXT characters.
function taskText(task) {
  const lines = String(task || '').replace(UNSAFE_TEXT, '').split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const text = lines.join(' / ');
  return text.length > MAX_TASK_TEXT ? `${text.slice(0, MAX_TASK_TEXT)} [cut; full text in state.json]` : text;
}

// `explorer=done tester=failed`: each report's status word, or `none`.
function reportsLine(facts) {
  const statuses = facts.statuses || {};
  const pairs = Object.keys(statuses).sort()
    .filter((w) => runState.WORKER_NAME.test(w))
    .map((w) => `${w}=${safeWord(statuses[w]) === 'unknown' ? 'invalid' : statuses[w]}`);
  return pairs.length > 0 ? pairs.join(' ') : 'none';
}

// The lines `run resume` prints (at most 7): run line, task text, worker
// states, report statuses, the plan batches once a plan is checked, the next
// step and, when there is something to resume, how to load the procedure.
function resumeLines(state, facts, dir) {
  const next = nextStep(state, facts);
  const type = state.type ? safeWord(state.type) : 'none';
  const batches = planBatchesLine(state);
  const lines = [
    `run=${state.id} mode=${safeWord(state.mode)} stage=${safeWord(state.stage)} type=${type} dir=${dir}`,
    `task: ${taskText(state.task) || '(empty)'}`,
    `workers: done=${workerNames(state, ['done'])} running=${workerNames(state, ['running'])} `
      + `failed=${workerNames(state, ['failed', 'report-invalid'])}`,
    `reports: ${reportsLine(facts)}`,
    ...(batches ? [`plan: ${batches}`] : []),
    formatNext(next),
  ];
  if (next.section) {
    const helper = facts.helper || HELPER;
    lines.push(`procedure: run node ${helper} procedure once; skip Start (keep id, mode, dir and task above) and continue at ## ${next.section}; `
      + `for a report you have not seen run node ${helper} report show ${state.id} <worker>`);
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

// The status word of a report file (read up to MAX_REPORT_READ bytes), or
// null when it is not a regular file or has no valid status.
function fileStatus(file) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_REPORT_READ);
    return reportStatus(buf.subarray(0, fs.readSync(fd, buf, 0, MAX_REPORT_READ, 0)).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Disk facts nextStep needs: report file names, each report's status word
// (by worker), running Codex jobs, helper path.
function runFacts(root, state) {
  const reports = runFiles(root, state.id).filter((n) => /^report-[a-z0-9-]+\.md$/i.test(n)).sort();
  const dir = runState.runDir(root, state.id);
  const statuses = {};
  for (const name of reports) {
    const worker = name.slice('report-'.length, -'.md'.length);
    if (runState.WORKER_NAME.test(worker)) statuses[worker] = fileStatus(path.join(dir, name)) || 'invalid';
  }
  return { reports, statuses, runningJobs: runningJobIds(root, state.id), helper: HELPER };
}

module.exports = { SECTIONS, nextStep, formatNext, runFacts, resumeLines, safeWord, taskText };
