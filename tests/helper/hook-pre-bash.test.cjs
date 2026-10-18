'use strict';

// PreToolUse Bash hook called directly: which commands count as noisy, the
// exact rewrite, and every reason to leave a command alone.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const { recognize, rewrite, preBash } = require(path.join(LIB, 'hook-pre-bash.cjs'));
const rs = require(path.join(LIB, 'run-state.cjs'));

const NOW = new Date('2026-10-18T12:00:00.000Z');
const HELPER = '/abs/neat/bin/neat.cjs';
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);

const TESTS = [
  'npm test', 'npm t', 'npm run test:unit', 'pnpm test', 'yarn test', 'bun test', 'npx jest',
  'npx vitest run', 'jest', 'node --test', 'node --test tests/a.test.cjs', 'pytest -q',
  'python3 -m pytest', 'tox', 'go test ./...', 'cargo test', 'mvn test', './gradlew test', 'ctest',
  'make test', 'dotnet test', 'rspec', 'bundle exec rspec', 'CI=1 npm test', 'cd app && npm test',
];
const BUILDS = [
  'npm run build', 'pnpm run build', 'tsc', 'tsc --noEmit', 'cargo build', 'cargo clippy',
  'go build ./...', 'go vet ./...', 'make', 'make all', 'cmake --build build', 'ninja', 'mvn compile',
  'dotnet build', 'vite build', 'next build', 'webpack',
];
const INSTALLS = [
  'npm install', 'npm i', 'npm ci', 'pnpm install', 'pnpm add x', 'yarn install', 'yarn add x',
  'bun install', 'pip install -r requirements.txt', 'python -m pip install x', 'poetry install',
  'uv sync', 'uv pip install x', 'bundle install', 'composer install', 'go mod download',
];
const NEVER = [
  'ls -la', 'git status', 'grep -rn x .', 'npm test | tail -5', 'npm test 2>&1', 'npm test > out.txt',
  'npm test; echo done', 'npm test && npm run build', 'echo $(npm test)', 'echo `npm test`',
  'npm test # note', 'npm test\nls', "npm test 'x", 'npm test \\', 'npm run dev', 'npm start',
  'npx vitest', 'vitest', 'jest --watch', 'tsc -w', 'node --test --watch', 'make clean', 'make install',
  'X=$(id) npm test', 'cd "my dir" && npm test', 'cd a && cd b && npm test', `npm test ${'x'.repeat(1992)}`,
  '', '   ', 'npm test &', 'npm test < in.txt', 'npm test {a,b}', 'npm test "x', 'X=$Y npm test',
];

describe('recognize', () => {
  test('known test commands', () => {
    for (const c of TESTS) assert.equal(recognize(c), 'test', c);
  });

  test('known build commands', () => {
    for (const c of BUILDS) assert.equal(recognize(c), 'build', c);
  });

  test('known install commands', () => {
    for (const c of INSTALLS) assert.equal(recognize(c), 'install', c);
  });

  test('operators, substitutions, comments, watch/serve forms and unknown programs are never recognized', () => {
    assert.equal(NEVER[26].length, 2001);
    for (const c of NEVER) assert.equal(recognize(c), null, JSON.stringify(c));
    for (const c of [undefined, null, 42, {}]) assert.equal(recognize(c), null);
  });

  test('balanced quotes are fine', () => {
    assert.equal(recognize('pytest -k "login and not slow"'), 'test');
    assert.equal(recognize("npm test -- --grep 'adds two'"), 'test');
  });
});

describe('rewrite', () => {
  test('pipe form, the original kept as its own subcommand', () => {
    const out = rewrite('npm test', { helper: HELPER, runId: 'RID', kind: 'test', logPath: '/p/l.txt' });
    assert.equal(out, `set -o pipefail; npm test 2>&1 | node ${HELPER} filter RID test /p/l.txt`);
  });
});

describe('preBash', () => {
  let tmp;
  let root;
  let cfgDir;
  let env;

  beforeEach(() => {
    tmp = makeTempDir('neat-prebash-');
    root = path.join(tmp, 'proj');
    cfgDir = path.join(tmp, 'cfg');
    fs.mkdirSync(root);
    fs.mkdirSync(cfgDir);
    env = { NEAT_NOW: NOW.toISOString(), CLAUDE_CONFIG_DIR: cfgDir };
  });
  afterEach(() => removeDir(tmp));

  function newRun(task = 'fix the test', { at = hoursAgo(1), stage = 'implement' } = {}) {
    const state = rs.createRun(root, { task, mode: 'gate' }, at);
    return rs.saveRun(root, rs.setStage(state, stage), at);
  }

  const bash = (command, extra = {}) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'Run the tests', timeout: 120000, ...extra },
  });
  const call = (input, ctxRoot = root, helper = HELPER) => preBash(input, env, { root: ctxRoot, helper });

  test('rewrites a noisy command during an active run and keeps the other input fields', () => {
    const { id } = newRun();
    const out = call(bash('npm test'));
    const data = JSON.parse(out);
    assert.deepEqual(Object.keys(data), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(data.hookSpecificOutput).sort(), ['hookEventName', 'updatedInput']);
    assert.equal(data.hookSpecificOutput.hookEventName, 'PreToolUse');
    const { updatedInput } = data.hookSpecificOutput;
    assert.equal(updatedInput.description, 'Run the tests');
    assert.equal(updatedInput.timeout, 120000);
    const logs = path.join(root, '.neat', 'runs', id, 'logs');
    const m = /^set -o pipefail; npm test 2>&1 \| node (\S+) filter (\S+) test (\S+)$/.exec(updatedInput.command);
    assert.ok(m, updatedInput.command);
    assert.equal(m[1], HELPER);
    assert.equal(m[2], id);
    assert.equal(path.dirname(m[3]), logs);
    assert.match(path.basename(m[3]), /^test-20261018-120000-[0-9a-f]{4}\.txt$/);
    assert.ok(!out.includes('permission'), out);
  });

  test('the newest active run gets the log', () => {
    newRun('older', { at: hoursAgo(5) });
    const { id } = newRun('newer', { at: hoursAgo(2) });
    const cmd = JSON.parse(call(bash('cargo build'))).hookSpecificOutput.updatedInput.command;
    assert.ok(cmd.includes(` filter ${id} build `), cmd);
  });

  test('leaves the command alone in every other case', () => {
    assert.equal(call(bash('npm test')), '', 'no runs dir');
    const run = newRun();
    assert.equal(call({ ...bash('npm test'), tool_name: 'Read' }), '');
    assert.equal(call(bash('npm test', { run_in_background: true })), '');
    assert.equal(call(bash('ls -la')), '');
    assert.equal(call({ tool_name: 'Bash' }), '');
    assert.equal(call({ tool_name: 'Bash', tool_input: 'npm test' }), '');
    assert.equal(call(bash('npm test'), null), '', 'no root');
    assert.equal(call(bash('npm test'), root, '/abs/with space/neat.cjs'), '', 'helper not shell-safe');

    rs.saveRun(root, rs.setStage(run, 'done'), hoursAgo(1));
    assert.equal(call(bash('npm test')), '', 'finished run');
    newRun('stale', { at: hoursAgo(30) });
    assert.equal(call(bash('npm test')), '', 'run not updated within 24 h');
  });

  test('filter.enabled false in the project or global config, or an invalid config, disables it', () => {
    newRun();
    assert.ok(call(bash('npm test')).startsWith('{'));
    const projectCfg = path.join(root, '.neat', 'config.json');
    fs.writeFileSync(projectCfg, '{"filter":{"enabled":false}}');
    assert.equal(call(bash('npm test')), '');
    fs.writeFileSync(projectCfg, '{ broken');
    assert.equal(call(bash('npm test')), '');
    fs.rmSync(projectCfg);
    fs.mkdirSync(path.join(cfgDir, 'neat'));
    fs.writeFileSync(path.join(cfgDir, 'neat', 'config.json'), '{"filter":{"enabled":false}}');
    assert.equal(call(bash('npm test')), '');
  });

  test('a project root outside the shell-safe charset is never rewritten', () => {
    const spaced = path.join(tmp, 'my proj');
    fs.mkdirSync(spaced);
    const state = rs.createRun(spaced, { task: 't', mode: 'gate' }, hoursAgo(1));
    rs.saveRun(spaced, rs.setStage(state, 'implement'), hoursAgo(1));
    assert.equal(call(bash('npm test'), spaced), '');
  });
});
