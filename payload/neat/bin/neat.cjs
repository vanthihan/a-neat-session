#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const runState = require(path.join(LIB, 'run-state.cjs'));
const reportCheck = require(path.join(LIB, 'report-check.cjs'));
const { parseTaskArgs, UsageError } = require(path.join(LIB, 'cli-args.cjs'));
const { formatStatus } = require(path.join(LIB, 'status.cjs'));

const MAX_ERROR_LINES = 5;

const HELP = [
  'neat run new [--stdin] [--mode gate|auto|step] [task]',
  'neat run stage <run-id> <explore|plan|implement|review|test|docs|done|cancelled>',
  'neat run worker <run-id> <name> <running|done|failed|report-invalid>',
  'neat write <run-id> <file-name> --stdin',
  'neat report check <file>',
  'neat status [--json]',
  'neat help',
].join('\n');

function out(text) {
  process.stdout.write(`${text}\n`);
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function cmdRunNew(args) {
  const useStdin = args[0] === '--stdin';
  const words = useStdin ? args.slice(1) : args;
  if (useStdin && words.length > 0) throw new UsageError('run new --stdin takes no task words');
  const text = useStdin ? readStdin() : words.join(' ');
  const { task, mode } = parseTaskArgs(text);
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.createRun(root, { task, mode }, runState.currentTime(process.env));
  out(`id=${state.id} mode=${state.mode} dir=${runState.runDir(root, state.id)}`);
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

function dispatch(argv) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === 'run' && sub === 'new') return cmdRunNew(rest);
  if (cmd === 'run' && sub === 'stage') return cmdRunStage(rest);
  if (cmd === 'run' && sub === 'worker') return cmdRunWorker(rest);
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
