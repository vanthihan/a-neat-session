'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');
const { parseInstallerArgs, chooseScope, USAGE } = require('../../lib/installer/args.cjs');
const {
  expandTilde,
  resolveTarget,
  helperPath,
  assertShellSafePath,
  settingsFileName,
} = require('../../lib/installer/paths.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');

describe('parseInstallerArgs', () => {
  test('--global', () => {
    assert.deepEqual(parseInstallerArgs(['--global']), {
      scope: 'global',
      uninstall: false,
      force: false,
      help: false,
    });
  });

  test('--local --uninstall --force', () => {
    assert.deepEqual(parseInstallerArgs(['--local', '--uninstall', '--force']), {
      scope: 'local',
      uninstall: true,
      force: true,
      help: false,
    });
  });

  test('no args leaves scope unset', () => {
    assert.equal(parseInstallerArgs([]).scope, null);
  });

  test('both scopes is an error', () => {
    assert.throws(() => parseInstallerArgs(['--global', '--local']), /choose one of --global or --local/);
  });

  test('unknown option is an error', () => {
    assert.throws(() => parseInstallerArgs(['--frobnicate']), /unknown option --frobnicate/);
  });

  test('-h and --help', () => {
    assert.equal(parseInstallerArgs(['-h']).help, true);
    assert.equal(parseInstallerArgs(['--help']).help, true);
  });

  test('USAGE lists every flag', () => {
    for (const flag of ['--global', '--local', '--uninstall', '--force', '--help']) {
      assert.ok(USAGE.includes(flag), flag);
    }
  });
});

describe('paths', () => {
  test('expandTilde', () => {
    assert.equal(expandTilde('~', '/h'), '/h');
    assert.equal(expandTilde('~/cfg', '/h'), path.join('/h', 'cfg'));
    assert.equal(expandTilde('/abs/~x', '/h'), '/abs/~x');
  });

  test('resolveTarget global honours CLAUDE_CONFIG_DIR with tilde', () => {
    assert.equal(resolveTarget('global', { CLAUDE_CONFIG_DIR: '~/cfg' }, '/p', '/h'), path.join('/h', 'cfg'));
  });

  test('resolveTarget global defaults to ~/.claude', () => {
    assert.equal(resolveTarget('global', {}, '/p', '/h'), path.join('/h', '.claude'));
    assert.equal(resolveTarget('global', { CLAUDE_CONFIG_DIR: '' }, '/p', '/h'), path.join('/h', '.claude'));
  });

  test('resolveTarget local is ./.claude', () => {
    assert.equal(resolveTarget('local', {}, '/p'), path.join('/p', '.claude'));
  });

  test('resolveTarget rejects unknown scope', () => {
    assert.throws(() => resolveTarget('team', {}, '/p', '/h'), /unknown scope/);
  });

  test('helperPath', () => {
    assert.equal(helperPath('/t'), path.join('/t', 'neat', 'bin', 'neat.cjs'));
  });

  test('assertShellSafePath', () => {
    assert.throws(() => assertShellSafePath('/home/u/my dir/.claude'), /CLAUDE_CONFIG_DIR/);
    assert.throws(() => assertShellSafePath('/home/u/$(x)/.claude'), /CLAUDE_CONFIG_DIR/);
    assert.doesNotThrow(() => assertShellSafePath('/home/u/.claude'));
    assert.doesNotThrow(() => assertShellSafePath('/home/u-1/a_b+c@d/.claude'));
  });

  test('settingsFileName', () => {
    assert.equal(settingsFileName('global'), 'settings.json');
    assert.equal(settingsFileName('local'), 'settings.local.json');
  });
});

describe('chooseScope', () => {
  test('non-TTY rejects asking for a flag', async () => {
    await assert.rejects(chooseScope({ isTTY: false, ask: async () => '1' }), (err) => {
      assert.match(err.message, /--global/);
      assert.match(err.message, /--local/);
      return true;
    });
  });

  test('TTY answers 1 and 2', async () => {
    const opts = { isTTY: true, globalTarget: '/g', localTarget: '/l' };
    assert.equal(await chooseScope({ ...opts, ask: async () => '1' }), 'global');
    assert.equal(await chooseScope({ ...opts, ask: async () => ' 2 ' }), 'local');
  });

  test('prompt names both targets', async () => {
    let seen = '';
    await chooseScope({
      isTTY: true,
      globalTarget: '/g',
      localTarget: '/l',
      ask: async (q) => {
        seen = q;
        return '1';
      },
    });
    assert.match(seen, /\/g/);
    assert.match(seen, /\/l/);
  });

  test('three invalid answers reject', async () => {
    let calls = 0;
    const ask = async () => {
      calls += 1;
      return 'x';
    };
    await assert.rejects(chooseScope({ isTTY: true, ask, globalTarget: '/g', localTarget: '/l' }));
    assert.equal(calls, 3);
  });

  test('second answer can be valid', async () => {
    const answers = ['nope', '2'];
    const ask = async () => answers.shift();
    assert.equal(await chooseScope({ isTTY: true, ask, globalTarget: '/g', localTarget: '/l' }), 'local');
  });
});

describe('bin/install.cjs scope handling', () => {
  let tmp;
  before(() => {
    tmp = makeTempDir('neat-scope-');
  });
  after(() => removeDir(tmp));

  test('--global installs into CLAUDE_CONFIG_DIR and prints the target first', () => {
    const cfg = path.join(tmp, 'cfg');
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    const res = runNode([INSTALLER, '--global'], { cwd: proj, env: childEnv({ CLAUDE_CONFIG_DIR: cfg }) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.split('\n')[0], `a-neat-session: target ${cfg}`);
    const doMd = fs.readFileSync(path.join(cfg, 'commands', 'neat', 'do.md'), 'utf8');
    assert.ok(doMd.includes(`node ${path.join(cfg, 'neat', 'bin', 'neat.cjs')}`));
    assert.ok(!fs.existsSync(path.join(proj, '.claude')), 'nothing written into the project');
  });

  test('--global with CLAUDE_CONFIG_DIR=~/x expands against HOME', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const res = runNode([INSTALLER, '--global'], {
      cwd: tmp,
      env: childEnv({ HOME: home, CLAUDE_CONFIG_DIR: '~/cfg2' }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(home, 'cfg2', 'commands', 'neat', 'do.md')));
  });

  test('--local installs into ./.claude', () => {
    const proj = path.join(tmp, 'proj-local');
    fs.mkdirSync(proj);
    const res = runNode([INSTALLER, '--local'], { cwd: proj, env: childEnv() });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.split('\n')[0], `a-neat-session: target ${path.join(proj, '.claude')}`);
    assert.ok(fs.existsSync(path.join(proj, '.claude', 'commands', 'neat', 'do.md')));
  });

  test('no scope flag and non-TTY stdin exits 2 asking for a flag', () => {
    const res = runNode([INSTALLER], { cwd: tmp, env: childEnv(), input: '' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--global/);
    assert.match(res.stderr, /--local/);
  });

  test('--help exits 0 and lists the flags', () => {
    const res = runNode([INSTALLER, '--help'], { cwd: tmp, env: childEnv() });
    assert.equal(res.status, 0, res.stderr);
    for (const flag of ['--global', '--local', '--uninstall', '--force']) {
      assert.ok(res.stdout.includes(flag), flag);
    }
  });

  test('bad flag exits 2', () => {
    const res = runNode([INSTALLER, '--frobnicate'], { cwd: tmp, env: childEnv() });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /^a-neat-session: unknown option --frobnicate/);
  });

  test('unsafe target path is refused before anything is written', () => {
    const cfg = path.join(tmp, 'bad dir');
    const res = runNode([INSTALLER, '--global'], { cwd: tmp, env: childEnv({ CLAUDE_CONFIG_DIR: cfg }) });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CLAUDE_CONFIG_DIR/);
    assert.ok(!fs.existsSync(cfg));
  });
});
