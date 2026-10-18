'use strict';

// Files that `git status` cannot show but that would let a worker act after
// its stage ends: git hooks and git config (they run at `neat run commit`),
// the installed helper, agents and commands, and the Claude Code permission
// settings (project and user level). `run new` records their fingerprints.
// Every guard reports a change since the previous guard as a violation, and
// `run commit` refuses while git hooks or git config differ from the record.

const fs = require('node:fs');
const path = require('node:path');
const gitLib = require('./git.cjs');
const config = require('./config.cjs');

// Install root of the running helper (<root>/neat/lib/protect.cjs).
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');
const SETTINGS = Object.freeze(['settings.json', 'settings.local.json']);
const MISSING = 'missing';

// Absolute paths of the regular entries directly inside `dir` whose name
// passes `keep` ([] when `dir` is missing or unreadable).
function entriesOf(dir, keep = () => true) {
  try {
    return fs.readdirSync(dir).filter(keep).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function gitPath(root, name) {
  return path.resolve(root, gitLib.git(root, ['rev-parse', '--git-path', name]).trim());
}

// Absolute paths that commit-time git reads: every hook file and the config.
function commitPaths(root) {
  return [gitPath(root, 'config'), ...entriesOf(gitPath(root, 'hooks'))];
}

function installPaths() {
  return [
    path.join(INSTALL_ROOT, 'neat', 'bin', 'neat.cjs'),
    ...entriesOf(__dirname, (n) => n.endsWith('.cjs')),
    ...entriesOf(path.join(INSTALL_ROOT, 'agents'), (n) => n.startsWith('neat-')),
    ...entriesOf(path.join(INSTALL_ROOT, 'commands', 'neat')),
  ];
}

function settingsPaths(root, env) {
  const dirs = [path.join(root, '.claude'), config.configDir(env), INSTALL_ROOT];
  return dirs.flatMap((dir) => SETTINGS.map((name) => path.join(dir, name)));
}

// { absolutePath: fingerprint } for every protected file of a git project.
function snapshot(root, env = process.env) {
  const files = [...new Set([...commitPaths(root), ...installPaths(), ...settingsPaths(root, env)])];
  return gitLib.fingerprints(root, files.sort());
}

// Paths whose fingerprint differs between two snapshots (a path present in
// only one of them counts as missing in the other).
function changedPaths(before, current) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(current)])].sort();
  return keys.filter((p) => (before[p] || MISSING) !== (current[p] || MISSING));
}

// Changed protected paths that git reads at commit time (hooks and config).
function commitBlockers(root, baseline, current) {
  const commitSet = new Set(commitPaths(root));
  return changedPaths(baseline, current).filter((p) => commitSet.has(p));
}

module.exports = { snapshot, changedPaths, commitBlockers };
