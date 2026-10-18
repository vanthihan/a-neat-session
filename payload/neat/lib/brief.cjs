'use strict';

// Generates the per-worker brief file. The orchestrator passes only the
// brief's absolute path to the worker (`Brief: <path>`).

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { REPORT_HEADINGS, MAX_REPORT_WORDS, REPORT_STATUSES } = require('./report-check.cjs');
const { UsageError } = require('./cli-args.cjs');

const READ_ONLY_ROLES = Object.freeze(['explorer', 'reviewer', 'tester']);
const PLAN_WORKER = /^(implementer-T|docs-D)(\d+)$/;

function roleOf(worker) {
  if (worker.startsWith('implementer-')) return 'implementer';
  if (worker.startsWith('docs-')) return 'docs';
  return worker;
}

function planTask(state, worker) {
  const m = worker.match(PLAN_WORKER);
  if (!m) return null;
  const id = `${m[1].slice(-1)}${m[2]}`;
  const found = (state.tasks || []).find((t) => t.id === id);
  if (!found) throw new Error(`unknown task ${id} (run plan check first)`);
  return found;
}

function oneLine(text) {
  return String(text).trim().replace(/\s*\n\s*/g, ' ');
}

function headerLines(state, worker, ctx) {
  const role = roleOf(worker);
  const file = (name) => path.join(ctx.runDir, name);
  const lines = [
    `Task: ${oneLine(state.task)}`,
    `Run id: ${state.id}`,
    `Run dir: ${ctx.runDir}`,
    `Helper: node ${ctx.helperPath}`,
    `Report: ${file(`report-${worker}.md`)}`,
  ];
  if (role === 'explorer') lines.push(`Map: ${file('explore-map.md')}`);
  if ((role === 'reviewer' || role === 'docs') && ctx.exists(file('diff.patch'))) {
    lines.push(`Diff: ${file('diff.patch')}`);
  }
  if (role === 'reviewer') lines.push(`Review file: ${file('review.md')}`);
  if (role === 'tester') lines.push(`Test log: ${file('test-log.txt')}`);
  return lines;
}

function assignmentLines(role, task) {
  if (task) return [`${task.id}: ${task.title}`, task.do];
  if (role === 'explorer') {
    return ['Map the code, tests, config and docs relevant to the task. Write one `path:line - note` entry per line into the Map file, at most 150 lines.'];
  }
  if (role === 'reviewer') {
    return ['Review the diff for correctness, security, error handling and adherence to the plan. Write full findings as `path:line - note` into the Review file; the report lists only the most important ones.'];
  }
  return ['Run the project\'s tests with all output redirected to the Test log. Report failures only, as `path:line - note`.'];
}

function ownedLines(role, task) {
  if (READ_ONLY_ROLES.includes(role)) return ['- none (read-only role)'];
  return task.owns.map((f) => `- ${f}`);
}

function contextLines(ctx) {
  const files = ['plan.md', 'report-explorer.md']
    .map((name) => path.join(ctx.runDir, name))
    .filter((p) => ctx.exists(p));
  return files.length > 0 ? files.map((p) => `- ${p}`) : ['- none'];
}

function saveLines(role, state, worker, ctx) {
  if (role === 'docs') {
    return ['- Save the report with the Write tool at the Report path. Search with the Grep and Glob tools.'];
  }
  return [
    '- Save the report through the helper with a quoted heredoc, and fix it until the helper prints `report ok`:',
    '',
    '```',
    `node ${ctx.helperPath} write ${state.id} report-${worker}.md --stdin <<'NEAT_EOF'`,
    '{report}',
    'NEAT_EOF',
    '```',
    '',
    '- Search with `grep -rn` and `find` through Bash; the Grep and Glob tools may be absent.',
  ];
}

function ruleLines(role, state, worker, ctx) {
  const editRule = READ_ONLY_ROLES.includes(role)
    ? '- Do not edit, create or delete project files. Use Bash for read-only commands and the helper only.'
    : '- Edit only the files under Files you own; create them if missing. List changes needed elsewhere under `## Open questions`.';
  return [
    '- Never commit, and never run git commands that change state (commit, add, reset, checkout, stash, merge, rebase, push).',
    editRule,
    '- Write extra output only inside the Run dir.',
    `- Report with exactly these headings, in order, each once: ${REPORT_HEADINGS.map((h) => `\`${h}\``).join(', ')}.`,
    `- At most ${MAX_REPORT_WORDS} words in the whole report. First line under \`## Status\`: ${REPORT_STATUSES.join('|')}. Findings as \`path:line - note\`. Artifacts: files you wrote in the Run dir, or \`none\`.`,
    ...saveLines(role, state, worker, ctx),
    '- Deliver the report exactly once: through the SubagentHandback tool if you have it, otherwise as your final message. The delivered text must equal the report file.',
  ];
}

// Pure: returns the brief text for `worker`.
function buildBrief(state, worker, ctx) {
  const role = roleOf(worker);
  const task = planTask(state, worker);
  const context = { ...ctx, exists: ctx.exists || fs.existsSync };
  const lines = [
    `# Brief: ${worker}`,
    '',
    ...headerLines(state, worker, context),
    '',
    '## Assignment',
    ...assignmentLines(role, task),
    '',
    '## Files you own',
    ...ownedLines(role, task),
    '',
    '## Context files',
    ...contextLines(context),
    '',
    '## Rules',
    ...ruleLines(role, state, worker, context),
  ];
  const notes = String(context.notes || '').trim();
  if (notes) lines.push('', '## Orchestrator notes', notes);
  return `${lines.join('\n')}\n`;
}

function helperPath() {
  return path.resolve(__dirname, '..', 'bin', 'neat.cjs');
}

// Writes brief-{worker}.md, marks the worker running and returns the absolute path.
function writeBrief(root, id, worker, notes, now) {
  if (typeof worker !== 'string' || !runState.WORKER_NAME.test(worker)) {
    throw new UsageError(`invalid worker name '${worker}' (use explorer|reviewer|tester|implementer-T<n>|docs-D<n>)`);
  }
  const state = runState.loadRun(root, id);
  const runDir = runState.runDir(root, id);
  const text = buildBrief(state, worker, { runDir, helperPath: helperPath(), notes });
  const file = runState.writeRunFile(root, id, `brief-${worker}.md`, text);
  const report = path.join(runDir, `report-${worker}.md`);
  runState.saveRun(root, runState.setWorker(state, worker, 'running', report), now);
  return file;
}

module.exports = { buildBrief, writeBrief };
