'use strict';

// Deterministic model and effort routing per worker:
// profile x role weight x task complexity, with a one-tier step-down when usage
// is at or above the soft threshold. Output values come only from the frozen
// tables below, never from config or environment strings.

const os = require('node:os');
const { effectiveConfig } = require('./config.cjs');
const { UsageError } = require('./cli-args.cjs');
const { COMPLEXITIES, WORKER_NAME } = require('./run-state.cjs');
const { readUsage, formatPercent } = require('./usage.cjs');
const codex = require('./codex.cjs');

const TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);
const ROLES = Object.freeze(['explorer', 'researcher', 'implementer', 'reviewer', 'tester', 'docs']);
const DEFAULT_COMPLEXITY = 'normal';
const DEFAULT_SOFT = 70;
// The second reviewer runs beside `reviewer` on another model: on Codex when
// it is available, else on the alternate Claude tier of the primary reviewer.
const SECOND_REVIEWER = 'reviewer-2';
// Primary reviewer tier (before step-down) -> second reviewer tier. The
// session model behind `inherit` is unknown and assumed strong.
const ALTERNATE_TIER = Object.freeze({ opus: 'sonnet', sonnet: 'opus', haiku: 'opus', inherit: 'sonnet' });

const ROLE_CLASS = Object.freeze({
  explorer: 'mechanical',
  docs: 'mechanical',
  tester: 'mechanical',
  implementer: 'mid',
  researcher: 'mid',
  reviewer: 'strong',
});

const ADAPTIVE = Object.freeze({
  mechanical: Object.freeze({ trivial: ['haiku', 'low'], normal: ['haiku', 'medium'], risky: ['haiku', 'high'] }),
  mid: Object.freeze({ trivial: ['haiku', 'low'], normal: ['sonnet', 'medium'], risky: ['opus', 'high'] }),
  strong: Object.freeze({ trivial: ['sonnet', 'medium'], normal: ['opus', 'medium'], risky: ['opus', 'high'] }),
});

// Fixed profiles ignore complexity.
const FIXED = Object.freeze({
  quality: Object.freeze({ mechanical: ['sonnet', 'medium'], mid: ['opus', 'high'], strong: ['opus', 'high'] }),
  balanced: Object.freeze({ mechanical: ['sonnet', 'medium'], mid: ['sonnet', 'medium'], strong: ['opus', 'medium'] }),
  budget: Object.freeze({ mechanical: ['haiku', 'low'], mid: ['haiku', 'low'], strong: ['sonnet', 'medium'] }),
});

// implementer-T* -> implementer, docs-D* -> docs, reviewer-2 -> reviewer,
// else the name itself.
function roleOf(worker) {
  if (worker === SECOND_REVIEWER) return 'reviewer';
  if (worker.startsWith('implementer-')) return 'implementer';
  if (worker.startsWith('docs-')) return 'docs';
  return worker;
}

function lookup(cls, profile, complexity) {
  if (profile === 'adaptive') {
    const cell = ADAPTIVE[cls][complexity];
    if (!cell) throw new Error(`unknown complexity '${complexity}'`);
    return cell;
  }
  const fixed = FIXED[profile];
  if (!fixed) throw new Error(`unknown profile '${profile}'`);
  return fixed[cls];
}

function atSoft(usage, soft) {
  return typeof usage === 'number' && Number.isFinite(usage) && usage >= soft;
}

// One tier down when `stepdown`, floor haiku.
function stepTier(model, stepdown) {
  return TIERS[Math.max(0, TIERS.indexOf(model) - (stepdown ? 1 : 0))];
}

// Pure: { model, effort, stepdown } for one role.
function routeFor({ role, profile, complexity = DEFAULT_COMPLEXITY, usage = null, soft = DEFAULT_SOFT }) {
  if (profile === 'inherit') return { model: 'inherit', effort: 'none', stepdown: false };
  const cls = ROLE_CLASS[role];
  if (!cls) throw new Error(`unknown role '${role}'`);
  const [model, effort] = lookup(cls, profile, complexity);
  const stepdown = atSoft(usage, soft);
  return { model: stepTier(model, stepdown), effort, stepdown };
}

// Pure: the second reviewer's Claude route. The primary reviewer's cell
// without step-down moves to the alternate tier (effort kept), then the same
// soft step-down applies (never under the inherit profile), so the two
// reviewers always run on different models.
function secondReviewerFor({ profile, complexity = DEFAULT_COMPLEXITY, usage = null, soft = DEFAULT_SOFT }) {
  const primary = routeFor({ role: 'reviewer', profile, complexity });
  const stepdown = profile !== 'inherit' && atSoft(usage, soft);
  return { model: stepTier(ALTERNATE_TIER[primary.model], stepdown), effort: primary.effort, stepdown };
}

function yesNo(flag) {
  return flag ? 'yes' : 'no';
}

// One route line, stable key order.
function formatRoute(r) {
  return [
    'route',
    `worker=${r.worker}`,
    `model=${r.model}`,
    `effort=${r.effort}`,
    `profile=${r.profile}`,
    `complexity=${r.complexity}`,
    `usage=${formatPercent(r.usage)}`,
    `stepdown=${yesNo(r.stepdown)}`,
    `hard=${yesNo(r.hard)}`,
    `ctx=${formatPercent(r.ctx)}`,
    `target=${r.target || 'claude'}`,
    `action=${r.action || 'run'}`,
  ].join(' ');
}

// { target, action } for `worker`. At or above hard a Codex-eligible worker
// goes to Codex when Codex is available, every other worker pauses; the
// second reviewer is skipped there when Codex is available (the primary
// reviewer already runs on it). Below hard only the second reviewer may go to
// Codex; every other worker stays on Claude and Codex is not probed for it.
function engineFor(worker, role, hard, cfg, env) {
  const codexReady = () => codex.eligible(role, cfg) && codex.availability(cfg, env).available;
  if (worker === SECOND_REVIEWER) {
    if (hard) return { target: 'claude', action: codexReady() ? 'skip' : 'pause' };
    return { target: codexReady() ? 'codex' : 'claude', action: 'run' };
  }
  if (!hard) return { target: 'claude', action: 'run' };
  return codexReady() ? { target: 'codex', action: 'run' } : { target: 'claude', action: 'pause' };
}

// Full route record for `worker` in run `state`. The profile comes from the
// layered config (state.profile wins over project, global and default). Usage
// comes from the capture at the effective usage.capturePath, judged at `now`:
// at or above thresholds.soft the worker drops one tier; thresholds.hard
// decides the engine (engineFor). The second reviewer's model is the
// alternate tier (secondReviewerFor); on Codex it is the Claude fallback.
// Context usage is reported and never changes the route.
function routeWorker(root, state, worker, env = process.env, now = new Date(), home = os.homedir()) {
  const cfg = effectiveConfig({ root, env, home, state });
  const profile = cfg.profile;
  const role = roleOf(worker);
  const complexity = COMPLEXITIES.includes(state.complexity) ? state.complexity : DEFAULT_COMPLEXITY;
  const { usage, ctx } = readUsage(cfg.usage.capturePath, now);
  const args = { role, profile, complexity, usage, soft: cfg.thresholds.soft };
  const r = worker === SECOND_REVIEWER ? secondReviewerFor(args) : routeFor(args);
  const hard = usage !== null && usage >= cfg.thresholds.hard;
  const { target, action } = engineFor(worker, role, hard, cfg, env);
  return {
    worker, model: r.model, effort: r.effort, profile, complexity, usage, stepdown: r.stepdown, hard, ctx, target, action,
  };
}

// `neat route` accepts any run worker name or a bare role.
function assertRoutable(worker) {
  const ok = typeof worker === 'string' && (WORKER_NAME.test(worker) || ROLES.includes(worker));
  if (!ok) {
    throw new UsageError(`invalid worker '${worker}' (use ${ROLES.join('|')}|${SECOND_REVIEWER}|implementer-T<n>|docs-D<n>|--all)`);
  }
}

const SAFE_ENV_VALUE = /^[A-Za-z0-9._-]{1,32}$/;

function shown(value) {
  return SAFE_ENV_VALUE.test(value) ? value : '(set)';
}

// Notes for environment variables that override the per-call model or effort.
function envNotes(env = process.env) {
  const notes = [];
  const effort = env.CLAUDE_CODE_EFFORT_LEVEL;
  if (effort) notes.push(`note: CLAUDE_CODE_EFFORT_LEVEL=${shown(effort)} overrides the routed effort`);
  const force = env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  if (force && force !== '0' && force.toLowerCase() !== 'false') {
    notes.push(`note: CLAUDE_CODE_SUBAGENT_MODEL_FORCE=${shown(force)} overrides the routed model`);
  }
  return notes;
}

module.exports = {
  TIERS, ROLES, SECOND_REVIEWER, roleOf, routeFor, secondReviewerFor, formatRoute, routeWorker, envNotes, assertRoutable,
};
