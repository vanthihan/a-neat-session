'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const VALID_REPORT = [
  '## Status',
  'done',
  '## Findings',
  '- src/app.js:12 - request parsing',
  '## Decisions',
  '- none',
  '## Open questions',
  '- none',
  '## Artifacts',
  '- explore-map.md',
  '',
].join('\n');

let proj;
let helper;
let env;
let runId;

before(() => {
  proj = makeTempDir('neat-tracer-');
  helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
  env = childEnv({ NEAT_PROJECT_DIR: proj });
});

after(() => removeDir(proj));

test('(a) --local install succeeds', () => {
  const res = runNode([path.join(REPO_ROOT, 'bin', 'install.cjs'), '--local'], { cwd: proj, env });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /installed/);
});

test('(b) installed do.md has the absolute helper path rendered', () => {
  const doMd = fs.readFileSync(path.join(proj, '.claude', 'commands', 'neat', 'do.md'), 'utf8');
  assert.ok(doMd.includes(`node ${helper} run new --stdin <<'NEAT_EOF'`));
  assert.ok(!doMd.includes('{{NEAT_BIN}}'));
});

test('(c) installed explorer agent exists', () => {
  const agent = fs.readFileSync(path.join(proj, '.claude', 'agents', 'neat-explorer.md'), 'utf8');
  assert.match(agent, /name: neat-explorer/);
});

test('(d) run new --stdin keeps the task byte-exact and parses --mode', () => {
  const res = runNode([helper, 'run', 'new', '--stdin'], {
    cwd: proj,
    env,
    input: 'fix "it\'s" $(rm -rf x) --mode auto\n',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^id=\d{8}-\d{6}-[a-z0-9-]+ mode=auto dir=/);
  runId = /^id=(\S+)/.exec(res.stdout)[1];
  const state = JSON.parse(fs.readFileSync(path.join(proj, '.neat', 'runs', runId, 'state.json'), 'utf8'));
  assert.strictEqual(state.task, 'fix "it\'s" $(rm -rf x)');
  assert.equal(state.mode, 'auto');
  assert.equal(state.stage, 'created');
});

test('(e) write stores a brief and prints its absolute path', () => {
  const input = 'Task: fix it\nRun id: x\n';
  const res = runNode([helper, 'write', runId, 'brief-explorer.md', '--stdin'], { cwd: proj, env, input });
  assert.equal(res.status, 0, res.stderr);
  const printed = res.stdout.trim();
  assert.ok(path.isAbsolute(printed));
  assert.ok(printed.endsWith('brief-explorer.md'));
  assert.equal(fs.readFileSync(printed, 'utf8'), input);
});

test('(f) a valid report passes write and report check', () => {
  const map = runNode([helper, 'write', runId, 'explore-map.md', '--stdin'], {
    cwd: proj,
    env,
    input: 'src/app.js:12 - request parsing\n',
  });
  assert.equal(map.status, 0, map.stderr);
  const res = runNode([helper, 'write', runId, 'report-explorer.md', '--stdin'], {
    cwd: proj,
    env,
    input: VALID_REPORT,
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /report ok/);
  const file = res.stdout.split('\n')[0];
  const check = runNode([helper, 'report', 'check', file], { cwd: proj, env });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /report ok/);
});

test('(g) a report missing ## Decisions is rejected', () => {
  const bad = VALID_REPORT.replace('## Decisions\n- none\n', '');
  const res = runNode([helper, 'write', runId, 'report-explorer.md', '--stdin'], { cwd: proj, env, input: bad });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /missing heading: ## Decisions/);
});

test('(h) installed helper help lists the subcommands', () => {
  const res = runNode([helper, 'help'], { cwd: proj, env });
  assert.equal(res.status, 0);
  for (const cmd of ['neat run new', 'neat write', 'neat report check']) {
    assert.ok(res.stdout.includes(cmd), `missing ${cmd}`);
  }
});
