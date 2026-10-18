'use strict';

// Guard, diff and commit for a run. The orchestrator is the only committer:
// it commits exactly the owned paths that `guardRun` recorded as changed.
// Pathspec commands run with --literal-pathspecs so `*`, `?`, `[` and `:` in
// model-written paths never act as globs or pathspec magic.

const runState = require('./run-state.cjs');
const gitLib = require('./git.cjs');
const { isReservedPath } = require('./plan-check.cjs');
const protect = require('./protect.cjs');

const LITERAL = '--literal-pathspecs';
const MAX_SUBJECT = 60;
const SHORT = 7;
const MAX_NOTE_NAMES = 5;
const UNTRACKED = '??';
// Never treated as test output: CI configuration and files that change what
// git reports to later guards.
const NEVER_GENERATED_TOP = Object.freeze(['.github']);
const NEVER_GENERATED_NAMES = Object.freeze(['.gitignore', '.gitattributes', '.gitmodules']);

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

// Protected files (outside the git status view) changed since the previous
// guard, or since `run new` for the first guard. A run created before the
// protected record existed has none to compare.
function protectedCheck(root, state) {
  if (!state.protected) return { seen: undefined, changed: [] };
  const seen = protect.snapshot(root);
  return { seen, changed: protect.changedPaths(state.protectedSeen || state.protected, seen) };
}

function violationText(file, taskIds) {
  return taskIds.length > 0
    ? `${file} not owned by ${taskIds.join(',')}`
    : `${file} changed during a read-only stage`;
}

// A new untracked path the test stage may leave behind as output. Reserved
// paths (helper, permission settings, run state), CI configuration, git
// control files and paths outside the project root stay violations.
function mayBeGenerated(p) {
  const segs = p.toLowerCase().split('/');
  if (segs[0] === '..' || NEVER_GENERATED_TOP.includes(segs[0])) return false;
  if (NEVER_GENERATED_NAMES.includes(segs[segs.length - 1])) return false;
  return !isReservedPath(p);
}

// During the test stage (read-only), paths whose every new porcelain entry is
// untracked are files the test run generated (coverage, snapshots, caches).
// Tracked edits, deletions, index changes and the paths `mayBeGenerated`
// refuses stay violations.
function generatedPaths(entries, testStage) {
  if (!testStage) return [];
  const paths = [...new Set(entries.map((e) => e.path))].filter(mayBeGenerated);
  return paths.filter((p) => entries.every((e) => e.path !== p || e.xy === UNTRACKED));
}

function generatedNote(paths) {
  const shown = paths.slice(0, MAX_NOTE_NAMES).join(', ');
  const more = paths.length > MAX_NOTE_NAMES ? ` (+${paths.length - MAX_NOTE_NAMES} more)` : '';
  return `note: test created ${paths.length} untracked files (not committed): ${shown}${more}`;
}

function hashesOf(state) {
  return state.hashes && typeof state.hashes === 'object' ? state.hashes : {};
}

// Known paths whose content differs from the fingerprint recorded by the last
// guard (or by `run new` for files dirty at start). A path without a record
// (a run created before fingerprints existed) is adopted, not reported.
function touchedPaths(known, before, current) {
  return [...known].filter((p) => Object.hasOwn(before, p) && current[p] !== before[p]);
}

// Checks HEAD, the paths that are new since the last guard and the known paths
// whose content changed since the last guard against the files owned by
// `taskIds` (none = read-only stage). A batch is checked against the union of
// its tasks' files. A guarded change that a non-owner edits again moves from
// `changed` to `unowned`, so `commitRun` never commits it. Untracked files new
// during the test stage become `generated`: noted, known to later guards and
// never committed. A changed protected file (git hooks and config, the
// installed helper, permission settings) is a violation. Records results in
// state.json.
function guardRun(root, id, taskIds = [], now) {
  const state = runState.loadRun(root, id);
  if (!gitLib.isGitRepo(root)) return { ok: true, lines: ['guard skip: not a git repository'] };
  const allowed = new Set(union(tasksById(state, taskIds).map((t) => t.owns)));
  const dirty = list(state, 'dirtyAtStart');
  const changed = list(state, 'changed');
  const prevGenerated = list(state, 'generated');
  const known = new Set([...dirty, ...changed, ...list(state, 'unowned'), ...prevGenerated]);
  const before = hashesOf(state);
  const current = gitLib.fingerprints(root, [...known]);
  const touched = touchedPaths(known, before, current);
  const freshEntries = gitLib.porcelainEntries(root).filter((e) => !known.has(e.path));
  const generated = generatedPaths(freshEntries, taskIds.length === 0 && state.stage === 'test');
  const fresh = union([freshEntries.map((e) => e.path)]).filter((p) => !generated.includes(p));
  const messages = [];
  const head = headViolation(root, state);
  if (head) messages.push(head);
  const outside = protectedCheck(root, state);
  outside.changed.forEach((p) => messages.push(`protected file changed: ${p}`));
  const owned = fresh.filter((p) => allowed.has(p));
  const foreign = fresh.filter((p) => !allowed.has(p));
  const tampered = touched.filter((p) => !allowed.has(p));
  union([foreign, tampered]).forEach((p) => messages.push(violationText(p, taskIds)));
  const tainted = new Set(tampered.filter((p) => changed.includes(p)));
  const at = (now || new Date()).toISOString();
  const next = {
    ...state,
    changed: union([changed.filter((p) => !tainted.has(p)), owned]),
    unowned: union([list(state, 'unowned'), foreign, [...tainted]]),
    generated: union([prevGenerated, generated]),
    hashes: { ...before, ...current, ...gitLib.fingerprints(root, [...fresh, ...generated]) },
    protectedSeen: outside.seen,
    violations: [...list(state, 'violations'), ...messages.map((message) => ({ stage: state.stage, message, at }))],
  };
  runState.saveRun(root, next, now);
  const notes = [...allowed].filter((p) => dirty.includes(p))
    .map((p) => `note: ${p} was modified before the run; neat will not commit it`);
  if (generated.length > 0) notes.push(generatedNote(generated));
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

// Best effort: take the run's paths back out of the index after a failed commit
// (working tree untouched), so the user's next commit does not sweep them in.
function unstage(root, paths) {
  try {
    if (gitLib.headSha(root)) gitLib.git(root, [LITERAL, 'reset', '-q', '--', ...paths]);
    else gitLib.git(root, [LITERAL, 'rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...paths]);
  } catch {
    // The commit error is what the caller needs to see.
  }
}

// Commits exactly the guarded owned changes (state.changed) with an explicit pathspec.
function commitRun(root, id, now) {
  const state = runState.loadRun(root, id);
  if (!gitLib.isGitRepo(root)) return { ok: true, lines: ['commit skip: not a git repository'] };
  if (headViolation(root, state)) return { ok: false, lines: ['commit refused: HEAD moved'] };
  const blockers = state.protected ? protect.commitBlockers(root, state.protected, protect.snapshot(root)) : [];
  if (blockers.length > 0) {
    return { ok: false, lines: [`commit refused: ${blockers.join(', ')} changed during the run`] };
  }
  const dirty = new Set(list(state, 'dirtyAtStart'));
  const present = new Set(gitLib.porcelainPaths(root));
  const candidates = list(state, 'changed').filter((p) => !dirty.has(p) && present.has(p));
  if (candidates.length === 0) return { ok: true, lines: ['commit skip: no owned changes'] };
  const unguarded = touchedPaths(candidates, hashesOf(state), gitLib.fingerprints(root, candidates));
  if (unguarded.length > 0) {
    return { ok: false, lines: [`commit refused: ${unguarded.join(', ')} changed since the last guard`] };
  }
  let files;
  try {
    gitLib.git(root, [LITERAL, 'add', '-A', '--', ...candidates]);
    files = stagedPaths(root, candidates);
    if (files.length === 0) return { ok: true, lines: ['commit skip: no owned changes'] };
    gitLib.git(root, [LITERAL, 'commit', '-q', '-m', subjectOf(state.task), '-m', `Run: ${id}`, '--', ...files]);
  } catch (err) {
    unstage(root, candidates);
    return failure(err);
  }
  const sha = gitLib.headSha(root);
  const done = new Set(candidates);
  const hashes = Object.fromEntries(Object.entries(hashesOf(state)).filter(([p]) => !done.has(p)));
  const next = {
    ...state,
    headSha: sha,
    hashes,
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
