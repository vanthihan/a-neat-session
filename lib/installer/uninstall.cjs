'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertInside, lstatKind, pruneEmptyDirs } = require('./fs-safe.cjs');
const { sha256, manifestPath, readManifest } = require('./manifest.cjs');
const { stableStringify, removeAdded, restoreScalar } = require('./settings-merge.cjs');
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

const SAFE_SHOWN = /^[^\u0000-\u001f\u007f]{1,256}$/;

function describeValue(v) {
  if (v === undefined) return 'unset';
  if (typeof v === 'string' && SAFE_SHOWN.test(v)) return `'${v}'`;
  return 'a different value';
}

// Put each replaced scalar back while it still holds our value; otherwise warn.
function restoreScalars(data, record, out) {
  let next = data;
  for (const rec of record.replaced || []) {
    const res = restoreScalar(next, rec);
    if (res.restored) {
      next = res.next;
    } else {
      const key = rec.path[0];
      out.warnings.push(`${key} is ${describeValue(next[key])} now (not ${rec.value}); left unchanged`);
    }
  }
  return next;
}

function removeEntries(current, record, backup, out) {
  if (!current.exists) return;
  const { next: pruned } = removeAdded(current.data, record.added, record.createdKeys);
  const next = restoreScalars(pruned, record, out);
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
    removeEntries(readSettings(target, record.file), record, backup, out);
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
