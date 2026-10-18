#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const runState = require(path.join(LIB, 'run-state.cjs'));
const reportCheck = require(path.join(LIB, 'report-check.cjs'));
const { parseTaskArgs, UsageError } = require(path.join(LIB, 'cli-args.cjs'));
const { formatStatus } = require(path.join(LIB, 'status.cjs'));
const planCheck = require(path.join(LIB, 'plan-check.cjs'));
const brief = require(path.join(LIB, 'brief.cjs'));
const gitOps = require(path.join(LIB, 'git-ops.cjs'));
const route = require(path.join(LIB, 'route.cjs'));
const config = require(path.join(LIB, 'config.cjs'));

const MAX_ERROR_LINES = 5;

const HELP = [
  'neat run new [--stdin] [--mode gate|auto|step] [--profile adaptive|quality|balanced|budget|inherit] [task]',
  'neat run stage <run-id> <explore|plan|implement|review|test|docs|done|cancelled>',
  'neat run worker <run-id> <name> <running|done|failed|report-invalid>',
  'neat run classify <run-id> <trivial|normal|risky>',
  'neat run guard <run-id> [--tasks T1,T2]',
  'neat run diff <run-id>',
  'neat run commit <run-id>',
  'neat plan check <run-id>',
  'neat brief <run-id> <worker> [--stdin]',
  'neat route <run-id> <worker|--all>',
  'neat write <run-id> <file-name> --stdin',
  'neat report check <file>',
  'neat config show [<run-id>]',
  'neat config get <profile|thresholds.soft|thresholds.hard|usage.capturePath>',
  'neat status [--json]',
  'neat help',
].join('\n');

function out(text) {
  process.stdout.write(`${text}\n`);
}

// Delimiter of the quoted heredocs in the shipped prompts. A text line equal to
// it would end the heredoc early, so input that contains one is refused.
const HEREDOC_END = 'NEAT_EOF';

function readStdin() {
  const text = fs.readFileSync(0, 'utf8');
  if (text.split(/\r?\n/).some((line) => line.trim() === HEREDOC_END)) {
    throw new UsageError(`input must not contain a line ${HEREDOC_END}`);
  }
  return text;
}

function cmdRunNew(args) {
  const useStdin = args[0] === '--stdin';
  const words = useStdin ? args.slice(1) : args;
  if (useStdin && words.length > 0) throw new UsageError('run new --stdin takes no task words');
  const text = useStdin ? readStdin() : words.join(' ');
  const { task, mode, profile } = parseTaskArgs(text);
  const root = runState.projectRoot(process.env, process.cwd());
  config.effectiveConfig({ root, env: process.env, state: { profile } }); // invalid config: exit 2, no run
  const state = runState.createRun(root, { task, mode, profile }, runState.currentTime(process.env));
  out(`id=${state.id} mode=${state.mode} dir=${runState.runDir(root, state.id)}`);
  gitOps.startLines(root, state).forEach((line) => out(line));
  return 0;
}

function cmdRunStage(args) {
  if (args.length !== 2) throw new UsageError('usage: neat run stage <run-id> <stage>');
  const [id, stage] = args;
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.loadRun(root, id);
  runState.saveRun(root, runState.setStage(state, stage), runState.currentTime(process.env));
  out(`stage ${stage}`);
  return 0;
}

function cmdRunWorker(args) {
  if (args.length !== 3) throw new UsageError('usage: neat run worker <run-id> <name> <status>');
  const [id, name, status] = args;
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.loadRun(root, id);
  const report = path.join(runState.runDir(root, id), `report-${name}.md`);
  const next = runState.setWorker(state, name, status, report);
  runState.saveRun(root, next, runState.currentTime(process.env));
  out(`worker ${name} ${status}`);
  return 0;
}

function cmdRunClassify(args) {
  if (args.length !== 2) throw new UsageError('usage: neat run classify <run-id> <trivial|normal|risky>');
  const [id, level] = args;
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.loadRun(root, id);
  runState.saveRun(root, runState.setComplexity(state, level), runState.currentTime(process.env));
  out(`complexity ${level}`);
  return 0;
}

// Prints route lines without changing the run, then env override notes.
function cmdRoute(args) {
  if (args.length !== 2) throw new UsageError('usage: neat route <run-id> <worker|--all>');
  const [id, target] = args;
  if (target !== '--all') route.assertRoutable(target);
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.loadRun(root, id);
  const now = runState.currentTime(process.env);
  const workers = target === '--all' ? route.ROLES : [target];
  workers.forEach((w) => out(route.formatRoute(route.routeWorker(root, state, w, process.env, now))));
  route.envNotes(process.env).forEach((line) => out(line));
  return 0;
}

// Always exits 0 so it can feed a command's `!` injection.
function cmdStatus(args) {
  const json = args[0] === '--json';
  if (args.length > (json ? 1 : 0)) throw new UsageError('usage: neat status [--json]');
  const root = runState.projectRoot(process.env, process.cwd());
  try {
    out(formatStatus(runState.listRuns(root), { json, runsDir: runState.runsDir(root) }));
  } catch (err) {
    out(`neat: status failed: ${err.message}`);
  }
  return 0;
}

function printCheck(result) {
  if (result.ok) {
    out(`report ok (${result.words} words)`);
    return 0;
  }
  result.errors.slice(0, MAX_ERROR_LINES).forEach((e) => out(e));
  return 1;
}

function cmdWrite(args) {
  const [id, name, flag] = args;
  if (!id || !name || flag !== '--stdin' || args.length !== 3) {
    throw new UsageError('usage: neat write <run-id> <file-name> --stdin');
  }
  const content = readStdin();
  const root = runState.projectRoot(process.env, process.cwd());
  const file = runState.writeRunFile(root, id, name, content);
  out(file);
  if (!name.startsWith('report-')) return 0;
  return printCheck(reportCheck.checkReportFile(file));
}

function cmdReportCheck(args) {
  if (args.length !== 1) throw new UsageError('usage: neat report check <file>');
  return printCheck(reportCheck.checkReportFile(path.resolve(process.cwd(), args[0])));
}

function printResult(result) {
  result.lines.forEach((line) => out(line));
  return result.ok ? 0 : 1;
}

function cmdRunGuard(args) {
  const [id, flag, list] = args;
  const ok = id && (args.length === 1 || (args.length === 3 && flag === '--tasks' && list));
  if (!ok) throw new UsageError('usage: neat run guard <run-id> [--tasks T1,T2]');
  const taskIds = list ? list.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const root = runState.projectRoot(process.env, process.cwd());
  return printResult(gitOps.guardRun(root, id, taskIds, runState.currentTime(process.env)));
}

function cmdRunDiff(args) {
  if (args.length !== 1) throw new UsageError('usage: neat run diff <run-id>');
  const root = runState.projectRoot(process.env, process.cwd());
  const { file, files, lines } = gitOps.writeDiff(root, args[0]);
  out(`diff ${file} files=${files} lines=${lines}`);
  return 0;
}

function cmdRunCommit(args) {
  if (args.length !== 1) throw new UsageError('usage: neat run commit <run-id>');
  const root = runState.projectRoot(process.env, process.cwd());
  return printResult(gitOps.commitRun(root, args[0], runState.currentTime(process.env)));
}

function cmdPlanCheck(args) {
  if (args.length !== 1) throw new UsageError('usage: neat plan check <run-id>');
  const root = runState.projectRoot(process.env, process.cwd());
  return printResult(planCheck.checkPlan(root, args[0], runState.currentTime(process.env)));
}

function cmdBrief(args) {
  const [id, worker, flag] = args;
  const ok = id && worker && (args.length === 2 || (args.length === 3 && flag === '--stdin'));
  if (!ok) throw new UsageError('usage: neat brief <run-id> <worker> [--stdin]');
  const notes = flag === '--stdin' ? readStdin() : '';
  const root = runState.projectRoot(process.env, process.cwd());
  const result = brief.writeBrief(root, id, worker, notes, runState.currentTime(process.env), process.env);
  out(result.file);
  out(route.formatRoute(result.route));
  return 0;
}

function cmdConfig(sub, args) {
  const root = runState.projectRoot(process.env, process.cwd());
  if (sub === 'show' && args.length <= 1) {
    const state = args.length === 1 ? runState.loadRun(root, args[0]) : null;
    config.configLines(config.effectiveConfig({ root, env: process.env, state })).forEach((line) => out(line));
    return 0;
  }
  if (sub === 'get' && args.length === 1) {
    out(config.configValue(config.effectiveConfig({ root, env: process.env }), args[0]));
    return 0;
  }
  throw new UsageError('usage: neat config show [<run-id>] | neat config get <key>');
}

function dispatch(argv) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === 'run' && sub === 'new') return cmdRunNew(rest);
  if (cmd === 'run' && sub === 'stage') return cmdRunStage(rest);
  if (cmd === 'run' && sub === 'worker') return cmdRunWorker(rest);
  if (cmd === 'run' && sub === 'classify') return cmdRunClassify(rest);
  if (cmd === 'run' && sub === 'guard') return cmdRunGuard(rest);
  if (cmd === 'run' && sub === 'diff') return cmdRunDiff(rest);
  if (cmd === 'run' && sub === 'commit') return cmdRunCommit(rest);
  if (cmd === 'plan' && sub === 'check') return cmdPlanCheck(rest);
  if (cmd === 'brief') return cmdBrief(argv.slice(1));
  if (cmd === 'config') return cmdConfig(sub, rest);
  if (cmd === 'route') return cmdRoute(argv.slice(1));
  if (cmd === 'status') return cmdStatus(argv.slice(1));
  if (cmd === 'write') return cmdWrite(argv.slice(1));
  if (cmd === 'report' && sub === 'check') return cmdReportCheck(rest);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(HELP);
    return 0;
  }
  process.stderr.write(`neat: unknown command: ${argv.join(' ') || '(none)'}\n${HELP}\n`);
  return 2;
}

function main(argv) {
  try {
    return dispatch(argv);
  } catch (err) {
    process.stderr.write(`neat: ${err.message}\n`);
    return err.exitCode === 2 ? 2 : 1;
  }
}

process.exitCode = main(process.argv.slice(2));
