'use strict';

// Layered, strictly validated config:
//   defaults <- global <claude-config-dir>/neat/config.json
//            <- project <root>/.neat/config.json
//            <- run (--profile stored in state.json)
// Both files are optional. A present but invalid file is a UsageError (exit 2)
// naming the file. The project file cannot set helper paths (usage.capturePath).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageError, PROFILES, DEFAULT_PROFILE } = require('./cli-args.cjs');

const DEFAULTS = Object.freeze({
  profile: DEFAULT_PROFILE,
  thresholds: Object.freeze({ soft: 70, hard: 90 }),
  usage: Object.freeze({ capturePath: null }),
});

// Allowed keys per section; a key not listed here is a config error.
const SCHEMA = Object.freeze({
  profile: null,
  thresholds: Object.freeze(['soft', 'hard']),
  usage: Object.freeze(['capturePath']),
});

const KEYS = Object.freeze(['profile', 'thresholds.soft', 'thresholds.hard', 'usage.capturePath']);

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

function checkThreshold(name, value, fail) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  if (!ok) fail(`thresholds.${name} must be a number from 0 to 100`);
}

function checkSection(name, value, fail) {
  if (!isObject(value)) fail(`${name} must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (!SCHEMA[name].includes(key)) fail(`unknown key '${name}.${key}'`);
  }
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
      checkThreshold(key, data.thresholds[key], fail);
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
}

// Effective config with a source per value and both file paths.
function effectiveConfig({ root, env = process.env, home = os.homedir(), state = null } = {}) {
  const globalFile = globalConfigPath(env, home);
  const projectFile = projectConfigPath(root);
  const cfg = {
    profile: DEFAULTS.profile,
    thresholds: { ...DEFAULTS.thresholds },
    usage: { capturePath: defaultCapturePath(env, home) },
  };
  const sources = Object.fromEntries(KEYS.map((k) => [k, 'default']));
  layer(cfg, sources, readConfigFile(globalFile, { scope: 'global', home }), 'global');
  layer(cfg, sources, readConfigFile(projectFile, { scope: 'project', home }), 'project');
  if (state && PROFILES.includes(state.profile)) layer(cfg, sources, { profile: state.profile }, 'run');
  const { soft, hard } = cfg.thresholds;
  if (soft > hard) {
    throw new UsageError(`invalid config: thresholds.soft (${soft}) must be <= thresholds.hard (${hard})`);
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
