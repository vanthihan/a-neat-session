'use strict';

// Test-only support code (never shipped).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Env vars that, when inherited from the session running the tests,
// could point helpers or the installer at real directories.
const SCRUBBED_ENV = ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'NEAT_PROJECT_DIR', 'NEAT_NOW'];

// One empty CLAUDE_CONFIG_DIR per test process, created on first use and
// removed on exit, so helper children never read the developer's real
// ~/.claude (global neat config, usage capture).
let emptyConfigDir = null;

function defaultConfigDir() {
  if (!emptyConfigDir) {
    emptyConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neat-cfg-'));
    process.on('exit', () => fs.rmSync(emptyConfigDir, { recursive: true, force: true }));
  }
  return emptyConfigDir;
}

// Inherited env minus SCRUBBED_ENV, plus CLAUDE_CONFIG_DIR pointing at an
// empty temp dir unless `overrides` names CLAUDE_CONFIG_DIR. An override whose
// value is undefined removes that variable.
function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  if (!Object.prototype.hasOwnProperty.call(overrides, 'CLAUDE_CONFIG_DIR')) {
    env.CLAUDE_CONFIG_DIR = defaultConfigDir();
  }
  const merged = { ...env, ...overrides };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged;
}

function runNode(args, { cwd = REPO_ROOT, env = childEnv(), input } = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function makeTempDir(prefix = 'neat-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir };
