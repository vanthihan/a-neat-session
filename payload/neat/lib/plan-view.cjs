'use strict';

// Readable plain-text view of a checked plan for the approval step
// (`neat plan view`): goal, approach and key points from the plan's
// `## Overview`, the stages, each task with its files and reason, and the
// order tasks run in. Columns are aligned with spaces; `--color` adds ANSI
// highlights over the same text. Plan text is untrusted: every value is
// cleaned of control codes and capped.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { selectedOf } = require('./stages.cjs');
const { recordedTasks, computeBatches, showText } = require('./plan-check.cjs');

const MAX_VIEW_LINES = 45;
const MAX_KEYS = 5;
const MAX_TASKS = 10;
const MAX_TEXT = 88;
const MAX_TITLE = 40;
const OVERVIEW_HEADING = /^##\s+overview\s*$/i;
const OVERVIEW_KEY = /^\s*(goal|approach|key):\s?(.*)$/i;
const KEY_TAG = /^(risk|decision|assumption|note):\s*(.+)$/i;
const KEY_MARK = Object.freeze({ Risk: '!', Decision: '*', Assumption: '?', Note: '-' });
const LABEL_WIDTH = 10;

// ANSI styles; `paint` is the identity when color is off.
const STYLE = Object.freeze({
  title: '1;36', label: '1', id: '1;33', risk: '1;31', decision: '1;32', assumption: '1;35',
  note: '2', dim: '2', worker: '36',
});

function painter(color) {
  return color ? (style, text) => `\u001b[${STYLE[style]}m${text}\u001b[0m` : (_style, text) => text;
}

function clean(value, max) {
  const text = showText(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

function keyLine(raw, paint) {
  const tagged = String(raw).match(KEY_TAG);
  const label = tagged ? tagged[1][0].toUpperCase() + tagged[1].slice(1).toLowerCase() : 'Note';
  const head = `${KEY_MARK[label]} ${label.padEnd(LABEL_WIDTH)}`;
  return `  ${paint(label.toLowerCase(), head)}  ${clean(tagged ? tagged[2] : raw, MAX_TEXT)}`;
}

function overviewLines(overview, paint) {
  if (!overview.found) return [paint('dim', '(no overview in plan.md)')];
  const lines = [];
  if (overview.goal) lines.push(`${paint('label', 'Goal')}      ${clean(overview.goal, MAX_TEXT)}`);
  if (overview.approach) lines.push(`${paint('label', 'Approach')}  ${clean(overview.approach, MAX_TEXT)}`);
  if (overview.keys.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(paint('label', 'Key points'), ...overview.keys.slice(0, MAX_KEYS).map((k) => keyLine(k, paint)));
    const extra = overview.keys.length - MAX_KEYS;
    if (extra > 0) lines.push(`  ${paint('dim', `… ${extra} more key points in plan.md`)}`);
  }
  return lines;
}

function stagesLines(state, paint) {
  const selected = selectedOf(state);
  const skipped = runState.PIPELINE.filter((name) => !selected.includes(name));
  const lines = [`${paint('label', 'Stages')}   ${selected.join(' > ')}`];
  if (skipped.length > 0) lines.push(`         ${paint('dim', `(skipped: ${skipped.join(', ')})`)}`);
  return lines;
}

function taskLines(tasks, paint) {
  const shown = tasks.slice(0, MAX_TASKS);
  const titles = shown.map((t) => clean(t.title, MAX_TITLE));
  const width = Math.max(...titles.map((t) => t.length));
  const lines = [paint('label', 'Tasks')];
  shown.forEach((t, i) => {
    lines.push(`  ${paint('id', t.id)}  ${titles[i].padEnd(width)}  ${paint('worker', t.worker)}`);
    lines.push(`      ${paint('dim', 'files')}  ${clean(t.owns.join(', '), MAX_TEXT)}`);
    if (t.why) lines.push(`      ${paint('dim', 'why')}    ${clean(t.why, MAX_TEXT)}`);
  });
  if (tasks.length > MAX_TASKS) lines.push(`  ${paint('dim', `… ${tasks.length - MAX_TASKS} more tasks in plan.md`)}`);
  return lines;
}

// Implement batches first, then docs batches; tasks in one batch run together.
function orderLines(tasks, paint) {
  const batches = computeBatches(tasks);
  const steps = [...batches.implement, ...batches.docs]
    .map((group) => (group.length > 1 ? `${group.join(' + ')} in parallel` : group[0]));
  const files = new Set(tasks.flatMap((t) => t.owns));
  return [
    `${paint('label', 'Run order')}  ${steps.join(', then ')}`,
    `           ${paint('dim', `${tasks.length} tasks, ${files.size} files`)}`,
  ];
}

function viewPlan(root, id, { color = false } = {}) {
  const state = runState.loadRun(root, id);
  const tasks = recordedTasks(state);
  if (tasks.length === 0) return { ok: false, lines: [`no checked plan in run ${id}; run plan check ${id}`] };
  const paint = painter(color);
  const file = path.join(runState.runDir(root, id), 'plan.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const title = clean(String(state.task || '').split('\n')[0], MAX_TEXT) || id;
  const lines = [
    paint('title', `Plan: ${title}`),
    '',
    ...overviewLines(readOverview(text), paint),
    '',
    ...stagesLines(state, paint),
    '',
    ...taskLines(tasks, paint),
    '',
    ...orderLines(tasks, paint),
  ];
  return { ok: true, lines: lines.slice(0, MAX_VIEW_LINES) };
}

module.exports = { viewPlan, readOverview, MAX_VIEW_LINES };
