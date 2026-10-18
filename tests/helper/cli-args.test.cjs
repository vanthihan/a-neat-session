'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const { parseTaskArgs, UsageError } = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'cli-args.cjs'));
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

function usage(text, message) {
  assert.throws(() => parseTaskArgs(text), (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err && err.name}`);
    assert.equal(err.exitCode, 2);
    assert.equal(err.message, message);
    return true;
  });
}

test('trailing --mode X is parsed', () => {
  assert.deepEqual(parseTaskArgs('add login --mode auto'), { task: 'add login', mode: 'auto', profile: null, research: false, tmux: false });
});

test('leading --mode=X is parsed and one layer of wrapping quotes is stripped', () => {
  assert.deepEqual(parseTaskArgs('--mode=step "add X"'), { task: 'add X', mode: 'step', profile: null, research: false, tmux: false });
  assert.deepEqual(parseTaskArgs("'add Y'"), { task: 'add Y', mode: 'gate', profile: null, research: false, tmux: false });
});

test('quotes that do not wrap the whole task are kept', () => {
  assert.equal(parseTaskArgs('"a" and "b"').task, '"a" and "b"');
});

test('--mode in the middle of the task is task text, mode defaults to gate', () => {
  assert.deepEqual(parseTaskArgs('remove the --mode flag from docs'), {
    task: 'remove the --mode flag from docs',
    mode: 'gate',
    profile: null,
    research: false,
    tmux: false,
  });
});

test('-- ends flag parsing', () => {
  assert.deepEqual(parseTaskArgs('--mode auto -- --weird task'), { task: '--weird task', mode: 'auto', profile: null, research: false, tmux: false });
});

test('shell metacharacters survive byte-exact', () => {
  const parsed = parseTaskArgs('fix "it\'s" $(rm -rf x) --mode auto');
  assert.strictEqual(parsed.task, 'fix "it\'s" $(rm -rf x)');
  assert.equal(parsed.mode, 'auto');
});

test('inner whitespace and newlines of the task are preserved', () => {
  assert.equal(parseTaskArgs('--mode step line one\n  line two\n').task, 'line one\n  line two');
});

test('unknown leading flags are usage errors that point to --', () => {
  usage('--verbose fix it', 'unknown flag --verbose (valid: --mode, --profile, --research, --tmux; put -- before a task that starts with a flag)');
});

test('trailing words that mention a flag are task text', () => {
  for (const text of [
    'add a --dry-run option', 'support --json', 'fix the --mode flag', 'make --mode work',
    'fix it --mod auto', 'fix it --verbose', 'fix it --mode fast', 'document --mode',
  ]) {
    assert.deepEqual(parseTaskArgs(text), { task: text, mode: 'gate', profile: null, research: false, tmux: false });
  }
  assert.deepEqual(parseTaskArgs('support --json --mode auto'), { task: 'support --json', mode: 'auto', profile: null, research: false, tmux: false });
});

test('invalid --mode= value is a usage error', () => {
  usage('fix it --mode=fast', "invalid --mode 'fast' (use gate|auto|step)");
  usage('--mode=fast fix it', "invalid --mode 'fast' (use gate|auto|step)");
  usage('--mode fast fix it', "invalid --mode 'fast' (use gate|auto|step)");
});

test('leading --mode without a value is a usage error', () => {
  usage('--mode', '--mode needs a value (use gate|auto|step)');
});

test('duplicate --mode is a usage error', () => {
  usage('--mode auto x --mode step', 'duplicate --mode');
});

test('leading and trailing --profile set the profile; no flag leaves it null', () => {
  assert.deepEqual(parseTaskArgs('--profile budget fix it'), { task: 'fix it', mode: 'gate', profile: 'budget', research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('fix it --profile quality'), { task: 'fix it', mode: 'gate', profile: 'quality', research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('--profile=inherit fix'), { task: 'fix', mode: 'gate', profile: 'inherit', research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('fix it'), { task: 'fix it', mode: 'gate', profile: null, research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('--mode auto --profile balanced x'), { task: 'x', mode: 'auto', profile: 'balanced', research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('fix it --profile adaptive --mode step'), { task: 'fix it', mode: 'step', profile: 'adaptive', research: false, tmux: false });
  assert.deepEqual(parseTaskArgs('fix it --profile=budget'), { task: 'fix it', mode: 'gate', profile: 'budget', research: false, tmux: false });
});

test('--profile mentioned in the task or with an invalid trailing value is task text', () => {
  for (const text of ['add a --profile option', 'fix it --profile wizard', 'fix it --profile=fast', 'document --profile']) {
    assert.deepEqual(parseTaskArgs(text), { task: text, mode: 'gate', profile: null, research: false, tmux: false });
  }
});

test('invalid, missing and duplicate leading --profile are usage errors', () => {
  usage('--profile wizard x', "invalid --profile 'wizard' (use adaptive|quality|balanced|budget|inherit)");
  usage('--profile=wizard x', "invalid --profile 'wizard' (use adaptive|quality|balanced|budget|inherit)");
  usage('--profile', '--profile needs a value (use adaptive|quality|balanced|budget|inherit)');
  usage('--profile budget x --profile quality', 'duplicate --profile');
});

test('leading --research sets research; without it research is false', () => {
  assert.deepEqual(parseTaskArgs('--research how does retry work'), {
    task: 'how does retry work', mode: 'gate', profile: null, research: true, tmux: false,
  });
  assert.equal(parseTaskArgs('how does retry work').research, false);
  assert.deepEqual(parseTaskArgs('--mode auto --research --profile budget x'), {
    task: 'x', mode: 'auto', profile: 'budget', research: true, tmux: false,
  });
});

test('duplicate --research and --research=value are usage errors', () => {
  usage('--research --research x', 'duplicate --research');
  usage('--research=yes x', 'unknown flag --research (valid: --mode, --profile, --research, --tmux; put -- before a task that starts with a flag)');
});

test('a trailing --research is task text', () => {
  assert.deepEqual(parseTaskArgs('explain x --research'), {
    task: 'explain x --research', mode: 'gate', profile: null, research: false, tmux: false,
  });
});

test('run new --stdin stores research in state.json', () => {
  const proj = makeTempDir('neat-cli-');
  try {
    const env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: '2026-10-18T01:02:03Z' });
    const res = runNode([HELPER, 'run', 'new', '--stdin'], { env, input: '--research how does retry work\n' });
    assert.equal(res.status, 0, res.stderr);
    const dir = res.stdout.match(/ dir=(\S+)/)[1];
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.research, true);
    assert.equal(state.task, 'how does retry work');
    const id = res.stdout.match(/^id=(\S+)/)[1];
    const st = runNode([HELPER, 'stages', id, '--type', 'feature'], { env });
    assert.equal(st.status, 0, st.stderr);
    assert.ok(st.stdout.split(' ')[1].split(',').includes('research'), st.stdout);
    const plain = runNode([HELPER, 'run', 'new', 'plain', 'task'], { env });
    const plainDir = plain.stdout.match(/ dir=(\S+)/)[1];
    assert.equal(JSON.parse(fs.readFileSync(path.join(plainDir, 'state.json'), 'utf8')).research, false);
  } finally {
    removeDir(proj);
  }
});

test('leading --tmux sets tmux; a trailing one is task text; a duplicate is an error', () => {
  assert.deepEqual(parseTaskArgs('--tmux fix bug'), { task: 'fix bug', mode: 'gate', profile: null, research: false, tmux: true });
  assert.deepEqual(parseTaskArgs('--research --tmux --mode auto fix'), {
    task: 'fix', mode: 'auto', profile: null, research: true, tmux: true,
  });
  assert.deepEqual(parseTaskArgs('fix bug --tmux'), { task: 'fix bug --tmux', mode: 'gate', profile: null, research: false, tmux: false });
  usage('--tmux --tmux x', 'duplicate --tmux');
  usage('--tmux=yes x', 'unknown flag --tmux (valid: --mode, --profile, --research, --tmux; put -- before a task that starts with a flag)');
});

test('run new --stdin stores tmux in state.json', () => {
  const proj = makeTempDir('neat-cli-');
  try {
    const env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: '2026-10-18T01:02:03Z' });
    const stateOf = (input) => {
      const res = runNode([HELPER, 'run', 'new', '--stdin'], { env, input });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(fs.readFileSync(path.join(res.stdout.match(/ dir=(\S+)/)[1], 'state.json'), 'utf8'));
    };
    const on = stateOf('--tmux watch it\n');
    assert.deepEqual([on.tmux, on.task], [true, 'watch it']);
    assert.equal(stateOf('plain task\n').tmux, false);
  } finally {
    removeDir(proj);
  }
});

test('help and the do command hint show --tmux', () => {
  const res = runNode([HELPER, 'help'], { env: childEnv({}) });
  assert.equal(res.status, 0);
  const lines = res.stdout.split('\n');
  assert.ok(lines.find((l) => l.startsWith('neat run new')).includes('[--tmux]'));
  assert.ok(lines.find((l) => l.startsWith('neat codex run')).includes('[--tmux]'));
  const doMd = fs.readFileSync(path.join(REPO_ROOT, 'payload', 'commands', 'neat', 'do.md'), 'utf8');
  assert.ok(doMd.split('\n').find((l) => l.startsWith('argument-hint:')).includes('[--tmux]'));
});

test('help shows --research on run new', () => {
  const res = runNode([HELPER, 'help'], { env: childEnv({}) });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.split('\n').find((l) => l.startsWith('neat run new')).includes('[--research]'));
});

test('empty task is a usage error', () => {
  usage('   ', 'task is required');
  usage('--mode auto', 'task is required');
  usage('""', 'task is required');
});

test('helper maps parse errors to exit 2 with a one-line message', () => {
  const proj = makeTempDir('neat-cli-');
  try {
    const res = runNode([HELPER, 'run', 'new', '--stdin'], {
      env: childEnv({ NEAT_PROJECT_DIR: proj }),
      input: 'x --mode=fast\n',
    });
    assert.equal(res.status, 2);
    assert.equal(res.stderr, "neat: invalid --mode 'fast' (use gate|auto|step)\n");
  } finally {
    removeDir(proj);
  }
});

test('helper accepts the task as argv words', () => {
  const proj = makeTempDir('neat-cli-');
  try {
    const res = runNode([HELPER, 'run', 'new', '--mode', 'step', 'add', 'login'], {
      env: childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: '2026-10-18T01:02:03Z' }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^id=20261018-010203-add-login mode=step dir=/);
  } finally {
    removeDir(proj);
  }
});
