'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { helperPath, settingsFileName } = require('./paths.cjs');
const { atomicWrite, assertInside, lstatKind } = require('./fs-safe.cjs');
const {
  MANIFEST_REL,
  MANIFEST_VERSION,
  SESSION_AGENT,
  SESSION_AGENT_KEY,
  sha256,
  readManifest,
  writeManifest,
  validateReplaced,
} = require('./manifest.cjs');
const { stableStringify, appendIfAbsent, removeAdded, setScalar } = require('./settings-merge.cjs');
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

// Payload files under this prefix are the helper runtime that the settings rule
// pre-authorizes; they must all be ours before any settings are written.
const RUNTIME_PREFIX = 'neat/';

// True when placeFile would skip `rel` (foreign file, or not a regular file).
function wouldSkip({ target, oldFiles, force }, rel, data) {
  const abs = assertInside(target, rel);
  const kind = lstatKind(abs);
  if (kind === 'missing') return false;
  if (kind !== 'file') return true;
  return sha256(fs.readFileSync(abs)) !== sha256(data) && !oldFiles[rel] && !force;
}

// Refuse the whole install (before any write) when a helper runtime file exists
// and is not ours: granting the permission rule would pre-authorize foreign code.
function assertRuntimeOwned(ctx, rendered) {
  const blocked = rendered
    .filter((f) => f.rel.startsWith(RUNTIME_PREFIX) && wouldSkip(ctx, f.rel, f.data))
    .map((f) => f.rel);
  if (blocked.length === 0) return;
  throw new Error(
    `helper files exist and are not owned by a-neat-session: ${blocked.join(', ')}; ` +
      'nothing was installed (re-run with --force or remove them)',
  );
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

// One settings hook entry that runs `node <helper> hook <name>` (the helper
// path is shell-safe, checked before install).
function hookEntry(target, name, matcher, timeout) {
  return {
    matcher,
    hooks: [{ type: 'command', command: `node ${helperPath(target)} hook ${name}`, timeout }],
  };
}

// The worker agents whose final report the SubagentStop hook checks (never
// the session agent).
const WORKER_MATCHER = 'neat-explorer|neat-researcher|neat-implementer|neat-reviewer|neat-tester|neat-docs';

// Everything the installer adds to the scope's settings file; uninstall
// takes back exactly the entries recorded in the manifest.
function settingsAdditions(target) {
  return [
    { path: ALLOW_PATH, value: permissionRule(target) },
    { path: ['hooks', 'SessionStart'], value: hookEntry(target, 'session-start', 'compact|resume|clear', 10) },
    { path: ['hooks', 'SubagentStop'], value: hookEntry(target, 'subagent-stop', WORKER_MATCHER, 30) },
  ];
}

function unionBy(a, b) {
  const seen = new Map();
  for (const item of [...a, ...b]) seen.set(stableStringify(item), item);
  return [...seen.values()];
}

// Split the entries an older install recorded into those still added today and
// stale ones (changed or dropped since), compared by stable equality.
function splitRecorded(recorded, additions) {
  const wanted = new Set(additions.map((a) => stableStringify({ path: a.path, value: a.value })));
  const kept = [];
  const stale = [];
  for (const entry of recorded) {
    (wanted.has(stableStringify({ path: entry.path, value: entry.value })) ? kept : stale).push(entry);
  }
  return { kept, stale };
}

const STICKY_NOTE =
  `the session agent stays ${SESSION_AGENT} (set by an earlier install; --uninstall restores the previous value)`;

// Decide the session agent scalar. A recorded opt-in stays (keeping its first
// previous value) while the setting still holds our agent; the flag sets it.
function planScalar(data, old, orchestratorDefault, abs) {
  const oldRecord = old && old.replaced ? old.replaced[0] : null;
  const setNote = `session agent set to ${SESSION_AGENT} in ${abs}`;
  if (oldRecord && data[SESSION_AGENT_KEY] === SESSION_AGENT) {
    return { next: data, replaced: [oldRecord], note: orchestratorDefault ? setNote : STICKY_NOTE };
  }
  if (!orchestratorDefault) return { next: data, replaced: null, note: null };
  const { next, record } = setScalar(data, [SESSION_AGENT_KEY], SESSION_AGENT);
  try {
    validateReplaced([record]);
  } catch {
    throw new Error(`the current ${SESSION_AGENT_KEY} value is not a short plain string; change or remove it`);
  }
  return { next, replaced: [record], note: setNote };
}

// Read and merge the settings file BEFORE any payload write, so a broken file aborts cleanly.
// Reconcile first: recorded entries the installer no longer adds are taken out.
function planSettings(target, scope, oldSettings, orchestratorDefault) {
  const file = settingsFileName(scope);
  const current = readSettings(target, file);
  const old = oldSettings && oldSettings.file === file ? oldSettings : null;
  const additions = settingsAdditions(target);
  try {
    const { kept, stale } = splitRecorded(old ? old.added : [], additions);
    const pruned = removeAdded(current.data, stale, old ? old.createdKeys : []).next;
    const merge = appendIfAbsent(pruned, additions);
    const scalar = planScalar(merge.next, old, orchestratorDefault, current.abs);
    return {
      file,
      current,
      old,
      next: scalar.next,
      added: unionBy(kept, merge.added),
      createdKeys: unionBy(old ? old.createdKeys : [], merge.createdKeys),
      replaced: scalar.replaced,
      notes: scalar.note ? [scalar.note] : [],
    };
  } catch (err) {
    throw new Error(`cannot update ${current.abs}: ${err.message}; fix or remove it, then re-run`);
  }
}

// Write the planned settings when anything changed (backing the original up once)
// and describe it for the manifest.
function applySettings(plan) {
  const { file, current, old, next } = plan;
  const backupAbs = `${current.abs}.neat-bak`;
  if (stableStringify(next) !== stableStringify(current.data)) {
    if (current.exists && lstatKind(backupAbs) === 'missing') fs.copyFileSync(current.abs, backupAbs);
    writeSettings(current, next);
  }
  const record = {
    file,
    backup: lstatKind(backupAbs) === 'missing' ? null : `${file}.neat-bak`,
    createdFile: old ? old.createdFile : !current.exists,
    added: plan.added,
    createdKeys: plan.createdKeys,
  };
  if (plan.replaced) record.replaced = plan.replaced;
  return record;
}

function install({ scope, target, payloadDir, force = false, orchestratorDefault = false }) {
  if (!path.isAbsolute(target)) throw new Error(`install target must be absolute: ${target}`);
  const old = readManifest(target);
  const settingsPlan = planSettings(target, scope, old && old.settings, orchestratorDefault);
  const oldFiles = old ? old.files : {};
  const vars = { NEAT_BIN: helperPath(target) };
  const payloadFiles = listPayloadFiles(payloadDir);

  const warnings = [];
  const report = { written: [], kept: [], skipped: [], removed: [], warn: (w) => warnings.push(w) };
  const dirsCreated = new Set(old ? old.dirsCreated : []);
  const recordDirs = (relDir) => missingDirs(target, relDir).forEach((d) => dirsCreated.add(d));
  const ctx = { target, oldFiles, force, report, recordDirs };

  const rendered = payloadFiles.map((rel) => ({ rel, ...renderPayloadFile(payloadDir, rel, vars) }));
  assertRuntimeOwned(ctx, rendered);
  const files = {};
  for (const { rel, data, mode } of rendered) {
    const hash = placeFile(ctx, rel, data, mode);
    if (hash) files[rel] = hash;
  }
  const payloadSet = new Set(payloadFiles);
  for (const rel of Object.keys(oldFiles)) {
    if (!payloadSet.has(rel)) removeStale(ctx, rel);
  }

  recordDirs(path.posix.dirname(MANIFEST_REL));
  const settings = applySettings(settingsPlan);
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
  const notes = settingsPlan.notes;
  return { scope, target, files: Object.keys(files), written, kept, skipped, removed, warnings, notes, manifest };
}

module.exports = { install, listPayloadFiles, renderTemplate, helperPath, settingsAdditions, hookEntry };
