'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const rs = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'run-state.cjs'));
const { UsageError } = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'cli-args.cjs'));

const NOW = new Date('2026-10-18T12:34:56Z');

let root;

before(() => {
  root = makeTempDir('neat-state-');
});

after(() => removeDir(root));

test('slugify lowercases and collapses separators', () => {
  assert.equal(rs.slugify('Fix: the  BUG!!'), 'fix-the-bug');
  assert.equal(rs.slugify('!!!'), 'task');
});

test('slugify caps the slug at 40 characters without a trailing dash', () => {
  const slug = rs.slugify(`${'abcdefghi '.repeat(9)}`);
  assert.ok(slug.length <= 40, slug);
  assert.ok(!slug.endsWith('-'));
});

test('isValidRunId rejects traversal and malformed ids', () => {
  assert.equal(rs.isValidRunId('20261018-123456-fix-bug'), true);
  assert.equal(rs.isValidRunId('../x'), false);
  assert.equal(rs.isValidRunId('20261018-123456-a/b'), false);
  assert.equal(rs.isValidRunId(''), false);
});

test('makeRunId appends -2, then -3 on collision', () => {
  const first = rs.makeRunId('fix bug', NOW, []);
  assert.equal(first, '20261018-123456-fix-bug');
  assert.equal(rs.makeRunId('fix bug', NOW, [first]), `${first}-2`);
  assert.equal(rs.makeRunId('fix bug', NOW, [first, `${first}-2`]), `${first}-3`);
});

test('createRun writes state.json with the documented fields', () => {
  const state = rs.createRun(root, { task: 'fix bug', mode: 'gate' }, NOW);
  const onDisk = JSON.parse(fs.readFileSync(path.join(rs.runsDir(root), state.id, 'state.json'), 'utf8'));
  assert.equal(onDisk.id, state.id);
  assert.equal(onDisk.task, 'fix bug');
  assert.equal(onDisk.mode, 'gate');
  assert.equal(onDisk.stage, 'created');
  assert.deepEqual(onDisk.stages.map((s) => s.name), ['explore', 'plan', 'implement', 'review', 'test', 'docs']);
  assert.ok(onDisk.stages.every((s) => s.status === 'pending'));
  assert.deepEqual(onDisk.workers, []);
  assert.equal(onDisk.createdAt, NOW.toISOString());
  assert.equal(onDisk.updatedAt, NOW.toISOString());
});

test('a second run in the same second gets a -2 id', () => {
  const again = rs.createRun(root, { task: 'fix bug', mode: 'gate' }, NOW);
  assert.equal(again.id, '20261018-123456-fix-bug-2');
});

test('loadRun and writeRunFile reject bad ids and names with UsageError', () => {
  assert.throws(() => rs.loadRun(root, '../x'), UsageError);
  const id = '20261018-123456-fix-bug';
  for (const name of ['../x.md', 'state.json', 'Brief.md', 'brief.sh', `${'a'.repeat(80)}.md`]) {
    assert.throws(() => rs.writeRunFile(root, id, name, 'x'), UsageError, name);
  }
  assert.throws(() => rs.writeRunFile(root, '20261018-123456-nope', 'brief.md', 'x'), UsageError);
});

test('writeRunFile writes atomically and returns the absolute path', () => {
  const id = '20261018-123456-fix-bug';
  const file = rs.writeRunFile(root, id, 'brief-explorer.md', 'hello\n');
  assert.equal(file, path.join(rs.runsDir(root), id, 'brief-explorer.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});
