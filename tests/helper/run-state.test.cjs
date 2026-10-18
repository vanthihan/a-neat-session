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
  assert.deepEqual(onDisk.stages.map((s) => s.name),
    ['explore', 'research', 'plan', 'implement', 'review', 'test', 'docs']);
  assert.deepEqual(onDisk.stages.filter((s) => s.status !== 'pending'), [{ name: 'research', status: 'skipped' }]);
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

// ---- Codex jobs in status ----

const { spawn, spawnSync } = require('node:child_process');

const STATUS_NOW = '2026-10-18T11:00:00Z';

function writeJobRecord(proj, runId, record) {
  const dir = path.join(proj, '.neat', 'runs', runId, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  const full = { runId, mode: 'bg', sandbox: 'read-only', exitCode: null, ...record };
  fs.writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`);
  return file;
}

// A live process with a job wrapper's command line (`codex _exec <run> <job>`).
function liveJobProcess(runId, jobId) {
  const args = ['-e', 'setInterval(() => {}, 1000)', 'codex', '_exec', runId, jobId];
  return spawn(process.execPath, args, { stdio: 'ignore' });
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// Every file under dir with its size and mtime, for "status writes nothing" checks.
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort().map((rel) => {
    const st = fs.statSync(path.join(dir, rel));
    return `${rel} ${st.size} ${st.mtimeMs}`;
  });
}

test('status lists Codex jobs newest first with run, worker, mode, status and age', () => {
  withProject((proj, neat) => {
    const older = newRun(neat, 'older task', '2026-10-18T08:00:00Z');
    const newer = newRun(neat, 'newer task', '2026-10-18T10:00:00Z');
    const live = liveJobProcess(newer, 'reviewer-aaaa');
    try {
      writeJobRecord(proj, older, {
        id: 'implementer-t1-0b0b', worker: 'implementer-T1', status: 'done', pid: deadPid(),
        startedAt: '2026-10-18T08:00:00.000Z', exitCode: 0,
      });
      writeJobRecord(proj, newer, {
        id: 'reviewer-aaaa', worker: 'reviewer', mode: 'tmux', status: 'running', pid: live.pid,
        startedAt: '2026-10-18T10:59:30.000Z',
      });
      const lostFile = writeJobRecord(proj, newer, {
        id: 'tester-cccc', worker: 'tester', status: 'running', pid: deadPid(),
        startedAt: '2026-10-18T10:58:00.000Z',
      });
      const before = snapshot(path.join(proj, '.neat'));
      const res = neat(['status'], { NEAT_NOW: STATUS_NOW });
      assert.equal(res.status, 0, res.stderr);
      const lines = res.stdout.trimEnd().split('\n');
      assert.equal(lines[0], `neat runs: 2 (showing 2) in ${path.join(proj, '.neat', 'runs')}`);
      assert.deepEqual(lines.slice(3), [
        'codex jobs: 3 (showing 3)',
        `reviewer-aaaa  run=${newer}  worker=reviewer  mode=tmux  status=running  age=30s`,
        `tester-cccc  run=${newer}  worker=tester  mode=bg  status=lost  age=2m`,
        `implementer-t1-0b0b  run=${older}  worker=implementer-T1  mode=bg  status=done  age=3h`,
      ]);
      assert.deepEqual(snapshot(path.join(proj, '.neat')), before, 'status must not write any file');
      assert.equal(JSON.parse(fs.readFileSync(lostFile, 'utf8')).status, 'running');
    } finally {
      live.kill('SIGKILL');
    }
  });
});

test('status without jobs has no jobs section', () => {
  withProject((proj, neat) => {
    const id = newRun(neat, 'plain task');
    const res = neat(['status']);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, [
      `neat runs: 1 (showing 1) in ${path.join(proj, '.neat', 'runs')}`,
      `${id}  mode=gate  stage=created  active=-  updated=2026-10-18T10:00:00.000Z`,
      '',
    ].join('\n'));
  });
});

test('status shows at most 10 jobs and marks a corrupt job file unreadable', () => {
  withProject((proj, neat) => {
    const id = newRun(neat, 'many jobs');
    for (let i = 0; i < 11; i += 1) {
      writeJobRecord(proj, id, {
        id: `docs-d${i}-00${String(i).padStart(2, '0')}`, worker: `docs-D${i}`, status: 'done', pid: deadPid(),
        startedAt: `2026-10-18T10:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }
    const badDir = path.join(proj, '.neat', 'runs', id, 'jobs');
    fs.writeFileSync(path.join(badDir, 'reviewer-dead.json'), '{ not json');
    const res = neat(['status'], { NEAT_NOW: STATUS_NOW });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    const at = lines.indexOf('codex jobs: 12 (showing 10)');
    assert.ok(at > 0, res.stdout);
    assert.equal(lines.length, at + 11);
    assert.equal(lines[at + 1], `docs-d10-0010  run=${id}  worker=docs-D10  mode=bg  status=done  age=50m`);

    const few = makeTempDir('neat-cli-state-');
    try {
      const env = childEnv({ NEAT_PROJECT_DIR: few, NEAT_NOW: STATUS_NOW });
      const runId = /^id=(\S+)/.exec(runNode([HELPER, 'run', 'new', 'one job'], { cwd: few, env }).stdout)[1];
      fs.mkdirSync(path.join(few, '.neat', 'runs', runId, 'jobs'));
      fs.writeFileSync(path.join(few, '.neat', 'runs', runId, 'jobs', 'reviewer-dead.json'), '{ not json');
      const out = runNode([HELPER, 'status'], { cwd: few, env });
      assert.equal(out.status, 0, out.stderr);
      assert.ok(out.stdout.endsWith(`codex jobs: 1 (showing 1)\nreviewer-dead  run=${runId}  unreadable\n`), out.stdout);
    } finally {
      removeDir(few);
    }
  });
});

test('status --json gives every run summary a jobs array', () => {
  withProject((proj, neat) => {
    const older = newRun(neat, 'older', '2026-10-18T08:00:00Z');
    const newer = newRun(neat, 'newer', '2026-10-18T09:00:00Z');
    writeJobRecord(proj, newer, {
      id: 'reviewer-abcd', worker: 'reviewer', status: 'running', pid: deadPid(), startedAt: '2026-10-18T09:30:00.000Z',
    });
    const res = neat(['status', '--json'], { NEAT_NOW: STATUS_NOW });
    assert.equal(res.status, 0, res.stderr);
    const runs = JSON.parse(res.stdout);
    assert.deepEqual(runs.map((r) => r.id), [newer, older]);
    assert.deepEqual(runs[0].jobs, [
      { id: 'reviewer-abcd', worker: 'reviewer', mode: 'bg', status: 'lost', startedAt: '2026-10-18T09:30:00.000Z' },
    ]);
    assert.deepEqual(runs[1].jobs, []);
  });
});

test('formatStatus renders jobs with ages from the given clock', () => {
  const runs = [{ id: 'r1', mode: 'auto', stage: 'review', workers: [], updatedAt: 'u' }];
  const jobs = [
    { id: 'reviewer-0001', runId: 'r1', worker: 'reviewer', mode: 'bg', status: 'done', startedAt: '2026-10-18T10:59:59.000Z' },
    { id: 'tester-0002', runId: 'r1', worker: 'tester', mode: 'bg', status: 'failed', startedAt: '2026-10-18T13:00:00.000Z' },
  ];
  const text = formatStatus(runs, { runsDir: '/p', jobs, now: new Date(STATUS_NOW) });
  assert.deepEqual(text.split('\n').slice(2), [
    'codex jobs: 2 (showing 2)',
    'reviewer-0001  run=r1  worker=reviewer  mode=bg  status=done  age=1s',
    'tester-0002  run=r1  worker=tester  mode=bg  status=failed  age=0s',
  ]);
  assert.equal(formatStatus(runs, { runsDir: '/p' }), formatStatus(runs, { runsDir: '/p', jobs: [] }));
});

test('updateRun waits for a held state lock, then applies its change to the fresh state', async () => {
  const own = makeTempDir('neat-state-lock-');
  try {
    const state = rs.createRun(own, { task: 'locked run', mode: 'auto' }, NOW);
    const lock = path.join(rs.runDir(own, state.id), 'state.lock');
    fs.writeFileSync(lock, '');
    const { spawn } = require('node:child_process');
    // Another process holds the lock, records a worker, then releases it.
    const holder = spawn(process.execPath, ['-e', `
      const rs = require(${JSON.stringify(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'run-state.cjs'))});
      const fs = require('node:fs');
      setTimeout(() => {
        rs.saveRun(${JSON.stringify(own)}, rs.setWorker(rs.loadRun(${JSON.stringify(own)}, ${JSON.stringify(state.id)}), 'tester', 'done', null));
        fs.rmSync(${JSON.stringify(lock)});
      }, 300);
    `], { stdio: 'ignore' });
    const exited = new Promise((resolve) => holder.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = rs.updateRun(own, state.id, (s) => rs.setWorker(s, 'reviewer', 'running', null), NOW);
    await exited;
    assert.deepEqual(saved.workers.map((w) => w.name).sort(), ['reviewer', 'tester']);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    removeDir(own);
  }
});

test('updateRun breaks a stale lock and releases its own lock when the change throws', () => {
  const own = makeTempDir('neat-state-lock-');
  try {
    const state = rs.createRun(own, { task: 'stale lock', mode: 'auto' }, NOW);
    const lock = path.join(rs.runDir(own, state.id), 'state.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lock, old, old);
    const saved = rs.updateRun(own, state.id, (s) => rs.setWorker(s, 'reviewer', 'done', null), NOW);
    assert.equal(saved.workers[0].name, 'reviewer');
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => rs.updateRun(own, state.id, (s) => rs.setWorker(s, 'nobody', 'done', null)), UsageError);
    assert.equal(fs.existsSync(lock), false);
    assert.throws(() => rs.updateRun(own, '20261018-000000-none', (s) => s), /run not found/);
  } finally {
    removeDir(own);
  }
});

test('createRun stores a well-formed sessionId and null otherwise', () => {
  const own = makeTempDir('neat-state-session-');
  try {
    assert.equal(rs.createRun(own, { task: 'a', mode: 'gate', sessionId: 'sess-a' }, NOW).sessionId, 'sess-a');
    assert.equal(rs.createRun(own, { task: 'b', mode: 'gate' }, NOW).sessionId, null);
    assert.equal(rs.createRun(own, { task: 'c', mode: 'gate', sessionId: '../x' }, NOW).sessionId, null);
    assert.equal(rs.createRun(own, { task: 'd', mode: 'gate', sessionId: 'a'.repeat(65) }, NOW).sessionId, null);
    const onDisk = rs.listRuns(own).map((s) => s.sessionId).sort();
    assert.deepEqual(onDisk, [null, null, null, 'sess-a']);
  } finally {
    removeDir(own);
  }
});

test('run new records CLAUDE_CODE_SESSION_ID from the environment', () => {
  const own = makeTempDir('neat-state-session-cli-');
  try {
    const env = childEnv({ NEAT_PROJECT_DIR: own, NEAT_NOW: NOW.toISOString(), CLAUDE_CODE_SESSION_ID: 'sess-a' });
    const res = runNode([HELPER, 'run', 'new', 'tag me'], { cwd: own, env });
    assert.equal(res.status, 0, res.stderr);
    const [state] = rs.listRuns(own);
    assert.equal(state.sessionId, 'sess-a');
    const plain = runNode([HELPER, 'run', 'new', 'no tag'], { cwd: own, env: childEnv({ NEAT_PROJECT_DIR: own }) });
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(rs.listRuns(own).map((s) => s.sessionId).sort(), [null, 'sess-a']);
  } finally {
    removeDir(own);
  }
});

test('activeRuns keeps unfinished runs updated within 24 hours, newest update first', () => {
  const own = makeTempDir('neat-state-active-');
  const hours = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
  try {
    const old = rs.createRun(own, { task: 'old', mode: 'gate' }, hours(30));
    const recent = rs.createRun(own, { task: 'recent', mode: 'gate' }, hours(5));
    const newest = rs.createRun(own, { task: 'newest', mode: 'gate' }, hours(10));
    rs.saveRun(own, newest, hours(1));
    const finished = rs.createRun(own, { task: 'finished', mode: 'gate' }, hours(2));
    rs.saveRun(own, rs.setStage(finished, 'done'), hours(2));
    const cancelled = rs.createRun(own, { task: 'cancelled', mode: 'gate' }, hours(2));
    rs.saveRun(own, rs.setStage(cancelled, 'cancelled'), hours(2));
    const broken = rs.createRun(own, { task: 'broken', mode: 'gate' }, hours(1));
    fs.writeFileSync(path.join(rs.runDir(own, broken.id), 'state.json'), '{ nope');

    assert.equal(rs.ACTIVE_MAX_AGE_MS, 24 * 3600 * 1000);
    assert.deepEqual(rs.activeRuns(own, NOW).map((s) => s.id), [newest.id, recent.id]);
    assert.deepEqual(rs.activeRuns(own, NOW, { maxAgeMs: Infinity }).map((s) => s.id), [newest.id, recent.id, old.id]);
    assert.deepEqual(rs.activeRuns(path.join(own, 'empty'), NOW), []);
  } finally {
    removeDir(own);
  }
});
