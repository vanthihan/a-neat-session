'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function helperPath(target) {
  return path.join(target, 'neat', 'bin', 'neat.cjs');
}

function install({ scope, target, payloadDir }) {
  if (!path.isAbsolute(target)) throw new Error(`install target must be absolute: ${target}`);
  const vars = { NEAT_BIN: helperPath(target) };
  const files = listPayloadFiles(payloadDir);
  for (const rel of files) {
    const src = path.join(payloadDir, ...rel.split('/'));
    const dest = path.join(target, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (rel.endsWith('.md')) {
      fs.writeFileSync(dest, renderTemplate(fs.readFileSync(src, 'utf8'), vars));
    } else {
      fs.writeFileSync(dest, fs.readFileSync(src));
      fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
    }
  }
  return { scope, target, files };
}

module.exports = { install, listPayloadFiles, renderTemplate, helperPath };
