'use strict';

// The next orchestrator step of a run, decided from its state and a few disk
// facts. nextStep is pure: every disk fact comes in through `facts`
// (runFacts). Lines hold only fixed text, ids, stage and section names, never
// report, brief or plan text.

const fs = require('node:fs');
const runState = require('./run-state.cjs');

// Pipeline stage -> section of the orchestrator procedure.
const SECTIONS = Object.freeze({
  explore: 'Explore',
  research: 'Research',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  test: 'Test',
  docs: 'Docs',
});

const TERMINAL = Object.freeze(['done', 'cancelled']);

function step(section, line) {
  return { section, line };
}

// { section, line }; section is null when there is nothing to resume. `facts`
// is { reports } from runFacts.
function nextStep(state, facts = {}) {
  const { id, stage } = state;
  if (TERMINAL.includes(stage)) return step(null, `run finished (stage=${stage}); nothing to resume`);
  if (stage === 'created') return step('Explore', `run stage ${id} explore, then the Worker loop with W = explorer`);
  const section = SECTIONS[stage];
  if (!section) return step(null, `unknown stage; run status to check run ${id}`);
  return step(section, `continue the ${section} section`);
}

// The `next:` line printed by `run resume` and injected by the hooks.
function formatNext(next) {
  return next.section ? `next: ${next.section} - ${next.line}` : next.line;
}

function runFiles(root, id) {
  try {
    return fs.readdirSync(runState.runDir(root, id));
  } catch {
    return [];
  }
}

// Disk facts nextStep needs: the sorted report file names of the run.
function runFacts(root, state) {
  const reports = runFiles(root, state.id).filter((n) => /^report-[a-z0-9-]+\.md$/i.test(n)).sort();
  return { reports };
}

module.exports = { SECTIONS, nextStep, formatNext, runFacts };
