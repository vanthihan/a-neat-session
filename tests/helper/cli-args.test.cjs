'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
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
  assert.deepEqual(parseTaskArgs('add login --mode auto'), { task: 'add login', mode: 'auto', profile: null });
});

test('leading --mode=X is parsed and one layer of wrapping quotes is stripped', () => {
  assert.deepEqual(parseTaskArgs('--mode=step "add X"'), { task: 'add X', mode: 'step', profile: null });
  assert.deepEqual(parseTaskArgs("'add Y'"), { task: 'add Y', mode: 'gate', profile: null });
});

test('quotes that do not wrap the whole task are kept', () => {
  assert.equal(parseTaskArgs('"a" and "b"').task, '"a" and "b"');
});

test('--mode in the middle of the task is task text, mode defaults to gate', () => {
  assert.deepEqual(parseTaskArgs('remove the --mode flag from docs'), {
    task: 'remove the --mode flag from docs',
    mode: 'gate',
    profile: null,
  });
});

test('-- ends flag parsing', () => {
  assert.deepEqual(parseTaskArgs('--mode auto -- --weird task'), { task: '--weird task', mode: 'auto', profile: null });
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
  usage('--verbose fix it', 'unknown flag --verbose (valid: --mode, --profile; put -- before a task that starts with a flag)');
});

test('trailing words that mention a flag are task text', () => {
  for (const text of [
    'add a --dry-run option', 'support --json', 'fix the --mode flag', 'make --mode work',
    'fix it --mod auto', 'fix it --verbose', 'fix it --mode fast', 'document --mode',
  ]) {
    assert.deepEqual(parseTaskArgs(text), { task: text, mode: 'gate', profile: null });
  }
  assert.deepEqual(parseTaskArgs('support --json --mode auto'), { task: 'support --json', mode: 'auto', profile: null });
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
  assert.deepEqual(parseTaskArgs('--profile budget fix it'), { task: 'fix it', mode: 'gate', profile: 'budget' });
  assert.deepEqual(parseTaskArgs('fix it --profile quality'), { task: 'fix it', mode: 'gate', profile: 'quality' });
  assert.deepEqual(parseTaskArgs('--profile=inherit fix'), { task: 'fix', mode: 'gate', profile: 'inherit' });
  assert.deepEqual(parseTaskArgs('fix it'), { task: 'fix it', mode: 'gate', profile: null });
  assert.deepEqual(parseTaskArgs('--mode auto --profile balanced x'), { task: 'x', mode: 'auto', profile: 'balanced' });
  assert.deepEqual(parseTaskArgs('fix it --profile adaptive --mode step'), { task: 'fix it', mode: 'step', profile: 'adaptive' });
  assert.deepEqual(parseTaskArgs('fix it --profile=budget'), { task: 'fix it', mode: 'gate', profile: 'budget' });
});

test('--profile mentioned in the task or with an invalid trailing value is task text', () => {
  for (const text of ['add a --profile option', 'fix it --profile wizard', 'fix it --profile=fast', 'document --profile']) {
    assert.deepEqual(parseTaskArgs(text), { task: text, mode: 'gate', profile: null });
  }
});

test('invalid, missing and duplicate leading --profile are usage errors', () => {
  usage('--profile wizard x', "invalid --profile 'wizard' (use adaptive|quality|balanced|budget|inherit)");
  usage('--profile=wizard x', "invalid --profile 'wizard' (use adaptive|quality|balanced|budget|inherit)");
  usage('--profile', '--profile needs a value (use adaptive|quality|balanced|budget|inherit)');
  usage('--profile budget x --profile quality', 'duplicate --profile');
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
