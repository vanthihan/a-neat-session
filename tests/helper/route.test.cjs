'use strict';

// Routing table (profile x role x complexity), step-down, route line format,
// complexity classification and the `neat route` inspection command.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const route = require(path.join(LIB, 'route.cjs'));
const rs = require(path.join(LIB, 'run-state.cjs'));
const { PROFILES, UsageError } = require(path.join(LIB, 'cli-args.cjs'));
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

const COMPLEXITIES = ['trivial', 'normal', 'risky'];
const CLASS = {
  explorer: 'mechanical', docs: 'mechanical', tester: 'mechanical',
  implementer: 'mid', researcher: 'mid', reviewer: 'strong',
};
// Expected cells, written out independently of route.cjs.
const ADAPTIVE = {
  mechanical: { trivial: 'haiku/low', normal: 'haiku/medium', risky: 'haiku/high' },
  mid: { trivial: 'haiku/low', normal: 'sonnet/medium', risky: 'opus/high' },
  strong: { trivial: 'sonnet/medium', normal: 'opus/medium', risky: 'opus/high' },
};
const FIXED = {
  quality: { mechanical: 'sonnet/medium', mid: 'opus/high', strong: 'opus/high' },
  balanced: { mechanical: 'sonnet/medium', mid: 'sonnet/medium', strong: 'opus/medium' },
  budget: { mechanical: 'haiku/low', mid: 'haiku/low', strong: 'sonnet/medium' },
};

function expected(profile, role, complexity) {
  if (profile === 'inherit') return 'inherit/none';
  if (profile === 'adaptive') return ADAPTIVE[CLASS[role]][complexity];
  return FIXED[profile][CLASS[role]];
}

function cell(r) {
  return `${r.model}/${r.effort}`;
}

describe('routing table', () => {
  test('constants', () => {
    assert.deepEqual(route.TIERS, ['haiku', 'sonnet', 'opus']);
    assert.deepEqual(route.ROLES, ['explorer', 'researcher', 'implementer', 'reviewer', 'tester', 'docs']);
    assert.ok(Object.isFrozen(route.TIERS) && Object.isFrozen(route.ROLES));
  });

  test('every profile x role x complexity cell matches the table', () => {
    for (const profile of PROFILES) {
      for (const role of route.ROLES) {
        for (const complexity of COMPLEXITIES) {
          const r = route.routeFor({ role, profile, complexity });
          assert.equal(cell(r), expected(profile, role, complexity), `${profile} ${role} ${complexity}`);
          assert.equal(r.stepdown, false);
        }
      }
    }
  });

  test('adaptive keeps mechanical roles on haiku and orders implementer tiers by complexity', () => {
    for (const role of ['explorer', 'docs', 'tester']) {
      for (const complexity of COMPLEXITIES) {
        assert.equal(route.routeFor({ role, profile: 'adaptive', complexity }).model, 'haiku');
      }
    }
    const impl = COMPLEXITIES.map((complexity) => cell(route.routeFor({ role: 'implementer', profile: 'adaptive', complexity })));
    assert.deepEqual(impl, ['haiku/low', 'sonnet/medium', 'opus/high']);
    assert.equal(cell(route.routeFor({ role: 'reviewer', profile: 'adaptive' })), 'opus/medium');
  });

  test('inherit routes inherit/none and never steps down', () => {
    assert.deepEqual(route.routeFor({ role: 'reviewer', profile: 'inherit', usage: 99, soft: 70 }),
      { model: 'inherit', effort: 'none', stepdown: false });
  });

  test('usage at or above soft steps one tier down, floor haiku, effort unchanged', () => {
    const at = route.routeFor({ role: 'reviewer', profile: 'adaptive', usage: 70, soft: 70 });
    assert.deepEqual(at, { model: 'sonnet', effort: 'medium', stepdown: true });
    const below = route.routeFor({ role: 'reviewer', profile: 'adaptive', usage: 69.9, soft: 70 });
    assert.deepEqual(below, { model: 'opus', effort: 'medium', stepdown: false });
    const floor = route.routeFor({ role: 'explorer', profile: 'adaptive', complexity: 'risky', usage: 95, soft: 70 });
    assert.deepEqual(floor, { model: 'haiku', effort: 'high', stepdown: true });
    assert.equal(route.routeFor({ role: 'reviewer', profile: 'adaptive', usage: null, soft: 70 }).stepdown, false);
  });

  test('roleOf maps plan workers to their role', () => {
    assert.equal(route.roleOf('implementer-T3'), 'implementer');
    assert.equal(route.roleOf('docs-D1'), 'docs');
    assert.equal(route.roleOf('reviewer'), 'reviewer');
  });

  test('formatRoute uses the stable key order', () => {
    const line = route.formatRoute({
      worker: 'implementer-T1', model: 'sonnet', effort: 'medium', profile: 'adaptive',
      complexity: 'normal', usage: 72, stepdown: true, hard: false, ctx: null,
    });
    assert.equal(line, 'route worker=implementer-T1 model=sonnet effort=medium profile=adaptive complexity=normal usage=72% stepdown=yes hard=no ctx=unknown target=claude action=run');
  });

  test('envNotes names the env vars that override per-call values', () => {
    assert.deepEqual(route.envNotes({}), []);
    assert.deepEqual(route.envNotes({ CLAUDE_CODE_EFFORT_LEVEL: 'high' }),
      ['note: CLAUDE_CODE_EFFORT_LEVEL=high overrides the routed effort']);
    assert.deepEqual(route.envNotes({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }),
      ['note: CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 overrides the routed model']);
  });
});

describe('setComplexity', () => {
  test('is pure and validates the level', () => {
    assert.deepEqual(rs.COMPLEXITIES, COMPLEXITIES);
    const state = { id: 'x', complexity: undefined, workers: [] };
    const next = rs.setComplexity(state, 'risky');
    assert.equal(next.complexity, 'risky');
    assert.equal(state.complexity, undefined);
    assert.throws(() => rs.setComplexity(state, 'huge'), (err) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.message, "invalid complexity 'huge' (use trivial|normal|risky)");
      return true;
    });
  });
});

describe('CLI', () => {
  let proj;
  let env;

  before(() => {
    proj = makeTempDir('neat-routecli-');
    env = childEnv({ NEAT_PROJECT_DIR: proj });
  });

  after(() => removeDir(proj));

  function neat(args, input, extraEnv = {}) {
    return runNode([HELPER, ...args], { cwd: proj, env: { ...env, ...extraEnv }, input });
  }

  function newRun(taskText) {
    const res = neat(['run', 'new', '--stdin'], taskText);
    assert.equal(res.status, 0, res.stderr);
    const id = res.stdout.match(/^id=(\S+)/m)[1];
    return { id, dir: path.join(proj, '.neat', 'runs', id) };
  }

  function readState(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  }

  test('help lists run classify and route', () => {
    const res = neat(['help']);
    assert.match(res.stdout, /^neat run classify <run-id> <trivial\|normal\|risky>$/m);
    assert.match(res.stdout, /^neat route <run-id> <worker\|--all>$/m);
  });

  test('run classify stores the complexity and later briefs route from it', () => {
    const { id, dir } = newRun('risky change\n');
    const res = neat(['run', 'classify', id, 'risky']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'complexity risky\n');
    assert.equal(readState(dir).complexity, 'risky');
    const brief = neat(['brief', id, 'reviewer']);
    assert.equal(brief.status, 0, brief.stderr);
    assert.match(brief.stdout.split('\n')[1], /^route worker=reviewer model=opus effort=high profile=adaptive complexity=risky /);
  });

  test('trivial routes an implementer to haiku/low', () => {
    const { id } = newRun('tiny change\n');
    assert.equal(neat(['run', 'classify', id, 'trivial']).status, 0);
    const res = neat(['route', id, 'implementer-T1']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'route worker=implementer-T1 model=haiku effort=low profile=adaptive complexity=trivial usage=unknown stepdown=no hard=no ctx=unknown target=claude action=run\n');
  });

  test('run classify with an invalid level exits 2', () => {
    const { id } = newRun('bad level\n');
    const res = neat(['run', 'classify', id, 'huge']);
    assert.equal(res.status, 2);
    assert.equal(res.stderr, "neat: invalid complexity 'huge' (use trivial|normal|risky)\n");
    assert.equal(neat(['run', 'classify', id]).status, 2);
  });

  test('route --all prints one line per role in order; an unknown worker exits 2', () => {
    const { id, dir } = newRun('inspect routes\n');
    const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const res = neat(['route', id, '--all']);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.match(/^route worker=(\S+) /)[1]), route.ROLES);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'route must not change state');
    assert.equal(neat(['route', id, 'wizard']).status, 2);
    assert.equal(neat(['route', id]).status, 2);
  });

  test('route adds notes for env vars that override routing', () => {
    const { id } = newRun('env override\n');
    const effort = neat(['route', id, '--all'], undefined, { CLAUDE_CODE_EFFORT_LEVEL: 'high' });
    assert.equal(effort.status, 0, effort.stderr);
    assert.ok(effort.stdout.includes('note: CLAUDE_CODE_EFFORT_LEVEL=high overrides the routed effort\n'));
    const force = neat(['route', id, 'reviewer'], undefined, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    assert.equal(force.stdout.split('\n')[1], 'note: CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 overrides the routed model');
  });
});

describe('routeWorker usage step-down', () => {
  const NOW = new Date('2026-05-01T12:00:00Z');
  const FUTURE = Math.floor(NOW.getTime() / 1000) + 3600;
  let root;
  let cfgDir;
  let env;

  before(() => {
    root = makeTempDir('neat-route-usage-root-');
    cfgDir = makeTempDir('neat-route-usage-cfg-');
    env = { CLAUDE_CONFIG_DIR: cfgDir, NEAT_CODEX_BIN: 'none' };
    fs.mkdirSync(path.join(cfgDir, 'neat'));
  });

  after(() => {
    removeDir(root);
    removeDir(cfgDir);
  });

  function setCapture(fiveHour, ctx = null, file = path.join(cfgDir, 'neat', 'usage.json')) {
    const data = { context_window: { used_percentage: ctx } };
    if (fiveHour !== null) data.rate_limits = { five_hour: { used_percentage: fiveHour, resets_at: FUTURE } };
    fs.writeFileSync(file, JSON.stringify(data));
  }

  function setGlobal(obj) {
    const file = path.join(cfgDir, 'neat', 'config.json');
    if (obj === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(obj));
  }

  function line(worker, state = { profile: null, complexity: 'normal' }) {
    return route.formatRoute(route.routeWorker(root, state, worker, env, NOW, cfgDir));
  }

  test('usage 72 at soft 70 steps every worker one tier down, effort unchanged', () => {
    setGlobal(null);
    setCapture(72, 33);
    assert.equal(line('implementer-T1'),
      'route worker=implementer-T1 model=haiku effort=medium profile=adaptive complexity=normal usage=72% stepdown=yes hard=no ctx=33% target=claude action=run');
    assert.match(line('reviewer'), /^route worker=reviewer model=sonnet effort=medium .* usage=72% stepdown=yes hard=no ctx=33% target=claude action=run$/);
    assert.match(line('explorer'), /^route worker=explorer model=haiku effort=medium .* stepdown=yes /);
  });

  test('usage exactly at soft steps down; one below does not', () => {
    setGlobal(null);
    setCapture(70);
    assert.match(line('reviewer'), / model=sonnet .* usage=70% stepdown=yes .* ctx=unknown target=claude action=run$/);
    setCapture(69);
    assert.match(line('reviewer'), / model=opus .* usage=69% stepdown=no /);
  });

  test('usage at or above hard reports hard=yes and still drops exactly one tier', () => {
    setGlobal(null);
    setCapture(92);
    assert.match(line('reviewer'), / model=sonnet effort=medium .* usage=92% stepdown=yes hard=yes /);
  });

  test('inherit never steps down but still reports usage and hard', () => {
    setGlobal(null);
    setCapture(95);
    assert.match(line('reviewer', { profile: 'inherit' }),
      / model=inherit effort=none profile=inherit .* usage=95% stepdown=no hard=yes /);
  });

  test('no capture gives usage=unknown and no step-down', () => {
    setGlobal(null);
    fs.rmSync(path.join(cfgDir, 'neat', 'usage.json'), { force: true });
    assert.match(line('reviewer'), / model=opus .* usage=unknown stepdown=no hard=no ctx=unknown target=claude action=run$/);
  });

  test('global thresholds.soft 50 makes usage 55 step down', () => {
    setGlobal({ thresholds: { soft: 50 } });
    setCapture(55);
    assert.match(line('reviewer'), / model=sonnet .* usage=55% stepdown=yes hard=no /);
    setGlobal(null);
  });

  test('the capture is read from the global usage.capturePath', () => {
    const other = path.join(cfgDir, 'elsewhere.json');
    setCapture(10);
    setCapture(88, null, other);
    setGlobal({ usage: { capturePath: other } });
    assert.match(line('reviewer'), / usage=88% stepdown=yes /);
    setGlobal(null);
    assert.match(line('reviewer'), / usage=10% stepdown=no /);
  });
});
