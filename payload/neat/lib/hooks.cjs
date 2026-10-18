'use strict';

// Entry point of `neat hook <name>`, the command Claude Code runs for the
// hooks the installer registers. It reads the hook input JSON from stdin,
// loads only the named handler and prints what the handler returns. A hook
// must never break the session: every error means no output, nothing goes to
// stderr and the exit code stays 0. No child process is started on this path.

const fs = require('node:fs');
const path = require('node:path');

// Upper bound for the text a handler injects into the session.
const MAX_HOOK_OUTPUT = 1500;
// Anything longer is dropped rather than cut, because cut JSON is invalid.
const MAX_RAW_OUTPUT = 10000;

const HELPER = path.resolve(__dirname, '..', 'bin', 'neat.cjs');

// Hook name -> [module, export]; a module is loaded only when its hook runs.
const HANDLERS = Object.freeze({
  'session-start': ['hook-session-start.cjs', 'sessionStart'],
});

function handlerFor(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, name)) return null;
  const [file, fn] = HANDLERS[name];
  return require(path.join(__dirname, file))[fn];
}

// Project root for a hook without asking git: NEAT_PROJECT_DIR, then
// CLAUDE_PROJECT_DIR, then an absolute `cwd` from the hook input, else null.
function hookRoot(input, env = process.env) {
  if (env.NEAT_PROJECT_DIR) return path.resolve(env.NEAT_PROJECT_DIR);
  if (env.CLAUDE_PROJECT_DIR) return path.resolve(env.CLAUDE_PROJECT_DIR);
  const cwd = input && input.cwd;
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) return path.resolve(cwd);
  return null;
}

function parseInput(text) {
  const data = JSON.parse(text);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('hook input is not an object');
  return data;
}

// Output for hook `name`, or '' (unknown hook, bad input, handler error).
function hookOutput(name, { stdinFd, env }) {
  try {
    const handler = handlerFor(name);
    if (!handler) return '';
    const input = parseInput(fs.readFileSync(stdinFd, 'utf8'));
    const out = handler(input, env, { root: hookRoot(input, env), helper: HELPER });
    return typeof out === 'string' && out.length <= MAX_RAW_OUTPUT ? out : '';
  } catch {
    return '';
  }
}

function defaultWrite(text) {
  process.stdout.on('error', () => {});
  process.stdout.write(text);
}

function main(name, { stdinFd = 0, env = process.env, write = defaultWrite } = {}) {
  const out = hookOutput(name, { stdinFd, env });
  try {
    if (out) write(out);
  } catch {
    // the session must not see a failure from a hook
  }
  process.exitCode = 0;
}

module.exports = { main, hookRoot, MAX_HOOK_OUTPUT };
