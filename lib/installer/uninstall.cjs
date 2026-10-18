'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertInside, lstatKind, pruneEmptyDirs } = require('./fs-safe.cjs');
const { sha256, manifestPath, readManifest } = require('./manifest.cjs');
const { stableStringify, removeAdded } = require('./settings-merge.cjs');
const { readSettings, writeSettings } = require('./settings-file.cjs');

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

// Original bytes from the backup when it holds exactly `next` (keeps the user's formatting).
function backupTextFor(backup, next) {
  if (lstatKind(backup) !== 'file') return undefined;
  try {
    const text = fs.readFileSync(backup, 'utf8');
    return stableStringify(JSON.parse(text)) === stableStringify(next) ? text : undefined;
  } catch {
    return undefined;
  }
}

const isEmptyObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;

function removeEntries(current, record, backup) {
  if (!current.exists) return;
  const { next } = removeAdded(current.data, record.added, record.createdKeys);
  if (record.createdFile && isEmptyObject(next) && current.writePath === current.abs) {
    fs.unlinkSync(current.abs);
  } else if (JSON.stringify(next) !== JSON.stringify(current.data)) {
    writeSettings(current, next, backupTextFor(backup, next));
  }
}

// Take back exactly the settings entries this package added; never delete the backup.
// Any failure (unreadable file, unexpected shape, write error) is a warning, so
// uninstall always finishes and removes its manifest.
function restoreSettings(target, record, out) {
  const backup = path.join(target, `${record.file}.neat-bak`);
  try {
    removeEntries(readSettings(target, record.file), record, backup);
  } catch (err) {
    const abs = path.join(target, record.file);
    out.warnings.push(`could not update ${abs}: ${err.reason || err.message}; remove the a-neat-session permission rule by hand`);
  }
  if (lstatKind(backup) !== 'missing') out.notes.push(`settings backup kept at ${backup}`);
}

function uninstall({ target }) {
  if (!path.isAbsolute(target)) throw new Error(`uninstall target must be absolute: ${target}`);
  const manifest = readManifest(target);
  if (!manifest) throw new Error(`no a-neat-session install found at ${target}`);

  const out = { removed: [], kept: [], warnings: [], notes: [] };
  for (const [rel, hash] of Object.entries(manifest.files)) {
    removeRecordedFile(target, rel, hash, out);
  }

  if (manifest.settings) restoreSettings(target, manifest.settings, out);

  fs.unlinkSync(manifestPath(target));
  pruneEmptyDirs(target, [...manifest.dirsCreated, 'neat']);
  return out;
}

module.exports = { uninstall };
