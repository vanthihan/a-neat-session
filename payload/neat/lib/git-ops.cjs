'use strict';

// Guard, diff and commit for a run. The orchestrator is the only committer:
// it commits exactly the owned paths that `guardRun` recorded as changed.
// Pathspec commands run with --literal-pathspecs so `*`, `?`, `[` and `:` in
// model-written paths never act as globs or pathspec magic.

const runState = require('./run-state.cjs');
const gitLib = require('./git.cjs');

const LITERAL = '--literal-pathspecs';
const MAX_SUBJECT = 60;
const SHORT = 7;

function short(sha) {
  return sha ? sha.slice(0, SHORT) : 'none';
}

function union(lists) {
  return [...new Set(lists.flat())].sort();
}

function tasksById(state, ids) {
  const tasks = state.tasks || [];
  return ids.map((id) => {
    const found = tasks.find((t) => t.id === id);
    if (!found) throw new Error(`unknown task ${id} (run plan check first)`);
    return found;
  });
}

function requirePlan(state) {
  if (!Array.isArray(state.tasks) || state.tasks.length === 0) throw new Error('run plan check first');
}

function list(state, key) {
  return Array.isArray(state[key]) ? state[key] : [];
}

function headViolation(root, state) {
  const current = gitLib.headSha(root);
  if (current === (state.headSha || null)) return null;
  return `HEAD moved (expected ${short(state.headSha)}, got ${short(current)})`;
}

function violationText(file, taskIds) {
  return taskIds.length > 0
    ? `${file} not owned by ${taskIds.join(',')}`
    : `${file} changed during a read-only stage`;
}

// Checks HEAD and the paths that changed since the last guard against the
// files owned by `taskIds` (none = read-only stage). Records results in state.json.
function guardRun(root, id, taskIds = [], now) {
  const state = runState.loadRun(root, id);
  if (!gitLib.isGitRepo(root)) return { ok: true, lines: ['guard skip: not a git repository'] };
  const allowed = new Set(union(tasksById(state, taskIds).map((t) => t.owns)));
  const dirty = list(state, 'dirtyAtStart');
  const known = new Set([...dirty, ...list(state, 'changed'), ...list(state, 'unowned')]);
  const fresh = gitLib.porcelainPaths(root).filter((p) => !known.has(p));
  const messages = [];
  const head = headViolation(root, state);
  if (head) messages.push(head);
  const owned = fresh.filter((p) => allowed.has(p));
  const foreign = fresh.filter((p) => !allowed.has(p));
  foreign.forEach((p) => messages.push(violationText(p, taskIds)));
  const at = (now || new Date()).toISOString();
  const next = {
    ...state,
    changed: union([list(state, 'changed'), owned]),
    unowned: union([list(state, 'unowned'), foreign]),
    violations: [...list(state, 'violations'), ...messages.map((message) => ({ stage: state.stage, message, at }))],
  };
  runState.saveRun(root, next, now);
  const notes = [...allowed].filter((p) => dirty.includes(p))
    .map((p) => `note: ${p} was modified before the run; neat will not commit it`);
  const lines = [...messages.map((m) => `guard violation: ${m}`), ...notes];
  if (messages.length === 0) lines.push(`guard ok new=${owned.length}`);
  return { ok: messages.length === 0, lines };
}

// Empty tree object id, for diffs in a repository without commits.
function emptyTree(root) {
  return gitLib.git(root, ['mktree'], { input: '' }).trim();
}

function untrackedOwned(root, owned) {
  const out = gitLib.git(root, [LITERAL, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...owned]);
  return out.split('\0').filter(Boolean);
}

function gitPatch(root, state, owned) {
  const base = state.baseSha || emptyTree(root);
  const parts = [gitLib.git(root, [LITERAL, 'diff', '--no-color', base, '--', ...owned])];
  for (const file of untrackedOwned(root, owned)) {
    parts.push(gitLib.git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { allowExit: [1] }));
  }
  return parts.filter(Boolean).join('');
}

function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Writes diff.patch (tracked owned changes since baseSha plus untracked owned files).
function writeDiff(root, id) {
  const state = runState.loadRun(root, id);
  requirePlan(state);
  const owned = union(state.tasks.map((t) => t.owns));
  if (!gitLib.isGitRepo(root)) {
    const text = ['# not a git repository; no diff available', '# owned files:', ...owned.map((p) => `- ${p}`), ''].join('\n');
    const file = runState.writeRunFile(root, id, 'diff.patch', text);
    return { file, files: 0, lines: countLines(text) };
  }
  const patch = gitPatch(root, state, owned);
  const file = runState.writeRunFile(root, id, 'diff.patch', patch);
  const files = (patch.match(/^diff --git /gm) || []).length;
  return { file, files, lines: countLines(patch) };
}

function subjectOf(task) {
  const first = String(task).split('\n')[0].trim();
  return `neat: ${first.slice(0, MAX_SUBJECT)}`;
}

function stagedPaths(root, paths) {
  const out = gitLib.git(root, [LITERAL, 'diff', '--cached', '--name-only', '--relative', '-z', '--', ...paths]);
  return out.split('\0').filter(Boolean).sort();
}

function failure(err) {
  return { ok: false, lines: ['commit failed', ...(err.stderrLines || [err.message])] };
}

// Commits exactly the guarded owned changes (state.changed) with an explicit pathspec.
function commitRun(root, id, now) {
  const state = runState.loadRun(root, id);
  if (!gitLib.isGitRepo(root)) return { ok: true, lines: ['commit skip: not a git repository'] };
  if (headViolation(root, state)) return { ok: false, lines: ['commit refused: HEAD moved'] };
  const dirty = new Set(list(state, 'dirtyAtStart'));
  const present = new Set(gitLib.porcelainPaths(root));
  const candidates = list(state, 'changed').filter((p) => !dirty.has(p) && present.has(p));
  if (candidates.length === 0) return { ok: true, lines: ['commit skip: no owned changes'] };
  let files;
  try {
    gitLib.git(root, [LITERAL, 'add', '-A', '--', ...candidates]);
    files = stagedPaths(root, candidates);
    if (files.length === 0) return { ok: true, lines: ['commit skip: no owned changes'] };
    gitLib.git(root, [LITERAL, 'commit', '-q', '-m', subjectOf(state.task), '-m', `Run: ${id}`, '--', ...files]);
  } catch (err) {
    return failure(err);
  }
  const sha = gitLib.headSha(root);
  const done = new Set(candidates);
  const next = {
    ...state,
    headSha: sha,
    changed: list(state, 'changed').filter((p) => !done.has(p)),
    commits: [...list(state, 'commits'), { sha, stage: state.stage, files }],
  };
  runState.saveRun(root, next, now);
  return { ok: true, lines: [`committed ${short(sha)} files=${files.length}`] };
}

// `.neat/` hint and dirty-file warning printed by `run new`.
function startLines(root, state) {
  if (!gitLib.isGitRepo(root)) return [];
  const lines = [];
  const dirty = list(state, 'dirtyAtStart');
  if (dirty.length > 0) {
    lines.push(`warn: ${dirty.length} files had uncommitted changes at start; neat will not commit them`);
  }
  if (!gitLib.isIgnored(root, '.neat')) lines.push('hint: add .neat/ to .gitignore');
  return lines;
}

module.exports = { guardRun, writeDiff, commitRun, startLines };
