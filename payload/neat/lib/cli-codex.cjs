'use strict';

// `neat codex <verb>`: detect, run, wait, result, cancel, plus the internal `_exec`
// wrapper started by `run`. Async verbs return a Promise of the exit code.

const { UsageError } = require('./cli-args.cjs');
const runState = require('./run-state.cjs');
const { effectiveConfig } = require('./config.cjs');
const codex = require('./codex.cjs');
const jobs = require('./jobs.cjs');
const runner = require('./job-runner.cjs');
const codexResult = require('./codex-result.cjs');

const HELP_LINES = Object.freeze([
  'neat codex detect',
  'neat codex run <run-id> <worker> [--sandbox read-only|workspace-write] [--tmux]',
  'neat codex wait <job-id>... [--timeout <seconds>]',
  'neat codex result [<job-id>] [--stdin]',
  'neat codex cancel <job-id> [--stdin]',
]);

const EXIT_RUNNING = 3;
const DEFAULT_WAIT_SECONDS = 3600;

function rootOf(io) {
  return runState.projectRoot(io.env, io.cwd);
}

function exitText(code) {
  return Number.isInteger(code) ? String(code) : 'none';
}

function jobLine(r) {
  return `job ${r.id} status=${r.status} exit=${exitText(r.exitCode)} worker=${r.worker}`;
}

// Exit 1 only when codex.enabled is on and Codex is missing.
function cmdDetect(args, io) {
  if (args.length !== 0) throw new UsageError('usage: neat codex detect');
  const avail = codex.availability(effectiveConfig({ root: rootOf(io), env: io.env }), io.env);
  if (avail.enabled === 'off') {
    io.out('codex=no');
    io.out('note: codex.enabled is off');
    return 0;
  }
  io.out(avail.available ? `codex=yes version=${avail.detected.version}` : 'codex=no');
  return avail.required && !avail.available ? 1 : 0;
}

const RUN_USAGE = 'usage: neat codex run <run-id> <worker> [--sandbox read-only|workspace-write] [--tmux]';

// <run-id> <worker> plus `--sandbox <v>` (or `--sandbox=<v>`) and `--tmux`.
function runArgs(args) {
  const words = [];
  let sandbox = null;
  let tmux = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--tmux') {
      if (tmux) throw new UsageError('--tmux given twice');
      tmux = true;
    } else if (a === '--sandbox' || a.startsWith('--sandbox=')) {
      if (sandbox !== null) throw new UsageError('--sandbox given twice');
      sandbox = a === '--sandbox' ? args[(i += 1)] : a.slice('--sandbox='.length);
      if (!sandbox) throw new UsageError('--sandbox needs a value');
    } else if (a.startsWith('-')) {
      throw new UsageError(`unknown flag ${a}`);
    } else {
      words.push(a);
    }
  }
  if (words.length !== 2) throw new UsageError(RUN_USAGE);
  return { runId: words[0], worker: words[1], sandbox, tmux };
}

function cmdRun(args, io) {
  const { runId, worker, sandbox, tmux } = runArgs(args);
  const root = rootOf(io);
  const { record: r, lines } = runner.startJob(root, {
    runId, worker, sandbox, tmux, env: io.env, now: runState.currentTime(io.env),
  });
  io.out(`job=${r.id} worker=${r.worker} mode=${r.mode} sandbox=${r.sandbox} pid=${r.pid}`);
  lines.forEach((line) => io.out(line));
  return 0;
}

// Job ids plus `--timeout <s>` (or `--timeout=<s>`).
function waitArgs(args) {
  const ids = [];
  let seconds = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const isFlag = a === '--timeout' || a.startsWith('--timeout=');
    if (!isFlag) {
      if (a.startsWith('-')) throw new UsageError(`unknown flag ${a}`);
      jobs.assertJobId(a);
      ids.push(a);
      continue;
    }
    if (seconds !== null) throw new UsageError('--timeout given twice');
    const raw = a === '--timeout' ? args[(i += 1)] : a.slice('--timeout='.length);
    seconds = Number(raw);
    if (!raw || !Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--timeout needs a positive number of seconds');
  }
  if (ids.length === 0) throw new UsageError('usage: neat codex wait <job-id>... [--timeout <seconds>]');
  return { ids, seconds: seconds === null ? DEFAULT_WAIT_SECONDS : seconds };
}

async function cmdWait(args, io) {
  const { ids, seconds } = waitArgs(args);
  const { records, timedOut } = await runner.waitJobs(rootOf(io), ids, { timeoutMs: seconds * 1000 });
  records.forEach((r) => io.out(jobLine(r)));
  return timedOut ? EXIT_RUNNING : 0;
}

// The job id from `<job-id>` or `--stdin` (first non-empty line); null when
// none was given. Every id is checked against the job id pattern.
function jobIdArg(args, io, usage) {
  if (args.length > 1) throw new UsageError(usage);
  if (args.length === 0) return null;
  let id = args[0];
  if (id === '--stdin') {
    const line = io.readStdin().split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
    if (line === undefined) return null;
    id = line;
  } else if (id.startsWith('-')) {
    throw new UsageError(`unknown flag ${id}`);
  }
  jobs.assertJobId(id);
  return id;
}

function cmdResult(args, io) {
  const id = jobIdArg(args, io, 'usage: neat codex result [<job-id>] [--stdin]');
  const root = rootOf(io);
  const record = id === null ? jobs.latestJob(root) : jobs.findJob(root, id);
  if (!record) throw new UsageError('no codex jobs');
  if (!jobs.isTerminal(record)) {
    io.out(`job ${record.id} status=${record.status}`);
    return EXIT_RUNNING;
  }
  const { file, text } = codexResult.writeResult(root, record);
  io.out(text.trimEnd());
  io.out(`report: ${file}`);
  return 0;
}

async function cmdCancel(args, io) {
  const id = jobIdArg(args, io, 'usage: neat codex cancel <job-id> [--stdin]');
  const root = rootOf(io);
  if (id === null) {
    const running = jobs.listJobs(root).filter((r) => r.status === 'running').map((r) => r.id);
    const list = running.length > 0 ? `running: ${running.join(' ')}` : 'no running jobs';
    throw new UsageError(`usage: neat codex cancel <job-id> [--stdin] (${list})`);
  }
  const { record, cancelled } = await runner.cancelJob(root, id, { env: io.env });
  io.out(cancelled ? `job ${record.id} cancelled` : `job ${record.id} already ${record.status}`);
  return 0;
}

function cmdExec(args, io) {
  const [runId, jobId, flag] = args;
  const ok = args.length === 2 || (args.length === 3 && flag === '--tee');
  if (!ok) throw new UsageError('usage: neat codex _exec <run-id> <job-id> [--tee]');
  if (!runState.isValidRunId(runId)) throw new UsageError(`invalid run id: ${runId}`);
  jobs.assertJobId(jobId);
  return runner.runWrapper(rootOf(io), runId, jobId, { tee: flag === '--tee' });
}

const VERBS = Object.freeze({
  detect: cmdDetect,
  run: cmdRun,
  wait: cmdWait,
  result: cmdResult,
  cancel: cmdCancel,
  _exec: cmdExec,
});

// io: { out(line), env, cwd, readStdin() }.
function dispatchCodex(args, io) {
  const [verb, ...rest] = args;
  const handler = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
  if (!handler) throw new UsageError(`usage:\n${HELP_LINES.join('\n')}`);
  return handler(rest, io);
}

module.exports = { HELP_LINES, dispatchCodex };
