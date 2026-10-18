#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const runState = require(path.join(LIB, 'run-state.cjs'));
const reportCheck = require(path.join(LIB, 'report-check.cjs'));

const MAX_ERROR_LINES = 5;
const MODES = ['gate', 'auto', 'step'];

const HELP = [
  'neat run new [--stdin] [--mode gate|auto|step] [task]',
  'neat write <run-id> <file-name> --stdin',
  'neat report check <file>',
  'neat help',
].join('\n');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

function out(text) {
  process.stdout.write(`${text}\n`);
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

// Minimal leading/trailing --mode handling; replaced by cli-args parsing.
function parseRunText(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let mode = null;
  const take = (value) => {
    if (!MODES.includes(value)) throw new UsageError(`invalid --mode '${value}' (use gate|auto|step)`);
    mode = value;
  };
  if (tokens[0] === '--mode') take(tokens.splice(0, 2)[1]);
  const n = tokens.length;
  if (mode === null && tokens[n - 2] === '--mode') take(tokens.splice(n - 2, 2)[1]);
  const task = tokens.join(' ');
  if (!task) throw new UsageError('task is required');
  return { task, mode: mode || 'gate' };
}

function cmdRunNew(args) {
  const useStdin = args.includes('--stdin');
  const rest = args.filter((a) => a !== '--stdin');
  const text = useStdin ? readStdin() : rest.join(' ');
  const { task, mode } = parseRunText(text);
  const root = runState.projectRoot(process.env, process.cwd());
  const state = runState.createRun(root, { task, mode }, runState.currentTime(process.env));
  out(`id=${state.id} mode=${state.mode} dir=${runState.runDir(root, state.id)}`);
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
  return printCheck(reportCheck.checkReport(content));
}

function cmdReportCheck(args) {
  if (args.length !== 1) throw new UsageError('usage: neat report check <file>');
  return printCheck(reportCheck.checkReportFile(path.resolve(process.cwd(), args[0])));
}

function dispatch(argv) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === 'run' && sub === 'new') return cmdRunNew(rest);
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
