'use strict';

// Readable view of a checked plan for the approval step (`neat plan view`):
// goal, approach and key points from the plan's `## Overview`, the stages,
// one table row per task with its reason, and the order tasks run in.
// Plan text is untrusted: every value is cleaned, capped and table-escaped.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { selectedOf } = require('./stages.cjs');
const { recordedTasks, computeBatches, showText } = require('./plan-check.cjs');

const MAX_VIEW_LINES = 40;
const MAX_KEYS = 5;
const MAX_ROWS = 15;
const MAX_TEXT = 300;
const MAX_TITLE = 80;
const MAX_CELL = 120;
const OVERVIEW_HEADING = /^##\s+overview\s*$/i;
const OVERVIEW_KEY = /^\s*(goal|approach|key):\s?(.*)$/i;
const KEY_TAG = /^(risk|decision|assumption|note):\s*(.+)$/i;

function clean(value, max) {
  const text = showText(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cell(value, max = MAX_CELL) {
  return clean(value, max).replace(/\|/g, '\\|') || '-';
}

// `## Overview` fields: the first goal and approach, every key line in order.
function readOverview(text) {
  const overview = { goal: '', approach: '', keys: [], found: false };
  let inside = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      inside = OVERVIEW_HEADING.test(line.trim());
      overview.found = overview.found || inside;
      continue;
    }
    const match = inside && line.match(OVERVIEW_KEY);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === 'key') overview.keys.push(match[2]);
    else if (!overview[key]) overview[key] = match[2];
  }
  return overview;
}

function keyLine(raw) {
  const tagged = String(raw).match(KEY_TAG);
  const label = tagged ? tagged[1][0].toUpperCase() + tagged[1].slice(1).toLowerCase() : 'Note';
  return `- **${label}:** ${clean(tagged ? tagged[2] : raw, MAX_TEXT)}`;
}

function overviewLines(overview) {
  if (!overview.found) return ['_No overview in plan.md._'];
  const lines = [];
  if (overview.goal) lines.push(`**Goal:** ${clean(overview.goal, MAX_TEXT)}`);
  if (overview.approach) {
    if (lines.length > 0) lines.push('');
    lines.push(`**Approach:** ${clean(overview.approach, MAX_TEXT)}`);
  }
  if (overview.keys.length > 0) {
    lines.push('', '**Key points**', ...overview.keys.slice(0, MAX_KEYS).map(keyLine));
    const extra = overview.keys.length - MAX_KEYS;
    if (extra > 0) lines.push(`- … ${extra} more key points in plan.md`);
  }
  return lines;
}

function stagesLine(state) {
  const selected = selectedOf(state);
  const skipped = runState.PIPELINE.filter((name) => !selected.includes(name));
  const tail = skipped.length > 0 ? ` (skipped: ${skipped.join(', ')})` : '';
  return `**Stages:** ${selected.join(' → ')}${tail}`;
}

function taskLines(tasks) {
  const rows = tasks.slice(0, MAX_ROWS).map((t) =>
    `| ${t.id} | ${cell(t.title, MAX_TITLE)} | ${t.worker} | ${cell(t.owns.join(', '))} | ${cell(t.why)} |`);
  const lines = ['**Tasks**', '| Task | Title | Worker | Files | Why |', '| --- | --- | --- | --- | --- |', ...rows];
  if (tasks.length > MAX_ROWS) lines.push(`… ${tasks.length - MAX_ROWS} more tasks in plan.md`);
  return lines;
}

// Implement batches first, then docs batches; tasks in one batch run together.
function orderLine(tasks) {
  const batches = computeBatches(tasks);
  const steps = [...batches.implement, ...batches.docs]
    .map((group) => (group.length > 1 ? `${group.join(' + ')} in parallel` : group[0]));
  return `**Run order:** ${steps.join(', then ')}`;
}

function viewPlan(root, id) {
  const state = runState.loadRun(root, id);
  const tasks = recordedTasks(state);
  if (tasks.length === 0) return { ok: false, lines: [`no checked plan in run ${id}; run plan check ${id}`] };
  const file = path.join(runState.runDir(root, id), 'plan.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const files = new Set(tasks.flatMap((t) => t.owns));
  const title = clean(String(state.task || '').split('\n')[0], MAX_TITLE) || id;
  const lines = [
    `### Plan: ${title}`,
    '',
    ...overviewLines(readOverview(text)),
    '',
    stagesLine(state),
    '',
    ...taskLines(tasks),
    '',
    orderLine(tasks),
    `${tasks.length} tasks, ${files.size} files.`,
  ];
  return { ok: true, lines: lines.slice(0, MAX_VIEW_LINES) };
}

module.exports = { viewPlan, readOverview, MAX_VIEW_LINES };
