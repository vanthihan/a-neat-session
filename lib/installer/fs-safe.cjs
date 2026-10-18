'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Write via a temp file in the same directory, then rename over the target.
function atomicWrite(abs, data, mode) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.neat-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Resolve rel under root; throw when it is absolute or escapes root.
function assertInside(root, rel) {
  const base = path.resolve(root);
  if (typeof rel !== 'string' || path.isAbsolute(rel)) {
    throw new Error(`refusing path outside target: ${rel}`);
  }
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`refusing path outside target: ${rel}`);
  }
  return abs;
}

// 'missing' | 'file' | 'symlink' | 'other' — never follows links.
function lstatKind(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'missing';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isFile()) return 'file';
  return 'other';
}

const depth = (rel) => path.resolve('/', rel).split(path.sep).filter(Boolean).length;

// Remove each listed directory, deepest first, only when it is a real empty directory inside root.
function pruneEmptyDirs(root, rels) {
  const unique = [...new Set(rels)].sort((a, b) => depth(b) - depth(a));
  const removed = [];
  for (const rel of unique) {
    let abs;
    try {
      abs = assertInside(root, rel);
    } catch {
      continue;
    }
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isDirectory() || fs.readdirSync(abs).length > 0) continue;
    fs.rmdirSync(abs);
    removed.push(rel);
  }
  return removed;
}

module.exports = { atomicWrite, assertInside, lstatKind, pruneEmptyDirs };
