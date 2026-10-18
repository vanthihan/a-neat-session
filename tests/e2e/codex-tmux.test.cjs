'use strict';

// tmux mode for Codex jobs. Every test runs its own tmux server under a short
// private TMUX_TMPDIR, started with the test env (the pane gets the server's
// environment, so the fake codex knobs must be there), with TMUX and
// TMUX_PANE removed, and kills only that server afterwards. The user's own
// tmux sessions are never addressed. Skipped when tmux is not installed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO_ROOT, childEnv, runNode, makeTempDir, removeDir, installFakeCodex,
} = require('../support/helpers.cjs');

const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const HAS_TMUX = (() => {
  const res = spawnSync('tmux', ['-V'], { stdio: 'ignore', env: childEnv() });
  return !res.error && res.status === 0;
})();
const OPTS = { skip: HAS_TMUX ? false : 'tmux is not installed' };
const JOB_LINE = /^job=([a-z0-9-]+) worker=(\w+) mode=(bg|tmux) sandbox=([a-z-]+) pid=(\d+)$/;
const KEEP_CMD = [process.execPath, '-e', 'setInterval(() => {}, 60000)'];

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function until(fn, ms) {
  const deadline = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < deadline) {
    sleepMs(50);
    v = fn();
  }
  return v;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

// A project (`opts.proj`, else a new temp dir), a fake codex and a private
// tmux server holding one session `keep`.
function setup(extra = {}, opts = {}) {
  const proj = opts.proj || makeTempDir('neat-tmx-');
  const binDir = makeTempDir('neat-tmx-bin-');
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntx-'));
  const shim = installFakeCodex(binDir);
  const log = path.join(binDir, 'calls.jsonl');
  const env = childEnv({
    NEAT_PROJECT_DIR: proj, NEAT_CODEX_BIN: shim, FAKE_CODEX_LOG: log, TMUX_TMPDIR: tmuxDir, ...extra,
  });
  const ctx = { proj, binDir, tmuxDir, log, env };
  const started = tmux(ctx, ['-f', '/dev/null', 'new-session', '-d', '-s', 'keep', '--', ...KEEP_CMD]);
  assert.equal(started.status, 0, started.stderr);
  return ctx;
}

function teardown(ctx) {
  tmux(ctx, ['kill-server']);
  removeDir(ctx.proj);
  removeDir(ctx.binDir);
  removeDir(ctx.tmuxDir);
}

function withTmux(extra, fn, opts = {}) {
  const ctx = setup(extra, opts);
  try {
    fn(ctx);
  } finally {
    teardown(ctx);
  }
}

// tmux on the test's private server only: TMUX_TMPDIR from the test env, no TMUX.
function tmux(ctx, args) {
  const env = { ...ctx.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return spawnSync('tmux', args, { env, encoding: 'utf8' });
}

function neat(ctx, args, extra = {}, input) {
  return runNode([HELPER, ...args], { cwd: ctx.proj, env: { ...ctx.env, ...extra }, input });
}

function newRun(ctx, task) {
  const res = neat(ctx, ['run', 'new', '--stdin'], {}, `${task}\n`);
  assert.equal(res.status, 0, res.stderr);
  const id = res.stdout.match(/^id=(\S+)/m)[1];
  return { id, dir: path.join(ctx.proj, '.neat', 'runs', id) };
}

function brief(ctx, id, worker) {
  const res = neat(ctx, ['brief', id, worker]);
  assert.equal(res.status, 0, res.stderr);
}

// codex run; returns the parsed job line and the other output lines.
function codexRun(ctx, args, extra = {}) {
  const res = neat(ctx, ['codex', 'run', ...args], extra);
  assert.equal(res.status, 0, res.stderr);
  const [first, ...rest] = res.stdout.trimEnd().split('\n');
  const m = first.match(JOB_LINE);
  assert.ok(m, res.stdout);
  return { job: m[1], worker: m[2], mode: m[3], sandbox: m[4], pid: Number(m[5]), rest };
}

function record(ctx, runId, job) {
  return JSON.parse(fs.readFileSync(path.join(ctx.proj, '.neat', 'runs', runId, 'jobs', `${job}.json`), 'utf8'));
}

// "<session> <window index> <window id> <window name> <pane pid>" for every window of the test server.
function windows(ctx) {
  const format = '#{session_name} #{window_index} #{window_id} #{window_name} #{pane_pid}';
  const res = tmux(ctx, ['list-windows', '-a', '-F', format]);
  if (res.status !== 0) return [];
  return res.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [session, index, id, name, pid] = l.split(' ');
    return { session, index, id, name, pid: Number(pid) };
  });
}

// TMUX value that makes the helper act as if run inside session `keep`.
function insideKeep(ctx) {
  const info = tmux(ctx, ['display-message', '-p', '-t', '=keep:', '#{socket_path},#{pid}']);
  assert.equal(info.status, 0, info.stderr);
  const sid = tmux(ctx, ['list-sessions', '-F', '#{session_name} #{session_id}']).stdout
    .split('\n').find((l) => l.startsWith('keep ')).split('$')[1];
  return { TMUX: `${info.stdout.trim()},${sid}` };
}

function sessions(ctx) {
  const res = tmux(ctx, ['list-sessions', '-F', '#{session_name}']);
  return res.status === 0 ? res.stdout.trim().split('\n') : [];
}

function calls(ctx) {
  if (!fs.existsSync(ctx.log)) return [];
  return fs.readFileSync(ctx.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('outside tmux: a detached session neat-<run> runs the job in a window and keeps it after the end', OPTS, () => {
  withTmux({ FAKE_CODEX_DELAY_MS: '1500' }, (ctx) => {
    const { id, dir } = newRun(ctx, 'watch the reviewer');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux']);
    assert.deepEqual([run.worker, run.mode, run.sandbox], ['reviewer', 'tmux', 'read-only']);
    assert.deepEqual(run.rest, [`attach: tmux attach -t neat-${id}`]);
    const win = windows(ctx).find((w) => w.name === `neat-${run.job}`);
    assert.ok(win, JSON.stringify(windows(ctx)));
    assert.equal(win.session, `neat-${id}`);
    const rec = record(ctx, id, run.job);
    assert.equal(rec.mode, 'tmux');
    assert.equal(rec.tmuxTarget, win.id);
    assert.match(rec.tmuxTarget, /^@\d+$/);
    assert.equal(rec.pid, run.pid);
    assert.equal(rec.pgid, run.pid);
    assert.equal(win.pid, run.pid);

    const waited = neat(ctx, ['codex', 'wait', run.job]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(waited.stdout, `job ${run.job} status=done exit=0 worker=reviewer\n`);
    const result = neat(ctx, ['codex', 'result', run.job]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^## Status\ndone\n/);
    assert.equal(neat(ctx, ['report', 'check', path.join(dir, 'report-reviewer.md')]).status, 0);

    const logText = fs.readFileSync(rec.logPath, 'utf8');
    assert.ok(logText.includes('codex\nok\n'), logText.slice(-200));
    assert.ok(windows(ctx).some((w) => w.name === `neat-${run.job}`), 'the window stays after the job ends');
    const pane = tmux(ctx, ['capture-pane', '-p', '-t', rec.tmuxTarget]);
    assert.equal(pane.status, 0, pane.stderr);
    assert.match(pane.stdout, /^ok$/m);
  });
});

test('a second job of the same run adds a window to the existing session', OPTS, () => {
  withTmux({}, (ctx) => {
    const { id } = newRun(ctx, 'two jobs');
    brief(ctx, id, 'reviewer');
    brief(ctx, id, 'tester');
    const first = codexRun(ctx, [id, 'reviewer', '--tmux']);
    const second = codexRun(ctx, [id, 'tester', '--tmux']);
    assert.equal(second.mode, 'tmux');
    assert.deepEqual(sessions(ctx).filter((s) => s.startsWith('neat-')), [`neat-${id}`]);
    const names = windows(ctx).filter((w) => w.session === `neat-${id}`).map((w) => w.name).sort();
    assert.deepEqual(names, [`neat-${first.job}`, `neat-${second.job}`].sort());
    const waited = neat(ctx, ['codex', 'wait', first.job, second.job]);
    assert.equal(waited.status, 0, waited.stderr);
    assert.match(waited.stdout, /status=done[^\n]*\n[^\n]*status=done/);
  });
});

test('/neat:do --tmux (state.tmux) makes codex run use tmux without the flag', OPTS, () => {
  withTmux({}, (ctx) => {
    const { id } = newRun(ctx, '--tmux run-wide tmux');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer']);
    assert.equal(run.mode, 'tmux');
    assert.ok(windows(ctx).some((w) => w.name === `neat-${run.job}`));
    assert.equal(neat(ctx, ['codex', 'wait', run.job]).status, 0);
  });
});

test('inside tmux: a new window opens in the current session and no attach line is printed', OPTS, () => {
  withTmux({}, (ctx) => {
    const inside = insideKeep(ctx);
    const { id } = newRun(ctx, 'inside tmux');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux'], inside);
    assert.equal(run.mode, 'tmux');
    assert.deepEqual(run.rest, []);
    const win = windows(ctx).find((w) => w.name === `neat-${run.job}`);
    assert.ok(win, JSON.stringify(windows(ctx)));
    assert.equal(win.session, 'keep');
    assert.equal(record(ctx, id, run.job).tmuxTarget, win.id);
    assert.ok(!sessions(ctx).includes(`neat-${id}`));
    assert.equal(neat(ctx, ['codex', 'wait', run.job]).stdout, `job ${run.job} status=done exit=0 worker=reviewer\n`);
  });
});

test('cancel of a tmux job ends its process group and removes the window', OPTS, () => {
  withTmux({ FAKE_CODEX_DELAY_MS: '10000' }, (ctx) => {
    const { id, dir } = newRun(ctx, 'cancel in tmux');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux']);
    const out = path.join(dir, 'jobs', `${run.job}.out.md`);
    const call = until(() => calls(ctx).find((c) => c.argv[0] === 'exec' && c.argv.includes(out)), 5000);
    assert.ok(call, 'fake codex must have started');
    const res = neat(ctx, ['codex', 'cancel', run.job]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `job ${run.job} cancelled\n`);
    assert.equal(record(ctx, id, run.job).status, 'cancelled');
    assert.ok(until(() => !alive(run.pid) && !alive(call.pid), 5000), 'wrapper and codex must stop');
    assert.ok(until(() => !windows(ctx).some((w) => w.name === `neat-${run.job}`), 3000), 'window must be gone');
  });
});

test('a project path holding tmux format syntax runs no command and the job still uses it', OPTS, () => {
  const outer = makeTempDir('neat-tmx-fmt-');
  const mark = path.join(outer, 'PWNED');
  const proj = path.join(outer, 'p#(touch $NTX_MARK)');
  fs.mkdirSync(proj);
  try {
    withTmux({ NTX_MARK: mark }, (ctx) => {
      const { id } = newRun(ctx, 'odd project path');
      brief(ctx, id, 'reviewer');
      const run = codexRun(ctx, [id, 'reviewer', '--tmux']);
      const waited = neat(ctx, ['codex', 'wait', run.job]);
      assert.equal(waited.stdout, `job ${run.job} status=done exit=0 worker=reviewer\n`);
      const exec = calls(ctx).find((c) => c.argv[0] === 'exec');
      assert.equal(exec.argv[exec.argv.indexOf('-C') + 1], proj);
      sleepMs(300);
      assert.equal(fs.existsSync(mark), false, 'tmux must not run #(...) from the project path');
    }, { proj });
  } finally {
    removeDir(outer);
  }
});

test('cancel after a window renumber closes the job window, never the window now at its old index', OPTS, () => {
  withTmux({ FAKE_CODEX_DELAY_MS: '10000' }, (ctx) => {
    assert.equal(tmux(ctx, ['set-option', '-g', 'renumber-windows', 'on']).status, 0);
    assert.equal(tmux(ctx, ['new-window', '-d', '-t', '=keep:', '-n', 'filler', '--', ...KEEP_CMD]).status, 0);
    const { id, dir } = newRun(ctx, 'renumbered windows');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux'], insideKeep(ctx));
    const out = path.join(dir, 'jobs', `${run.job}.out.md`);
    const call = until(() => calls(ctx).find((c) => c.argv[0] === 'exec' && c.argv.includes(out)), 5000);
    assert.ok(call, 'fake codex must have started');
    const jobIndex = windows(ctx).find((w) => w.name === `neat-${run.job}`).index;
    assert.equal(tmux(ctx, ['new-window', '-d', '-t', '=keep:', '-n', 'editor', '--', ...KEEP_CMD]).status, 0);
    assert.equal(tmux(ctx, ['kill-window', '-t', '=keep:filler']).status, 0);
    const editor = windows(ctx).find((w) => w.name === 'editor');
    assert.equal(editor.index, jobIndex, 'the editor now sits at the job window\'s old index');

    const res = neat(ctx, ['codex', 'cancel', run.job]);
    assert.equal(res.stdout, `job ${run.job} cancelled\n`);
    assert.ok(until(() => !windows(ctx).some((w) => w.name === `neat-${run.job}`), 3000), 'job window must be gone');
    assert.ok(windows(ctx).some((w) => w.id === editor.id), 'the editor window must survive');
    assert.ok(until(() => !alive(call.pid), 5000), 'codex must stop');
  });
});

test('cancel leaves a window alone when the recorded window id is no longer the job window', OPTS, () => {
  withTmux({ FAKE_CODEX_DELAY_MS: '10000' }, (ctx) => {
    const { id, dir } = newRun(ctx, 'foreign window id');
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux']);
    const keepWin = windows(ctx).find((w) => w.session === 'keep');
    const file = path.join(dir, 'jobs', `${run.job}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, tmuxTarget: keepWin.id }));
    const res = neat(ctx, ['codex', 'cancel', run.job]);
    assert.equal(res.stdout, `job ${run.job} cancelled\n`);
    assert.ok(windows(ctx).some((w) => w.id === keepWin.id), 'a window not named for the job is never killed');
  });
});

test('without tmux on PATH the job runs in the background with a note', OPTS, () => {
  withTmux({}, (ctx) => {
    const nodeOnly = makeTempDir('neat-tmx-path-');
    try {
      fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
      const { id } = newRun(ctx, 'no tmux here');
      brief(ctx, id, 'reviewer');
      const run = codexRun(ctx, [id, 'reviewer', '--tmux'], { PATH: nodeOnly });
      assert.equal(run.mode, 'bg');
      assert.deepEqual(run.rest, ['note: tmux not found; running in the background']);
      assert.equal(record(ctx, id, run.job).mode, 'bg');
      assert.equal(neat(ctx, ['codex', 'wait', run.job]).stdout, `job ${run.job} status=done exit=0 worker=reviewer\n`);
      assert.ok(!windows(ctx).some((w) => w.name === `neat-${run.job}`));
    } finally {
      removeDir(nodeOnly);
    }
  });
});

test('task text with shell syntax reaches codex stdin byte-exact through tmux', OPTS, () => {
  withTmux({}, (ctx) => {
    const task = 'fix "it\'s"; echo hi $(touch pwned) `touch pwned2` done';
    const { id } = newRun(ctx, task);
    brief(ctx, id, 'reviewer');
    const run = codexRun(ctx, [id, 'reviewer', '--tmux']);
    assert.equal(neat(ctx, ['codex', 'wait', run.job]).status, 0);
    const exec = calls(ctx).find((c) => c.argv[0] === 'exec');
    assert.ok(exec, 'fake codex must have run');
    assert.ok(exec.stdin.includes(`Task: ${task}\n`), exec.stdin.slice(0, 200));
    assert.equal(fs.existsSync(path.join(ctx.proj, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(ctx.proj, 'pwned2')), false);
  });
});
