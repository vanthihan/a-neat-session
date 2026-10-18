'use strict';

// Turns a finished Codex job into a report-contract file `report-<worker>.md`.
// Only this capped report reaches the main session: conforming Codex output
// passes through unchanged, anything else is wrapped (first words under
// Findings plus the full output path), and a failed job never shows the log.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');
const { checkReport, checkReportFile } = require('./report-check.cjs');

const MAX_READ_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const WRAP_WORDS = 250;
const MAX_ERROR_LINES = 5;
const MAX_ERROR_CHARS = 160;
const MAX_ERROR_WORDS = 30;
const ERROR_LINE = /\bERROR\b|error:/;
const HINTS = Object.freeze([
  [/\b401\b|unauthorized|not logged in/i, 'hint: run codex login'],
  [/usage limit|rate limit|\b429\b|quota/i, 'hint: Codex usage limit reached'],
]);

// At most `limit` bytes of `file` as text (the first ones, or the last ones
// with `tail`), or null when it cannot be read.
function readCapped(file, limit = MAX_READ_BYTES, { tail = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const total = fs.fstatSync(fd).size;
    const size = Math.min(total, limit);
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, tail ? total - size : 0);
    const text = buf.subarray(0, read).toString('utf8');
    // A cut tail starts mid-line: drop that partial first line.
    return tail && total > size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function report(status, findings, artifacts) {
  return [
    '## Status', status, '',
    '## Findings', ...findings, '',
    '## Decisions', 'none', '',
    '## Open questions', 'none', '',
    '## Artifacts', ...artifacts.map((a) => `- ${a}`), '',
  ].join('\n');
}

// First WRAP_WORDS words of `text`, with leading `#` stripped from every line
// so no heading survives.
function firstWords(text) {
  const plain = String(text).split(/\r?\n/).map((l) => l.replace(/^\s*#+/, '')).join('\n');
  const words = plain.trim() === '' ? [] : plain.trim().split(/\s+/).slice(0, WRAP_WORDS);
  return words.length > 0 ? [words.join(' ')] : ['none'];
}

function shorten(line) {
  return line.split(/\s+/).slice(0, MAX_ERROR_WORDS).join(' ').slice(0, MAX_ERROR_CHARS);
}

// Log lines that are not part of the prompt echo.
function ownLogLines(logText, promptText) {
  const prompt = new Set(String(promptText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return String(logText || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !prompt.has(l));
}

// The last few error lines of the log plus one hint; nothing else from the log.
function logFindings(logText, promptText) {
  const lines = ownLogLines(logText, promptText);
  const errors = lines.filter((l) => ERROR_LINE.test(l)).slice(-MAX_ERROR_LINES).map((l) => `- ${shorten(l)}`);
  const hint = HINTS.find(([re]) => lines.some((l) => re.test(l)));
  return hint ? [...errors, `- ${hint[1]}`] : errors;
}

function failureFindings(record, logText, promptText) {
  if (record.status === 'cancelled') return ['- job cancelled'];
  const exit = Number.isInteger(record.exitCode) ? record.exitCode : 'none';
  const lost = record.note === 'lost' ? '; the job process was lost' : '';
  return [`- codex exited ${exit}; no output file${lost}`, ...logFindings(logText, promptText)];
}

// Pure: { text, passThrough } for a terminal job record. `logText` should be
// the tail of the job log and `promptText` the prompt, whose echo is dropped.
function buildResult(record, { outputText = null, logText = '', promptText = '' } = {}) {
  if (record.status === 'done' && outputText !== null) {
    if (checkReport(outputText).ok) {
      return { text: outputText.endsWith('\n') ? outputText : `${outputText}\n`, passThrough: true };
    }
    return { text: report('done', firstWords(outputText), [record.outputPath]), passThrough: false };
  }
  const findings = failureFindings(record, logText, promptText);
  return { text: report('failed', findings, [record.logPath]), passThrough: false };
}

// Writes report-<worker>.md for a terminal job; returns { file, text }.
function writeResult(root, record) {
  const name = `report-${record.worker}.md`;
  const done = record.status === 'done';
  const outputText = done ? readCapped(record.outputPath) : null;
  const logText = done ? '' : readCapped(record.logPath, LOG_TAIL_BYTES, { tail: true });
  const promptText = done ? '' : readCapped(record.promptPath);
  const built = buildResult(record, { outputText, logText, promptText });
  let file = runState.writeRunFile(root, record.runId, name, built.text);
  if (!built.passThrough || checkReportFile(file).ok) return { file, text: built.text };
  // Conforming text that names missing artifacts: fall back to the wrapped form.
  const text = report('done', firstWords(outputText), [record.outputPath]);
  file = runState.writeRunFile(root, record.runId, name, text);
  return { file: path.resolve(file), text };
}

module.exports = { MAX_READ_BYTES, readCapped, buildResult, writeResult };
