'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');
const { listPayloadFiles } = require('../../lib/installer/install.cjs');
const {
  MANIFEST_REL,
  MANIFEST_VERSION,
  sha256,
  readManifest,
  writeManifest,
  validateManifest,
} = require('../../lib/installer/manifest.cjs');
const { atomicWrite, assertInside, lstatKind, pruneEmptyDirs } = require('../../lib/installer/fs-safe.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const PAYLOAD = path.join(REPO_ROOT, 'payload');

const hashFile = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

// Sorted map of relative path -> sha256 (symlinks recorded by their link text).
function snapshot(root) {
  const out = {};
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out[rel] = `symlink:${fs.readlinkSync(abs)}`;
      else if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = hashFile(abs);
    }
  };
  walk(root, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

let tmp;
let proj;
let target;

function run(args) {
  return runNode([INSTALLER, ...args], { cwd: proj, env: childEnv() });
}
function warnings(stderr) {
  return stderr
    .split('\n')
    .filter((l) => l.startsWith('a-neat-session: warning: '))
    .map((l) => l.slice('a-neat-session: warning: '.length));
}
function manifest() {
  return JSON.parse(fs.readFileSync(path.join(target, ...MANIFEST_REL.split('/')), 'utf8'));
}
function installOk(args = []) {
  const res = run(['--local', ...args]);
  assert.equal(res.status, 0, res.stderr);
  return res;
}

beforeEach(() => {
  tmp = makeTempDir('neat-life-');
  proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj);
  target = path.join(proj, '.claude');
});
afterEach(() => removeDir(tmp));

describe('fs-safe', () => {
  test('atomicWrite creates parents and leaves no temp file', () => {
    const abs = path.join(tmp, 'a', 'b', 'c.txt');
    atomicWrite(abs, 'hello');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(path.dirname(abs)), ['c.txt']);
  });

  test('assertInside', () => {
    assert.equal(assertInside('/r', 'a/b'), path.join('/r', 'a', 'b'));
    assert.equal(assertInside('/r', '.'), '/r');
    assert.throws(() => assertInside('/r', '../x'), /refusing path outside target: \.\.\/x/);
    assert.throws(() => assertInside('/r', '/etc/passwd'), /refusing path outside target/);
    assert.throws(() => assertInside('/r', '../r2/x'), /refusing path outside target/);
  });

  test('lstatKind never follows links', () => {
    const file = path.join(tmp, 'f');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(file, path.join(tmp, 'l'));
    assert.equal(lstatKind(file), 'file');
    assert.equal(lstatKind(path.join(tmp, 'l')), 'symlink');
    assert.equal(lstatKind(path.join(tmp, 'nope')), 'missing');
    assert.equal(lstatKind(tmp), 'other');
  });

  test('pruneEmptyDirs removes only empty dirs, deepest first', () => {
    fs.mkdirSync(path.join(tmp, 'x', 'y', 'z'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'k'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'k', 'keep'), '1');
    pruneEmptyDirs(tmp, ['x', 'x/y', 'x/y/z', 'k', '../outside']);
    assert.ok(!fs.existsSync(path.join(tmp, 'x')));
    assert.ok(fs.existsSync(path.join(tmp, 'k', 'keep')));
  });
});

describe('manifest', () => {
  const good = () => ({
    manifestVersion: MANIFEST_VERSION,
    files: { 'commands/neat/do.md': 'a'.repeat(64) },
    dirsCreated: ['commands/neat'],
  });

  test('MANIFEST_REL and sha256', () => {
    assert.equal(MANIFEST_REL, 'neat/manifest.json');
    assert.equal(sha256('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  });

  test('validateManifest accepts a good manifest', () => {
    assert.deepEqual(validateManifest(good()).unsafe, []);
  });

  test('validateManifest rejects absolute paths, bad hashes and versions', () => {
    assert.throws(() => validateManifest({ ...good(), files: { '/etc/passwd': 'a'.repeat(64) } }), /absolute/);
    assert.throws(() => validateManifest({ ...good(), files: { 'a\\b': 'a'.repeat(64) } }), /must use \//);
    assert.throws(() => validateManifest({ ...good(), files: { a: 'xyz' } }), /sha256/);
    assert.throws(() => validateManifest({ ...good(), manifestVersion: 2 }), /manifestVersion/);
    assert.throws(() => validateManifest({ ...good(), dirsCreated: ['/abs'] }), /absolute/);
    assert.throws(() => validateManifest([]), /object/);
  });

  test('validateManifest flags .. paths as unsafe', () => {
    const res = validateManifest({ ...good(), files: { '../outside.txt': 'a'.repeat(64) } });
    assert.deepEqual(res.unsafe, ['../outside.txt']);
  });

  test('readManifest / writeManifest round trip', () => {
    assert.equal(readManifest(tmp), null);
    writeManifest(tmp, good());
    assert.deepEqual(readManifest(tmp), good());
    const raw = fs.readFileSync(path.join(tmp, 'neat', 'manifest.json'), 'utf8');
    assert.ok(raw.endsWith('}\n'));
    assert.ok(raw.includes('\n  "manifestVersion": 1'));
  });

  test('readManifest throws on invalid JSON', () => {
    fs.mkdirSync(path.join(tmp, 'neat'));
    fs.writeFileSync(path.join(tmp, 'neat', 'manifest.json'), '{ nope');
    assert.throws(() => readManifest(tmp), /invalid manifest at .*manifest\.json/);
  });
});

describe('install and upgrade', () => {
  test('fresh install writes a manifest with rendered-byte hashes', () => {
    installOk();
    const m = manifest();
    assert.equal(m.manifestVersion, 1);
    assert.equal(m.package, 'a-neat-session');
    assert.equal(m.version, require('../../package.json').version);
    assert.equal(m.scope, 'local');
    assert.equal(m.target, target);
    assert.ok(!Number.isNaN(Date.parse(m.installedAt)));
    assert.deepEqual(Object.keys(m.files).sort(), listPayloadFiles(PAYLOAD));
    for (const [rel, hash] of Object.entries(m.files)) {
      assert.equal(hash, hashFile(path.join(target, ...rel.split('/'))), rel);
    }
    assert.ok(m.dirsCreated.includes('commands/neat'));
    assert.ok(m.dirsCreated.includes('neat/bin'));
  });

  test('installed helper keeps its executable mode', () => {
    installOk();
    const src = fs.statSync(path.join(PAYLOAD, 'neat', 'bin', 'neat.cjs')).mode & 0o777;
    const dest = fs.statSync(path.join(target, 'neat', 'bin', 'neat.cjs')).mode & 0o777;
    assert.equal(dest, src);
  });

  test('second install is idempotent and silent', () => {
    installOk();
    const first = manifest();
    const before = snapshot(target);
    const res = installOk();
    assert.deepEqual(warnings(res.stderr), []);
    assert.deepEqual(manifest().files, first.files);
    const after = snapshot(target);
    delete before['neat/manifest.json'];
    delete after['neat/manifest.json'];
    assert.deepEqual(after, before);
  });

  test('user-edited file is kept with a warning; --force restores it and saves .neat-old', () => {
    installOk();
    const doMd = path.join(target, 'commands', 'neat', 'do.md');
    const original = fs.readFileSync(doMd, 'utf8');
    const originalHash = manifest().files['commands/neat/do.md'];
    fs.appendFileSync(doMd, '\nmy edit\n');
    const edited = fs.readFileSync(doMd, 'utf8');

    const res = installOk();
    assert.deepEqual(warnings(res.stderr), ['kept modified commands/neat/do.md (use --force to overwrite)']);
    assert.equal(fs.readFileSync(doMd, 'utf8'), edited);
    assert.equal(manifest().files['commands/neat/do.md'], originalHash);

    const forced = installOk(['--force']);
    assert.deepEqual(warnings(forced.stderr), []);
    assert.equal(fs.readFileSync(doMd, 'utf8'), original);
    assert.equal(fs.readFileSync(`${doMd}.neat-old`, 'utf8'), edited);
    assert.ok(!('commands/neat/do.md.neat-old' in manifest().files));
  });

  test('foreign file is not overwritten and not recorded', () => {
    const foreign = path.join(target, 'agents', 'neat-explorer.md');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'mine\n');
    const res = installOk();
    assert.deepEqual(warnings(res.stderr), [
      'skipped agents/neat-explorer.md: exists and is not owned by a-neat-session (use --force to replace)',
    ]);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'mine\n');
    assert.ok(!('agents/neat-explorer.md' in manifest().files));
    assert.ok(!manifest().dirsCreated.includes('agents'));
  });

  test('--force replaces a foreign file after saving it', () => {
    const foreign = path.join(target, 'agents', 'neat-explorer.md');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'mine\n');
    installOk(['--force']);
    assert.equal(fs.readFileSync(`${foreign}.neat-old`, 'utf8'), 'mine\n');
    assert.match(fs.readFileSync(foreign, 'utf8'), /name: neat-explorer/);
    assert.ok('agents/neat-explorer.md' in manifest().files);
  });

  test('files dropped from the payload are deleted when unmodified, kept when edited', () => {
    installOk();
    const m = manifest();
    const stale = path.join(target, 'commands', 'neat', 'old.md');
    const staleEdited = path.join(target, 'commands', 'neat', 'old-edited.md');
    fs.writeFileSync(stale, 'old\n');
    fs.writeFileSync(staleEdited, 'old2\n');
    m.files['commands/neat/old.md'] = sha256('old\n');
    m.files['commands/neat/old-edited.md'] = sha256('original\n');
    writeManifest(target, m);

    const res = installOk();
    assert.ok(!fs.existsSync(stale));
    assert.equal(fs.readFileSync(staleEdited, 'utf8'), 'old2\n');
    assert.deepEqual(warnings(res.stderr), [
      'kept modified commands/neat/old-edited.md (no longer installed by a-neat-session)',
    ]);
    assert.ok(!('commands/neat/old.md' in manifest().files));
    assert.ok(!('commands/neat/old-edited.md' in manifest().files));
  });

  test('symlink at a payload path is skipped, never followed', () => {
    installOk();
    const outside = path.join(tmp, 'outside.md');
    fs.writeFileSync(outside, 'outside\n');
    const link = path.join(target, 'commands', 'neat', 'status.md');
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    const res = installOk(['--force']);
    assert.equal(warnings(res.stderr).length, 1);
    assert.match(warnings(res.stderr)[0], /^skipped commands\/neat\/status\.md: not a regular file/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  });

  test('invalid manifest JSON aborts install with exit 1', () => {
    installOk();
    fs.writeFileSync(path.join(target, 'neat', 'manifest.json'), '{ nope');
    const res = run(['--local']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`invalid manifest at ${path.join(target, 'neat', 'manifest.json')}`));
  });
});

describe('uninstall', () => {
  test('removes owned files, keeps edited and unrelated files, prunes created dirs', () => {
    installOk();
    const doMd = path.join(target, 'commands', 'neat', 'do.md');
    fs.appendFileSync(doMd, 'edit\n');
    const mine = path.join(target, 'agents', 'mine.md');
    fs.writeFileSync(mine, 'mine\n');
    const total = listPayloadFiles(PAYLOAD).length;

    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`removed ${total - 1} files, kept 1 modified files`));
    assert.deepEqual(warnings(res.stderr), ['kept modified commands/neat/do.md']);
    assert.ok(fs.existsSync(doMd));
    assert.equal(fs.readFileSync(mine, 'utf8'), 'mine\n');
    assert.ok(!fs.existsSync(path.join(target, 'neat')));
    assert.ok(!fs.existsSync(path.join(target, 'commands', 'neat', 'status.md')));
    assert.deepEqual(Object.keys(snapshot(target)).sort(), ['agents/mine.md', 'commands/neat/do.md']);
  });

  test('clean uninstall restores the pre-install project snapshot', () => {
    fs.writeFileSync(path.join(proj, 'README.md'), 'hi\n');
    const pre = snapshot(proj);
    installOk();
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(snapshot(proj), pre);
    assert.ok(!fs.existsSync(target), 'created .claude dir pruned');
  });

  test('pre-existing target dir is never removed', () => {
    fs.mkdirSync(target);
    installOk();
    assert.equal(run(['--local', '--uninstall']).status, 0);
    assert.ok(fs.existsSync(target));
  });

  test('no manifest exits 1', () => {
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`no a-neat-session install found at ${target}`));
  });

  test('tampered manifest entry cannot delete outside the target', () => {
    installOk();
    const outside = path.join(proj, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    const m = manifest();
    m.files['../outside.txt'] = sha256('keep me\n');
    writeManifest(target, m);
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(warnings(res.stderr).includes('refusing path outside target: ../outside.txt'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
  });

  test('absolute manifest entry makes the manifest invalid', () => {
    installOk();
    const m = manifest();
    m.files[path.join(proj, 'x')] = 'a'.repeat(64);
    fs.writeFileSync(path.join(target, 'neat', 'manifest.json'), JSON.stringify(m));
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /invalid manifest at/);
  });

  test('symlinked manifest path is skipped and its target unchanged', () => {
    installOk();
    const link = path.join(target, 'commands', 'neat', 'status.md');
    const outside = path.join(tmp, 'same-content.md');
    fs.copyFileSync(link, outside);
    const outsideHash = hashFile(outside);
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(warnings(res.stderr).some((w) => w.startsWith('skipped commands/neat/status.md: not a regular file')));
    assert.ok(fs.existsSync(outside));
    assert.equal(hashFile(outside), outsideHash);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  });

  test('invalid manifest JSON exits 1', () => {
    installOk();
    const mPath = path.join(target, 'neat', 'manifest.json');
    fs.writeFileSync(mPath, 'not json');
    const res = run(['--local', '--uninstall']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, new RegExp(`invalid manifest at ${mPath}`));
  });
});
