'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { helperPath, settingsFileName } = require('./paths.cjs');
const { atomicWrite, assertInside, lstatKind } = require('./fs-safe.cjs');
const { MANIFEST_REL, MANIFEST_VERSION, sha256, readManifest, writeManifest } = require('./manifest.cjs');
const { stableStringify, appendIfAbsent } = require('./settings-merge.cjs');
const { readSettings, writeSettings } = require('./settings-file.cjs');
const pkg = require('../../package.json');

const PLACEHOLDER = /\{\{NEAT_BIN\}\}/g;

// Sorted POSIX-style relative paths of every regular file under payloadDir.
function listPayloadFiles(payloadDir) {
  const out = [];
  const walk = (dir, prefix) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(payloadDir, '');
  return out.sort();
}

function renderTemplate(text, vars) {
  if (typeof vars.NEAT_BIN !== 'string' || vars.NEAT_BIN === '') {
    throw new Error('renderTemplate: NEAT_BIN is required');
  }
  return text.replace(PLACEHOLDER, () => vars.NEAT_BIN);
}

// Installed bytes and file mode for one payload file (only .md files are templates).
function renderPayloadFile(payloadDir, rel, vars) {
  const src = path.join(payloadDir, ...rel.split('/'));
  if (rel.endsWith('.md')) {
    return { data: Buffer.from(renderTemplate(fs.readFileSync(src, 'utf8'), vars)), mode: undefined };
  }
  return { data: fs.readFileSync(src), mode: fs.statSync(src).mode & 0o777 };
}

// Relative directories (target itself as '.') that do not exist yet on the way to relDir.
function missingDirs(target, relDir) {
  const out = [];
  if (lstatKind(target) === 'missing') out.push('.');
  const segments = relDir === '.' ? [] : relDir.split('/');
  for (let i = 1; i <= segments.length; i += 1) {
    const rel = segments.slice(0, i).join('/');
    if (lstatKind(path.join(target, ...segments.slice(0, i))) === 'missing') out.push(rel);
  }
  return out;
}

// Decide and apply what happens to one payload file. Returns the hash to record (or null).
function placeFile(ctx, rel, data, mode) {
  const { target, oldFiles, force, report, recordDirs } = ctx;
  const abs = assertInside(target, rel);
  const newHash = sha256(data);
  const kind = lstatKind(abs);
  if (kind === 'missing') {
    recordDirs(path.posix.dirname(rel));
    atomicWrite(abs, data, mode);
    report.written.push(rel);
    return newHash;
  }
  if (kind !== 'file') {
    report.warn(`skipped ${rel}: not a regular file (remove it and re-run)`);
    report.skipped.push(rel);
    return null;
  }
  const current = fs.readFileSync(abs);
  const currentHash = sha256(current);
  if (currentHash === newHash) return newHash;
  const oldHash = oldFiles[rel];
  if (oldHash && currentHash === oldHash) {
    atomicWrite(abs, data, mode);
    report.written.push(rel);
    return newHash;
  }
  if (force) {
    atomicWrite(`${abs}.neat-old`, current);
    atomicWrite(abs, data, mode);
    report.written.push(rel);
    return newHash;
  }
  if (oldHash) {
    report.warn(`kept modified ${rel} (use --force to overwrite)`);
    report.kept.push(rel);
    return oldHash;
  }
  report.warn(`skipped ${rel}: exists and is not owned by a-neat-session (use --force to replace)`);
  report.skipped.push(rel);
  return null;
}

// Delete files an older install wrote that the current payload no longer ships.
function removeStale(ctx, rel) {
  const { target, oldFiles, report } = ctx;
  let abs;
  try {
    abs = assertInside(target, rel);
  } catch (err) {
    report.warn(err.message);
    return;
  }
  const kind = lstatKind(abs);
  if (kind === 'missing') return;
  if (kind !== 'file') {
    report.warn(`skipped ${rel}: not a regular file (remove it by hand if unwanted)`);
    return;
  }
  if (sha256(fs.readFileSync(abs)) === oldFiles[rel]) {
    fs.unlinkSync(abs);
    report.removed.push(rel);
  } else {
    report.warn(`kept modified ${rel} (no longer installed by a-neat-session)`);
    report.kept.push(rel);
  }
}

const ALLOW_PATH = ['permissions', 'allow'];

function permissionRule(target) {
  return `Bash(node ${helperPath(target)} *)`;
}

// Read and merge the settings file BEFORE any payload write, so a broken file aborts cleanly.
function planSettings(target, scope) {
  const file = settingsFileName(scope);
  const current = readSettings(target, file);
  let merge;
  try {
    merge = appendIfAbsent(current.data, [{ path: ALLOW_PATH, value: permissionRule(target) }]);
  } catch (err) {
    throw new Error(`cannot update ${current.abs}: ${err.message}; fix or remove it, then re-run`);
  }
  return { file, current, merge };
}

function unionBy(a, b) {
  const seen = new Map();
  for (const item of [...a, ...b]) seen.set(stableStringify(item), item);
  return [...seen.values()];
}

// Write the merged settings (backing the original up once) and describe it for the manifest.
function applySettings(plan, oldSettings) {
  const { file, current, merge } = plan;
  const backupAbs = `${current.abs}.neat-bak`;
  if (merge.added.length > 0) {
    if (current.exists && lstatKind(backupAbs) === 'missing') fs.copyFileSync(current.abs, backupAbs);
    writeSettings(current, merge.next);
  }
  const old = oldSettings && oldSettings.file === file ? oldSettings : null;
  return {
    file,
    backup: lstatKind(backupAbs) === 'missing' ? null : `${file}.neat-bak`,
    createdFile: old ? old.createdFile : !current.exists,
    added: unionBy(old ? old.added : [], merge.added),
    createdKeys: unionBy(old ? old.createdKeys : [], merge.createdKeys),
  };
}

function install({ scope, target, payloadDir, force = false }) {
  if (!path.isAbsolute(target)) throw new Error(`install target must be absolute: ${target}`);
  const old = readManifest(target);
  const settingsPlan = planSettings(target, scope);
  const oldFiles = old ? old.files : {};
  const vars = { NEAT_BIN: helperPath(target) };
  const payloadFiles = listPayloadFiles(payloadDir);

  const warnings = [];
  const report = { written: [], kept: [], skipped: [], removed: [], warn: (w) => warnings.push(w) };
  const dirsCreated = new Set(old ? old.dirsCreated : []);
  const recordDirs = (relDir) => missingDirs(target, relDir).forEach((d) => dirsCreated.add(d));
  const ctx = { target, oldFiles, force, report, recordDirs };

  const files = {};
  for (const rel of payloadFiles) {
    const { data, mode } = renderPayloadFile(payloadDir, rel, vars);
    const hash = placeFile(ctx, rel, data, mode);
    if (hash) files[rel] = hash;
  }
  const payloadSet = new Set(payloadFiles);
  for (const rel of Object.keys(oldFiles)) {
    if (!payloadSet.has(rel)) removeStale(ctx, rel);
  }

  recordDirs(path.posix.dirname(MANIFEST_REL));
  const settings = applySettings(settingsPlan, old && old.settings);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    package: pkg.name,
    version: pkg.version,
    scope,
    target,
    installedAt: new Date().toISOString(),
    files,
    dirsCreated: [...dirsCreated].sort(),
    settings,
  };
  writeManifest(target, manifest);
  const { written, kept, skipped, removed } = report;
  return { scope, target, files: Object.keys(files), written, kept, skipped, removed, warnings, manifest };
}

module.exports = { install, listPayloadFiles, renderTemplate, helperPath };
