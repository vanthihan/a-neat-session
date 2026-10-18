#!/usr/bin/env node
'use strict';

// Test-only stand-in for the codex CLI (never shipped, never touches the
// network). Knobs come from the environment:
//   FAKE_CODEX_LOG           append one JSON line per call: { argv, stdin, pid, cwd }
//   FAKE_CODEX_VERSION_EXIT  exit code of `--version` (default 0)
//   FAKE_CODEX_DELAY_MS      wait before finishing (default 0)
//   FAKE_CODEX_TOUCH         comma-separated paths (relative to -C) to append a line to
//   FAKE_CODEX_EXIT          exit code (default 0)
//   FAKE_CODEX_OUTPUT        text written to the -o file on success
//   FAKE_CODEX_STDERR        stderr text on failure
// Like the real CLI it echoes the prompt on stderr.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT = [
  '## Status',
  'done',
  '',
  '## Findings',
  '- src/app.js:3 - low - name could be clearer',
  '',
  '## Decisions',
  'none',
  '',
  '## Open questions',
  'none',
  '',
  '## Artifacts',
  'none',
  '',
].join('\n');
const DEFAULT_STDERR = 'ERROR: unexpected status 401 Unauthorized';

const argv = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;

function record(stdin) {
  if (!log) return;
  const line = JSON.stringify({ argv, stdin, pid: process.pid, cwd: process.cwd() });
  fs.appendFileSync(log, `${line}\n`);
}

function argAfter(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function touchAll(dir) {
  const list = process.env.FAKE_CODEX_TOUCH;
  if (!list) return;
  for (const rel of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const file = path.resolve(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, 'changed by fake codex\n');
  }
}

function finish() {
  touchAll(argAfter('-C') || process.cwd());
  const code = Number(process.env.FAKE_CODEX_EXIT || 0);
  const out = argAfter('-o');
  if (code === 0) {
    if (out) fs.writeFileSync(out, process.env.FAKE_CODEX_OUTPUT !== undefined ? process.env.FAKE_CODEX_OUTPUT : DEFAULT_OUTPUT);
    process.stderr.write('codex\nok\n');
  } else {
    process.stderr.write(`${process.env.FAKE_CODEX_STDERR || DEFAULT_STDERR}\n`);
  }
  process.exit(code);
}

if (argv[0] === '--version') {
  record(null);
  process.stdout.write('codex-cli 9.9.9\n');
  process.exit(Number(process.env.FAKE_CODEX_VERSION_EXIT || 0));
}

const stdin = fs.readFileSync(0, 'utf8');
record(stdin);
process.stderr.write(stdin);
setTimeout(finish, Number(process.env.FAKE_CODEX_DELAY_MS || 0));
