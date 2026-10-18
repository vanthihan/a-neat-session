'use strict';

// Deterministic model and effort routing per worker:
// profile x role weight x task complexity, with a one-tier step-down when usage
// is at or above the soft threshold. Output values come only from the frozen
// tables below, never from config or environment strings.

const os = require('node:os');
const { effectiveConfig } = require('./config.cjs');

const TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);
const ROLES = Object.freeze(['explorer', 'researcher', 'implementer', 'reviewer', 'tester', 'docs']);
const COMPLEXITY_LEVELS = Object.freeze(['trivial', 'normal', 'risky']);
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

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : 'unknown';
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
    `usage=${percent(r.usage)}`,
    `stepdown=${yesNo(r.stepdown)}`,
    `hard=${yesNo(r.hard)}`,
    `ctx=${percent(r.ctx)}`,
  ].join(' ');
}

// Full route record for `worker` in run `state`. The profile comes from the
// layered config (state.profile wins over project, global and default).
// `now` is reserved for the usage reading.
function routeWorker(root, state, worker, env = process.env, now = new Date(), home = os.homedir()) {
  const cfg = effectiveConfig({ root, env, home, state });
  const profile = cfg.profile;
  const complexity = COMPLEXITY_LEVELS.includes(state.complexity) ? state.complexity : DEFAULT_COMPLEXITY;
  const usage = null;
  const ctx = null;
  const r = routeFor({ role: roleOf(worker), profile, complexity, usage, soft: cfg.thresholds.soft });
  return { worker, model: r.model, effort: r.effort, profile, complexity, usage, stepdown: r.stepdown, hard: false, ctx };
}

module.exports = { TIERS, ROLES, roleOf, routeFor, formatRoute, routeWorker };
