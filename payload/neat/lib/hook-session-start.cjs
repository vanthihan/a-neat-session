'use strict';

// SessionStart hook. After a compaction or a resumed session it tells the
// session which neat run of this session is active and what comes next, so
// the orchestrator can continue without asking again; after /clear it points
// at the newest unfinished run. Only ids, mode, stage, one sanitized task line
// and helper-built lines are injected, never report, brief or plan text.

const runState = require('./run-state.cjs');
const { nextStep, formatNext, runFacts, safeWord } = require('./next-step.cjs');
const { MAX_HOOK_OUTPUT } = require('./hooks.cjs');

const SAME_SESSION_SOURCES = Object.freeze(['compact', 'resume']);
const MAX_TASK_LINE = 80;
// ANSI escape sequences (CSI with parameters, or a single-character escape).
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// First line of the task, escape sequences and control characters removed,
// at most MAX_TASK_LINE characters ('' when nothing is left).
function taskLine(task) {
  const first = String(task || '').split('\n')[0];
  return first.replace(ANSI, '').replace(/\t/g, ' ').replace(CONTROL, '').trim().slice(0, MAX_TASK_LINE).trim();
}

function activeLines(state, root, helper) {
  const { id } = state;
  const task = taskLine(state.task);
  return [
    `neat run ${id} is active (mode=${safeWord(state.mode)}, stage=${safeWord(state.stage)}).`,
    ...(task ? [`task: ${task}`] : []),
    formatNext(nextStep(state, { ...runFacts(root, state), helper })),
    `If the neat steps are no longer in your context, run /neat:resume ${id} (or: node ${helper} run resume ${id}).`,
  ];
}

function output(lines) {
  const additionalContext = lines.join('\n').slice(0, MAX_HOOK_OUTPUT);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } });
}

// The run this session was working on: recorded with this session id, or
// with no session id at all; the newest such run.
function sessionRun(runs, sessionId) {
  return runs.find((s) => s.sessionId === null || s.sessionId === undefined || s.sessionId === sessionId) || null;
}

function sessionStart(input, env, { root, helper }) {
  const { source } = input;
  if (!root || (source !== 'clear' && !SAME_SESSION_SOURCES.includes(source))) return '';
  const runs = runState.activeRuns(root, runState.currentTime(env));
  if (source === 'clear') {
    const [newest] = runs;
    if (!newest) return '';
    const { id } = newest;
    return output([`neat run ${id} is unfinished (stage=${safeWord(newest.stage)}): run /neat:resume ${id} to continue it.`]);
  }
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  const state = sessionRun(runs, sessionId);
  return state ? output(activeLines(state, root, helper)) : '';
}

module.exports = { sessionStart };
