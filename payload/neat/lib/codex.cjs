'use strict';

// Codex CLI detection and the exact `codex exec` argument list. Every value
// passed to Codex comes from a fixed table or a strict pattern; the prompt
// itself never appears in argv (it travels on stdin).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPORT_HEADINGS, MAX_REPORT_WORDS, REPORT_STATUSES } = require('./report-check.cjs');
const { UsageError } = require('./cli-args.cjs');

const VERSION_TIMEOUT_MS = 5000;
const VERSION = /(\d+\.\d+\.\d+[\w.-]*)/;
const NO_CODEX = 'none';
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

// Routed effort -> model_reasoning_effort. `none` (inherit) omits the setting.
const EFFORT = Object.freeze({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' });
const SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
const ELIGIBLE_ROLES = Object.freeze(['implementer', 'tester', 'docs', 'reviewer']);

const NOT_FOUND = Object.freeze({ found: false, path: null, version: null });
const detected = new Map();

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// NEAT_CODEX_BIN: `none` = absent, an absolute executable file = that binary,
// anything else = absent. Unset: the first executable `codex` on PATH
// (relative PATH entries are skipped).
function resolveBinary(env) {
  const forced = env.NEAT_CODEX_BIN;
  if (forced !== undefined && forced !== '') {
    if (forced === NO_CODEX || !path.isAbsolute(forced)) return null;
    return isExecutableFile(forced) ? forced : null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'codex');
    if (isExecutableFile(file)) return file;
  }
  return null;
}

// { found, path, version }; `codex --version` runs once per binary per process.
function detect(env = process.env) {
  const bin = resolveBinary(env);
  if (!bin) return NOT_FOUND;
  if (detected.has(bin)) return detected.get(bin);
  let result = NOT_FOUND;
  try {
    const out = execFileSync(bin, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(VERSION);
    result = Object.freeze({ found: true, path: bin, version: m ? m[1] : 'unknown' });
  } catch {
    result = NOT_FOUND;
  }
  detected.set(bin, result);
  return result;
}

// { available, required, detected } from config and detection. `off` never
// probes for the binary; `on` marks Codex as required.
function availability(cfg, env = process.env) {
  const enabled = cfg.codex.enabled;
  if (enabled === 'off') return { available: false, required: false, enabled, detected: null };
  const detected = detect(env);
  return { available: detected.found, required: enabled === 'on', enabled, detected };
}

// A role may go to Codex: one of ELIGIBLE_ROLES, and a write role only while
// codex.sandboxDefault allows writes.
function eligible(role, cfg) {
  if (!ELIGIBLE_ROLES.includes(role)) return false;
  return role === 'reviewer' || cfg.codex.sandboxDefault === 'workspace-write';
}

// Sandbox for `role`: the reviewer is always read-only; write roles use the
// --sandbox flag, else codex.sandboxDefault.
function sandboxFor(role, flag, cfg) {
  if (flag !== null && flag !== undefined && !SANDBOXES.includes(flag)) {
    throw new UsageError(`invalid --sandbox '${flag}' (use ${SANDBOXES.join('|')})`);
  }
  if (role === 'reviewer') {
    if (flag === 'workspace-write') throw new UsageError('the reviewer runs read-only (--sandbox workspace-write is refused)');
    return 'read-only';
  }
  if (flag) return flag;
  return cfg.codex.sandboxDefault === 'read-only' ? 'read-only' : 'workspace-write';
}

// Pure: the argv after the codex binary. Throws on any value outside the tables.
function buildExecArgs({ sandbox, root, effort = 'none', model = null, outputPath }) {
  if (!SANDBOXES.includes(sandbox)) throw new Error(`invalid sandbox '${sandbox}'`);
  const args = ['exec', '-s', sandbox, '-C', root, '--skip-git-repo-check'];
  if (effort !== 'none') {
    const mapped = Object.prototype.hasOwnProperty.call(EFFORT, effort) ? EFFORT[effort] : null;
    if (!mapped) throw new Error(`invalid effort '${effort}'`);
    args.push('-c', `model_reasoning_effort=${mapped}`);
  }
  if (model) {
    if (!MODEL.test(model)) throw new Error('invalid codex model');
    args.push(`--model=${model}`);
  }
  args.push('-o', outputPath, '-');
  return args;
}

// Lines appended to the brief to form the Codex prompt.
function codexRules(role) {
  const headings = REPORT_HEADINGS.map((h) => `\`${h}\``).join(', ');
  const lines = [
    '## Codex rules',
    '- You run as a Codex worker. These rules replace every rule above about saving or delivering the report: do not run the helper\'s write command and do not create report or review files.',
    '- Change project files only under Files you own; when none are listed, change nothing.',
    `- Your final message is the report: exactly these headings, in order, each once: ${headings}.`,
    `- At most ${MAX_REPORT_WORDS} words in the whole report. First line under \`## Status\`: ${REPORT_STATUSES.join('|')}.`,
  ];
  if (role === 'reviewer') {
    lines.push('- List findings as `path:line - high|medium|low - issue`, highest first, or `none`.');
  }
  return lines;
}

module.exports = {
  EFFORT,
  SANDBOXES,
  ELIGIBLE_ROLES,
  MODEL,
  detect,
  availability,
  eligible,
  sandboxFor,
  buildExecArgs,
  codexRules,
};
