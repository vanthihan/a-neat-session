'use strict';

// PreToolUse Bash hook. While a neat run is active, a plain known noisy
// command (tests, builds, package installs) is rewritten to
//   set -o pipefail; <original> 2>&1 | node <helper> filter <run-id> <kind> <log>
// so its full output goes to the run's logs and only the failure-relevant
// lines come back, with the command's own exit code. The original stays its
// own subcommand, so the user's allow/ask/deny rules still decide whether it
// runs: this hook only returns the new tool input, never a verdict on it.
// Anything it does not fully understand is left alone.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const runState = require('./run-state.cjs');

const MAX_COMMAND = 2000;
const SHELL_SAFE = /^[A-Za-z0-9._/+@-]+$/;
// Shell syntax the recognizer never accepts (operators, redirects,
// substitutions, grouping, comments, escapes, line breaks).
const FORBIDDEN = /[\n\r|&;<>`(){}#\\]/;
const LEADING_CD = /^cd ([A-Za-z0-9._/+@-]+) && (.+)$/s;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$'"]*$/;
const WATCH_WORDS = new Set(['--watch', '--watchAll', '-w', 'watch', 'dev', 'serve', '--serve', 'start']);
const MAKE_REFUSED = new Set(['clean', 'distclean', 'install', 'uninstall', 'run']);
const RUNNER_PREFIXES = Object.freeze([['npx'], ['bunx'], ['pnpm', 'exec'], ['yarn', 'exec']]);
const INSTALL_SUBS = Object.freeze({
  npm: ['install', 'i', 'ci'],
  pnpm: ['install', 'i', 'add'],
  yarn: ['install', 'add'],
  bun: ['install', 'add'],
});

// True when every single and double quote is closed.
function quotesBalanced(text) {
  let open = null;
  for (const ch of text) {
    if (open) {
      if (ch === open) open = null;
    } else if (ch === '"' || ch === "'") {
      open = ch;
    }
  }
  return open === null;
}

// npm/pnpm/yarn/bun subcommands and package scripts.
function packageKind([pm, sub, script]) {
  if (!Object.prototype.hasOwnProperty.call(INSTALL_SUBS, pm)) return null;
  if (sub === 'test' || (pm === 'npm' && sub === 't')) return 'test';
  if (sub === 'run' && typeof script === 'string') {
    if (/^test(:|$)/.test(script)) return 'test';
    if (/^build(:|$)/.test(script)) return 'build';
    return null;
  }
  return INSTALL_SUBS[pm].includes(sub) ? 'install' : null;
}

// Test runners and build tools that may also be started through npx & co.
const TOOLS = Object.freeze({
  jest: () => 'test',
  mocha: () => 'test',
  vitest: (a) => (a === 'run' ? 'test' : null),
  playwright: (a) => (a === 'test' ? 'test' : null),
  tsc: () => 'build',
  webpack: () => 'build',
  vite: (a) => (a === 'build' ? 'build' : null),
  next: (a) => (a === 'build' ? 'build' : null),
});

function makeKind(args) {
  if (args.some((a) => MAKE_REFUSED.has(a))) return null;
  return args.some((a) => a === 'test' || a === 'check') ? 'test' : 'build';
}

// Programs run directly: argument patterns -> kind.
const PROGRAMS = Object.freeze({
  node: (a) => (a === '--test' ? 'test' : null),
  pytest: () => 'test',
  python: (a, b, c) => (a !== '-m' ? null : b === 'pytest' ? 'test' : b === 'pip' && c === 'install' ? 'install' : null),
  pip: (a) => (a === 'install' ? 'install' : null),
  tox: () => 'test',
  go: (a, b) => (a === 'test' ? 'test' : a === 'build' || a === 'vet' ? 'build' : a === 'mod' && b === 'download' ? 'install' : null),
  cargo: (a, b) => (a === 'test' || (a === 'nextest' && b === 'run') ? 'test' : ['build', 'check', 'clippy'].includes(a) ? 'build' : null),
  mvn: (a) => (['test', 'verify'].includes(a) ? 'test' : ['compile', 'package', 'install'].includes(a) ? 'build' : null),
  gradle: (a) => (['test', 'check'].includes(a) ? 'test' : a === 'build' ? 'build' : null),
  ctest: () => 'test',
  cmake: (a) => (a === '--build' ? 'build' : null),
  ninja: () => 'build',
  dotnet: (a) => (a === 'test' ? 'test' : a === 'build' ? 'build' : null),
  rspec: () => 'test',
  phpunit: () => 'test',
  mix: (a) => (a === 'test' ? 'test' : null),
  bundle: (a, b) => (a === 'exec' && b === 'rspec' ? 'test' : a === 'install' ? 'install' : null),
  poetry: (a) => (a === 'install' ? 'install' : null),
  uv: (a, b) => (a === 'sync' || (a === 'pip' && b === 'install') ? 'install' : null),
  composer: (a) => (a === 'install' ? 'install' : null),
});
const PROGRAM_ALIASES = Object.freeze({ python3: 'python', pip3: 'pip', './gradlew': 'gradle', gradlew: 'gradle' });

function toolKind(words) {
  const [program, ...args] = words;
  const fn = Object.prototype.hasOwnProperty.call(TOOLS, program) ? TOOLS[program] : null;
  return fn ? fn(...args) : null;
}

function runnerArgs(words) {
  const prefix = RUNNER_PREFIXES.find((p) => p.every((w, i) => words[i] === w));
  return prefix ? words.slice(prefix.length) : null;
}

function classify(words) {
  if (words.length === 0) return null;
  const viaRunner = runnerArgs(words);
  if (viaRunner) return toolKind(viaRunner);
  const fromPackage = packageKind(words);
  if (fromPackage) return fromPackage;
  const [first, ...args] = words;
  if (first === 'make') return makeKind(args);
  const program = PROGRAM_ALIASES[first] || first;
  if (Object.prototype.hasOwnProperty.call(PROGRAMS, program)) return PROGRAMS[program](...args);
  return toolKind(words);
}

// 'test' | 'build' | 'install' for a plain known noisy command, else null.
function recognize(command) {
  if (typeof command !== 'string' || command.length > MAX_COMMAND) return null;
  const cd = LEADING_CD.exec(command.trim());
  const rest = cd ? cd[2] : command;
  if (FORBIDDEN.test(rest) || rest.includes('$(') || !quotesBalanced(rest)) return null;
  const words = rest.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && ASSIGNMENT.test(words[0])) words.shift();
  if (words.some((w) => WATCH_WORDS.has(w) || w.startsWith('--watch'))) return null;
  return classify(words);
}

function rewrite(original, { helper, runId, kind, logPath }) {
  return `set -o pipefail; ${original} 2>&1 | node ${helper} filter ${runId} ${kind} ${logPath}`;
}

// <run dir>/logs/<kind>-<YYYYMMDD-HHMMSS>-<4 hex>.txt
function logPathFor(root, id, kind, now) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const name = `${kind}-${stamp}-${crypto.randomBytes(2).toString('hex')}.txt`;
  return path.join(runState.runDir(root, id), 'logs', name);
}

function filterEnabled(root, env) {
  const config = require('./config.cjs');
  return config.effectiveConfig({ root, env }).filter.enabled === true;
}

function rewriteFor(input, env, { root, helper }) {
  if (!input || input.tool_name !== 'Bash') return '';
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return '';
  if (toolInput.run_in_background === true) return '';
  const kind = recognize(toolInput.command);
  if (!kind || typeof root !== 'string' || typeof helper !== 'string') return '';
  if (!SHELL_SAFE.test(root) || !SHELL_SAFE.test(helper)) return '';
  if (!fs.existsSync(runState.runsDir(root))) return '';
  if (!filterEnabled(root, env)) return '';
  const now = runState.currentTime(env);
  const [run] = runState.activeRuns(root, now);
  if (!run) return '';
  const logPath = logPathFor(root, run.id, kind, now);
  if (!SHELL_SAFE.test(logPath)) return '';
  const command = rewrite(toolInput.command, { helper, runId: run.id, kind, logPath });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...toolInput, command } } });
}

function preBash(input, env, ctx) {
  try {
    return rewriteFor(input, env || {}, ctx || {});
  } catch {
    return '';
  }
}

module.exports = { recognize, rewrite, preBash };
