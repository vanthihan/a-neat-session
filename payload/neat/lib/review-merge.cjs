'use strict';

// Merges the findings of two independent reviewers into one ranked list:
// parse `path:line - severity - text` (or `path:line severity: text`) lines,
// normalise severities, pair findings on the same file within a few lines
// with similar text, rank agreements first and flag disagreements. Findings
// are untrusted model output: they are only cleaned, saved and printed.

const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');

const DICE_MIN = 0.25;
const SAME_LINE_DICE_MIN = 0.1;
const LINE_WINDOW = 3;
const MAX_FINDINGS = 200;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_TEXT = 300;
const MAX_PATH = 200;
const MERGED_FILE = 'review-merged.md';

const SEVERITY_WORDS = Object.freeze({
  critical: 'critical', high: 'critical', blocker: 'critical', error: 'critical',
  warning: 'warning', medium: 'warning', major: 'warning',
  info: 'info', low: 'info', minor: 'info', nit: 'info', note: 'info',
});
const SEVERITY_RANK = Object.freeze({ critical: 3, warning: 2, info: 1 });
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'but', 'can',
  'may', 'into', 'when', 'its', 'has', 'have', 'should', 'there', 'which', 'also',
]);
const STEM_SUFFIXES = Object.freeze(['ing', 'ed', 'es', 's']);

// Optional bullet, optional backtick, path (not starting with `#`), line,
// optional `-end` range or `:column`, then the rest of the line.
const LOCATION = /^\s*(?:[-*+]\s+)?`?([^\s`:#\p{Cc}][^\s`:\p{Cc}]*):(\d{1,9})(?:-\d+|:\d+)?`?\s*(.*)$/u;
// A leading severity word followed by `:` or `-` (brackets or bold allowed).
const SEVERITY_LEAD = /^[[(*_]*([A-Za-z]+)[\])*_]*\s*[-:–—]\s*(.*)$/;
const CONTROL = /[\p{Cc}​-‏‪-‮⁦-⁩]/gu;

function normalizeSeverity(word) {
  const key = String(word || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_WORDS, key) ? SEVERITY_WORDS[key] : 'info';
}

function cleanText(text, max = MAX_TEXT) {
  return String(text).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Repo-relative path: absolute paths under `root` lose the root, then `./`
// and diff-style `a/` or `b/` prefixes are dropped.
function normalizePath(raw, root) {
  let p = raw;
  if (root && path.isAbsolute(p)) {
    const rel = path.relative(root, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) p = rel.split(path.sep).join('/');
  }
  while (p.startsWith('./')) p = p.slice(2);
  if (/^[ab]\/./.test(p)) p = p.slice(2);
  return p.slice(0, MAX_PATH);
}

function parseLine(line, root) {
  const m = LOCATION.exec(line);
  if (!m || !/[A-Za-z]/.test(m[1])) return null;
  let rest = m[3].replace(/^[-:–—]\s*/, '');
  let severity = 'info';
  const lead = SEVERITY_LEAD.exec(rest);
  if (lead && Object.prototype.hasOwnProperty.call(SEVERITY_WORDS, lead[1].toLowerCase())) {
    severity = SEVERITY_WORDS[lead[1].toLowerCase()];
    rest = lead[2];
  }
  const text = cleanText(rest);
  if (!text) return null;
  return { path: normalizePath(m[1], root), line: Number(m[2]), severity, text };
}

// Pure: findings from one reviewer's text, at most MAX_FINDINGS.
function parseFindings(text, { root = null } = {}) {
  const found = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (found.length >= MAX_FINDINGS) break;
    const finding = parseLine(line, root);
    if (finding) found.push(finding);
  }
  return found;
}

function stem(token) {
  for (const suffix of STEM_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length);
  }
  return token;
}

function tokens(text) {
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/);
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem));
}

// Pure: Dice coefficient of the two texts' stemmed token sets, 0..1.
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size + tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

// Candidate pairs (same path, within LINE_WINDOW, similar enough), best first.
function candidates(first, second) {
  const list = [];
  first.forEach((a, i) => second.forEach((b, j) => {
    const distance = Math.abs(a.line - b.line);
    if (a.path !== b.path || distance > LINE_WINDOW) return;
    const score = similarity(a.text, b.text);
    if (score >= DICE_MIN || (distance === 0 && score >= SAME_LINE_DICE_MIN)) list.push({ i, j, score, distance });
  }));
  return list.sort((x, y) => y.score - x.score || x.distance - y.distance || x.i - y.i || x.j - y.j);
}

function higher(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function paired(a, b) {
  const gap = Math.abs(SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return {
    path: a.path,
    line: a.line,
    severity: higher(a.severity, b.severity),
    source: 'both',
    text: b.text.length > a.text.length ? b.text : a.text,
    disputed: gap >= 2,
  };
}

function single(f, label, otherPresent) {
  return { ...f, source: label, disputed: f.severity === 'critical' && otherPresent };
}

function group(m) {
  if (m.source === 'both') return 0;
  return m.disputed ? 1 : 2;
}

function compareMerged(a, b) {
  return group(a) - group(b)
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.line - b.line
    || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
}

// Pure: one ranked list from two finding lists. A source that is absent
// (not present) never makes the other's criticals disputed.
function mergeFindings(first, second, opts = {}) {
  const { firstPresent = true, secondPresent = true, firstLabel = 'claude', secondLabel = 'codex' } = opts;
  const usedA = new Set();
  const usedB = new Set();
  const merged = [];
  for (const c of candidates(first, second)) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    merged.push(paired(first[c.i], second[c.j]));
  }
  first.forEach((f, i) => { if (!usedA.has(i)) merged.push(single(f, firstLabel, secondPresent)); });
  second.forEach((f, j) => { if (!usedB.has(j)) merged.push(single(f, secondLabel, firstPresent)); });
  return merged.sort(compareMerged);
}

// Text is cleaned again here so callers passing findings directly get the
// same control-character and length limits as parsed ones.
function formatLine(m) {
  return `${m.path}:${m.line} ${m.severity} [${m.source}] ${cleanText(m.text)}${m.disputed ? ' (disputed)' : ''}`;
}

// Pure: the review-merged.md text, one line per finding, or `none`.
function formatMerged(merged) {
  return merged.length > 0 ? `${merged.map(formatLine).join('\n')}\n` : 'none\n';
}

function readCapped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function mtimeOf(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

// One reviewer's source: the newer of its Codex output and its review file,
// else its report. Returns { file, label } or null.
function pickSource(dir, worker, claudeLabel) {
  const suffix = worker === 'reviewer' ? '' : worker.slice('reviewer'.length);
  const codexFile = path.join(dir, `codex-${worker}.md`);
  const reviewFile = path.join(dir, `review${suffix}.md`);
  const codexTime = mtimeOf(codexFile);
  const reviewTime = mtimeOf(reviewFile);
  if (codexTime !== null && (reviewTime === null || codexTime > reviewTime)) return { file: codexFile, label: 'codex' };
  if (reviewTime !== null) return { file: reviewFile, label: claudeLabel };
  const report = path.join(dir, `report-${worker}.md`);
  return mtimeOf(report) !== null ? { file: report, label: claudeLabel } : null;
}

function countMerged(merged) {
  const counts = { critical: 0, warning: 0, info: 0, both: 0, disputed: 0 };
  for (const m of merged) {
    counts[m.severity] += 1;
    if (m.source === 'both') counts.both += 1;
    if (m.disputed) counts.disputed += 1;
  }
  return counts;
}

// Merges the two reviewers of run `id`, writes review-merged.md and returns
// { file, counts, lines, merged }.
function mergeRun(root, id) {
  runState.loadRun(root, id); // unknown run: UsageError before anything is read
  const dir = runState.runDir(root, id);
  const a = pickSource(dir, 'reviewer', 'claude');
  const b = pickSource(dir, 'reviewer-2', 'claude-2');
  const read = (src) => (src ? parseFindings(readCapped(src.file), { root }) : []);
  const merged = mergeFindings(read(a), read(b), {
    firstPresent: a !== null,
    secondPresent: b !== null,
    firstLabel: a ? a.label : 'claude',
    secondLabel: b ? b.label : 'codex',
  });
  const file = runState.writeRunFile(root, id, MERGED_FILE, formatMerged(merged));
  return { file, counts: countMerged(merged), lines: merged.map(formatLine), merged };
}

module.exports = {
  DICE_MIN,
  SAME_LINE_DICE_MIN,
  LINE_WINDOW,
  MAX_FINDINGS,
  MAX_READ_BYTES,
  MAX_TEXT,
  MERGED_FILE,
  parseFindings,
  normalizeSeverity,
  similarity,
  mergeFindings,
  formatMerged,
  mergeRun,
};
