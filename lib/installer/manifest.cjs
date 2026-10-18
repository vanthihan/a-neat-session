'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./fs-safe.cjs');

const MANIFEST_REL = 'neat/manifest.json';
const MANIFEST_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];
// The only settings scalar the installer may replace, and the only value it may set.
const SESSION_AGENT_KEY = 'agent';
const SESSION_AGENT = 'neat-orchestrator';
const MAX_PREVIOUS = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function manifestPath(target) {
  return path.join(target, ...MANIFEST_REL.split('/'));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Throws for malformed or absolute paths; returns true when the path has a `..` segment.
function checkRelPath(rel, what) {
  if (typeof rel !== 'string' || rel === '') throw new Error(`${what}: empty or non-string path`);
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) {
    throw new Error(`${what}: absolute path ${rel}`);
  }
  if (rel.includes('\\')) throw new Error(`${what}: ${rel} must use / separators`);
  const segments = rel.split('/');
  if (segments.some((s) => s === '')) throw new Error(`${what}: empty segment in ${rel}`);
  return segments.includes('..');
}

const isKeyPath = (p) => Array.isArray(p) && p.length > 0 && p.every((k) => typeof k === 'string' && k !== '');

const hasExactKeys = (o, keys) => Object.keys(o).sort().join('\0') === [...keys].sort().join('\0');

const isPlainPrevious = (p) =>
  isPlainObject(p) &&
  ((p.present === false && hasExactKeys(p, ['present'])) ||
    (p.present === true &&
      hasExactKeys(p, ['present', 'value']) &&
      typeof p.value === 'string' &&
      p.value.length >= 1 &&
      p.value.length <= MAX_PREVIOUS &&
      !CONTROL_CHARS.test(p.value)));

const isScalarRecord = (r) =>
  isPlainObject(r) &&
  hasExactKeys(r, ['path', 'value', 'previous']) &&
  Array.isArray(r.path) &&
  r.path.length === 1 &&
  r.path[0] === SESSION_AGENT_KEY &&
  r.value === SESSION_AGENT &&
  isPlainPrevious(r.previous);

// Uninstall writes `previous` back into settings, so only the session agent key,
// our own value and a short plain-string previous value are accepted.
function validateReplaced(replaced) {
  if (replaced === undefined) return;
  if (!Array.isArray(replaced) || replaced.length > 1 || !replaced.every(isScalarRecord)) {
    throw new Error('settings.replaced is malformed');
  }
}

// The settings record drives writes on uninstall, so only the two known file names are accepted.
function validateSettingsRecord(s) {
  if (!isPlainObject(s)) throw new Error('settings is not an object');
  if (!SETTINGS_FILES.includes(s.file)) throw new Error(`settings.file must be one of ${SETTINGS_FILES.join(', ')}`);
  if (s.backup !== null && s.backup !== `${s.file}.neat-bak`) throw new Error('settings.backup is not the expected name');
  if (typeof s.createdFile !== 'boolean') throw new Error('settings.createdFile is not a boolean');
  if (!Array.isArray(s.added) || !s.added.every((a) => isPlainObject(a) && isKeyPath(a.path) && 'value' in a)) {
    throw new Error('settings.added is malformed');
  }
  if (!Array.isArray(s.createdKeys) || !s.createdKeys.every(isKeyPath)) {
    throw new Error('settings.createdKeys is malformed');
  }
  validateReplaced(s.replaced);
}

// Throws on structural problems. Paths with `..` segments are returned in `unsafe`;
// callers refuse them (and assertInside guards every filesystem operation anyway).
function validateManifest(m) {
  if (!isPlainObject(m)) throw new Error('manifest is not an object');
  if (m.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`unsupported manifestVersion ${JSON.stringify(m.manifestVersion)}`);
  }
  if (!isPlainObject(m.files)) throw new Error('files is not an object');
  if (!Array.isArray(m.dirsCreated)) throw new Error('dirsCreated is not an array');
  const unsafe = [];
  for (const [rel, hash] of Object.entries(m.files)) {
    if (checkRelPath(rel, 'files')) unsafe.push(rel);
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error(`files: ${rel} has no sha256 hash`);
  }
  for (const rel of m.dirsCreated) {
    if (rel !== '.' && checkRelPath(rel, 'dirsCreated')) unsafe.push(rel);
  }
  if (m.settings !== undefined) validateSettingsRecord(m.settings);
  return { unsafe };
}

function readManifest(target) {
  const file = manifestPath(target);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`invalid manifest at ${file}: ${err.message}`);
  }
  try {
    const m = JSON.parse(raw);
    validateManifest(m);
    return m;
  } catch (err) {
    throw new Error(`invalid manifest at ${file}: ${err.message}`);
  }
}

function writeManifest(target, m) {
  validateManifest(m);
  atomicWrite(manifestPath(target), `${JSON.stringify(m, null, 2)}\n`);
}

module.exports = {
  MANIFEST_REL,
  MANIFEST_VERSION,
  sha256,
  manifestPath,
  readManifest,
  writeManifest,
  validateManifest,
  validateReplaced,
  SESSION_AGENT_KEY,
  SESSION_AGENT,
};
