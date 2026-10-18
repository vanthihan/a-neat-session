#!/usr/bin/env node
'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { parseInstallerArgs, chooseScope, USAGE, InstallerUsageError } = require('../lib/installer/args.cjs');
const { resolveTarget, helperPath, assertShellSafePath } = require('../lib/installer/paths.cjs');
const { install } = require('../lib/installer/install.cjs');
const { uninstall } = require('../lib/installer/uninstall.cjs');

const PAYLOAD_DIR = path.join(__dirname, '..', 'payload');
const RESTART_LINE =
  'Restart Claude Code (or start a new session) to load /neat:do, /neat:status and the neat-* agents.';

function out(line) {
  process.stdout.write(`${line}\n`);
}

function warnAll(warnings) {
  for (const w of warnings) process.stderr.write(`a-neat-session: warning: ${w}\n`);
}

async function askOnTerminal(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function pickScope(opts) {
  if (opts.scope) return opts.scope;
  return chooseScope({
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askOnTerminal,
    globalTarget: resolveTarget('global'),
    localTarget: resolveTarget('local'),
  });
}

async function main(argv) {
  const opts = parseInstallerArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const scope = await pickScope(opts);
  const target = resolveTarget(scope);
  assertShellSafePath(helperPath(target));
  out(`a-neat-session: target ${target}`);
  if (opts.uninstall) {
    const result = uninstall({ target });
    warnAll(result.warnings);
    for (const note of result.notes) out(`a-neat-session: ${note}`);
    out(`a-neat-session: removed ${result.removed.length} files, kept ${result.kept.length} modified files`);
    return 0;
  }
  const result = install({ scope, target, payloadDir: PAYLOAD_DIR, force: opts.force });
  warnAll(result.warnings);
  out(`a-neat-session: installed ${result.files.length} files into ${target}`);
  out(RESTART_LINE);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`a-neat-session: ${err.message}\n`);
    process.exitCode = err instanceof InstallerUsageError ? 2 : 1;
  },
);
