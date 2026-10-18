'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPORT_HEADINGS = Object.freeze([
  '## Status',
  '## Findings',
  '## Decisions',
  '## Open questions',
  '## Artifacts',
]);
const MAX_REPORT_WORDS = 300;
const REPORT_STATUSES = Object.freeze(['done', 'partial', 'blocked', 'failed']);
const RUN_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,48}$/;
const STATUS_LINE = new RegExp(`^(${REPORT_STATUSES.join('|')})\\b`);

function countWords(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function headingLines(lines) {
  return lines
    .map((line, index) => ({ text: line.trimEnd(), index }))
    .filter((h) => h.text.startsWith('## '));
}

function headingErrors(headings) {
  const errors = [];
  const seen = new Set();
  const order = [];
  for (const h of headings) {
    if (!REPORT_HEADINGS.includes(h.text)) errors.push(`unexpected heading: ${h.text}`);
    else if (seen.has(h.text)) errors.push(`duplicate heading: ${h.text}`);
    else {
      seen.add(h.text);
      order.push(h.text);
    }
  }
  for (const expected of REPORT_HEADINGS) {
    if (!seen.has(expected)) errors.push(`missing heading: ${expected}`);
  }
  const expectedOrder = REPORT_HEADINGS.filter((h) => seen.has(h));
  const misplaced = order.find((h, i) => h !== expectedOrder[i]);
  if (misplaced) errors.push(`heading out of order: ${misplaced}`);
  return errors;
}

// Lines strictly between `heading` and the next `## ` heading.
function sectionLines(lines, headings, heading) {
  const start = headings.find((h) => h.text === heading);
  if (!start) return null;
  const next = headings.find((h) => h.index > start.index);
  return lines.slice(start.index + 1, next ? next.index : lines.length);
}

function statusErrors(lines, headings) {
  const body = sectionLines(lines, headings, '## Status');
  if (body === null) return [];
  const first = body.find((l) => l.trim() !== '');
  const value = (first || '').toLowerCase().replace(/^[\s*`-]+/, '');
  return STATUS_LINE.test(value) ? [] : [`status must be one of ${REPORT_STATUSES.join('|')}`];
}

function checkReport(text) {
  const lines = String(text).split(/\r?\n/);
  const headings = headingLines(lines);
  const words = countWords(String(text));
  const errors = [
    ...headingErrors(headings),
    ...statusErrors(lines, headings),
  ];
  if (words > MAX_REPORT_WORDS) errors.push(`too long: ${words} words (max ${MAX_REPORT_WORDS})`);
  return { ok: errors.length === 0, errors, words };
}

// True when absPath sits inside <something>/.neat/runs/<valid run id>/.
function isInsideRunDir(absPath) {
  const parts = absPath.split(path.sep);
  for (let i = 0; i + 3 < parts.length; i += 1) {
    if (parts[i] === '.neat' && parts[i + 1] === 'runs' && RUN_ID.test(parts[i + 2])) return true;
  }
  return false;
}

function failure(message) {
  return { ok: false, errors: [message], words: 0 };
}

// Candidate paths for one Artifacts item, most likely first: the whole
// backticked span when the item starts with one, else the text before ` - `
// and then its first word. Paths may contain spaces.
function itemCandidates(item) {
  const quoted = item.match(/^`([^`]+)`/);
  if (quoted) return [quoted[1].trim()];
  const head = item.split(/\s+-\s+/)[0].replace(/`/g, '').trim();
  return [...new Set([head, head.split(/\s+/)[0]])];
}

// Each `- ` item under ## Artifacts is a path or `none`, as a list of
// candidates. Relative paths resolve against the report's directory.
function artifactItems(text, reportDir) {
  const lines = String(text).split(/\r?\n/);
  const body = sectionLines(lines, headingLines(lines), '## Artifacts') || [];
  return body
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => itemCandidates(l.slice(2).trim()).filter(Boolean))
    .filter((c) => c.length > 0 && !/^none\.?$/i.test(c[0]))
    .map((c) => c.map((item) => path.resolve(reportDir, item)));
}

function artifactErrors(text, reportDir) {
  return artifactItems(text, reportDir)
    .filter((candidates) => !candidates.some((p) => fs.existsSync(p)))
    .map((candidates) => `artifact not found: ${candidates[0]}`);
}

// checkReport plus the Artifacts check, for report text that is not in a
// file (relative artifact paths resolve against reportDir).
function checkReportText(text, reportDir) {
  const base = checkReport(text);
  const errors = [...base.errors, ...artifactErrors(String(text), reportDir)];
  return { ok: errors.length === 0, errors, words: base.words };
}

function checkReportFile(file) {
  const resolved = path.resolve(file);
  if (!isInsideRunDir(resolved)) return failure(`path outside .neat/runs: ${resolved}`);
  if (!fs.existsSync(resolved)) return failure(`report not found: ${resolved}`);
  const real = fs.realpathSync(resolved);
  if (!isInsideRunDir(real)) return failure(`path outside .neat/runs: ${real}`);
  return checkReportText(fs.readFileSync(real, 'utf8'), path.dirname(resolved));
}

module.exports = {
  REPORT_HEADINGS,
  MAX_REPORT_WORDS,
  REPORT_STATUSES,
  countWords,
  checkReport,
  checkReportText,
  checkReportFile,
};
