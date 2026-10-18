'use strict';

// Safe git primitives: argument arrays only (no shell), `--` before pathspecs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_STDERR_LINES = 10;

function lastLines(text, n = MAX_STDERR_LINES) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n);
}

// Runs git in `root`. Exit codes listed in allowExit return stdout instead of throwing.
function git(root, args, { allowExit = [], input } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    if (typeof err.status === 'number' && allowExit.includes(err.status)) return err.stdout || '';
    const wrapped = new Error(`git ${args.filter((a) => !a.startsWith('-'))[0] || ''} failed`);
    wrapped.stderrLines = lastLines(err.stderr || err.message);
    wrapped.exitStatus = err.status;
    throw wrapped;
  }
}

function isGitRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

// HEAD commit SHA, or null when the repository has no commits yet.
function headSha(root) {
  const out = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowExit: [1] }).trim();
  return out || null;
}

// Subdirectory of the work tree that `root` is ('' at the top level, else 'sub/dir').
function repoPrefix(root) {
  return git(root, ['rev-parse', '--show-prefix']).trim().replace(/\/$/, '');
}

// Porcelain v1 -z entries: "XY path\0", renames/copies add "source\0" after the new path.
function parsePorcelain(out) {
  const fields = out.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    const xy = entry.slice(0, 2);
    if (/[RC]/.test(xy)) {
      // A rename source disappeared too; keep it so a rename cannot hide a deletion.
      if (xy.includes('R') && fields[i + 1]) paths.push(fields[i + 1]);
      i += 1;
    }
  }
  return paths;
}

// Sorted unique changed/untracked paths relative to `root`, .neat/ excluded.
function porcelainPaths(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const prefix = repoPrefix(root);
  const rel = parsePorcelain(out).map((p) => (prefix ? path.posix.relative(prefix, p) : p));
  const kept = rel.filter((p) => p !== '.neat' && !p.startsWith('.neat/'));
  return [...new Set(kept)].sort();
}

// True when git ignores `rel` (check-ignore exit 0); exit 1 means not ignored.
function isIgnored(root, rel) {
  try {
    git(root, ['check-ignore', '-q', '--', rel]);
    return true;
  } catch {
    return false;
  }
}

// Content fingerprint of `rel` under `root`: a sha256 of a regular file, the
// target of a symlink, or a sentinel for a missing path or a directory.
function fingerprint(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return `link:${fs.readlinkSync(abs)}`;
  if (!st.isFile()) return st.isDirectory() ? 'dir' : 'other';
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
}

// { path: fingerprint } for every path in `paths`.
function fingerprints(root, paths) {
  return Object.fromEntries(paths.map((p) => [p, fingerprint(root, p)]));
}

module.exports = { git, isGitRepo, headSha, porcelainPaths, isIgnored, lastLines, fingerprints };
