'use strict';

// SubagentStop hook: a neat worker whose final message breaks the report
// contract is sent back with the checker's error lines, so the main window
// only ever receives a short fixed-shape report. After MAX_REJECTIONS blocks
// for the same agent the stop is allowed and a warning is kept in the run.
// Whenever something is unclear (other agent, empty message, unknown run, own
// error) the worker may stop: this hook must never trap an agent.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { checkReportText, checkReportFile, MAX_REPORT_WORDS, countWords } = require('./report-check.cjs');

const WORKER_AGENTS = Object.freeze([
  'neat-explorer', 'neat-researcher', 'neat-implementer', 'neat-reviewer', 'neat-tester', 'neat-docs',
]);
const MAX_REJECTIONS = 2;
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_REASON_ERRORS = 5;
const MAX_ERROR_LINE = 160;
const MAX_WARNINGS = 20;
const AGENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const BRIEF_LINE = /^Brief: (\/.+)$/;
const BRIEF_FILE = /^brief-(.+)\.md$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const FIX_LINE = 'Fix the report, save it again with the helper, and reply with only the corrected report.';

// First line of the transcript (bounded read), or null when the path is not
// an absolute regular file or line 1 is longer than MAX_TRANSCRIPT_BYTES.
function firstTranscriptLine(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  if (!fs.statSync(file).isFile()) return null;
  const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
  const fd = fs.openSync(file, 'r');
  let size = 0;
  try {
    size = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const end = buf.subarray(0, size).indexOf(0x0a);
  if (end === -1 && size === buf.length) return null;
  return buf.subarray(0, end === -1 ? size : end).toString('utf8');
}

// The Agent prompt text of the transcript's first entry ('' when absent).
function promptText(line) {
  const data = JSON.parse(line);
  const content = data && data.message ? data.message.content : null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

// { id, worker } named by a `Brief: <run dir>/brief-<worker>.md` prompt of
// this project, or null.
function briefTarget(text, root) {
  const m = BRIEF_LINE.exec(text.trim());
  if (!m) return null;
  const brief = m[1];
  const id = path.basename(path.dirname(brief));
  const file = BRIEF_FILE.exec(path.basename(brief));
  if (!file || !runState.isValidRunId(id) || !runState.WORKER_NAME.test(file[1])) return null;
  const worker = file[1];
  const dir = runState.runDir(root, id);
  if (brief !== path.join(dir, `brief-${worker}.md`)) return null;
  if (!fs.existsSync(path.join(dir, 'state.json'))) return null;
  return { id, worker };
}

function transcriptTarget(input, root) {
  try {
    const line = firstTranscriptLine(input.agent_transcript_path);
    return line === null ? null : briefTarget(promptText(line), root);
  } catch {
    return null;
  }
}

// The run and worker this agent works for: the Brief line of its transcript,
// else the newest active run with the worker unknown, else null.
function locateRun(input, env, root) {
  const found = transcriptTarget(input || {}, root);
  if (found) return found;
  const [newest] = runState.activeRuns(root, runState.currentTime(env));
  return newest ? { id: newest.id, worker: null } : null;
}

// A worker that handed its report back through the handback tool ends with a
// short plain message; that is fine when its saved report file passes.
function deliveredByFile(text, root, target) {
  if (!target.worker) return false;
  if (text.split(/\r?\n/).some((l) => l.startsWith('## '))) return false;
  if (countWords(text) > MAX_REPORT_WORDS) return false;
  const file = path.join(runState.runDir(root, target.id), `report-${target.worker}.md`);
  return fs.existsSync(file) && checkReportFile(file).ok;
}

function guardKey(input, target) {
  if (typeof input.agent_id === 'string' && AGENT_KEY.test(input.agent_id)) return input.agent_id;
  return target.worker || input.agent_type;
}

function warningLine(input, target) {
  return `report guard: ${target.worker || input.agent_type} stopped with an invalid report after ${MAX_REJECTIONS} rejections`;
}

// Counts this rejection under the run lock; returns the new count. The
// warning is added in the same update when the cap is first passed.
function countRejection(root, input, target, env) {
  const key = guardKey(input, target);
  let count = 0;
  runState.updateRun(root, target.id, (state) => {
    const guard = state.reportGuard && typeof state.reportGuard === 'object' ? state.reportGuard : {};
    count = (Number.isInteger(guard[key]) ? guard[key] : 0) + 1;
    const warnings = Array.isArray(state.warnings) ? state.warnings : [];
    const nextWarnings = count === MAX_REJECTIONS + 1
      ? [...warnings, warningLine(input, target)].slice(-MAX_WARNINGS)
      : warnings;
    return { ...state, reportGuard: { ...guard, [key]: count }, warnings: nextWarnings };
  }, runState.currentTime(env));
  return count;
}

// Only checker error lines (fixed text, heading names, counts, paths), each
// cut short, then the fix instruction.
function reasonText(errors) {
  const lines = errors
    .slice(0, MAX_REASON_ERRORS)
    .map((e) => String(e).replace(CONTROL, ' ').slice(0, MAX_ERROR_LINE));
  return [...lines, FIX_LINE].join('\n');
}

function check(input, env, root) {
  if (!WORKER_AGENTS.includes(input.agent_type)) return '';
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (text.trim() === '' || !root) return '';
  const target = locateRun(input, env, root);
  if (!target) return '';
  const result = checkReportText(text, runState.runDir(root, target.id));
  if (result.ok || deliveredByFile(text, root, target)) return '';
  if (countRejection(root, input, target, env) > MAX_REJECTIONS) return '';
  return JSON.stringify({ decision: 'block', reason: reasonText(result.errors) });
}

function subagentStop(input, env, ctx) {
  try {
    return check(input || {}, env || {}, ctx && ctx.root);
  } catch {
    return '';
  }
}

module.exports = { subagentStop, locateRun, MAX_REJECTIONS, WORKER_AGENTS };
