'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const rs = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'run-state.cjs'));
const { UsageError } = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'cli-args.cjs'));

const NOW = new Date('2026-10-18T12:34:56Z');

let root;

before(() => {
  root = makeTempDir('neat-state-');
});

after(() => removeDir(root));

test('slugify lowercases and collapses separators', () => {
  assert.equal(rs.slugify('Fix: the  BUG!!'), 'fix-the-bug');
  assert.equal(rs.slugify('!!!'), 'task');
});

test('slugify caps the slug at 40 characters without a trailing dash', () => {
  const slug = rs.slugify(`${'abcdefghi '.repeat(9)}`);
  assert.ok(slug.length <= 40, slug);
  assert.ok(!slug.endsWith('-'));
});

test('isValidRunId rejects traversal and malformed ids', () => {
  assert.equal(rs.isValidRunId('20261018-123456-fix-bug'), true);
  assert.equal(rs.isValidRunId('../x'), false);
  assert.equal(rs.isValidRunId('20261018-123456-a/b'), false);
  assert.equal(rs.isValidRunId(''), false);
});

test('makeRunId appends -2, then -3 on collision', () => {
  const first = rs.makeRunId('fix bug', NOW, []);
  assert.equal(first, '20261018-123456-fix-bug');
  assert.equal(rs.makeRunId('fix bug', NOW, [first]), `${first}-2`);
  assert.equal(rs.makeRunId('fix bug', NOW, [first, `${first}-2`]), `${first}-3`);
});

test('createRun writes state.json with the documented fields', () => {
  const state = rs.createRun(root, { task: 'fix bug', mode: 'gate' }, NOW);
  const onDisk = JSON.parse(fs.readFileSync(path.join(rs.runsDir(root), state.id, 'state.json'), 'utf8'));
  assert.equal(onDisk.id, state.id);
  assert.equal(onDisk.task, 'fix bug');
  assert.equal(onDisk.mode, 'gate');
  assert.equal(onDisk.stage, 'created');
  assert.deepEqual(onDisk.stages.map((s) => s.name), ['explore', 'plan', 'implement', 'review', 'test', 'docs']);
  assert.ok(onDisk.stages.every((s) => s.status === 'pending'));
  assert.deepEqual(onDisk.workers, []);
  assert.equal(onDisk.createdAt, NOW.toISOString());
  assert.equal(onDisk.updatedAt, NOW.toISOString());
});

test('a second run in the same second gets a -2 id', () => {
  const again = rs.createRun(root, { task: 'fix bug', mode: 'gate' }, NOW);
  assert.equal(again.id, '20261018-123456-fix-bug-2');
});

test('loadRun and writeRunFile reject bad ids and names with UsageError', () => {
  assert.throws(() => rs.loadRun(root, '../x'), UsageError);
  const id = '20261018-123456-fix-bug';
  for (const name of ['../x.md', 'state.json', 'Brief.md', 'brief.sh', `${'a'.repeat(80)}.md`]) {
    assert.throws(() => rs.writeRunFile(root, id, name, 'x'), UsageError, name);
  }
  assert.throws(() => rs.writeRunFile(root, '20261018-123456-nope', 'brief.md', 'x'), UsageError);
});

test('writeRunFile writes atomically and returns the absolute path', () => {
  const id = '20261018-123456-fix-bug';
  const file = rs.writeRunFile(root, id, 'brief-explorer.md', 'hello\n');
  assert.equal(file, path.join(rs.runsDir(root), id, 'brief-explorer.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

// ---- stage / worker transitions and status (helper CLI) ----

const { childEnv, runNode } = require('../support/helpers.cjs');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const { formatStatus } = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'status.cjs'));

function withProject(fn) {
  const proj = makeTempDir('neat-cli-state-');
  try {
    return fn(proj, (args, extraEnv = {}) => runNode([HELPER, ...args], {
      cwd: proj,
      env: childEnv({ NEAT_PROJECT_DIR: proj, ...extraEnv }),
    }));
  } finally {
    removeDir(proj);
  }
}

function readState(proj, id) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.neat', 'runs', id, 'state.json'), 'utf8'));
}

function newRun(neat, task = 'fix bug', now = '2026-10-18T10:00:00Z') {
  const res = neat(['run', 'new', task], { NEAT_NOW: now });
  assert.equal(res.status, 0, res.stderr);
  return /^id=(\S+)/.exec(res.stdout)[1];
}

function stageStatus(state, name) {
  return state.stages.find((s) => s.name === name).status;
}

test('run stage moves the running stage forward and ends with done', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    let res = neat(['run', 'stage', id, 'explore']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stage explore\n');
    let st = readState(proj, id);
    assert.equal(st.stage, 'explore');
    assert.equal(stageStatus(st, 'explore'), 'running');
    neat(['run', 'stage', id, 'plan']);
    st = readState(proj, id);
    assert.equal(stageStatus(st, 'explore'), 'done');
    assert.equal(stageStatus(st, 'plan'), 'running');
    neat(['run', 'stage', id, 'done']);
    st = readState(proj, id);
    assert.equal(stageStatus(st, 'plan'), 'done');
    assert.equal(st.stage, 'done');
  });
});

test('run stage cancelled marks the running stage cancelled', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    neat(['run', 'stage', id, 'explore']);
    const res = neat(['run', 'stage', id, 'cancelled']);
    assert.equal(res.status, 0, res.stderr);
    const st = readState(proj, id);
    assert.equal(stageStatus(st, 'explore'), 'cancelled');
    assert.equal(st.stage, 'cancelled');
  });
});

test('run stage rejects unknown stages and bad ids with exit 2', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    assert.equal(neat(['run', 'stage', id, 'deploy']).status, 2);
    assert.equal(neat(['run', 'stage', '../x', 'explore']).status, 2);
  });
});

test('run worker records one entry per worker with its report path', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    const res = neat(['run', 'worker', id, 'explorer', 'running']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'worker explorer running\n');
    const report = path.join(proj, '.neat', 'runs', id, 'report-explorer.md');
    assert.deepEqual(readState(proj, id).workers, [{ name: 'explorer', status: 'running', report }]);
    neat(['run', 'worker', id, 'explorer', 'done']);
    assert.deepEqual(readState(proj, id).workers, [{ name: 'explorer', status: 'done', report }]);
  });
});

test('run worker validates names and statuses', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    for (const name of ['explorer', 'reviewer', 'tester', 'implementer-T1', 'docs-D1']) {
      assert.equal(neat(['run', 'worker', id, name, 'running']).status, 0, name);
    }
    for (const name of ['implementer', 'docs', '../x']) {
      assert.equal(neat(['run', 'worker', id, name, 'running']).status, 2, name);
    }
    for (const status of ['done', 'failed', 'report-invalid']) {
      assert.equal(neat(['run', 'worker', id, 'tester', status]).status, 0, status);
    }
    assert.equal(neat(['run', 'worker', id, 'tester', 'paused']).status, 2);
  });
});

test('setStage and setWorker do not mutate their input', () => {
  const state = rs.createRun(root, { task: 'pure check', mode: 'auto' }, NOW);
  const snapshot = structuredClone(state);
  const staged = rs.setStage(state, 'explore');
  const withWorker = rs.setWorker(staged, 'explorer', 'running', '/x/report-explorer.md');
  assert.deepEqual(state, snapshot);
  assert.notEqual(staged, state);
  assert.equal(withWorker.workers.length, 1);
  assert.equal(staged.workers.length, 0);
  assert.throws(() => rs.setStage(state, 'deploy'), UsageError);
  assert.throws(() => rs.setWorker(state, 'implementer', 'running'), UsageError);
});

test('status with no runs exits 0 with a message', () => {
  withProject((proj, neat) => {
    const res = neat(['status']);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, `no neat runs in ${path.join(proj, '.neat', 'runs')}\n`);
  });
});

test('status lists runs newest first with mode, stage and active workers', () => {
  withProject((proj, neat) => {
    const older = newRun(neat, 'older task', '2026-10-18T09:00:00Z');
    const newer = newRun(neat, 'newer task --mode auto', '2026-10-18T11:00:00Z');
    neat(['run', 'stage', newer, 'explore'], { NEAT_NOW: '2026-10-18T11:05:00Z' });
    neat(['run', 'worker', newer, 'explorer', 'running'], { NEAT_NOW: '2026-10-18T11:06:00Z' });
    const res = neat(['status']);
    assert.equal(res.status, 0);
    const lines = res.stdout.trimEnd().split('\n');
    assert.equal(lines[0], `neat runs: 2 (showing 2) in ${path.join(proj, '.neat', 'runs')}`);
    assert.equal(lines[1], `${newer}  mode=auto  stage=explore  active=explorer  updated=2026-10-18T11:06:00.000Z`);
    assert.equal(lines[2], `${older}  mode=gate  stage=created  active=-  updated=2026-10-18T09:00:00.000Z`);
  });
});

test('status --json returns the run summaries', () => {
  withProject((proj, neat) => {
    const id = newRun(neat, 'json task');
    const res = neat(['status', '--json']);
    assert.equal(res.status, 0);
    const runs = JSON.parse(res.stdout);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, id);
    assert.equal(runs[0].task, 'json task');
    assert.equal(runs[0].mode, 'gate');
    assert.equal(runs[0].stage, 'created');
    assert.deepEqual(runs[0].activeWorkers, []);
    assert.equal(runs[0].updatedAt, '2026-10-18T10:00:00.000Z');
  });
});

test('status shows at most 10 runs and survives a corrupt state file', () => {
  withProject((proj, neat) => {
    for (let i = 0; i < 12; i += 1) {
      rs.createRun(proj, { task: `task ${i}`, mode: 'gate' }, new Date(Date.UTC(2026, 9, 18, 8, i)));
    }
    const ids = fs.readdirSync(path.join(proj, '.neat', 'runs')).sort();
    const newest = ids[ids.length - 1];
    fs.writeFileSync(path.join(proj, '.neat', 'runs', newest, 'state.json'), '{ not json');
    const res = neat(['status']);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^neat runs: 12 \(showing 10\) in /);
    assert.equal(lines.length, 11);
    assert.equal(lines[1], `${newest}  unreadable state`);
  });
});

test('formatStatus renders an empty list', () => {
  assert.equal(formatStatus([], { runsDir: '/p/.neat/runs' }), 'no neat runs in /p/.neat/runs');
  assert.equal(formatStatus([], { json: true, runsDir: '/p/.neat/runs' }), '[]');
});

test('status.md injects the helper status output', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'payload', 'commands', 'neat', 'status.md'), 'utf8');
  assert.ok(md.split('\n').includes('!`node {{NEAT_BIN}} status`'));
});
