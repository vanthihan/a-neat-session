#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { install } = require('../lib/installer/install.cjs');

const USAGE = 'usage: a-neat-session --local';

function fail(message, code) {
  process.stderr.write(`a-neat-session: ${message}\n`);
  process.exit(code);
}

function main(argv) {
  if (argv.length !== 1 || argv[0] !== '--local') fail(USAGE, 2);
  const target = path.resolve(process.cwd(), '.claude');
  const payloadDir = path.join(__dirname, '..', 'payload');
  let result;
  try {
    result = install({ scope: 'local', target, payloadDir });
  } catch (err) {
    fail(`install failed: ${err.message}`, 1);
  }
  process.stdout.write(`a-neat-session: installed ${result.files.length} files into ${target}\n`);
  process.stdout.write('Restart Claude Code (or start a new session) to load /neat:do and the neat-* agents.\n');
}

main(process.argv.slice(2));
