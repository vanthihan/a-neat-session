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
const WRAP_WORDS = 250;

// At most MAX_READ_BYTES of `file` as text, or null when it cannot be read.
function readCapped(file, limit = MAX_READ_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, limit);
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, read).toString('utf8');
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

function failureFindings(record) {
  if (record.status === 'cancelled') return ['- job cancelled'];
  const exit = Number.isInteger(record.exitCode) ? record.exitCode : 'none';
  return [`- codex exited ${exit}; no output file`];
}

// Pure: { text, passThrough } for a terminal job record.
function buildResult(record, { outputText = null } = {}) {
  if (record.status === 'done' && outputText !== null) {
    if (checkReport(outputText).ok) {
      return { text: outputText.endsWith('\n') ? outputText : `${outputText}\n`, passThrough: true };
    }
    return { text: report('done', firstWords(outputText), [record.outputPath]), passThrough: false };
  }
  return { text: report('failed', failureFindings(record), [record.logPath]), passThrough: false };
}

// Writes report-<worker>.md for a terminal job; returns { file, text }.
function writeResult(root, record) {
  const name = `report-${record.worker}.md`;
  const outputText = record.status === 'done' ? readCapped(record.outputPath) : null;
  const built = buildResult(record, { outputText });
  let file = runState.writeRunFile(root, record.runId, name, built.text);
  if (!built.passThrough || checkReportFile(file).ok) return { file, text: built.text };
  // Conforming text that names missing artifacts: fall back to the wrapped form.
  const text = report('done', firstWords(outputText), [record.outputPath]);
  file = runState.writeRunFile(root, record.runId, name, text);
  return { file: path.resolve(file), text };
}

module.exports = { MAX_READ_BYTES, readCapped, buildResult, writeResult };
