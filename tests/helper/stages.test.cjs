'use strict';

// Stage selection by task type: the pure map, flag overrides, the propose
// rule, the `stage X skipped` line and legacy (Phase 1) run states.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const stages = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'stages.cjs'));
const rs = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'run-state.cjs'));
const { UsageError } = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'cli-args.cjs'));

const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const FULL = ['explore', 'plan', 'implement', 'review', 'test', 'docs'];

function withProject(fn) {
  const proj = makeTempDir('neat-stages-');
  try {
    return fn(proj, (args, extraEnv = {}) => runNode([HELPER, ...args], {
      cwd: proj,
      env: childEnv({ NEAT_PROJECT_DIR: proj, ...extraEnv }),
    }));
  } finally {
    removeDir(proj);
  }
}

function stateFile(proj, id) {
  return path.join(proj, '.neat', 'runs', id, 'state.json');
}

function readState(proj, id) {
  return JSON.parse(fs.readFileSync(stateFile(proj, id), 'utf8'));
}

function writeState(proj, id, state) {
  fs.writeFileSync(stateFile(proj, id), `${JSON.stringify(state, null, 2)}\n`);
}

function newRun(neat, task = 'fix bug') {
  const res = neat(['run', 'new', task], { NEAT_NOW: '2026-10-18T10:00:00Z' });
  assert.equal(res.status, 0, res.stderr);
  return /^id=(\S+)/.exec(res.stdout)[1];
}

function statusOf(state, name) {
  const entry = state.stages.find((s) => s.name === name);
  return entry ? entry.status : undefined;
}

// ---- pure functions ----

test('selectStages maps every task type to its stages in pipeline order', () => {
  assert.deepEqual(stages.TYPES, ['small-fix', 'feature', 'refactor', 'research', 'docs']);
  assert.deepEqual(stages.selectStages('small-fix'), ['explore', 'plan', 'implement', 'test']);
  assert.deepEqual(stages.selectStages('feature'), FULL);
  assert.deepEqual(stages.selectStages('refactor'), FULL);
  assert.deepEqual(stages.selectStages('research'), ['explore', 'research']);
  assert.deepEqual(stages.selectStages('docs'), ['explore', 'plan', 'docs']);
});

test('the research flag adds research right after explore', () => {
  assert.deepEqual(stages.selectStages('small-fix', { research: true }),
    ['explore', 'research', 'plan', 'implement', 'test']);
  assert.deepEqual(stages.selectStages('research', { research: true }), ['explore', 'research']);
  assert.deepEqual(stages.selectStages('feature', { research: false }), FULL);
});

test('an unknown type is a UsageError naming the valid types', () => {
  assert.throws(() => stages.selectStages('x'), (err) => err instanceof UsageError
    && err.message === "invalid --type 'x' (use small-fix|feature|refactor|research|docs)");
});

test('applyStages records the selection and skips unselected stages', () => {
  const state = { id: 'r', stage: 'explore', stages: rs.PIPELINE.map((name) => ({ name, status: 'pending' })) };
  const snapshot = structuredClone(state);
  const selected = stages.selectStages('small-fix');
  const next = stages.applyStages(state, 'small-fix', selected);
  assert.deepEqual(state, snapshot, 'input unchanged');
  assert.equal(next.type, 'small-fix');
  assert.deepEqual(next.selectedStages, selected);
  assert.deepEqual(next.stages.map((s) => [s.name, s.status]), [
    ['explore', 'pending'], ['research', 'skipped'], ['plan', 'pending'], ['implement', 'pending'],
    ['review', 'skipped'], ['test', 'pending'], ['docs', 'skipped'],
  ]);
});

test('applyStages keeps done and running entries and flips pending/skipped on a new call', () => {
  const state = {
    id: 'r',
    stage: 'explore',
    stages: [
      { name: 'explore', status: 'running' },
      { name: 'research', status: 'skipped' },
      { name: 'plan', status: 'pending' },
      { name: 'implement', status: 'pending' },
      { name: 'review', status: 'skipped' },
      { name: 'test', status: 'pending' },
      { name: 'docs', status: 'skipped' },
    ],
  };
  const next = stages.applyStages(state, 'research', stages.selectStages('research'));
  assert.deepEqual(next.stages.map((s) => [s.name, s.status]), [
    ['explore', 'running'], ['research', 'pending'], ['plan', 'skipped'], ['implement', 'skipped'],
    ['review', 'skipped'], ['test', 'skipped'], ['docs', 'skipped'],
  ]);
  const back = stages.applyStages(next, 'feature', stages.selectStages('feature'));
  assert.deepEqual(back.stages.map((s) => s.status),
    ['running', 'skipped', 'pending', 'pending', 'pending', 'pending', 'pending']);
});

test('applyStages inserts a missing research entry and never skips explore', () => {
  const legacy = { id: 'r', stage: 'created', stages: FULL.map((name) => ({ name, status: 'pending' })) };
  const next = stages.applyStages(legacy, 'docs', ['plan', 'docs']);
  assert.deepEqual(next.stages.map((s) => s.name), rs.PIPELINE);
  assert.equal(statusOf(next, 'explore'), 'pending');
  assert.equal(statusOf(next, 'research'), 'skipped');
  assert.equal(legacy.stages.length, 6, 'input unchanged');
});

test('selectedOf prefers selectedStages, else the pipeline names that are present and not skipped', () => {
  assert.deepEqual(stages.selectedOf({ selectedStages: ['explore', 'research'], stages: [] }), ['explore', 'research']);
  const fresh = { stages: rs.PIPELINE.map((name) => ({ name, status: name === 'research' ? 'skipped' : 'pending' })) };
  assert.deepEqual(stages.selectedOf(fresh), FULL);
  const legacy = { stages: FULL.map((name) => ({ name, status: 'done' })) };
  assert.deepEqual(stages.selectedOf(legacy), FULL);
});

test('isSkipped is true for a skipped or missing pipeline stage only', () => {
  const legacy = { stages: FULL.map((name) => ({ name, status: 'pending' })) };
  assert.equal(stages.isSkipped(legacy, 'research'), true);
  assert.equal(stages.isSkipped(legacy, 'review'), false);
  assert.equal(stages.isSkipped(legacy, 'done'), false);
  assert.equal(stages.isSkipped(legacy, 'cancelled'), false);
  assert.equal(stages.isSkipped({ stages: [{ name: 'docs', status: 'skipped' }] }, 'docs'), true);
});

// ---- CLI ----

test('stages --type small-fix on a gate run records the selection and proposes research', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    neat(['run', 'stage', id, 'explore']);
    const res = neat(['stages', id, '--type', 'small-fix']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stages explore,plan,implement,test type=small-fix propose=yes\n');
    const st = readState(proj, id);
    assert.equal(st.type, 'small-fix');
    assert.deepEqual(st.selectedStages, ['explore', 'plan', 'implement', 'test']);
    for (const name of ['research', 'review', 'docs']) assert.equal(statusOf(st, name), 'skipped', name);
    assert.equal(statusOf(st, 'explore'), 'running');
    assert.equal(st.stage, 'explore');
  });
});

test('--research selects research and turns the proposal off', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    const res = neat(['stages', id, '--type', 'small-fix', '--research']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stages explore,research,plan,implement,test type=small-fix propose=no\n');
    assert.equal(statusOf(readState(proj, id), 'research'), 'pending');
  });
});

test('auto runs never propose; --mode given to stages decides the proposal', () => {
  withProject((proj, neat) => {
    const id = newRun(neat, 'add a thing --mode auto');
    let res = neat(['stages', id, '--type', 'feature']);
    assert.equal(res.stdout, 'stages explore,plan,implement,review,test,docs type=feature propose=no\n');
    res = neat(['stages', id, '--type', 'feature', '--mode', 'step']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stages explore,plan,implement,review,test,docs type=feature propose=yes\n');
    assert.equal(readState(proj, id).mode, 'auto', 'run mode unchanged');
    res = neat(['stages', id, '--type=docs', '--mode=gate']);
    assert.equal(res.stdout, 'stages explore,plan,docs type=docs propose=yes\n');
  });
});

test('research: true in state.json selects research', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    writeState(proj, id, { ...readState(proj, id), research: true });
    const res = neat(['stages', id, '--type', 'feature']);
    assert.equal(res.stdout, 'stages explore,research,plan,implement,review,test,docs type=feature propose=no\n');
  });
});

test('stages usage errors exit 2', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    assert.equal(neat(['stages', id]).status, 2);
    assert.equal(neat(['stages', id, '--type']).status, 2);
    assert.equal(neat(['stages', id, '--type', 'bogus']).status, 2);
    assert.equal(neat(['stages', id, '--type', 'feature', '--fast']).status, 2);
    assert.equal(neat(['stages', id, '--type', 'feature', '--mode', 'yolo']).status, 2);
    assert.equal(neat(['stages', id, '--type', 'feature', '--type', 'docs']).status, 2);
    assert.equal(neat(['stages', '../x', '--type', 'feature']).status, 2);
    assert.equal(neat(['stages']).status, 2);
  });
});

test('run stage on a skipped stage prints skipped and changes nothing', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    neat(['run', 'stage', id, 'explore']);
    neat(['stages', id, '--type', 'small-fix']);
    neat(['run', 'stage', id, 'plan']);
    const before = readState(proj, id);
    const res = neat(['run', 'stage', id, 'review']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stage review skipped\n');
    const after = readState(proj, id);
    assert.equal(after.stage, 'plan');
    assert.deepEqual(after.stages, before.stages);
    assert.equal(after.updatedAt, before.updatedAt);
  });
});

test('a Phase 1 state without a research entry reports research skipped', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    const st = readState(proj, id);
    writeState(proj, id, { ...st, stages: st.stages.filter((s) => s.name !== 'research') });
    const res = neat(['run', 'stage', id, 'research']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, 'stage research skipped\n');
    assert.equal(neat(['run', 'stage', id, 'review']).stdout, 'stage review\n');
  });
});

test('run stage done leaves skipped stages skipped', () => {
  withProject((proj, neat) => {
    const id = newRun(neat);
    neat(['run', 'stage', id, 'explore']);
    neat(['stages', id, '--type', 'docs']);
    neat(['run', 'stage', id, 'plan']);
    neat(['run', 'stage', id, 'docs']);
    neat(['run', 'stage', id, 'done']);
    const st = readState(proj, id);
    assert.deepEqual(st.stages.map((s) => [s.name, s.status]), [
      ['explore', 'done'], ['research', 'skipped'], ['plan', 'done'], ['implement', 'skipped'],
      ['review', 'skipped'], ['test', 'skipped'], ['docs', 'done'],
    ]);
  });
});
