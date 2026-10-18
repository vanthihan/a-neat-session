'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertInside, lstatKind, pruneEmptyDirs } = require('./fs-safe.cjs');
const { sha256, manifestPath, readManifest } = require('./manifest.cjs');

// Remove one recorded file when it is still a regular file with the recorded hash.
function removeRecordedFile(target, rel, hash, out) {
  let abs;
  try {
    abs = assertInside(target, rel);
  } catch (err) {
    out.warnings.push(err.message);
    return;
  }
  const kind = lstatKind(abs);
  if (kind === 'missing') return;
  if (kind !== 'file') {
    out.warnings.push(`skipped ${rel}: not a regular file (left in place)`);
    out.kept.push(rel);
    return;
  }
  if (sha256(fs.readFileSync(abs)) !== hash) {
    out.warnings.push(`kept modified ${rel}`);
    out.kept.push(rel);
    return;
  }
  fs.unlinkSync(abs);
  out.removed.push(rel);
}

function uninstall({ target }) {
  if (!path.isAbsolute(target)) throw new Error(`uninstall target must be absolute: ${target}`);
  const manifest = readManifest(target);
  if (!manifest) throw new Error(`no a-neat-session install found at ${target}`);

  const out = { removed: [], kept: [], warnings: [], notes: [] };
  for (const [rel, hash] of Object.entries(manifest.files)) {
    removeRecordedFile(target, rel, hash, out);
  }

  fs.unlinkSync(manifestPath(target));
  pruneEmptyDirs(target, [...manifest.dirsCreated, 'neat']);
  return out;
}

module.exports = { uninstall };
