'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { UsageError } = require('./cli-args.cjs');
const gitLib = require('./git.cjs');
const protect = require('./protect.cjs');

const PIPELINE = Object.freeze(['explore', 'research', 'plan', 'implement', 'review', 'test', 'docs']);
const STAGES = Object.freeze([...PIPELINE, 'done', 'cancelled']);
const WORKER_NAME = /^(explorer|researcher|reviewer|reviewer-2|tester|implementer-T\d+|docs-D\d+)$/;
const WORKER_STATUSES = Object.freeze(['running', 'done', 'failed', 'report-invalid']);
const COMPLEXITIES = Object.freeze(['trivial', 'normal', 'risky']);
const RUN_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,48}$/;
const RUN_FILE_NAME = /^[a-z][A-Za-z0-9-]*\.(md|txt|patch|json)$/;
const MAX_FILE_NAME = 80;
const MAX_SLUG = 40;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
// A run not updated for this long no longer counts as active for the hooks.
const ACTIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STAGES = Object.freeze(['done', 'cancelled']);

function projectRoot(env = process.env, cwd = process.cwd()) {
  if (env.NEAT_PROJECT_DIR) return path.resolve(env.NEAT_PROJECT_DIR);
  if (env.CLAUDE_PROJECT_DIR) return path.resolve(env.CLAUDE_PROJECT_DIR);
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top || path.resolve(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function runsDir(root) {
  return path.join(root, '.neat', 'runs');
}

function runDir(root, id) {
  return path.join(runsDir(root), id);
}

// Clock: NEAT_NOW (ISO string) overrides the real time, for tests.
function currentTime(env = process.env) {
  if (!env.NEAT_NOW) return new Date();
  const d = new Date(env.NEAT_NOW);
  if (Number.isNaN(d.getTime())) throw new UsageError(`invalid NEAT_NOW: ${env.NEAT_NOW}`);
  return d;
}

function trimDashes(s) {
  return s.replace(/^-+|-+$/g, '');
}

function slugify(task) {
  const base = trimDashes(String(task).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const cut = trimDashes(base.slice(0, MAX_SLUG));
  return cut || 'task';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(now) {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${date}-${time}`;
}

function makeRunId(task, now, existingIds = []) {
  const base = `${stamp(now)}-${slugify(task)}`;
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function isValidRunId(id) {
  return typeof id === 'string' && RUN_ID.test(id);
}

function assertRunId(id) {
  if (!isValidRunId(id)) throw new UsageError(`invalid run id: ${id}`);
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function listRunIds(root) {
  const dir = runsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isValidRunId(e.name))
    .map((e) => e.name);
}

function writeState(root, state) {
  const file = path.join(runDir(root, state.id), 'state.json');
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
}

// Git baseline of a run: SHAs, paths already dirty, their content
// fingerprints and the protected files' fingerprints (null/null/[]/{} and no
// protected record outside git).
function gitBaseline(root) {
  if (!gitLib.isGitRepo(root)) return { baseSha: null, headSha: null, dirtyAtStart: [], hashes: {} };
  const sha = gitLib.headSha(root);
  const dirty = gitLib.porcelainPaths(root);
  return {
    baseSha: sha,
    headSha: sha,
    dirtyAtStart: dirty,
    hashes: gitLib.fingerprints(root, dirty),
    protected: protect.snapshot(root),
  };
}

// The Claude Code session that started a run, or null when it is unknown.
function cleanSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null;
}

function createRun(root, { task, mode, profile, research, tmux, sessionId }, now = currentTime()) {
  const baseline = gitBaseline(root);
  fs.mkdirSync(runsDir(root), { recursive: true });
  const id = makeRunId(task, now, listRunIds(root));
  fs.mkdirSync(runDir(root, id));
  const iso = now.toISOString();
  const state = {
    id,
    task,
    mode,
    profile: profile || null,
    research: Boolean(research),
    tmux: Boolean(tmux),
    sessionId: cleanSessionId(sessionId),
    stage: 'created',
    // research runs only when selected (`neat stages`), so it starts skipped.
    stages: PIPELINE.map((name) => ({ name, status: name === 'research' ? 'skipped' : 'pending' })),
    workers: [],
    ...baseline,
    tasks: [],
    changed: [],
    unowned: [],
    violations: [],
    commits: [],
    createdAt: iso,
    updatedAt: iso,
  };
  writeState(root, state);
  return state;
}

// A parsed state.json is usable only as a plain object (not null, an array
// or a scalar).
function isStateObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadRun(root, id) {
  assertRunId(id);
  const file = path.join(runDir(root, id), 'state.json');
  if (!fs.existsSync(file)) throw new UsageError(`run not found: ${id}`);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isStateObject(state)) throw new UsageError(`unreadable state: ${id}`);
  return state;
}

function saveRun(root, state, now = currentTime()) {
  assertRunId(state.id);
  const next = { ...state, updatedAt: now.toISOString() };
  writeState(root, next);
  return next;
}

const LOCK_WAIT_MS = 15000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Takes the run's state.lock (O_EXCL); a lock older than LOCK_STALE_MS was
// left by a process that died and is broken. Returns the lock file.
function lockRun(root, id) {
  const file = path.join(runDir(root, id), 'state.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // released between the open and the stat
    }
    if (age > LOCK_STALE_MS) fs.rmSync(file, { force: true });
    else if (Date.now() > deadline) throw new Error(`run state is locked: ${file}`);
    else sleepSync(LOCK_POLL_MS);
  }
}

// Read-modify-write of a run's state under its lock: loads the current state,
// saves `change(state)`, returns the saved state. Use it wherever another
// helper call may write the same run at the same time (parallel workers), so
// no update is lost.
function updateRun(root, id, change, now = currentTime()) {
  assertRunId(id);
  loadRun(root, id); // unknown run: UsageError before any lock file
  const lock = lockRun(root, id);
  try {
    return saveRun(root, change(loadRun(root, id)), now);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function assertOneOf(kind, value, allowed) {
  if (!allowed.includes(value)) {
    throw new UsageError(`invalid ${kind} '${value}' (use ${allowed.join('|')})`);
  }
}

// Pure: returns a new state with `stage` running (or the run finished).
// Setting the stage that is already running changes nothing, so a resumed
// session may start that stage's section again.
function setStage(state, stage) {
  assertOneOf('stage', stage, STAGES);
  const terminal = stage === 'done' || stage === 'cancelled';
  const current = (state.stages || []).find((s) => s.name === stage);
  if (!terminal && state.stage === stage && current && current.status === 'running') {
    return { ...state, stages: state.stages.map((s) => ({ ...s })) };
  }
  const stages = state.stages.map((s) => {
    if (s.status === 'running') return { ...s, status: stage === 'cancelled' ? 'cancelled' : 'done' };
    if (!terminal && s.name === stage) return { ...s, status: 'running' };
    return { ...s };
  });
  return { ...state, stage, stages };
}

// Pure: returns a new state with the task complexity set.
function setComplexity(state, level) {
  assertOneOf('complexity', level, COMPLEXITIES);
  return { ...state, complexity: level };
}

// Pure: adds or updates the worker entry `name`. Other fields of an existing
// entry are kept; `extra` (for example { model, effort }) is merged last.
function setWorker(state, name, status, report, extra = {}) {
  if (typeof name !== 'string' || !WORKER_NAME.test(name)) {
    throw new UsageError(`invalid worker name '${name}' (use explorer|researcher|reviewer|reviewer-2|tester|implementer-T<n>|docs-D<n>)`);
  }
  assertOneOf('worker status', status, WORKER_STATUSES);
  const workers = Array.isArray(state.workers) ? state.workers : [];
  const existing = workers.find((w) => w.name === name);
  const entry = {
    ...(existing || {}),
    name,
    status,
    report: report || (existing && existing.report) || null,
    ...extra,
  };
  const next = existing
    ? workers.map((w) => (w.name === name ? entry : { ...w }))
    : [...workers.map((w) => ({ ...w })), entry];
  return { ...state, workers: next };
}

// Newest first by id; a run whose state cannot be parsed is reported, not thrown.
function listRuns(root) {
  return listRunIds(root)
    .sort()
    .reverse()
    .map((id) => {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(runDir(root, id), 'state.json'), 'utf8'));
        if (isStateObject(state)) return state;
      } catch {
        // reported below
      }
      return { id, error: 'unreadable state' };
    });
}

function updatedAtMs(state) {
  const t = Date.parse(state.updatedAt);
  return Number.isNaN(t) ? null : t;
}

// Unfinished runs (stage neither done nor cancelled) updated within
// `maxAgeMs` of `now`, newest update first. Unreadable runs and states with a
// malformed id are left out; `{ maxAgeMs: Infinity }` keeps unfinished runs
// of any age.
function activeRuns(root, now = currentTime(), { maxAgeMs = ACTIVE_MAX_AGE_MS } = {}) {
  const nowMs = now.getTime();
  return listRuns(root)
    .filter((s) => !s.error && isValidRunId(s.id) && typeof s.stage === 'string' && !TERMINAL_STAGES.includes(s.stage))
    .filter((s) => {
      const t = updatedAtMs(s);
      return maxAgeMs === Infinity || (t !== null && nowMs - t <= maxAgeMs);
    })
    .sort((a, b) => (updatedAtMs(b) || 0) - (updatedAtMs(a) || 0));
}

function isUnbound(state) {
  return state.sessionId === null || state.sessionId === undefined;
}

// The run, out of `runs` (newest first, as from activeRuns), that the Claude
// Code session `sessionId` works on: the newest run recorded with that
// session id, else a run with no recorded session. With `onlyRun` such an
// unbound run counts only when it is the single active run. A run recorded
// with another session is never returned.
function runOfSession(runs, sessionId, { onlyRun = false } = {}) {
  const sid = cleanSessionId(sessionId);
  const own = sid ? runs.find((s) => s.sessionId === sid) : null;
  if (own) return own;
  if (onlyRun) return runs.length === 1 && isUnbound(runs[0]) ? runs[0] : null;
  return runs.find(isUnbound) || null;
}

function assertRunFileName(name) {
  const ok = typeof name === 'string' && name.length <= MAX_FILE_NAME
    && name !== 'state.json' && RUN_FILE_NAME.test(name);
  if (!ok) throw new UsageError(`invalid run file name: ${name}`);
}

function writeRunFile(root, id, name, content) {
  assertRunId(id);
  assertRunFileName(name);
  const dir = runDir(root, id);
  if (!fs.existsSync(path.join(dir, 'state.json'))) throw new UsageError(`run not found: ${id}`);
  const file = path.join(dir, name);
  atomicWrite(file, content);
  return file;
}

module.exports = {
  PIPELINE,
  STAGES,
  WORKER_NAME,
  WORKER_STATUSES,
  COMPLEXITIES,
  ACTIVE_MAX_AGE_MS,
  TERMINAL_STAGES,
  projectRoot,
  runsDir,
  runDir,
  currentTime,
  slugify,
  makeRunId,
  isValidRunId,
  createRun,
  loadRun,
  saveRun,
  updateRun,
  setStage,
  setComplexity,
  setWorker,
  listRuns,
  activeRuns,
  runOfSession,
  writeRunFile,
};
