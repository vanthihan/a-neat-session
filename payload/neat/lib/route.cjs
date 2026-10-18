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

// implementer-T* -> implementer, docs-D* -> docs, else the name itself.
function roleOf(worker) {
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

// Pure: { model, effort, stepdown } for one role.
function routeFor({ role, profile, complexity = DEFAULT_COMPLEXITY, usage = null, soft = DEFAULT_SOFT }) {
  if (profile === 'inherit') return { model: 'inherit', effort: 'none', stepdown: false };
  const cls = ROLE_CLASS[role];
  if (!cls) throw new Error(`unknown role '${role}'`);
  const [model, effort] = lookup(cls, profile, complexity);
  const stepdown = typeof usage === 'number' && Number.isFinite(usage) && usage >= soft;
  const tier = Math.max(0, TIERS.indexOf(model) - (stepdown ? 1 : 0));
  return { model: TIERS[tier], effort, stepdown };
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

// Full route record for `worker` in run `state`. The profile comes from the
// layered config (state.profile wins over project, global and default). Usage
// comes from the capture at the effective usage.capturePath, judged at `now`:
// at or above thresholds.soft the worker drops one tier; thresholds.hard
// decides the engine: at or above it a Codex-eligible worker goes to Codex
// when Codex is found. Codex is never probed below hard. Context usage is
// reported and never changes the route.
function routeWorker(root, state, worker, env = process.env, now = new Date(), home = os.homedir()) {
  const cfg = effectiveConfig({ root, env, home, state });
  const profile = cfg.profile;
  const role = roleOf(worker);
  const complexity = COMPLEXITIES.includes(state.complexity) ? state.complexity : DEFAULT_COMPLEXITY;
  const { usage, ctx } = readUsage(cfg.usage.capturePath, now);
  const r = routeFor({ role, profile, complexity, usage, soft: cfg.thresholds.soft });
  const hard = usage !== null && usage >= cfg.thresholds.hard;
  const onCodex = hard && codex.ELIGIBLE_ROLES.includes(role) && codex.detect(env).found;
  return {
    worker, model: r.model, effort: r.effort, profile, complexity, usage, stepdown: r.stepdown, hard, ctx,
    target: onCodex ? 'codex' : 'claude',
    action: 'run',
  };
}

// `neat route` accepts any run worker name or a bare role.
function assertRoutable(worker) {
  const ok = typeof worker === 'string' && (WORKER_NAME.test(worker) || ROLES.includes(worker));
  if (!ok) {
    throw new UsageError(`invalid worker '${worker}' (use ${ROLES.join('|')}|implementer-T<n>|docs-D<n>|--all)`);
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

module.exports = { TIERS, ROLES, roleOf, routeFor, formatRoute, routeWorker, envNotes, assertRoutable };
