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

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return { ...env, ...overrides };
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
