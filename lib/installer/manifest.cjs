'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./fs-safe.cjs');

const MANIFEST_REL = 'neat/manifest.json';
const MANIFEST_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;

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
};
