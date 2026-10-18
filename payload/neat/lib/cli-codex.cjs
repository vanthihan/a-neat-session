'use strict';

// `neat codex <verb>`: detect, run, wait, result, plus the internal `_exec`
// wrapper started by `run`. Async verbs return a Promise of the exit code.

const { UsageError } = require('./cli-args.cjs');
const runState = require('./run-state.cjs');
const codex = require('./codex.cjs');
const jobs = require('./jobs.cjs');
const runner = require('./job-runner.cjs');
const codexResult = require('./codex-result.cjs');

const HELP_LINES = Object.freeze([
  'neat codex detect',
  'neat codex run <run-id> <worker>',
  'neat codex wait <job-id>... [--timeout <seconds>]',
  'neat codex result [<job-id>]',
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

function cmdDetect(args, io) {
  if (args.length !== 0) throw new UsageError('usage: neat codex detect');
  const found = codex.detect(io.env);
  io.out(found.found ? `codex=yes version=${found.version}` : 'codex=no');
  return 0;
}

function cmdRun(args, io) {
  const [runId, worker] = args;
  if (args.length !== 2) throw new UsageError('usage: neat codex run <run-id> <worker>');
  const root = rootOf(io);
  const r = runner.startJob(root, { runId, worker, env: io.env, now: runState.currentTime(io.env) });
  io.out(`job=${r.id} worker=${r.worker} mode=${r.mode} sandbox=${r.sandbox} pid=${r.pid}`);
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

function cmdResult(args, io) {
  if (args.length > 1) throw new UsageError('usage: neat codex result [<job-id>]');
  const root = rootOf(io);
  let record;
  if (args.length === 1) record = jobs.findJob(root, args[0]);
  else {
    record = jobs.latestJob(root);
    if (!record) throw new UsageError('no codex jobs');
  }
  if (!jobs.isTerminal(record)) {
    io.out(`job ${record.id} status=${record.status}`);
    return EXIT_RUNNING;
  }
  const { file, text } = codexResult.writeResult(root, record);
  io.out(text.trimEnd());
  io.out(`report: ${file}`);
  return 0;
}

function cmdExec(args, io) {
  const [runId, jobId] = args;
  if (args.length !== 2) throw new UsageError('usage: neat codex _exec <run-id> <job-id>');
  if (!runState.isValidRunId(runId)) throw new UsageError(`invalid run id: ${runId}`);
  jobs.assertJobId(jobId);
  return runner.runWrapper(rootOf(io), runId, jobId);
}

const VERBS = Object.freeze({
  detect: cmdDetect,
  run: cmdRun,
  wait: cmdWait,
  result: cmdResult,
  _exec: cmdExec,
});

// io: { out(line), env, cwd }.
function dispatchCodex(args, io) {
  const [verb, ...rest] = args;
  const handler = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
  if (!handler) throw new UsageError(`usage:\n${HELP_LINES.join('\n')}`);
  return handler(rest, io);
}

module.exports = { HELP_LINES, dispatchCodex };
