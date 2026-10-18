'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');
const { stableStringify, appendIfAbsent, removeAdded } = require('../../lib/installer/settings-merge.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const ALLOW = ['permissions', 'allow'];
const R = 'Bash(node /abs/neat/bin/neat.cjs *)';

describe('settings-merge (pure)', () => {
  test('stableStringify sorts keys recursively', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 0 } }), '{"a":{"c":0,"d":[{"x":2,"y":1}]},"b":1}');
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });

  test('appendIfAbsent on {} creates keys and does not mutate input', () => {
    const input = {};
    const { next, added, createdKeys } = appendIfAbsent(input, [{ path: ALLOW, value: R }]);
    assert.deepEqual(next.permissions.allow, [R]);
    assert.deepEqual(added, [{ path: ALLOW, value: R }]);
    assert.deepEqual(createdKeys, [['permissions'], ['permissions', 'allow']]);
    assert.deepEqual(input, {});
  });

  test('appendIfAbsent keeps existing order and is idempotent', () => {
    const input = { permissions: { allow: ['Bash(ls *)'] } };
    const first = appendIfAbsent(input, [{ path: ALLOW, value: R }]);
    assert.deepEqual(first.next.permissions.allow, ['Bash(ls *)', R]);
    assert.deepEqual(first.createdKeys, []);
    assert.deepEqual(input.permissions.allow, ['Bash(ls *)']);
    const second = appendIfAbsent(first.next, [{ path: ALLOW, value: R }]);
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.next, first.next);
  });

  test('appendIfAbsent compares objects by stable equality', () => {
    const input = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }], matcher: '' }] } };
    const { added } = appendIfAbsent(input, [
      { path: ['hooks', 'Stop'], value: { matcher: '', hooks: [{ command: 'x', type: 'command' }] } },
    ]);
    assert.deepEqual(added, []);
  });

  test('non-array leaf throws', () => {
    assert.throws(
      () => appendIfAbsent({ permissions: { allow: 'Bash(*)' } }, [{ path: ALLOW, value: R }]),
      /permissions\.allow is not an array/,
    );
    assert.throws(() => appendIfAbsent({ permissions: 'x' }, [{ path: ALLOW, value: R }]), /permissions is not an object/);
  });

  test('removeAdded restores the original', () => {
    const original = { model: 'opus', permissions: { allow: ['Bash(ls *)'], deny: ['Read(.env)'] } };
    const { next, added, createdKeys } = appendIfAbsent(original, [{ path: ALLOW, value: R }]);
    const restored = removeAdded(next, added, createdKeys);
    assert.deepEqual(restored.next, original);
    assert.deepEqual(restored.removed, added);
  });

  test('removeAdded drops created keys only when empty', () => {
    const { next, added, createdKeys } = appendIfAbsent({}, [{ path: ALLOW, value: R }]);
    assert.deepEqual(removeAdded(next, added, createdKeys).next, {});
    const withUser = structuredClone(next);
    withUser.permissions.allow.push('Bash(git *)');
    assert.deepEqual(removeAdded(withUser, added, createdKeys).next, { permissions: { allow: ['Bash(git *)'] } });
    assert.deepEqual(withUser.permissions.allow, [R, 'Bash(git *)'], 'input not mutated');
  });

  test('removeAdded tolerates entries the user already removed', () => {
    const res = removeAdded({ permissions: { allow: [] } }, [{ path: ALLOW, value: R }], []);
    assert.deepEqual(res.next, { permissions: { allow: [] } });
    assert.deepEqual(res.removed, []);
  });
});

describe('installer settings integration', () => {
  let tmp;
  let cfg;
  let proj;
  const ruleFor = (target) => `Bash(node ${path.join(target, 'neat', 'bin', 'neat.cjs')} *)`;
  const runGlobal = (args) => runNode([INSTALLER, '--global', ...args], { cwd: proj, env: childEnv({ CLAUDE_CONFIG_DIR: cfg }) });
  const runLocal = (args) => runNode([INSTALLER, '--local', ...args], { cwd: proj, env: childEnv() });
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

  const USER_SETTINGS = {
    model: 'opus',
    permissions: { allow: ['Bash(ls *)'], deny: ['Read(.env)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };

  beforeEach(() => {
    tmp = makeTempDir('neat-settings-');
    cfg = path.join(tmp, 'cfg');
    proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
  });
  afterEach(() => removeDir(tmp));

  test('global install merges the rule into settings.json and backs it up once', () => {
    fs.mkdirSync(cfg);
    const settings = path.join(cfg, 'settings.json');
    const originalText = `${JSON.stringify(USER_SETTINGS, null, 4)}\n`;
    fs.writeFileSync(settings, originalText);

    let res = runGlobal([]);
    assert.equal(res.status, 0, res.stderr);
    const merged = readJson(settings);
    assert.equal(merged.model, 'opus');
    assert.deepEqual(merged.permissions.deny, ['Read(.env)']);
    assert.deepEqual(merged.hooks, USER_SETTINGS.hooks);
    assert.deepEqual(merged.permissions.allow, ['Bash(ls *)', ruleFor(cfg)]);
    assert.deepEqual(Object.keys(merged), Object.keys(USER_SETTINGS));
    assert.equal(fs.readFileSync(`${settings}.neat-bak`, 'utf8'), originalText);

    const afterFirst = fs.readFileSync(settings, 'utf8');
    res = runGlobal([]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(settings, 'utf8'), afterFirst, 'no duplicate rule, no rewrite');
    assert.equal(fs.readFileSync(`${settings}.neat-bak`, 'utf8'), originalText);
  });

  test('existing backup is never overwritten', () => {
    fs.mkdirSync(cfg);
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, '{}\n');
    fs.writeFileSync(`${settings}.neat-bak`, 'older backup\n');
    assert.equal(runGlobal([]).status, 0);
    assert.equal(fs.readFileSync(`${settings}.neat-bak`, 'utf8'), 'older backup\n');
  });

  test('local install writes settings.local.json and leaves settings.json alone', () => {
    const target = path.join(proj, '.claude');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'settings.json'), '{"model":"x"}\n');
    const res = runLocal([]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readJson(path.join(target, 'settings.local.json')), { permissions: { allow: [ruleFor(target)] } });
    assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"model":"x"}\n');
    assert.ok(!fs.existsSync(path.join(target, 'settings.local.json.neat-bak')), 'no backup when no file existed');
  });

  test('unparseable settings aborts before any write', () => {
    fs.mkdirSync(cfg);
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, '{ invalid');
    const res = runGlobal([]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(settings), res.stderr);
    assert.deepEqual(fs.readdirSync(cfg), ['settings.json']);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{ invalid');
  });

  test('settings with a non-array permissions.allow aborts before any write', () => {
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"permissions":{"allow":"Bash(*)"}}');
    const res = runGlobal([]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /permissions\.allow is not an array/);
    assert.deepEqual(fs.readdirSync(cfg), ['settings.json']);
  });

  test('uninstall restores settings, keeps and reports the backup', () => {
    fs.mkdirSync(cfg);
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify(USER_SETTINGS));
    assert.equal(runGlobal([]).status, 0);
    const res = runGlobal(['--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readJson(settings), USER_SETTINGS);
    assert.equal(fs.readFileSync(settings, 'utf8'), JSON.stringify(USER_SETTINGS), 'original bytes restored');
    assert.ok(res.stdout.includes(`settings backup kept at ${settings}.neat-bak`), res.stdout);
    assert.ok(fs.existsSync(`${settings}.neat-bak`));
  });

  test('uninstall keeps user entries added after install', () => {
    fs.mkdirSync(cfg);
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(ls *)"]}}');
    assert.equal(runGlobal([]).status, 0);
    const s = readJson(settings);
    s.permissions.allow.push('Bash(git *)');
    s.theme = 'dark';
    fs.writeFileSync(settings, JSON.stringify(s));
    assert.equal(runGlobal(['--uninstall']).status, 0);
    assert.deepEqual(readJson(settings), { permissions: { allow: ['Bash(ls *)', 'Bash(git *)'] }, theme: 'dark' });
  });

  test('uninstall deletes a settings file the installer created when it ends up empty', () => {
    assert.equal(runGlobal([]).status, 0);
    assert.ok(fs.existsSync(path.join(cfg, 'settings.json')));
    const res = runGlobal(['--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(cfg, 'settings.json')));
    assert.ok(!fs.existsSync(cfg), 'created config dir pruned');
  });

  test('uninstall keeps a created settings file the user added keys to', () => {
    assert.equal(runGlobal([]).status, 0);
    const settings = path.join(cfg, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ ...readJson(settings), model: 'opus' }));
    assert.equal(runGlobal(['--uninstall']).status, 0);
    assert.deepEqual(readJson(settings), { model: 'opus' });
  });

  test('re-install keeps createdFile from the first install', () => {
    assert.equal(runGlobal([]).status, 0);
    assert.equal(runGlobal([]).status, 0);
    const m = readJson(path.join(cfg, 'neat', 'manifest.json'));
    assert.equal(m.settings.file, 'settings.json');
    assert.equal(m.settings.createdFile, true);
    assert.equal(m.settings.backup, null);
    assert.deepEqual(m.settings.added, [{ path: ALLOW, value: ruleFor(cfg) }]);
  });

  test('uninstall with unparseable settings warns and still removes files', () => {
    assert.equal(runGlobal([]).status, 0);
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{ broken');
    const res = runGlobal(['--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /warning: could not update .*settings\.json: .*remove the a-neat-session permission rule by hand/);
    assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), '{ broken');
    assert.ok(!fs.existsSync(path.join(cfg, 'commands', 'neat', 'do.md')));
  });

  test('uninstall with a settings shape it cannot edit warns and still completes', () => {
    assert.equal(runGlobal([]).status, 0);
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{ "permissions": null }\n');
    const res = runGlobal(['--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /warning: could not update .*settings\.json: permissions is not an object; remove the a-neat-session permission rule by hand/);
    assert.ok(!fs.existsSync(path.join(cfg, 'neat', 'manifest.json')));
    assert.ok(!fs.existsSync(path.join(cfg, 'commands', 'neat', 'do.md')));
    assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), '{ "permissions": null }\n');
  });
});
