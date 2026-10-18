'use strict';

// Keeps README.md true to the code: every config key, slash command,
// installer flag, /neat:do flag and hook event the code has is documented,
// and every command and helper verb the README names exists. Every expected
// list is derived from the code at test time, except the fixed mention list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');
const { settingsAdditions } = require('../../lib/installer/install.cjs');

const README = path.join(REPO_ROOT, 'README.md');
const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const COMMANDS_DIR = path.join(REPO_ROOT, 'payload', 'commands', 'neat');
const FLAG = /--[a-z][a-z-]*/g;
const MIN_HELPER_CALLS = 5;

const MENTIONS = [
  'npx a-neat-session --global', 'npx a-neat-session --local', '--uninstall', '--force', '--orchestrator-default',
  'claude --agent neat-orchestrator', 'gate', 'auto', 'step', 'adaptive', 'quality', 'balanced', 'budget',
  'inherit', 'usage-capture', 'statusLine', 'codex', 'tmux', 'SubagentStop', 'SessionStart', 'PreToolUse',
  'Bash(set -o pipefail)', '.neat/runs', '/clear',
];

let readmeCache;
function readme() {
  if (readmeCache === undefined) readmeCache = fs.readFileSync(README, 'utf8');
  return readmeCache;
}

function missingFrom(text, words) {
  return words.filter((w) => !text.includes(w));
}

// Config keys printed by `neat config show` in an empty config dir and project.
function configKeys() {
  const project = makeTempDir('neat-readme-');
  try {
    const res = runNode([HELPER, 'config', 'show'], { cwd: project, env: childEnv({ NEAT_PROJECT_DIR: project }) });
    assert.equal(res.status, 0, res.stderr);
    const keys = res.stdout.split('\n')
      .map((line) => /^([A-Za-z.]+)=.* \((?:default|global|project|run)\)$/.exec(line))
      .filter(Boolean)
      .map((m) => m[1]);
    assert.ok(keys.length >= 5, `only ${keys.length} keys parsed from:\n${res.stdout}`);
    return keys;
  } finally {
    removeDir(project);
  }
}

function commandNames() {
  return fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

function frontmatterField(text, key) {
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  const line = lines.slice(1, end).find((l) => l.startsWith(`${key}:`));
  assert.ok(line, `no ${key} in frontmatter`);
  return line.slice(key.length + 1).trim();
}

// First word of every `neat <verb> ...` line of `neat help`.
function helpVerbs() {
  const res = runNode([HELPER, 'help']);
  assert.equal(res.status, 0, res.stderr);
  return new Set(res.stdout.split('\n').filter((l) => l.startsWith('neat ')).map((l) => l.split(/\s+/)[1]));
}

// Verbs of helper calls in the README: `neat.cjs <verb>` anywhere, `neat <verb>`
// at the start of a code span, and fenced code lines starting with `neat `.
function readmeHelperVerbs(text) {
  const verbs = [];
  for (const m of text.matchAll(/neat\.cjs ([a-z][a-z-]*)/g)) verbs.push(m[1]);
  for (const m of text.matchAll(/`neat ([a-z][a-z-]*)/g)) verbs.push(m[1]);
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) fenced = !fenced;
    const m = fenced ? /^\s*neat ([a-z][a-z-]*)/.exec(line) : null;
    if (m) verbs.push(m[1]);
  }
  return verbs;
}

test('README mentions the install commands, flags, modes, profiles, hooks and run files', () => {
  assert.deepEqual(missingFrom(readme(), MENTIONS), []);
});

test('every key `neat config show` prints is documented', () => {
  assert.deepEqual(missingFrom(readme(), configKeys()), []);
});

test('every slash command file is documented and every documented command exists', () => {
  const names = commandNames();
  assert.ok(names.length >= 5, names.join(','));
  assert.deepEqual(missingFrom(readme(), names.map((n) => `/neat:${n}`)), []);
  const named = [...new Set([...readme().matchAll(/\/neat:([a-z][a-z-]*)/g)].map((m) => m[1]))];
  assert.deepEqual(named.filter((n) => !names.includes(n)), []);
});

test('every installer flag in --help is documented', () => {
  const res = runNode([INSTALLER, '--help']);
  assert.equal(res.status, 0, res.stderr);
  const flags = [...new Set(res.stdout.match(FLAG))];
  assert.ok(flags.length >= 5, flags.join(','));
  assert.deepEqual(missingFrom(readme(), flags), []);
});

test('every /neat:do flag in the argument hint is documented', () => {
  const hint = frontmatterField(fs.readFileSync(path.join(COMMANDS_DIR, 'do.md'), 'utf8'), 'argument-hint');
  const flags = [...new Set(hint.match(FLAG))];
  assert.ok(flags.length >= 4, flags.join(','));
  assert.deepEqual(missingFrom(readme(), flags), []);
});

test('every hook event the installer registers is documented', () => {
  const events = settingsAdditions(path.join(path.sep, 'tmp', 'neat-target'))
    .filter((a) => a.path[0] === 'hooks')
    .map((a) => a.path[1]);
  assert.ok(events.length >= 3, events.join(','));
  assert.deepEqual(missingFrom(readme(), events), []);
});

test('every helper verb the README names is listed by `neat help`', () => {
  const known = helpVerbs();
  const verbs = readmeHelperVerbs(readme());
  assert.ok(verbs.length >= MIN_HELPER_CALLS, `only ${verbs.length} helper calls found`);
  assert.deepEqual([...new Set(verbs.filter((v) => !known.has(v)))], []);
});
