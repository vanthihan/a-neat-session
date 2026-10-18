'use strict';

// Pure helpers for merging installer entries into a Claude Code settings object.
// Nothing here mutates its input; every function returns new objects.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (isPlainObject(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeysDeep(v[k])]),
    );
  }
  return v;
}

function stableStringify(v) {
  return JSON.stringify(sortKeysDeep(v));
}

// Walk to the parent object of keyPath's leaf, creating missing objects when `create`.
function parentOf(root, keyPath, create, createdKeys) {
  let node = root;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (node[key] === undefined) {
      if (!create) return null;
      node[key] = {};
      createdKeys.push(keyPath.slice(0, i + 1));
    }
    if (!isPlainObject(node[key])) throw new Error(`${keyPath.slice(0, i + 1).join('.')} is not an object`);
    node = node[key];
  }
  return node;
}

// additions: [{ path: ['permissions', 'allow'], value }]. Arrays get each value appended
// unless an equal item (stable JSON equality) is already present; existing order is kept.
function appendIfAbsent(settings, additions) {
  if (!isPlainObject(settings)) throw new Error('settings root is not an object');
  const next = structuredClone(settings);
  const added = [];
  const createdKeys = [];
  for (const { path: keyPath, value } of additions) {
    const parent = parentOf(next, keyPath, true, createdKeys);
    const leaf = keyPath[keyPath.length - 1];
    if (parent[leaf] === undefined) {
      parent[leaf] = [];
      createdKeys.push([...keyPath]);
    }
    if (!Array.isArray(parent[leaf])) throw new Error(`${keyPath.join('.')} is not an array`);
    const wanted = stableStringify(value);
    if (!parent[leaf].some((item) => stableStringify(item) === wanted)) {
      parent[leaf].push(structuredClone(value));
      added.push({ path: [...keyPath], value: structuredClone(value) });
    }
  }
  return { next, added, createdKeys };
}

const isEmptyContainer = (v) =>
  (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);

// Reverse appendIfAbsent: drop items equal to each added value, then delete created keys
// (deepest first) only when they are now empty.
function removeAdded(settings, added, createdKeys) {
  if (!isPlainObject(settings)) throw new Error('settings root is not an object');
  const next = structuredClone(settings);
  const removed = [];
  for (const entry of added) {
    const parent = parentOf(next, entry.path, false, []);
    const leaf = entry.path[entry.path.length - 1];
    if (!parent || !Array.isArray(parent[leaf])) continue;
    const unwanted = stableStringify(entry.value);
    const kept = parent[leaf].filter((item) => stableStringify(item) !== unwanted);
    if (kept.length !== parent[leaf].length) {
      parent[leaf] = kept;
      removed.push(entry);
    }
  }
  const byDepth = [...createdKeys].sort((a, b) => b.length - a.length);
  for (const keyPath of byDepth) {
    let parent;
    try {
      parent = parentOf(next, keyPath, false, []);
    } catch {
      continue;
    }
    const leaf = keyPath[keyPath.length - 1];
    if (parent && isEmptyContainer(parent[leaf])) delete parent[leaf];
  }
  return { next, removed };
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function scalarKey(keyPath) {
  if (!Array.isArray(keyPath) || keyPath.length !== 1 || typeof keyPath[0] !== 'string' || keyPath[0] === '') {
    throw new Error('scalar key path must name one top-level key');
  }
  return keyPath[0];
}

// Set one top-level scalar and describe what it replaced, so restoreScalar can undo it.
// Returns { next, record: { path, value, previous: { present, value? } } }.
function setScalar(settings, keyPath, value) {
  if (!isPlainObject(settings)) throw new Error('settings root is not an object');
  const key = scalarKey(keyPath);
  const next = structuredClone(settings);
  const previous = hasOwn(settings, key) ? { present: true, value: structuredClone(settings[key]) } : { present: false };
  next[key] = structuredClone(value);
  return { next, record: { path: [key], value: structuredClone(value), previous } };
}

// Undo setScalar, but only while the key still holds the value we set: a value
// the user changed afterwards is theirs. Returns { next, restored }.
function restoreScalar(settings, record) {
  if (!isPlainObject(settings)) throw new Error('settings root is not an object');
  const key = scalarKey(record.path);
  const next = structuredClone(settings);
  if (!hasOwn(settings, key) || stableStringify(settings[key]) !== stableStringify(record.value)) {
    return { next, restored: false };
  }
  if (record.previous.present) next[key] = structuredClone(record.previous.value);
  else delete next[key];
  return { next, restored: true };
}

module.exports = { stableStringify, appendIfAbsent, removeAdded, setScalar, restoreScalar };
