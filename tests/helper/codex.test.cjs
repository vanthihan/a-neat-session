'use strict';

// Codex detection, availability from config, eligibility, sandbox choice, the
// exact `codex exec` argv, and the `codex detect|run` CLI refusals. Codex is
// always the fake shim; the real binary is never reachable.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO_ROOT, childEnv, runNode, makeTempDir, removeDir, installFakeCodex,
} = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const codex = require(path.join(LIB, 'codex.cjs'));
const { UsageError } = require(path.join(LIB, 'cli-args.cjs'));
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

const ARG_ALLOWLIST = ['exec', '-s', '-C', '--skip-git-repo-check', '-c', '-o', '-'];

let binDir;
let shim;

before(() => {
  binDir = makeTempDir('neat-codex-bin-');
  shim = installFakeCodex(binDir);
});

after(() => removeDir(binDir));

function cfgOf(codexCfg = {}) {
  return { codex: { enabled: 'auto', model: null, sandboxDefault: 'workspace-write', ...codexCfg } };
}

function usageError(fn, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err && err.message}`);
    if (message) assert.match(err.message, message);
    return true;
  });
}

describe('detect', () => {
  test('an absolute NEAT_CODEX_BIN shim is found with its version', () => {
    assert.deepEqual({ ...codex.detect({ NEAT_CODEX_BIN: shim }) }, { found: true, path: shim, version: '9.9.9' });
  });

  test('none, a relative path, a missing file or a directory is not found', () => {
    for (const bin of ['none', 'codex', path.join(binDir, 'missing'), binDir]) {
      assert.equal(codex.detect({ NEAT_CODEX_BIN: bin, PATH: binDir }).found, false, bin);
    }
  });

  test('without NEAT_CODEX_BIN the first executable codex on PATH is used', () => {
    const r = codex.detect({ PATH: ['relative/dir', binDir].join(path.delimiter) });
    assert.equal(r.found, true);
    assert.equal(r.path, shim);
    assert.equal(codex.detect({ PATH: '' }).found, false);
  });

  test('guard: childEnv defaults NEAT_CODEX_BIN to none, and none beats PATH', () => {
    assert.equal(childEnv().NEAT_CODEX_BIN, 'none');
    assert.equal(childEnv({ NEAT_CODEX_BIN: shim }).NEAT_CODEX_BIN, shim);
    assert.equal(childEnv().TMUX, undefined);
    assert.equal(codex.detect({ NEAT_CODEX_BIN: 'none', PATH: binDir }).found, false);
  });
});

describe('availability and eligibility', () => {
  test('off is unavailable, auto/on follow detection, on + missing is required', () => {
    assert.deepEqual(pick(codex.availability(cfgOf({ enabled: 'off' }), { NEAT_CODEX_BIN: shim })),
      { available: false, required: false });
    assert.deepEqual(pick(codex.availability(cfgOf({ enabled: 'auto' }), { NEAT_CODEX_BIN: shim })),
      { available: true, required: false });
    assert.deepEqual(pick(codex.availability(cfgOf({ enabled: 'on' }), { NEAT_CODEX_BIN: shim })),
      { available: true, required: true });
    assert.deepEqual(pick(codex.availability(cfgOf({ enabled: 'on' }), { NEAT_CODEX_BIN: 'none' })),
      { available: false, required: true });
    assert.deepEqual(pick(codex.availability(cfgOf({ enabled: 'auto' }), { NEAT_CODEX_BIN: 'none' })),
      { available: false, required: false });
  });

  test('eligible: four roles; write roles only while sandboxDefault is workspace-write', () => {
    assert.deepEqual([...codex.ELIGIBLE_ROLES], ['implementer', 'tester', 'docs', 'reviewer']);
    for (const role of codex.ELIGIBLE_ROLES) assert.equal(codex.eligible(role, cfgOf()), true, role);
    for (const role of ['explorer', 'researcher']) assert.equal(codex.eligible(role, cfgOf()), false, role);
    const ro = cfgOf({ sandboxDefault: 'read-only' });
    assert.equal(codex.eligible('reviewer', ro), true);
    for (const role of ['implementer', 'tester', 'docs']) assert.equal(codex.eligible(role, ro), false, role);
  });

  test('sandboxFor: reviewer read-only, write roles flag > default', () => {
    assert.equal(codex.sandboxFor('reviewer', null, cfgOf()), 'read-only');
    assert.equal(codex.sandboxFor('reviewer', 'read-only', cfgOf()), 'read-only');
    usageError(() => codex.sandboxFor('reviewer', 'workspace-write', cfgOf()), /reviewer/);
    assert.equal(codex.sandboxFor('implementer', null, cfgOf()), 'workspace-write');
    assert.equal(codex.sandboxFor('implementer', 'read-only', cfgOf()), 'read-only');
    assert.equal(codex.sandboxFor('tester', null, cfgOf({ sandboxDefault: 'read-only' })), 'read-only');
    usageError(() => codex.sandboxFor('docs', 'danger-full-access', cfgOf()), /invalid --sandbox/);
  });
});

function pick(a) {
  return { available: a.available, required: a.required };
}

describe('buildExecArgs', () => {
  const base = { sandbox: 'read-only', root: '/p', outputPath: '/p/out.md' };

  test('maps every effort; max becomes xhigh; none omits the setting', () => {
    const table = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };
    for (const [effort, mapped] of Object.entries(table)) {
      const args = codex.buildExecArgs({ ...base, effort });
      assert.deepEqual(args, ['exec', '-s', 'read-only', '-C', '/p', '--skip-git-repo-check',
        '-c', `model_reasoning_effort=${mapped}`, '-o', '/p/out.md', '-']);
    }
    assert.deepEqual(codex.buildExecArgs({ ...base, effort: 'none' }),
      ['exec', '-s', 'read-only', '-C', '/p', '--skip-git-repo-check', '-o', '/p/out.md', '-']);
  });

  test('rejects values outside the tables', () => {
    assert.throws(() => codex.buildExecArgs({ ...base, effort: 'bogus' }), /invalid effort/);
    assert.throws(() => codex.buildExecArgs({ ...base, effort: 'constructor' }), /invalid effort/);
    assert.throws(() => codex.buildExecArgs({ ...base, sandbox: 'danger-full-access' }), /invalid sandbox/);
    for (const model of ['-x', 'a b', 'x'.repeat(65)]) {
      assert.throws(() => codex.buildExecArgs({ ...base, effort: 'low', model }), /invalid codex model/, model);
    }
  });

  test('every emitted flag is on the allowlist; the model uses --model=<v>', () => {
    const args = codex.buildExecArgs({ ...base, sandbox: 'workspace-write', effort: 'high', model: 'gpt-x' });
    assert.ok(args.includes('--model=gpt-x'));
    const flags = args.filter((a) => a.startsWith('-') && !a.startsWith('--model='));
    for (const f of flags) assert.ok(ARG_ALLOWLIST.includes(f), f);
    assert.deepEqual(args.slice(-3), ['-o', '/p/out.md', '-']);
  });
});

describe('CLI', () => {
  let proj;
  let cfg;
  let log;
  let env;

  before(() => {
    proj = makeTempDir('neat-codexcli-');
    cfg = makeTempDir('neat-codexcli-cfg-');
    log = path.join(cfg, 'calls.jsonl');
    env = childEnv({ NEAT_PROJECT_DIR: proj, CLAUDE_CONFIG_DIR: cfg, NEAT_CODEX_BIN: shim, FAKE_CODEX_LOG: log });
  });

  after(() => {
    removeDir(proj);
    removeDir(cfg);
  });

  function neat(args, extra = {}, input) {
    return runNode([HELPER, ...args], { cwd: proj, env: { ...env, ...extra }, input });
  }

  function setGlobal(obj) {
    const file = path.join(cfg, 'neat', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (obj === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(obj));
  }

  function newRun(task) {
    const res = neat(['run', 'new', '--stdin'], {}, `${task}\n`);
    assert.equal(res.status, 0, res.stderr);
    const id = res.stdout.match(/^id=(\S+)/m)[1];
    return { id, dir: path.join(proj, '.neat', 'runs', id) };
  }

  function jobFiles(dir) {
    const jobsDir = path.join(dir, 'jobs');
    return fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [];
  }

  function execCalls() {
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((c) => c.argv[0] === 'exec');
  }

  // codex run + wait; returns the argv codex received.
  function runAndWait(id, worker, flags = [], extra = {}) {
    fs.rmSync(log, { force: true });
    const res = neat(['codex', 'run', id, worker, ...flags], extra);
    assert.equal(res.status, 0, res.stderr);
    const job = res.stdout.match(/^job=(\S+)/)[1];
    const waited = neat(['codex', 'wait', job]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.match(waited.stdout, /status=done/);
    return execCalls()[0].argv;
  }

  function sandboxOf(argv) {
    return argv[argv.indexOf('-s') + 1];
  }

  test('codex detect: yes, no, on + missing exits 1, off notes it without probing', () => {
    setGlobal(null);
    assert.equal(neat(['codex', 'detect']).stdout, 'codex=yes version=9.9.9\n');
    const none = neat(['codex', 'detect'], { NEAT_CODEX_BIN: 'none' });
    assert.deepEqual([none.status, none.stdout], [0, 'codex=no\n']);
    const broken = neat(['codex', 'detect'], { FAKE_CODEX_VERSION_EXIT: '1' });
    assert.deepEqual([broken.status, broken.stdout], [0, 'codex=no\n']);
    setGlobal({ codex: { enabled: 'on' } });
    const required = neat(['codex', 'detect'], { NEAT_CODEX_BIN: 'none' });
    assert.deepEqual([required.status, required.stdout], [1, 'codex=no\n']);
    setGlobal({ codex: { enabled: 'off' } });
    fs.rmSync(log, { force: true });
    const off = neat(['codex', 'detect']);
    assert.deepEqual([off.status, off.stdout], [0, 'codex=no\nnote: codex.enabled is off\n']);
    assert.equal(fs.existsSync(log), false, 'off must not run codex');
    setGlobal(null);
  });

  test('run new with codex.enabled on and no codex exits 2 and creates no run', () => {
    setGlobal({ codex: { enabled: 'on' } });
    try {
      const runs = path.join(proj, '.neat', 'runs');
      const before = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
      const res = neat(['run', 'new', '--stdin'], { NEAT_CODEX_BIN: 'none' }, 'needs codex\n');
      assert.equal(res.status, 2);
      assert.match(res.stderr, /codex\.enabled is on but codex was not found/);
      const after = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
      assert.equal(after, before);
      const ok = neat(['run', 'new', '--stdin'], {}, 'codex present\n');
      assert.equal(ok.status, 0, ok.stderr);
    } finally {
      setGlobal(null);
    }
  });

  test('codex run refuses ineligible workers, unavailable codex and bad flags without a job', () => {
    setGlobal(null);
    const { id, dir } = newRun('refusals');
    for (const w of ['explorer', 'researcher', 'reviewer']) assert.equal(neat(['brief', id, w]).status, 0);
    const cases = [
      [['explorer'], {}, /explorer runs on Claude only/],
      [['researcher'], {}, /researcher runs on Claude only/],
      [['reviewer'], { NEAT_CODEX_BIN: 'none' }, /codex was not found/],
      [['reviewer', '--sandbox', 'workspace-write'], {}, /reviewer/],
      [['reviewer', '--sandbox=danger-full-access'], {}, /invalid --sandbox/],
      [['reviewer', '--sandbox'], {}, /--sandbox needs a value/],
      [['reviewer', '--fast'], {}, /unknown flag --fast/],
    ];
    for (const [args, extra, message] of cases) {
      const res = neat(['codex', 'run', id, ...args], extra);
      assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, message);
    }
    setGlobal({ codex: { enabled: 'off' } });
    const off = neat(['codex', 'run', id, 'reviewer']);
    assert.equal(off.status, 2);
    assert.match(off.stderr, /codex\.enabled is off/);
    setGlobal(null);
    assert.deepEqual(jobFiles(dir), []);
  });

  test('sandbox: flag, sandboxDefault and the workspace-write default; model and effort', () => {
    setGlobal(null);
    const { id, dir } = newRun('sandbox choice');
    fs.writeFileSync(path.join(dir, 'brief-implementer-T1.md'), '# Brief: implementer-T1\n');
    assert.equal(sandboxOf(runAndWait(id, 'implementer-T1', ['--sandbox', 'read-only'])), 'read-only');
    const plain = runAndWait(id, 'implementer-T1');
    assert.equal(sandboxOf(plain), 'workspace-write');
    assert.ok(!plain.includes('-c'), 'no routed effort -> no -c pair');
    setGlobal({ codex: { sandboxDefault: 'read-only', model: 'gpt-x' } });
    const ro = runAndWait(id, 'implementer-T1');
    assert.equal(sandboxOf(ro), 'read-only');
    assert.ok(ro.includes('--model=gpt-x'));
    setGlobal(null);
  });

  test('profile inherit routes effort none, so codex gets no effort setting', () => {
    setGlobal(null);
    const res = neat(['run', 'new', '--stdin'], {}, '--profile inherit inherit effort\n');
    const id = res.stdout.match(/^id=(\S+)/m)[1];
    assert.equal(neat(['brief', id, 'tester']).status, 0);
    const argv = runAndWait(id, 'tester');
    assert.ok(!argv.some((a) => a.startsWith('model_reasoning_effort')), argv.join(' '));
    assert.equal(sandboxOf(argv), 'workspace-write');
  });
});
