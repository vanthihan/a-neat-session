'use strict';

// Parses the run's plan.md, validates file ownership and computes batches.
// Plan format (free text before the first task heading is ignored):
//   ## T1: {title}          implementer task (T1, T2, ...)
//   ## D1: {title}          docs task (D1, D2, ...)
//   worker: implementer|docs
//   owns: path/a.js, path/b.js
//   do: {instructions, continuing until the next "## " line}

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { selectedOf } = require('./stages.cjs');

const TASK_HEADING = /^## ([TD]\d+): (.+)$/;
const KEY_LINE = /^\s*(worker|owns|do):\s?(.*)$/;
const WORKER_FOR_PREFIX = Object.freeze({ T: 'implementer', D: 'docs' });
// `.claude` holds the pre-authorized helper and the permission settings; `.git`
// and `.neat` are refused at any depth (nested repositories, run state).
const RESERVED_TOP = Object.freeze(['.claude']);
const RESERVED_ANYWHERE = Object.freeze(['.neat', '.git']);
const MAX_ERROR_LINES = 10;
// Stages a run has when `neat stages` was never called (also runs created
// before stage selection existed).
const DEFAULT_SELECTED = Object.freeze(['explore', 'plan', 'implement', 'review', 'test', 'docs']);
// Task kind -> the stage that runs it and the error when none is planned.
const KINDS = Object.freeze([
  Object.freeze({ worker: 'implementer', stage: 'implement', missing: 'plan needs at least one implementer task (## T1: ...)' }),
  Object.freeze({ worker: 'docs', stage: 'docs', missing: 'plan needs at least one docs task (## D1: ...)' }),
]);

function newTask(id, title) {
  return { id, title: title.trim(), worker: null, ownsRaw: null, doLines: null, dupKeys: [] };
}

function applyKey(task, key, value) {
  if (key === 'do') {
    task.doLines = [value];
    return;
  }
  const field = key === 'owns' ? 'ownsRaw' : 'worker';
  if (task[field] !== null) task.dupKeys.push(key);
  task[field] = value.trim();
}

// Splits the plan into raw task records (no validation).
function scanTasks(text) {
  const tasks = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = line.trimEnd().match(TASK_HEADING);
    if (heading) {
      current = newTask(heading[1], heading[2]);
      tasks.push(current);
    } else if (line.startsWith('## ')) {
      current = null;
    } else if (current && current.doLines !== null) {
      current.doLines.push(line);
    } else if (current) {
      const key = line.match(KEY_LINE);
      if (key) applyKey(current, key[1], key[2]);
    }
  }
  return tasks;
}

// True for a normalised repo-relative path under a reserved directory. The
// guard uses the same rule, so no stage can leave files there unreported.
function isReservedPath(norm) {
  const segs = String(norm).toLowerCase().split('/');
  return RESERVED_TOP.includes(segs[0]) || segs.some((s) => RESERVED_ANYWHERE.includes(s));
}

// Returns { path } (normalised) or { error } for one owned path.
function checkPath(raw) {
  if (raw.includes('\\')) return { error: `path must use forward slashes: ${raw}` };
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return { error: `path must be relative: ${raw}` };
  if (raw.endsWith('/')) return { error: `path must name a file: ${raw}` };
  const norm = path.posix.normalize(raw);
  if (norm === '..' || norm.startsWith('../')) return { error: `path escapes repo: ${raw}` };
  if (norm === '.' || norm === '') return { error: `path must name a file: ${raw}` };
  if (isReservedPath(norm)) return { error: `path not allowed: ${raw}` };
  return { path: norm };
}

function validateTask(raw) {
  const errors = [];
  const expected = WORKER_FOR_PREFIX[raw.id[0]];
  if (raw.worker !== expected) errors.push(`${raw.id}: worker must be ${expected}`);
  raw.dupKeys.forEach((k) => errors.push(`${raw.id}: duplicate ${k}:`));
  const entries = (raw.ownsRaw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) errors.push(`${raw.id}: missing owns:`);
  const owns = [];
  for (const entry of entries) {
    const res = checkPath(entry);
    if (res.error) errors.push(`${raw.id}: ${res.error}`);
    else if (!owns.includes(res.path)) owns.push(res.path);
  }
  const doText = (raw.doLines || []).join('\n').trim();
  if (doText === '') errors.push(`${raw.id}: missing do:`);
  const task = { id: raw.id, worker: expected, title: raw.title, owns, do: doText };
  return { task, errors };
}

// Task kinds must match the selected stages: a kind is required when its
// stage is selected and rejected when it is not.
function stageErrors(tasks, selected) {
  const errors = [];
  for (const kind of KINDS) {
    const ofKind = tasks.filter((t) => t.worker === kind.worker);
    if (!selected.includes(kind.stage)) {
      ofKind.forEach((t) => errors.push(`${t.id}: ${kind.stage} stage not selected`));
    } else if (ofKind.length === 0) {
      errors.push(kind.missing);
    }
  }
  return errors;
}

function parsePlan(text, selected = DEFAULT_SELECTED) {
  const tasks = [];
  const errors = [];
  const seen = new Set();
  for (const raw of scanTasks(text)) {
    if (seen.has(raw.id)) {
      errors.push(`duplicate task id ${raw.id}`);
      continue;
    }
    seen.add(raw.id);
    const res = validateTask(raw);
    tasks.push(res.task);
    errors.push(...res.errors);
  }
  errors.push(...stageErrors(tasks, selected));
  return { tasks, errors };
}

// Batch of each task: 1 + highest batch of an earlier same-type task sharing a file, else 0.
function batchNumbers(tasks) {
  const numbers = new Map();
  tasks.forEach((t, i) => {
    let batch = 0;
    for (const earlier of tasks.slice(0, i)) {
      if (earlier.worker !== t.worker) continue;
      if (earlier.owns.some((f) => t.owns.includes(f))) batch = Math.max(batch, numbers.get(earlier.id) + 1);
    }
    numbers.set(t.id, batch);
  });
  return numbers;
}

function groupBatches(tasks, numbers, worker) {
  const groups = [];
  for (const t of tasks.filter((x) => x.worker === worker)) {
    const n = numbers.get(t.id);
    while (groups.length <= n) groups.push([]);
    groups[n].push(t.id);
  }
  return groups.filter((g) => g.length > 0);
}

function computeBatches(tasks) {
  const numbers = batchNumbers(tasks);
  return {
    implement: groupBatches(tasks, numbers, 'implementer'),
    docs: groupBatches(tasks, numbers, 'docs'),
  };
}

function formatBatches(groups) {
  if (groups.length === 0) return 'none';
  return groups.map((g) => `[${g.join(',')}]`).join(' ');
}

// Validates plan.md of run `id`; on success records tasks (with batch) in state.json.
function checkPlan(root, id, now) {
  const state = runState.loadRun(root, id);
  const file = path.join(runState.runDir(root, id), 'plan.md');
  if (!fs.existsSync(file)) return { ok: false, lines: ['plan.md not found'] };
  const selected = selectedOf(state);
  const { tasks, errors } = parsePlan(fs.readFileSync(file, 'utf8'), selected);
  if (errors.length > 0) return { ok: false, lines: errors.slice(0, MAX_ERROR_LINES) };
  const numbers = batchNumbers(tasks);
  const recorded = tasks.map((t) => ({ ...t, owns: [...t.owns], batch: numbers.get(t.id) }));
  runState.saveRun(root, { ...state, tasks: recorded }, now);
  const batches = computeBatches(tasks);
  const line = [
    `plan ok tasks=${tasks.length}`,
    `stages=${selected.join(',')}`,
    `implement=${formatBatches(batches.implement)}`,
    `docs=${formatBatches(batches.docs)}`,
  ].join(' ');
  return { ok: true, lines: [line] };
}

module.exports = { parsePlan, computeBatches, checkPlan, isReservedPath, MAX_ERROR_LINES };
