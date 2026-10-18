'use strict';

// Proves the `npx a-neat-session` path: pack the repo, then run the packed
// tarball through `npm exec` for --local, --global and --uninstall.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, makeTempDir, removeDir } = require('../support/helpers.cjs');

const NPM_TIMEOUT_MS = 120000;

let tmp;
let tgz;
let packedFiles;
let npmEnv;

function npm(args, { cwd, env = {} }) {
  const res = spawnSync('npm', args, {
    cwd,
    env: { ...npmEnv, ...env },
    encoding: 'utf8',
    timeout: NPM_TIMEOUT_MS,
  });
  if (res.error) throw res.error;
  return res;
}

function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(root, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function newProject(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  return dir;
}

function execPackage(args, opts) {
  const res = npm(['exec', '--yes', `--package=${tgz}`, '--', 'a-neat-session', ...args], opts);
  assert.equal(res.status, 0, `npm exec ${args.join(' ')} failed:\n${res.stdout}\n${res.stderr}`);
  return res;
}

before(() => {
  tmp = makeTempDir('neat-pack-');
  npmEnv = childEnv({
    npm_config_cache: path.join(tmp, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  });
  const res = npm(['pack', '--pack-destination', tmp, '--json'], { cwd: REPO_ROOT });
  assert.equal(res.status, 0, res.stderr);
  const [info] = JSON.parse(res.stdout);
  tgz = path.join(tmp, info.filename);
  packedFiles = info.files.map((f) => f.path);
});

after(() => removeDir(tmp));

test('packed tarball ships the installer and payload but no tests', () => {
  assert.ok(fs.existsSync(tgz));
  assert.ok(packedFiles.includes('bin/install.cjs'));
  assert.ok(packedFiles.includes('payload/commands/neat/do.md'));
  assert.ok(packedFiles.includes('package.json'));
  assert.deepEqual(packedFiles.filter((p) => p.startsWith('tests/')), []);
});

test('npm exec --local installs into the project and uninstall restores it', () => {
  const proj = newProject('local');
  const pre = snapshot(proj);
  execPackage(['--local'], { cwd: proj });
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'commands', 'neat', 'do.md')));
  const rule = `Bash(node ${path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs')} *)`;
  const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.permissions.allow, [rule]);

  execPackage(['--uninstall', '--local'], { cwd: proj });
  assert.deepEqual(snapshot(proj), pre);
  assert.ok(!fs.existsSync(path.join(proj, '.claude')));
});

test('npm exec --local over an existing settings.local.json leaves only the backup behind', () => {
  const proj = newProject('local-settings');
  const settings = path.join(proj, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, '{\n  "permissions": {\n    "allow": ["Bash(ls *)"]\n  }\n}\n');
  const pre = snapshot(proj);

  execPackage(['--local'], { cwd: proj });
  execPackage(['--uninstall', '--local'], { cwd: proj });

  const post = snapshot(proj);
  assert.equal(post['.claude/settings.local.json.neat-bak'], pre['.claude/settings.local.json']);
  delete post['.claude/settings.local.json.neat-bak'];
  assert.deepEqual(post, pre);
});

test('npm exec --global installs into CLAUDE_CONFIG_DIR', () => {
  const proj = newProject('global');
  const cfg = path.join(tmp, 'cfg');
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const res = execPackage(['--global'], { cwd: proj, env });
  assert.ok(res.stdout.includes(`a-neat-session: target ${cfg}`));
  assert.ok(fs.existsSync(path.join(cfg, 'agents', 'neat-explorer.md')));
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes(`Bash(node ${path.join(cfg, 'neat', 'bin', 'neat.cjs')} *)`));
  assert.ok(!fs.existsSync(path.join(proj, '.claude')));

  execPackage(['--uninstall', '--global'], { cwd: proj, env });
  assert.ok(!fs.existsSync(cfg), 'config dir created by the installer is removed again');
});
