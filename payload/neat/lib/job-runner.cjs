'use strict';

// Starts Codex workers as detached background jobs or in tmux windows and
// waits for them. `startJob` runs the helper's own `codex _exec` wrapper as a
// new process group leader (pid = pgid): spawned detached in background mode,
// or as the pane command of a tmux window (tmux runs a multi-argument command
// directly and makes it a session leader). The wrapper pipes the prompt file
// to `codex exec ... -` and records the outcome. No shell is involved
// anywhere: every process starts from an argv array and the prompt travels
// on stdin.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { UsageError } = require('./cli-args.cjs');
const { effectiveConfig } = require('./config.cjs');
const runState = require('./run-state.cjs');
const { roleOf } = require('./route.cjs');
const codex = require('./codex.cjs');
const jobs = require('./jobs.cjs');

const POLL_MS = 200;
// How long the wrapper waits for startJob to record its pid.
const OWN_RECORD_WAIT_MS = 10000;
const OWN_RECORD_POLL_MS = 20;
const PRIVATE_MODE = 0o600;
const TMUX_TIMEOUT_MS = 10000;
const TMUX_FORMAT = '#{session_name}:#{window_index} #{pane_pid}';
const NO_TMUX_NOTE = 'note: tmux not found; running in the background';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helperPath() {
  return path.resolve(__dirname, '..', 'bin', 'neat.cjs');
}

function nowIso(env = process.env) {
  return runState.currentTime(env).toISOString();
}

function assertAvailable(cfg, env) {
  const avail = codex.availability(cfg, env);
  if (avail.enabled === 'off') throw new UsageError('codex.enabled is off');
  if (!avail.available) throw new UsageError('codex was not found');
  return avail.detected.path;
}

// Checks everything a job needs; returns the job settings. Throws a
// UsageError before anything is written.
function jobPlan(root, state, worker, { env, sandbox }) {
  if (typeof worker !== 'string' || !runState.WORKER_NAME.test(worker)) {
    throw new UsageError(`invalid worker name '${worker}'`);
  }
  const role = roleOf(worker);
  if (!codex.ELIGIBLE_ROLES.includes(role)) throw new UsageError(`${role} runs on Claude only`);
  const cfg = effectiveConfig({ root, env, state });
  const chosen = codex.sandboxFor(role, sandbox, cfg);
  const codexPath = assertAvailable(cfg, env);
  const briefPath = path.join(runState.runDir(root, state.id), `brief-${worker}.md`);
  if (!fs.existsSync(briefPath)) {
    throw new UsageError(`no brief for ${worker}: run neat brief ${state.id} ${worker} first`);
  }
  const entry = (state.workers || []).find((w) => w.name === worker) || {};
  const previous = entry.job ? jobs.readJob(root, state.id, entry.job) : null;
  if (previous && previous.status === 'running' && jobs.isAlive(previous)) {
    throw new UsageError(`job ${previous.id} of ${worker} is still running (wait for it or cancel it first)`);
  }
  return { role, briefPath, codexPath, sandbox: chosen, effort: entry.effort || 'none', model: cfg.codex.model };
}

function execArgs(record, root) {
  return codex.buildExecArgs({
    sandbox: record.sandbox, root, effort: record.effort, model: record.model, outputPath: record.outputPath,
  });
}

function writePrompt(file, briefPath, role) {
  const text = `${fs.readFileSync(briefPath, 'utf8').trimEnd()}\n\n${codex.codexRules(role).join('\n')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: PRIVATE_MODE });
}

function spawnWrapper(root, runId, jobId, env) {
  const child = spawn(process.execPath, [helperPath(), 'codex', '_exec', runId, jobId], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: { ...env, NEAT_PROJECT_DIR: root },
  });
  if (!child.pid) throw new Error('could not start the codex job');
  child.unref();
  return child.pid;
}

// tmux with argv `args`, on the server the caller's env points at.
function tmuxCmd(args, env) {
  return spawnSync('tmux', args, {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TMUX_TIMEOUT_MS,
  });
}

function tmuxAvailable(env) {
  const res = tmuxCmd(['-V'], env);
  return !res.error && res.status === 0;
}

// Opens the job's tmux window running the wrapper with `--tee`. Inside tmux
// (env.TMUX) the window opens in the current session; outside, in the
// detached session neat-<runId>, created on first use. Session and window
// names come only from validated run and job ids. There is no `-c` start
// directory: tmux expands formats in it, and `#(...)` in a project path would
// run a shell command. The wrapper gets the root from NEAT_PROJECT_DIR (`-e`
// values and the command argv are passed verbatim). Returns { pid, target, attach }.
function startTmux(root, runId, jobId, env) {
  const session = `neat-${runId}`;
  const window = ['-n', `neat-${jobId}`];
  const tail = [
    '-e', `NEAT_PROJECT_DIR=${root}`, '-P', '-F', TMUX_FORMAT,
    '--', process.execPath, helperPath(), 'codex', '_exec', runId, jobId, '--tee',
  ];
  const inside = Boolean(env.TMUX);
  const intoSession = ['new-window', '-d', '-t', `=${session}`, ...window, ...tail];
  let res;
  if (inside) {
    res = tmuxCmd(['new-window', '-d', ...window, ...tail], env);
  } else if (tmuxCmd(['has-session', '-t', `=${session}`], env).status === 0) {
    res = tmuxCmd(intoSession, env);
  } else {
    res = tmuxCmd(['new-session', '-d', '-s', session, ...window, ...tail], env);
    if (res.status !== 0) res = tmuxCmd(intoSession, env); // another job created it first
  }
  const m = res.status === 0 ? /^(\S+:\d+) (\d+)\s*$/.exec(res.stdout || '') : null;
  if (!m) {
    const why = String(res.stderr || (res.error && res.error.message) || '').trim().split('\n')[0];
    throw new Error(`could not open a tmux window for the codex job${why ? `: ${why}` : ''}`);
  }
  tmuxCmd(['set-option', '-w', '-t', m[1], 'remain-on-exit', 'on'], env);
  return { pid: Number(m[2]), target: m[1], attach: inside ? null : `attach: tmux attach -t ${session}` };
}

// How the job runs: tmux when asked for (flag or state.tmux) and installed.
function launchMode(state, tmux, env) {
  if (tmux !== true && state.tmux !== true) return { mode: 'bg', lines: [] };
  if (tmuxAvailable(env)) return { mode: 'tmux', lines: [] };
  return { mode: 'bg', lines: [NO_TMUX_NOTE] };
}

// Starts `worker` of run `runId` on Codex; returns { record, lines } where
// lines are extra output lines (`attach:` hint, notes). `sandbox` is the
// --sandbox flag value or null; `tmux` true asks for a tmux window.
function startJob(root, {
  runId, worker, sandbox = null, tmux = false, env = process.env, now = runState.currentTime(env),
}) {
  const state = runState.loadRun(root, runId);
  const plan = jobPlan(root, state, worker, { env, sandbox });
  const launch = launchMode(state, tmux, env);
  const dir = runState.runDir(root, runId);
  const id = jobs.makeJobId(root, runId, worker);
  const base = {
    id, runId, worker, mode: launch.mode, sandbox: plan.sandbox, effort: plan.effort, model: plan.model,
    codexPath: plan.codexPath, tmuxTarget: null, root,
    outputPath: path.join(dir, `codex-${worker}.md`),
    logPath: jobs.jobFile(root, runId, id, '.log'),
    promptPath: jobs.jobFile(root, runId, id, '.prompt.md'),
  };
  execArgs(base, root); // invalid sandbox/effort/model: stop before any write
  fs.rmSync(base.outputPath, { force: true });
  writePrompt(base.promptPath, plan.briefPath, plan.role);
  const started = launch.mode === 'tmux'
    ? startTmux(root, runId, id, env)
    : { pid: spawnWrapper(root, runId, id, env), target: null, attach: null };
  const record = jobs.writeJob(root, {
    ...base, tmuxTarget: started.target, pid: started.pid, pgid: started.pid,
    status: 'running', startedAt: now.toISOString(), endedAt: null, exitCode: null,
  });
  const report = path.join(dir, `report-${worker}.md`);
  const extra = { engine: 'codex', job: id };
  runState.saveRun(root, runState.setWorker(state, worker, 'running', report, extra), now);
  return { record, lines: [...launch.lines, ...(started.attach ? [started.attach] : [])] };
}

// The wrapper's own record once startJob has stored this process's pid.
async function ownRecord(root, runId, jobId) {
  const deadline = Date.now() + OWN_RECORD_WAIT_MS;
  for (;;) {
    const record = jobs.readJob(root, runId, jobId);
    if (record && record.pid === process.pid) return record.status === 'running' ? record : null;
    if (Date.now() > deadline) return null;
    await sleep(OWN_RECORD_POLL_MS);
  }
}

function hasOutput(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

// Copies codex output both to the job log and to this process's stdout (the tmux pane).
function teeTo(stream, logFd) {
  stream.on('data', (chunk) => {
    fs.writeSync(logFd, chunk);
    process.stdout.write(chunk);
  });
}

function runCodex(root, record, logFd, tee) {
  return new Promise((resolve) => {
    let child;
    const out = tee ? 'pipe' : logFd;
    try {
      child = spawn(record.codexPath, execArgs(record, root), { cwd: root, stdio: ['pipe', out, out] });
    } catch {
      resolve(null);
      return;
    }
    if (tee) {
      teeTo(child.stdout, logFd);
      teeTo(child.stderr, logFd);
    }
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
    child.stdin.on('error', () => {});
    child.stdin.end(fs.readFileSync(record.promptPath));
  });
}

// Body of `codex _exec`: runs codex for the job and records the outcome
// unless someone else (cancel) already ended the job. `tee` also shows the
// output on stdout (tmux mode). The project root comes from the record,
// because a tmux pane has the tmux server's environment, not the caller's.
async function runWrapper(root, runId, jobId, { tee = false } = {}) {
  const record = await ownRecord(root, runId, jobId);
  if (!record) return 1;
  const jobRoot = record.root || root;
  process.stdout.on('error', () => {});
  const logFd = fs.openSync(record.logPath, 'a', PRIVATE_MODE);
  let code;
  try {
    code = await runCodex(jobRoot, record, logFd, tee);
  } finally {
    fs.closeSync(logFd);
  }
  const ok = code === 0 && hasOutput(record.outputPath);
  jobs.finishJob(root, record, { status: ok ? 'done' : 'failed', exitCode: code, endedAt: nowIso() });
  return 0;
}

function lostPatch() {
  return { status: 'failed', exitCode: null, note: 'lost', endedAt: nowIso() };
}

// Current record of a job; a running job whose process is gone becomes failed/lost.
function settle(root, record) {
  const current = jobs.readJob(root, record.runId, record.id) || record;
  if (jobs.isTerminal(current) || jobs.isAlive(current)) return current;
  const after = jobs.finishJob(root, current, lostPatch());
  if (jobs.isTerminal(after)) return after;
  return jobs.writeJob(root, { ...after, ...lostPatch() }); // its owner died mid-write
}

// Resolves { records, timedOut } once every job ended or at the deadline.
async function waitJobs(root, jobIds, { timeoutMs = 3600 * 1000, pollMs = POLL_MS } = {}) {
  let records = jobIds.map((id) => jobs.findJob(root, id));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    records = records.map((r) => (jobs.isTerminal(r) ? r : settle(root, r)));
    if (records.every(jobs.isTerminal)) return { records, timedOut: false };
    if (Date.now() >= deadline) return { records, timedOut: true };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

const CANCEL_GRACE_MS = 3000;
const CANCEL_POLL_MS = 100;
// How long cancel waits for a job that is already being finished by its wrapper.
const ENDING_WAIT_MS = 1000;

// Signals the job's process group; only a live job leader (pid = pgid, its
// command line carrying the job id) is ever signalled.
function signalGroup(record, signal) {
  if (record.pgid !== record.pid || !jobs.isAlive(record)) return;
  try {
    process.kill(-record.pgid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

async function settledRecord(root, record) {
  const deadline = Date.now() + ENDING_WAIT_MS;
  let current = jobs.readJob(root, record.runId, record.id) || record;
  while (!jobs.isTerminal(current) && Date.now() < deadline) {
    await sleep(CANCEL_POLL_MS);
    current = jobs.readJob(root, record.runId, record.id) || current;
  }
  return current;
}

// Marks the job cancelled first, then stops its process group: SIGTERM, and
// SIGKILL when the leader is still alive after `graceMs`. Resolves
// { record, cancelled } (cancelled false when the job had already ended).
async function cancelJob(root, jobId, { graceMs = CANCEL_GRACE_MS, env = process.env } = {}) {
  const found = jobs.findJob(root, jobId);
  if (jobs.isTerminal(found)) return { record: found, cancelled: false };
  if (!jobs.claimEnd(root, found)) return { record: await settledRecord(root, found), cancelled: false };
  const current = jobs.readJob(root, found.runId, found.id) || found;
  const record = jobs.writeJob(root, { ...current, status: 'cancelled', endedAt: nowIso() });
  signalGroup(record, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (jobs.isAlive(record) && Date.now() < deadline) await sleep(CANCEL_POLL_MS);
  signalGroup(record, 'SIGKILL');
  if (record.mode === 'tmux' && typeof record.tmuxTarget === 'string') {
    tmuxCmd(['kill-window', '-t', record.tmuxTarget], env); // errors ignored: the window may be gone
  }
  return { record, cancelled: true };
}

module.exports = { startJob, runWrapper, waitJobs, cancelJob };
