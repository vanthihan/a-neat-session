'use strict';

const fs = require('node:fs');
const { atomicWrite, assertInside, lstatKind } = require('./fs-safe.cjs');

function parseError(abs, reason) {
  const err = new Error(`cannot parse ${abs}: ${reason}; fix or remove it, then re-run`);
  err.reason = reason;
  return err;
}

// Strictly read a Claude Code settings file inside target. A missing file reads as {}.
// A symlinked settings file (e.g. kept in a dotfiles repo) is read and later written
// through its real path so the link itself survives.
function readSettings(target, file) {
  const abs = assertInside(target, file);
  const kind = lstatKind(abs);
  if (kind === 'missing') return { abs, writePath: abs, exists: false, data: {}, text: null };
  if (kind === 'other') throw parseError(abs, 'not a regular file');
  const writePath = kind === 'symlink' ? fs.realpathSync(abs) : abs;
  const text = fs.readFileSync(writePath, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw parseError(abs, err.message);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw parseError(abs, 'top level is not a JSON object');
  }
  return { abs, writePath, exists: true, data, text };
}

// Atomic write that keeps the existing file mode (settings files are often private).
// `text` lets a caller write exact bytes (e.g. the original formatting from the backup).
function writeSettings(current, next, text = `${JSON.stringify(next, null, 2)}\n`) {
  const mode = current.exists ? fs.statSync(current.writePath).mode & 0o777 : undefined;
  atomicWrite(current.writePath, text, mode);
}

module.exports = { readSettings, writeSettings };
