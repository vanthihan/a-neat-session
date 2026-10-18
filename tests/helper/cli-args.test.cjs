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
  assert.deepEqual(parseTaskArgs('add login --mode auto'), { task: 'add login', mode: 'auto' });
});

test('leading --mode=X is parsed and one layer of wrapping quotes is stripped', () => {
  assert.deepEqual(parseTaskArgs('--mode=step "add X"'), { task: 'add X', mode: 'step' });
  assert.deepEqual(parseTaskArgs("'add Y'"), { task: 'add Y', mode: 'gate' });
});

test('quotes that do not wrap the whole task are kept', () => {
  assert.equal(parseTaskArgs('"a" and "b"').task, '"a" and "b"');
});

test('--mode in the middle of the task is task text, mode defaults to gate', () => {
  assert.deepEqual(parseTaskArgs('remove the --mode flag from docs'), {
    task: 'remove the --mode flag from docs',
    mode: 'gate',
  });
});

test('-- ends flag parsing', () => {
  assert.deepEqual(parseTaskArgs('--mode auto -- --weird task'), { task: '--weird task', mode: 'auto' });
});

test('shell metacharacters survive byte-exact', () => {
  const parsed = parseTaskArgs('fix "it\'s" $(rm -rf x) --mode auto');
  assert.strictEqual(parsed.task, 'fix "it\'s" $(rm -rf x)');
  assert.equal(parsed.mode, 'auto');
});

test('inner whitespace and newlines of the task are preserved', () => {
  assert.equal(parseTaskArgs('--mode step line one\n  line two\n').task, 'line one\n  line two');
});

test('unknown flags are usage errors', () => {
  usage('fix it --mod auto', 'unknown flag --mod (valid: --mode)');
  usage('--verbose fix it', 'unknown flag --verbose (valid: --mode)');
  usage('fix it --verbose', 'unknown flag --verbose (valid: --mode)');
});

test('invalid mode value is a usage error', () => {
  usage('fix it --mode fast', "invalid --mode 'fast' (use gate|auto|step)");
  usage('--mode=fast fix it', "invalid --mode 'fast' (use gate|auto|step)");
});

test('--mode without a value is a usage error', () => {
  usage('fix it --mode', '--mode needs a value (use gate|auto|step)');
});

test('duplicate --mode is a usage error', () => {
  usage('--mode auto x --mode step', 'duplicate --mode');
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
      input: 'x --mode fast\n',
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
