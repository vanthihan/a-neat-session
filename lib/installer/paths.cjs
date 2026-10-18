'use strict';

const os = require('node:os');
const path = require('node:path');

// Characters allowed in the install path. The helper path is embedded unquoted
// in installed commands and in the settings permission rule.
const SHELL_SAFE = /^[A-Za-z0-9._/+@-]+$/;

function expandTilde(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function resolveTarget(scope, env = process.env, cwd = process.cwd(), home = os.homedir()) {
  if (scope === 'global') {
    const configured = env.CLAUDE_CONFIG_DIR;
    const dir = configured ? expandTilde(configured, home) : path.join(home, '.claude');
    return path.resolve(cwd, dir);
  }
  if (scope === 'local') return path.resolve(cwd, '.claude');
  throw new Error(`unknown scope: ${scope}`);
}

function helperPath(target) {
  return path.join(target, 'neat', 'bin', 'neat.cjs');
}

function assertShellSafePath(abs) {
  if (!SHELL_SAFE.test(abs)) {
    throw new Error(
      `install path contains spaces or shell characters: ${abs}\n` +
        'Use a path with only letters, digits and . _ / + @ - (set CLAUDE_CONFIG_DIR for --global, ' +
        'or run --local from such a directory).',
    );
  }
  return abs;
}

function settingsFileName(scope) {
  if (scope === 'global') return 'settings.json';
  if (scope === 'local') return 'settings.local.json';
  throw new Error(`unknown scope: ${scope}`);
}

module.exports = { expandTilde, resolveTarget, helperPath, assertShellSafePath, settingsFileName };
