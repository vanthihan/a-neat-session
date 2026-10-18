'use strict';

// Stage selection by task type. Pure functions only: the CLI in neat.cjs
// loads and saves the run. run-state.cjs must not require this module.

const { PIPELINE } = require('./run-state.cjs');
const { UsageError } = require('./cli-args.cjs');

const TYPES = Object.freeze(['small-fix', 'feature', 'refactor', 'research', 'docs']);

// Worker stages per type. `plan` (the orchestrator's ownership step) is added
// whenever implement or docs runs; explore always runs because the type is
// judged from its report.
const TYPE_STAGES = Object.freeze({
  'small-fix': Object.freeze(['explore', 'implement', 'test']),
  feature: Object.freeze(['explore', 'implement', 'review', 'test', 'docs']),
  refactor: Object.freeze(['explore', 'implement', 'review', 'test', 'docs']),
  research: Object.freeze(['explore', 'research']),
  docs: Object.freeze(['explore', 'docs']),
});

// Statuses a new selection may change; done/running/cancelled are history.
const OPEN_STATUSES = Object.freeze(['pending', 'skipped']);

function selectStages(type, { research = false } = {}) {
  if (!TYPES.includes(type)) {
    throw new UsageError(`invalid --type '${type}' (use ${TYPES.join('|')})`);
  }
  const chosen = new Set(['explore', ...TYPE_STAGES[type]]);
  if (research) chosen.add('research');
  if (chosen.has('implement') || chosen.has('docs')) chosen.add('plan');
  return PIPELINE.filter((name) => chosen.has(name));
}

function entryOf(state, name) {
  const list = Array.isArray(state.stages) ? state.stages : [];
  return list.find((s) => s.name === name) || null;
}

// The selected pipeline stages: the recorded selection, else (no `stages`
// call yet, or a Phase 1 state) every pipeline stage present and not skipped.
function selectedOf(state) {
  if (Array.isArray(state.selectedStages)) return [...state.selectedStages];
  return PIPELINE.filter((name) => {
    const entry = entryOf(state, name);
    return entry !== null && entry.status !== 'skipped';
  });
}

// Pure: returns a new state with `type`, `selectedStages` and the stage
// entries rebuilt in PIPELINE order (a missing entry is inserted).
function applyStages(state, type, selected) {
  const stages = PIPELINE.map((name) => {
    const entry = entryOf(state, name) || { name, status: 'pending' };
    if (!OPEN_STATUSES.includes(entry.status)) return { ...entry };
    const keep = name === 'explore' || selected.includes(name);
    return { ...entry, status: keep ? 'pending' : 'skipped' };
  });
  return { ...state, type, selectedStages: [...selected], stages };
}

// True for a pipeline stage that is skipped or has no entry (Phase 1 states
// have no research entry).
function isSkipped(state, stage) {
  if (!PIPELINE.includes(stage)) return false;
  const entry = entryOf(state, stage);
  return entry === null || entry.status === 'skipped';
}

module.exports = { TYPES, selectStages, selectedOf, applyStages, isSkipped };
