'use strict';

// Layered, strictly validated config:
//   defaults <- global <claude-config-dir>/neat/config.json
//            <- project <root>/.neat/config.json
//            <- run (--profile stored in state.json)
// Both files are optional. A present but invalid file is a UsageError (exit 2)
// naming the file. The project file cannot set helper paths (usage.capturePath)
// and may only switch Codex off; the Codex model and sandbox are global-only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageError, PROFILES, DEFAULT_PROFILE } = require('./cli-args.cjs');

const DEFAULTS = Object.freeze({
  profile: DEFAULT_PROFILE,
  thresholds: Object.freeze({ soft: 70, hard: 90 }),
  usage: Object.freeze({ capturePath: null }),
  codex: Object.freeze({ enabled: 'auto', model: null, sandboxDefault: 'workspace-write' }),
  review: Object.freeze({ maxRounds: 2 }),
  context: Object.freeze({ warn: 60, critical: 75 }),
  filter: Object.freeze({ enabled: true }),
});

const CODEX_ENABLED = Object.freeze(['auto', 'on', 'off']);
const CODEX_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_REVIEW_ROUNDS = 5;

// Allowed keys per section; a key not listed here is a config error.
const SCHEMA = Object.freeze({
  profile: null,
  thresholds: Object.freeze(['soft', 'hard']),
  usage: Object.freeze(['capturePath']),
  codex: Object.freeze(['enabled', 'model', 'sandboxDefault']),
  review: Object.freeze(['maxRounds']),
  context: Object.freeze(['warn', 'critical']),
  filter: Object.freeze(['enabled']),
});

const KEYS = Object.freeze([
  'profile', 'thresholds.soft', 'thresholds.hard', 'usage.capturePath',
  'codex.enabled', 'codex.model', 'codex.sandboxDefault', 'review.maxRounds',
  'context.warn', 'context.critical', 'filter.enabled',
]);

// Local copy of the installer's expandTilde: the payload is installed on its
// own and cannot require the installer package.
function expandTilde(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

function configDir(env = process.env, home = os.homedir()) {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) return path.resolve(expandTilde(configured, home));
  return path.join(home, '.claude');
}

function globalConfigPath(env = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), 'neat', 'config.json');
}

function projectConfigPath(root) {
  return path.join(root, '.neat', 'config.json');
}

function defaultCapturePath(env = process.env, home = os.homedir()) {
  return path.join(configDir(env, home), 'neat', 'usage.json');
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkPercent(key, value, fail) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  if (!ok) fail(`${key} must be a number from 0 to 100`);
}

function checkSection(name, value, fail) {
  if (!isObject(value)) fail(`${name} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!SCHEMA[name].includes(key)) fail(`unknown key '${name}.${key}'`);
  }
}

function validateCodex(value, scope, fail) {
  checkSection('codex', value, fail);
  const out = {};
  if ('enabled' in value) {
    if (!CODEX_ENABLED.includes(value.enabled)) fail(`codex.enabled must be one of ${CODEX_ENABLED.join('|')}`);
    if (scope === 'project' && value.enabled !== 'off') fail('codex.enabled may only be off in the project config');
    out.enabled = value.enabled;
  }
  if ('model' in value) {
    if (scope === 'project') fail('codex.model is only allowed in the global config');
    if (typeof value.model !== 'string' || !CODEX_MODEL.test(value.model)) {
      fail('codex.model must match [A-Za-z0-9._:-] (1-64 characters, starting with a letter or digit)');
    }
    out.model = value.model;
  }
  if ('sandboxDefault' in value) {
    if (scope === 'project') fail('codex.sandboxDefault is only allowed in the global config');
    if (!CODEX_SANDBOXES.includes(value.sandboxDefault)) {
      fail(`codex.sandboxDefault must be one of ${CODEX_SANDBOXES.join('|')}`);
    }
    out.sandboxDefault = value.sandboxDefault;
  }
  return out;
}

// Allowed in both scopes: a project can only add rounds the user is asked about.
function validateReview(value, fail) {
  checkSection('review', value, fail);
  if (!('maxRounds' in value)) return {};
  const n = value.maxRounds;
  if (!Number.isInteger(n) || n < 0 || n > MAX_REVIEW_ROUNDS) {
    fail(`review.maxRounds must be an integer from 0 to ${MAX_REVIEW_ROUNDS}`);
  }
  return { maxRounds: n };
}

// Allowed in both scopes: context thresholds only add warnings and the filter
// switch only turns a feature off.
function validateContext(value, fail) {
  checkSection('context', value, fail);
  for (const key of Object.keys(value)) checkPercent(`context.${key}`, value[key], fail);
  return { ...value };
}

function validateFilter(value, fail) {
  checkSection('filter', value, fail);
  if ('enabled' in value && typeof value.enabled !== 'boolean') fail('filter.enabled must be true or false');
  return { ...value };
}

// Validates one parsed file; returns a normalised copy (capturePath expanded).
function validate(data, { scope, home, fail }) {
  if (!isObject(data)) fail('must be a JSON object');
  for (const key of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) fail(`unknown key '${key}'`);
  }
  const out = {};
  if ('profile' in data) {
    if (!PROFILES.includes(data.profile)) fail(`profile must be one of ${PROFILES.join('|')}`);
    out.profile = data.profile;
  }
  if ('thresholds' in data) {
    checkSection('thresholds', data.thresholds, fail);
    out.thresholds = {};
    for (const key of Object.keys(data.thresholds)) {
      checkPercent(`thresholds.${key}`, data.thresholds[key], fail);
      out.thresholds[key] = data.thresholds[key];
    }
  }
  if ('usage' in data) {
    checkSection('usage', data.usage, fail);
    if ('capturePath' in data.usage) {
      if (scope === 'project') fail('usage.capturePath is only allowed in the global config');
      const raw = data.usage.capturePath;
      if (typeof raw !== 'string' || raw === '') fail('usage.capturePath must be an absolute path');
      const expanded = expandTilde(raw, home);
      if (!path.isAbsolute(expanded)) fail('usage.capturePath must be an absolute path');
      out.usage = { capturePath: path.resolve(expanded) };
    }
  }
  if ('codex' in data) out.codex = validateCodex(data.codex, scope, fail);
  if ('review' in data) out.review = validateReview(data.review, fail);
  if ('context' in data) out.context = validateContext(data.context, fail);
  if ('filter' in data) out.filter = validateFilter(data.filter, fail);
  return out;
}

// Missing file -> {}. Otherwise strict JSON plus key/value validation.
function readConfigFile(file, { scope = 'global', home = os.homedir() } = {}) {
  const abs = path.resolve(file);
  const fail = (msg) => {
    throw new UsageError(`invalid config ${abs}: ${msg}`);
  };
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    return fail(err.message);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail(err.message);
  }
  return validate(data, { scope, home, fail });
}

function layer(cfg, sources, data, source) {
  if (data.profile !== undefined) {
    cfg.profile = data.profile;
    sources.profile = source;
  }
  for (const key of ['soft', 'hard']) {
    if (data.thresholds && data.thresholds[key] !== undefined) {
      cfg.thresholds[key] = data.thresholds[key];
      sources[`thresholds.${key}`] = source;
    }
  }
  if (data.usage && data.usage.capturePath !== undefined) {
    cfg.usage.capturePath = data.usage.capturePath;
    sources['usage.capturePath'] = source;
  }
  for (const section of ['codex', 'review', 'context', 'filter']) {
    for (const key of SCHEMA[section]) {
      if (data[section] && data[section][key] !== undefined) {
        cfg[section][key] = data[section][key];
        sources[`${section}.${key}`] = source;
      }
    }
  }
}

// Effective config with a source per value and both file paths.
function effectiveConfig({ root, env = process.env, home = os.homedir(), state = null } = {}) {
  const globalFile = globalConfigPath(env, home);
  const projectFile = projectConfigPath(root);
  const cfg = {
    profile: DEFAULTS.profile,
    thresholds: { ...DEFAULTS.thresholds },
    usage: { capturePath: defaultCapturePath(env, home) },
    codex: { ...DEFAULTS.codex },
    review: { ...DEFAULTS.review },
    context: { ...DEFAULTS.context },
    filter: { ...DEFAULTS.filter },
  };
  const sources = Object.fromEntries(KEYS.map((k) => [k, 'default']));
  layer(cfg, sources, readConfigFile(globalFile, { scope: 'global', home }), 'global');
  layer(cfg, sources, readConfigFile(projectFile, { scope: 'project', home }), 'project');
  if (state && PROFILES.includes(state.profile)) layer(cfg, sources, { profile: state.profile }, 'run');
  const { soft, hard } = cfg.thresholds;
  if (soft > hard) {
    throw new UsageError(`invalid config: thresholds.soft (${soft}) must be <= thresholds.hard (${hard})`);
  }
  const { warn, critical } = cfg.context;
  if (warn > critical) {
    throw new UsageError(`invalid config: context.warn (${warn}) must be <= context.critical (${critical})`);
  }
  return {
    ...cfg,
    sources,
    files: {
      global: { path: globalFile, exists: fs.existsSync(globalFile) },
      project: { path: projectFile, exists: fs.existsSync(projectFile) },
    },
  };
}

function configValue(cfg, key) {
  if (key === 'profile') return cfg.profile;
  if (key === 'thresholds.soft') return String(cfg.thresholds.soft);
  if (key === 'thresholds.hard') return String(cfg.thresholds.hard);
  if (key === 'usage.capturePath') return cfg.usage.capturePath;
  if (key === 'codex.enabled') return cfg.codex.enabled;
  if (key === 'codex.model') return cfg.codex.model || '(unset)';
  if (key === 'codex.sandboxDefault') return cfg.codex.sandboxDefault;
  if (key === 'review.maxRounds') return String(cfg.review.maxRounds);
  if (key === 'context.warn') return String(cfg.context.warn);
  if (key === 'context.critical') return String(cfg.context.critical);
  if (key === 'filter.enabled') return String(cfg.filter.enabled);
  throw new UsageError(`unknown config key '${key}' (use ${KEYS.join('|')})`);
}

function configLines(cfg) {
  const fileLine = (name, f) => `${name}=${f.path} (${f.exists ? 'found' : 'missing'})`;
  return [
    ...KEYS.map((key) => `${key}=${configValue(cfg, key)} (${cfg.sources[key]})`),
    fileLine('global', cfg.files.global),
    fileLine('project', cfg.files.project),
  ];
}

module.exports = {
  DEFAULTS,
  configDir,
  globalConfigPath,
  projectConfigPath,
  defaultCapturePath,
  readConfigFile,
  effectiveConfig,
  configLines,
  configValue,
};
