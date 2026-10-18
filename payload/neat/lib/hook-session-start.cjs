'use strict';

// SessionStart hook: after a compaction (or a resumed session) it tells the
// session which neat run is active and what comes next, so the orchestrator
// can continue without asking again. Only ids, mode, stage and helper-built
// lines are injected, never report, brief or plan text.

const runState = require('./run-state.cjs');
const { nextStep, formatNext, runFacts } = require('./next-step.cjs');
const { MAX_HOOK_OUTPUT } = require('./hooks.cjs');

const INJECT_SOURCES = Object.freeze(['compact', 'resume']);
const WORD = /^[a-z][a-z-]{0,31}$/;

// A state field shown as a plain word, or `unknown`.
function word(value) {
  return typeof value === 'string' && WORD.test(value) ? value : 'unknown';
}

function contextLines(state, root, helper) {
  const { id } = state;
  const next = nextStep(state, runFacts(root, state));
  return [
    `neat run ${id} is active (mode=${word(state.mode)}, stage=${word(state.stage)}).`,
    formatNext(next),
    `If the neat steps are no longer in your context, run /neat:resume ${id} (or: node ${helper} run resume ${id}).`,
  ];
}

function output(text) {
  const additionalContext = text.slice(0, MAX_HOOK_OUTPUT);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
}

function sessionStart(input, env, { root, helper }) {
  if (!INJECT_SOURCES.includes(input.source) || !root) return '';
  const [state] = runState.activeRuns(root, runState.currentTime(env));
  if (!state) return '';
  return output(contextLines(state, root, helper).join('\n'));
}

module.exports = { sessionStart };
