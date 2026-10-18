'use strict';

// Layered strict config: defaults <- global <- project <- run (--profile).
// Pure functions get injected env/home/root; CLI cases use temp
// NEAT_PROJECT_DIR and CLAUDE_CONFIG_DIR so the real ~/.claude is never read.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const config = require(path.join(LIB, 'config.cjs'));
const { UsageError } = require(path.join(LIB, 'cli-args.cjs'));
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

const dirs = [];
after(() => dirs.forEach(removeDir));

function tmp(prefix) {
  const d = makeTempDir(prefix);
  dirs.push(d);
  return d;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

// A fresh home, config dir and project root per case.
function layout() {
  const home = tmp('neat-home-');
  const cfgDir = tmp('neat-cfgdir-');
  const root = tmp('neat-root-');
  const env = { CLAUDE_CONFIG_DIR: cfgDir };
  return {
    home,
    root,
    env,
    globalFile: path.join(cfgDir, 'neat', 'config.json'),
    projectFile: path.join(root, '.neat', 'config.json'),
    effective: (state) => config.effectiveConfig({ root, env, home, state }),
  };
}

function configError(fn, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.exitCode, 2);
    if (message instanceof RegExp) assert.match(err.message, message);
    else assert.equal(err.message, message);
    return true;
  });
}

describe('paths', () => {
  test('CLAUDE_CONFIG_DIR sets the global file; ~/ expands against home', () => {
    assert.equal(config.configDir({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), path.resolve('/c'));
    assert.equal(config.configDir({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/h'), path.join('/h', 'cfg'));
    assert.equal(config.globalConfigPath({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), path.join('/c', 'neat', 'config.json'));
    assert.equal(config.defaultCapturePath({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), path.join('/c', 'neat', 'usage.json'));
  });

  test('without CLAUDE_CONFIG_DIR the global file lives under <home>/.claude', () => {
    assert.equal(config.configDir({}, '/h'), path.join('/h', '.claude'));
    assert.equal(config.configDir({ CLAUDE_CONFIG_DIR: '' }, '/h'), path.join('/h', '.claude'));
    assert.equal(config.globalConfigPath({}, '/h'), path.join('/h', '.claude', 'neat', 'config.json'));
  });

  test('project file is <root>/.neat/config.json', () => {
    assert.equal(config.projectConfigPath('/p'), path.join('/p', '.neat', 'config.json'));
  });
});

describe('effectiveConfig layering', () => {
  test('no files -> defaults, every source default', () => {
    const l = layout();
    const cfg = l.effective();
    assert.equal(cfg.profile, 'adaptive');
    assert.deepEqual(cfg.thresholds, { soft: 70, hard: 90 });
    assert.equal(cfg.usage.capturePath, path.join(l.env.CLAUDE_CONFIG_DIR, 'neat', 'usage.json'));
    assert.deepEqual(cfg.sources, {
      profile: 'default',
      'thresholds.soft': 'default',
      'thresholds.hard': 'default',
      'usage.capturePath': 'default',
      'codex.enabled': 'default',
      'codex.model': 'default',
      'codex.sandboxDefault': 'default',
    });
    assert.deepEqual(cfg.codex, { enabled: 'auto', model: null, sandboxDefault: 'workspace-write' });
    assert.deepEqual(cfg.files, {
      global: { path: l.globalFile, exists: false },
      project: { path: l.projectFile, exists: false },
    });
    assert.ok(Object.isFrozen(config.DEFAULTS));
  });

  test('project overrides global, the run overrides both', () => {
    const l = layout();
    writeJson(l.globalFile, { profile: 'budget' });
    assert.deepEqual([l.effective().profile, l.effective().sources.profile], ['budget', 'global']);
    writeJson(l.projectFile, { profile: 'quality' });
    assert.deepEqual([l.effective().profile, l.effective().sources.profile], ['quality', 'project']);
    const run = l.effective({ profile: 'inherit' });
    assert.deepEqual([run.profile, run.sources.profile], ['inherit', 'run']);
    assert.equal(l.effective({ profile: null }).profile, 'quality');
  });

  test('thresholds merge per key across files', () => {
    const l = layout();
    writeJson(l.globalFile, { thresholds: { soft: 60 } });
    writeJson(l.projectFile, { thresholds: { hard: 80 } });
    const cfg = l.effective();
    assert.deepEqual(cfg.thresholds, { soft: 60, hard: 80 });
    assert.equal(cfg.sources['thresholds.soft'], 'global');
    assert.equal(cfg.sources['thresholds.hard'], 'project');
  });

  test('global usage.capturePath is used; ~/ expands against home', () => {
    const l = layout();
    writeJson(l.globalFile, { usage: { capturePath: '~/x.json' } });
    const cfg = l.effective();
    assert.equal(cfg.usage.capturePath, path.join(l.home, 'x.json'));
    assert.equal(cfg.sources['usage.capturePath'], 'global');
  });
});

describe('validation', () => {
  test('invalid JSON names the absolute path', () => {
    const l = layout();
    writeJson(l.projectFile, '{ "profile": }');
    configError(() => l.effective(), new RegExp(`^invalid config ${l.projectFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
  });

  test('top level must be an object', () => {
    for (const bad of ['[]', '"budget"', 'null', '3']) {
      const l = layout();
      writeJson(l.globalFile, bad);
      configError(() => l.effective(), `invalid config ${l.globalFile}: must be a JSON object`);
    }
  });

  test('unknown keys are rejected', () => {
    const l = layout();
    writeJson(l.projectFile, { profle: 'budget' });
    configError(() => l.effective(), `invalid config ${l.projectFile}: unknown key 'profle'`);
    const l2 = layout();
    writeJson(l2.projectFile, { thresholds: { sofft: 3 } });
    configError(() => l2.effective(), `invalid config ${l2.projectFile}: unknown key 'thresholds.sofft'`);
  });

  test('profile must be in the enum', () => {
    const l = layout();
    writeJson(l.globalFile, { profile: 'fast' });
    configError(
      () => l.effective(),
      `invalid config ${l.globalFile}: profile must be one of adaptive|quality|balanced|budget|inherit`,
    );
  });

  test('thresholds must be numbers from 0 to 100', () => {
    for (const soft of ['70', -1, 101, null, true]) {
      const l = layout();
      writeJson(l.globalFile, { thresholds: { soft } });
      configError(() => l.effective(), `invalid config ${l.globalFile}: thresholds.soft must be a number from 0 to 100`);
    }
    const l = layout();
    writeJson(l.globalFile, { thresholds: 5 });
    configError(() => l.effective(), `invalid config ${l.globalFile}: thresholds must be a JSON object`);
  });

  test('merged soft above hard is rejected', () => {
    const l = layout();
    writeJson(l.projectFile, { thresholds: { soft: 95 } });
    configError(() => l.effective(), 'invalid config: thresholds.soft (95) must be <= thresholds.hard (90)');
  });

  test('usage.capturePath must be absolute and is refused in the project file', () => {
    const l = layout();
    writeJson(l.globalFile, { usage: { capturePath: 'rel/usage.json' } });
    configError(() => l.effective(), `invalid config ${l.globalFile}: usage.capturePath must be an absolute path`);
    const l2 = layout();
    writeJson(l2.projectFile, { usage: { capturePath: '/tmp/x.json' } });
    configError(
      () => l2.effective(),
      `invalid config ${l2.projectFile}: usage.capturePath is only allowed in the global config`,
    );
  });

  test('readConfigFile returns {} for a missing file', () => {
    assert.deepEqual(config.readConfigFile(path.join(tmp('neat-none-'), 'nope.json')), {});
  });
});

describe('codex settings', () => {
  test('global config accepts every codex key with valid values', () => {
    const l = layout();
    writeJson(l.globalFile, { codex: { enabled: 'on', model: 'gpt-x.1:mini', sandboxDefault: 'read-only' } });
    const cfg = l.effective();
    assert.deepEqual(cfg.codex, { enabled: 'on', model: 'gpt-x.1:mini', sandboxDefault: 'read-only' });
    assert.equal(cfg.sources['codex.enabled'], 'global');
    assert.equal(cfg.sources['codex.model'], 'global');
    assert.equal(config.configValue(cfg, 'codex.model'), 'gpt-x.1:mini');
    for (const enabled of ['auto', 'off']) {
      writeJson(l.globalFile, { codex: { enabled } });
      assert.equal(l.effective().codex.enabled, enabled);
    }
  });

  test('invalid codex values and unknown codex keys are config errors', () => {
    const l = layout();
    const cases = [
      [{ codex: { enabled: 'yes' } }, 'codex.enabled must be one of auto|on|off'],
      [{ codex: { model: 'a b' } }, 'codex.model must match [A-Za-z0-9._:-] (1-64 characters, starting with a letter or digit)'],
      [{ codex: { model: '-x' } }, 'codex.model must match [A-Za-z0-9._:-] (1-64 characters, starting with a letter or digit)'],
      [{ codex: { model: 7 } }, 'codex.model must match [A-Za-z0-9._:-] (1-64 characters, starting with a letter or digit)'],
      [{ codex: { sandboxDefault: 'danger-full-access' } }, 'codex.sandboxDefault must be one of read-only|workspace-write'],
      [{ codex: { approval: 'never' } }, "unknown key 'codex.approval'"],
      [{ codex: 'on' }, 'codex must be a JSON object'],
    ];
    for (const [value, reason] of cases) {
      writeJson(l.globalFile, value);
      configError(() => l.effective(), `invalid config ${l.globalFile}: ${reason}`);
    }
  });

  test('the project config may only switch codex off', () => {
    const l = layout();
    writeJson(l.globalFile, { codex: { enabled: 'auto' } });
    writeJson(l.projectFile, { codex: { enabled: 'off' } });
    const cfg = l.effective();
    assert.equal(cfg.codex.enabled, 'off');
    assert.equal(cfg.sources['codex.enabled'], 'project');
    for (const enabled of ['auto', 'on']) {
      writeJson(l.projectFile, { codex: { enabled } });
      configError(() => l.effective(),
        `invalid config ${l.projectFile}: codex.enabled may only be off in the project config`);
    }
    writeJson(l.projectFile, { codex: { model: 'gpt-x' } });
    configError(() => l.effective(), `invalid config ${l.projectFile}: codex.model is only allowed in the global config`);
    writeJson(l.projectFile, { codex: { sandboxDefault: 'read-only' } });
    configError(() => l.effective(),
      `invalid config ${l.projectFile}: codex.sandboxDefault is only allowed in the global config`);
  });
});

describe('configLines and configValue', () => {
  test('show lines carry value and source plus both file paths', () => {
    const l = layout();
    writeJson(l.globalFile, { profile: 'balanced' });
    const lines = config.configLines(l.effective());
    assert.deepEqual(lines, [
      'profile=balanced (global)',
      'thresholds.soft=70 (default)',
      'thresholds.hard=90 (default)',
      `usage.capturePath=${path.join(l.env.CLAUDE_CONFIG_DIR, 'neat', 'usage.json')} (default)`,
      'codex.enabled=auto (default)',
      'codex.model=(unset) (default)',
      'codex.sandboxDefault=workspace-write (default)',
      `global=${l.globalFile} (found)`,
      `project=${l.projectFile} (missing)`,
    ]);
  });

  test('configValue prints bare values and rejects unknown keys', () => {
    const cfg = layout().effective();
    assert.equal(config.configValue(cfg, 'profile'), 'adaptive');
    assert.equal(config.configValue(cfg, 'thresholds.soft'), '70');
    assert.equal(config.configValue(cfg, 'thresholds.hard'), '90');
    assert.ok(path.isAbsolute(config.configValue(cfg, 'usage.capturePath')));
    configError(
      () => config.configValue(cfg, 'nope'),
      "unknown config key 'nope' (use profile|thresholds.soft|thresholds.hard|usage.capturePath|codex.enabled|codex.model|codex.sandboxDefault)",
    );
  });
});

describe('CLI', () => {
  let proj;
  let cfgDir;
  let env;

  before(() => {
    proj = tmp('neat-cfgcli-');
    cfgDir = tmp('neat-cfgcli-home-');
    env = childEnv({ NEAT_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfgDir });
  });

  function neat(args, input) {
    return runNode([HELPER, ...args], { cwd: proj, env, input });
  }

  function projectConfig(value) {
    const file = path.join(proj, '.neat', 'config.json');
    if (value === undefined) fs.rmSync(file, { force: true });
    else writeJson(file, value);
  }

  test('config show prints defaults with sources and both paths', () => {
    const res = neat(['config', 'show']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.trimEnd().split('\n'), [
      'profile=adaptive (default)',
      'thresholds.soft=70 (default)',
      'thresholds.hard=90 (default)',
      `usage.capturePath=${path.join(cfgDir, 'neat', 'usage.json')} (default)`,
      'codex.enabled=auto (default)',
      'codex.model=(unset) (default)',
      'codex.sandboxDefault=workspace-write (default)',
      `global=${path.join(cfgDir, 'neat', 'config.json')} (missing)`,
      `project=${path.join(proj, '.neat', 'config.json')} (missing)`,
    ]);
  });

  test('config get prints the bare value; an unknown key exits 2', () => {
    const res = neat(['config', 'get', 'thresholds.soft']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '70\n');
    assert.equal(neat(['config', 'get', 'codex.enabled']).stdout, 'auto\n');
    assert.equal(neat(['config', 'get', 'codex.model']).stdout, '(unset)\n');
    assert.equal(neat(['config', 'get', 'codex.sandboxDefault']).stdout, 'workspace-write\n');
    const bad = neat(['config', 'get', 'nope']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown config key 'nope'/);
    assert.equal(neat(['config', 'get']).status, 2);
    assert.equal(neat(['config', 'frob']).status, 2);
  });

  test('config show <run-id> reports the run profile', () => {
    const run = neat(['run', 'new', '--stdin'], '--profile budget fix it\n');
    assert.equal(run.status, 0, run.stderr);
    const id = run.stdout.match(/^id=(\S+)/)[1];
    const res = neat(['config', 'show', id]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^profile=budget \(run\)$/m);
  });

  test('run new with an invalid project config exits 2 and creates no run', () => {
    const runs = path.join(proj, '.neat', 'runs');
    const before = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
    projectConfig({ profle: 'budget' });
    try {
      const res = neat(['run', 'new', '--stdin'], 'fix it\n');
      assert.equal(res.status, 2);
      assert.equal(res.stderr, `neat: invalid config ${path.join(proj, '.neat', 'config.json')}: unknown key 'profle'\n`);
      const after = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
      assert.equal(after, before);
      assert.equal(neat(['config', 'show']).status, 2);
    } finally {
      projectConfig(undefined);
    }
  });

  test('brief routes with the project profile unless the run used --profile', () => {
    projectConfig({ profile: 'budget' });
    try {
      const plain = neat(['run', 'new', '--stdin'], 'plain run\n');
      const plainId = plain.stdout.match(/^id=(\S+)/)[1];
      const a = neat(['brief', plainId, 'reviewer']);
      assert.equal(a.status, 0, a.stderr);
      assert.match(a.stdout.split('\n')[1], /^route worker=reviewer model=sonnet effort=medium profile=budget /);
      const flagged = neat(['run', 'new', '--stdin'], '--profile quality flagged run\n');
      const flaggedId = flagged.stdout.match(/^id=(\S+)/)[1];
      const b = neat(['brief', flaggedId, 'reviewer']);
      assert.match(b.stdout.split('\n')[1], /^route worker=reviewer model=opus effort=high profile=quality /);
      projectConfig('{ broken');
      assert.equal(neat(['brief', plainId, 'reviewer']).status, 2);
    } finally {
      projectConfig(undefined);
    }
  });
});

describe('test env isolation', () => {
  test('childEnv points CLAUDE_CONFIG_DIR at an existing empty temp dir by default', () => {
    const env = childEnv();
    assert.ok(env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR must be set');
    assert.ok(fs.statSync(env.CLAUDE_CONFIG_DIR).isDirectory());
    assert.notEqual(path.resolve(env.CLAUDE_CONFIG_DIR), path.join(require('node:os').homedir(), '.claude'));
    assert.equal(childEnv().CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
  });

  test('an explicit CLAUDE_CONFIG_DIR override is kept', () => {
    assert.equal(childEnv({ CLAUDE_CONFIG_DIR: '/x/cfg' }).CLAUDE_CONFIG_DIR, '/x/cfg');
  });
});
