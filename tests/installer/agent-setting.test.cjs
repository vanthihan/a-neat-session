'use strict';

// Opt-in session agent: `--orchestrator-default` sets settings `agent` to
// neat-orchestrator reversibly (manifest-tracked, restored on uninstall,
// sticky across reinstalls) and the manifest record is strictly validated.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');
const { setScalar, restoreScalar } = require('../../lib/installer/settings-merge.cjs');
const { parseInstallerArgs, USAGE } = require('../../lib/installer/args.cjs');
const { MANIFEST_VERSION, readManifest, validateManifest } = require('../../lib/installer/manifest.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const AGENT = 'neat-orchestrator';
const STICKY = 'the session agent stays neat-orchestrator (set by an earlier install; --uninstall restores the previous value)';
const GLOBAL_WARNING =
  'a-neat-session: warning: --orchestrator-default with --global makes every Claude Code session in every project ' +
  'start as the neat orchestrator; --local limits it to this project';

describe('--orchestrator-default argument', () => {
  test('parses with --local, defaults to false and is ignored with --uninstall', () => {
    assert.equal(parseInstallerArgs(['--local', '--orchestrator-default']).orchestratorDefault, true);
    assert.equal(parseInstallerArgs(['--local']).orchestratorDefault, false);
    const un = parseInstallerArgs(['--uninstall', '--local', '--orchestrator-default']);
    assert.equal(un.uninstall, true);
  });

  test('USAGE documents the flag', () => {
    const line = USAGE.split('\n').find((l) => l.includes('--orchestrator-default'));
    assert.ok(line, USAGE);
    assert.match(USAGE, /--orchestrator-default[\s\S]*every session in that scope[\s\S]*neat orchestrator/);
  });
});

describe('setScalar / restoreScalar (pure)', () => {
  test('setScalar on settings without the key records previous absent and does not mutate input', () => {
    const input = { model: 'opus' };
    const { next, record } = setScalar(input, ['agent'], AGENT);
    assert.deepEqual(next, { model: 'opus', agent: AGENT });
    assert.deepEqual(record, { path: ['agent'], value: AGENT, previous: { present: false } });
    assert.deepEqual(input, { model: 'opus' });
  });

  test('setScalar records an existing value as previous', () => {
    const input = { agent: 'mine' };
    const { next, record } = setScalar(input, ['agent'], AGENT);
    assert.equal(next.agent, AGENT);
    assert.deepEqual(record.previous, { present: true, value: 'mine' });
    assert.equal(input.agent, 'mine');
  });

  test('setScalar rejects a non-object root', () => {
    assert.throws(() => setScalar([], ['agent'], AGENT), /not an object/);
    assert.throws(() => setScalar(null, ['agent'], AGENT), /not an object/);
  });

  test('restoreScalar puts the previous value back or deletes the key', () => {
    const withPrev = { path: ['agent'], value: AGENT, previous: { present: true, value: 'mine' } };
    const input = { agent: AGENT, model: 'opus' };
    const res = restoreScalar(input, withPrev);
    assert.equal(res.restored, true);
    assert.deepEqual(res.next, { agent: 'mine', model: 'opus' });
    assert.equal(input.agent, AGENT, 'input not mutated');
    const noPrev = { path: ['agent'], value: AGENT, previous: { present: false } };
    assert.deepEqual(restoreScalar({ agent: AGENT, model: 'opus' }, noPrev), { next: { model: 'opus' }, restored: true });
  });

  test('restoreScalar leaves a value the user changed', () => {
    const rec = { path: ['agent'], value: AGENT, previous: { present: false } };
    for (const input of [{ agent: 'other' }, { model: 'opus' }]) {
      const res = restoreScalar(input, rec);
      assert.equal(res.restored, false);
      assert.deepEqual(res.next, input);
    }
  });
});

describe('manifest settings.replaced validation', () => {
  const base = () => ({
    manifestVersion: MANIFEST_VERSION,
    files: {},
    dirsCreated: [],
    settings: { file: 'settings.local.json', backup: null, createdFile: true, added: [], createdKeys: [] },
  });
  const withReplaced = (replaced) => {
    const m = base();
    m.settings.replaced = replaced;
    return m;
  };
  const rec = (previous, overrides = {}) => ({ path: ['agent'], value: AGENT, previous, ...overrides });

  test('MANIFEST_VERSION stays 1 and replaced is optional', () => {
    assert.equal(MANIFEST_VERSION, 1);
    assert.doesNotThrow(() => validateManifest(base()));
  });

  test('accepts the two valid record shapes', () => {
    assert.doesNotThrow(() => validateManifest(withReplaced([])));
    assert.doesNotThrow(() => validateManifest(withReplaced([rec({ present: false })])));
    assert.doesNotThrow(() => validateManifest(withReplaced([rec({ present: true, value: 'my-agent' })])));
    assert.doesNotThrow(() => validateManifest(withReplaced([rec({ present: true, value: 'x'.repeat(256) })])));
  });

  const BAD = {
    'not an array': rec({ present: false }),
    'two records': [rec({ present: false }), rec({ present: false })],
    'other key': [rec({ present: false }, { path: ['model'] })],
    'nested path': [rec({ present: false }, { path: ['agent', 'x'] })],
    'other value': [rec({ present: false }, { value: 'evil' })],
    'missing previous': [{ path: ['agent'], value: AGENT }],
    'previous present without value': [rec({ present: true })],
    'previous non-string': [rec({ present: true, value: { a: 1 } })],
    'previous empty': [rec({ present: true, value: '' })],
    'previous too long': [rec({ present: true, value: 'x'.repeat(257) })],
    'previous control char': [rec({ present: true, value: 'a\nb' })],
    'previous absent with value': [rec({ present: false, value: 'x' })],
    'previous present not boolean': [rec({ present: 'yes', value: 'x' })],
  };
  for (const [label, replaced] of Object.entries(BAD)) {
    test(`rejects ${label}`, () => {
      assert.throws(() => validateManifest(withReplaced(replaced)), /settings\.replaced is malformed/);
    });
  }

  test('readManifest reports a tampered record with the file path', () => {
    const tmp = makeTempDir('neat-replaced-');
    try {
      const file = path.join(tmp, 'neat', 'manifest.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(withReplaced([rec({ present: false }, { path: ['permissions'] })])));
      assert.throws(() => readManifest(tmp), (err) => err.message === `invalid manifest at ${file}: settings.replaced is malformed`);
    } finally {
      removeDir(tmp);
    }
  });
});

describe('installer --orchestrator-default', () => {
  let tmp;
  let cfg;
  let proj;
  let target;
  let localSettings;
  const runLocal = (args) => runNode([INSTALLER, '--local', ...args], { cwd: proj, env: childEnv() });
  const runGlobal = (args) => runNode([INSTALLER, '--global', ...args], { cwd: proj, env: childEnv({ CLAUDE_CONFIG_DIR: cfg }) });
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const manifestOf = (t) => readJson(path.join(t, 'neat', 'manifest.json'));
  const ok = (res) => {
    assert.equal(res.status, 0, res.stderr);
    return res;
  };

  beforeEach(() => {
    tmp = makeTempDir('neat-agent-');
    cfg = path.join(tmp, 'cfg');
    proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    target = path.join(proj, '.claude');
    localSettings = path.join(target, 'settings.local.json');
  });
  afterEach(() => removeDir(tmp));

  test('local opt-in into a project without settings sets agent and uninstall removes it', () => {
    const res = ok(runLocal(['--orchestrator-default']));
    const s = readJson(localSettings);
    assert.equal(s.agent, AGENT);
    assert.ok(Array.isArray(s.permissions.allow) && s.permissions.allow.length === 1);
    assert.ok(Array.isArray(s.hooks.SessionStart));
    assert.ok(res.stdout.includes(`a-neat-session: session agent set to neat-orchestrator in ${localSettings}`), res.stdout);
    assert.ok(!res.stderr.includes('--global'), res.stderr);
    assert.deepEqual(manifestOf(target).settings.replaced, [{ path: ['agent'], value: AGENT, previous: { present: false } }]);

    ok(runLocal(['--uninstall']));
    assert.ok(!fs.existsSync(localSettings), 'created settings file removed');
  });

  test('an existing agent is backed up and restored on uninstall', () => {
    fs.mkdirSync(target);
    const original = '{ "agent": "my-agent", "model": "opus" }\n';
    fs.writeFileSync(localSettings, original);
    ok(runLocal(['--orchestrator-default']));
    assert.equal(readJson(localSettings).agent, AGENT);
    assert.equal(fs.readFileSync(`${localSettings}.neat-bak`, 'utf8'), original);
    assert.deepEqual(manifestOf(target).settings.replaced[0].previous, { present: true, value: 'my-agent' });

    ok(runLocal(['--uninstall']));
    const after = readJson(localSettings);
    assert.equal(after.agent, 'my-agent');
    assert.equal(after.model, 'opus');
    assert.equal(fs.readFileSync(localSettings, 'utf8'), original, 'original bytes restored');
  });

  test('uninstall leaves an agent value the user changed and warns', () => {
    ok(runLocal(['--orchestrator-default']));
    const s = readJson(localSettings);
    s.agent = 'other';
    fs.writeFileSync(localSettings, JSON.stringify(s));
    const res = ok(runLocal(['--uninstall']));
    assert.ok(res.stderr.includes("agent is 'other' now (not neat-orchestrator); left unchanged"), res.stderr);
    assert.deepEqual(readJson(localSettings), { agent: 'other' });
  });

  test('reinstall without the flag keeps the opt-in while agent is still ours', () => {
    fs.mkdirSync(target);
    fs.writeFileSync(localSettings, '{"agent":"my-agent"}');
    ok(runLocal(['--orchestrator-default']));
    const res = ok(runLocal([]));
    assert.ok(res.stdout.includes(`a-neat-session: ${STICKY}`), res.stdout);
    assert.equal(readJson(localSettings).agent, AGENT);
    assert.deepEqual(manifestOf(target).settings.replaced[0].previous, { present: true, value: 'my-agent' });
  });

  test('reinstall with the flag keeps the first recorded previous value', () => {
    fs.mkdirSync(target);
    fs.writeFileSync(localSettings, '{"agent":"my-agent"}');
    ok(runLocal(['--orchestrator-default']));
    const res = ok(runLocal(['--orchestrator-default']));
    assert.ok(res.stdout.includes('session agent set to neat-orchestrator'), res.stdout);
    assert.deepEqual(manifestOf(target).settings.replaced, [
      { path: ['agent'], value: AGENT, previous: { present: true, value: 'my-agent' } },
    ]);
    ok(runLocal(['--uninstall']));
    assert.equal(readJson(localSettings).agent, 'my-agent');
  });

  test('reinstall without the flag after the user changed agent drops the record', () => {
    ok(runLocal(['--orchestrator-default']));
    const s = readJson(localSettings);
    s.agent = 'other';
    fs.writeFileSync(localSettings, JSON.stringify(s));
    const before = fs.readFileSync(localSettings, 'utf8');
    const res = ok(runLocal([]));
    assert.ok(!res.stdout.includes(STICKY), res.stdout);
    assert.equal(fs.readFileSync(localSettings, 'utf8'), before, 'settings untouched');
    assert.equal(manifestOf(target).settings.replaced, undefined);
    ok(runLocal(['--uninstall']));
    assert.deepEqual(readJson(localSettings), { agent: 'other' });
  });

  test('a default install never writes agent', () => {
    ok(runLocal([]));
    assert.equal(readJson(localSettings).agent, undefined);
    assert.equal(manifestOf(target).settings.replaced, undefined);
    ok(runLocal(['--uninstall']));

    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(localSettings, '{"agent":"mine"}');
    const res = ok(runLocal([]));
    assert.equal(readJson(localSettings).agent, 'mine');
    assert.ok(!res.stdout.includes('session agent'), res.stdout);
  });

  test('an existing agent that is not a short plain string aborts before any write', () => {
    fs.mkdirSync(target);
    fs.writeFileSync(localSettings, '{"agent":{"name":"x"}}');
    const res = runLocal(['--orchestrator-default']);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(localSettings), res.stderr);
    assert.deepEqual(fs.readdirSync(target), ['settings.local.json']);
  });

  test('--global --orchestrator-default warns on stderr and succeeds', () => {
    const res = ok(runGlobal(['--orchestrator-default']));
    assert.ok(res.stderr.includes(GLOBAL_WARNING), res.stderr);
    assert.equal(readJson(path.join(cfg, 'settings.json')).agent, AGENT);
    ok(runGlobal(['--uninstall']));
    assert.ok(!fs.existsSync(path.join(cfg, 'settings.json')));
  });

  test('--uninstall --orchestrator-default is accepted', () => {
    ok(runLocal(['--orchestrator-default']));
    ok(runLocal(['--uninstall', '--orchestrator-default']));
    assert.ok(!fs.existsSync(localSettings));
  });

  test('the installed orchestrator agent names the installed helper', () => {
    ok(runLocal([]));
    const agentFile = path.join(target, 'agents', 'neat-orchestrator.md');
    const text = fs.readFileSync(agentFile, 'utf8');
    assert.ok(!text.includes('{{NEAT_BIN}}'));
    assert.ok(text.includes(`node ${path.join(target, 'neat', 'bin', 'neat.cjs')} procedure`), text);
  });

  test('a tampered record makes uninstall refuse without writing settings', () => {
    ok(runLocal(['--orchestrator-default']));
    const mPath = path.join(target, 'neat', 'manifest.json');
    const m = readJson(mPath);
    m.settings.replaced = [{ path: ['permissions'], value: AGENT, previous: { present: true, value: 'x' } }];
    fs.writeFileSync(mPath, JSON.stringify(m));
    const before = fs.readFileSync(localSettings, 'utf8');
    const res = runLocal(['--uninstall']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /settings\.replaced is malformed/);
    assert.equal(fs.readFileSync(localSettings, 'utf8'), before);
  });
});
