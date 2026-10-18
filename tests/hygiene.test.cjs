'use strict';

// HYG-01: no shipped file names another framework or plugin. The shipped set
// is exactly what `npm pack --dry-run --json` lists; the denylist stays in tests/.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./support/helpers.cjs');
const { loadDenylist, scanText, shippedFiles } = require('./support/denylist-scan.cjs');

const DENYLIST = path.join(__dirname, 'fixtures', 'denylist.txt');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

let shippedCache;
function shipped() {
  if (!shippedCache) shippedCache = shippedFiles(REPO_ROOT);
  return shippedCache;
}

test('scanText matches case-insensitively', () => {
  assert.deepEqual(scanText('uses the GSD flow', ['gsd']), [{ line: 1, term: 'gsd' }]);
});

test('scanText respects word boundaries', () => {
  assert.deepEqual(scanText('eccentric decca', ['ecc']), []);
});

test('scanText matches hyphenated terms and reports the line number', () => {
  assert.deepEqual(scanText('see oh-my-claudecode', ['oh-my-claudecode']), [{ line: 1, term: 'oh-my-claudecode' }]);
  assert.deepEqual(scanText('a\nb gsd-core', ['gsd']), [{ line: 2, term: 'gsd' }]);
});

test('loadDenylist skips comments and blank lines and lowercases terms', () => {
  const terms = loadDenylist(DENYLIST);
  assert.ok(terms.length >= 20, `${terms.length} terms`);
  assert.ok(terms.every((t) => t === t.toLowerCase() && t.trim() === t && t !== '' && !t.startsWith('#')));
});

test('shipped files come from npm pack and exclude tests and planning files', () => {
  const files = shipped();
  for (const required of ['package.json', 'bin/install.cjs', 'payload/commands/neat/do.md']) {
    assert.ok(files.includes(required), `${required} missing from ${files.join(', ')}`);
  }
  const leaked = files.filter((f) => f.startsWith('tests/') || f.startsWith('.planning/'));
  assert.deepEqual(leaked, []);
});

test('no shipped file names a denylisted term', () => {
  const terms = loadDenylist(DENYLIST);
  const hits = [];
  for (const file of shipped()) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const hit of scanText(text, terms)) hits.push(`${file}:${hit.line}:${hit.term}`);
  }
  assert.deepEqual(hits, [], `denylisted terms in shipped files:\n${hits.join('\n')}`);
});

test('package.json has no dependencies and no install lifecycle scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const field of DEP_FIELDS) {
    assert.ok(!pkg[field] || Object.keys(pkg[field]).length === 0, `${field} must be empty`);
  }
  for (const script of INSTALL_SCRIPTS) {
    assert.ok(!(pkg.scripts && pkg.scripts[script]), `scripts.${script} must not exist`);
  }
});
