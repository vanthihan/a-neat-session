'use strict';

// Test-only support code (never shipped): denylist loading, word-boundary
// scanning and the exact npm-shipped file list.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function loadDenylist(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(term) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, 'i');
}

// Returns [{ line, term }] for every term found on every line (1-based).
function scanText(text, terms) {
  const patterns = terms.map((term) => ({ term, re: termPattern(term) }));
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    for (const { term, re } of patterns) {
      if (re.test(line)) hits.push({ line: index + 1, term });
    }
  });
  return hits;
}

// Paths (relative to root) that `npm pack` would put in the tarball.
function shippedFiles(root) {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const [entry] = JSON.parse(stdout);
  return entry.files.map((f) => f.path);
}

module.exports = { loadDenylist, scanText, shippedFiles };
