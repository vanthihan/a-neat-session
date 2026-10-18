'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { UsageError } = require('./cli-args.cjs');
const gitLib = require('./git.cjs');

const PIPELINE = Object.freeze(['explore', 'plan', 'implement', 'review', 'test', 'docs']);
const STAGES = Object.freeze([...PIPELINE, 'done', 'cancelled']);
const WORKER_NAME = /^(explorer|reviewer|tester|implementer-T\d+|docs-D\d+)$/;
const WORKER_STATUSES = Object.freeze(['running', 'done', 'failed', 'report-invalid']);
const RUN_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,48}$/;
const RUN_FILE_NAME = /^[a-z][A-Za-z0-9-]*\.(md|txt|patch|json)$/;
const MAX_FILE_NAME = 80;
const MAX_SLUG = 40;

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

// Git baseline of a run: SHAs, paths already dirty and their content
// fingerprints (null/null/[]/{} outside git).
function gitBaseline(root) {
  if (!gitLib.isGitRepo(root)) return { baseSha: null, headSha: null, dirtyAtStart: [], hashes: {} };
  const sha = gitLib.headSha(root);
  const dirty = gitLib.porcelainPaths(root);
  return { baseSha: sha, headSha: sha, dirtyAtStart: dirty, hashes: gitLib.fingerprints(root, dirty) };
}

function createRun(root, { task, mode, profile }, now = currentTime()) {
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
    stage: 'created',
    stages: PIPELINE.map((name) => ({ name, status: 'pending' })),
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

function loadRun(root, id) {
  assertRunId(id);
  const file = path.join(runDir(root, id), 'state.json');
  if (!fs.existsSync(file)) throw new UsageError(`run not found: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveRun(root, state, now = currentTime()) {
  assertRunId(state.id);
  const next = { ...state, updatedAt: now.toISOString() };
  writeState(root, next);
  return next;
}

function assertOneOf(kind, value, allowed) {
  if (!allowed.includes(value)) {
    throw new UsageError(`invalid ${kind} '${value}' (use ${allowed.join('|')})`);
  }
}

// Pure: returns a new state with `stage` running (or the run finished).
function setStage(state, stage) {
  assertOneOf('stage', stage, STAGES);
  const terminal = stage === 'done' || stage === 'cancelled';
  const stages = state.stages.map((s) => {
    if (s.status === 'running') return { ...s, status: stage === 'cancelled' ? 'cancelled' : 'done' };
    if (!terminal && s.name === stage) return { ...s, status: 'running' };
    return { ...s };
  });
  return { ...state, stage, stages };
}

// Pure: adds or updates the worker entry `name`. Other fields of an existing
// entry are kept; `extra` (for example { model, effort }) is merged last.
function setWorker(state, name, status, report, extra = {}) {
  if (typeof name !== 'string' || !WORKER_NAME.test(name)) {
    throw new UsageError(`invalid worker name '${name}' (use explorer|reviewer|tester|implementer-T<n>|docs-D<n>)`);
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
        return JSON.parse(fs.readFileSync(path.join(runDir(root, id), 'state.json'), 'utf8'));
      } catch {
        return { id, error: 'unreadable state' };
      }
    });
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
  setStage,
  setWorker,
  listRuns,
  writeRunFile,
};
