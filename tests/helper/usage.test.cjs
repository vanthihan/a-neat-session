'use strict';

// Usage capture reader: per-window validity, staleness, percent formatting.
// Fixtures are synthetic statusline-shaped objects (no real capture values)
// written under temp dirs; nothing here touches the real Claude config dir.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, makeTempDir, removeDir } = require('../support/helpers.cjs');

const usage = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'usage.cjs'));
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

const NOW = new Date('2026-05-01T12:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

// Statusline-shaped object with sanitized placeholder values.
function statusline({ fiveHour, sevenDay, ctx = 12 } = {}) {
  const data = {
    session_id: 'sess-0000',
    transcript_path: '/tmp/example/transcript.jsonl',
    cwd: '/tmp/example',
    model: { id: 'example-model', display_name: 'Example' },
    workspace: { current_dir: '/tmp/example', project_dir: '/tmp/example' },
    version: '0.0.0',
    cost: { total_cost_usd: 0.5, total_duration_ms: 1000 },
    context_window: { total_input_tokens: 10, used_percentage: ctx, remaining_percentage: 88 },
  };
  if (fiveHour !== undefined || sevenDay !== undefined) {
    data.rate_limits = {};
    if (fiveHour !== undefined) data.rate_limits.five_hour = fiveHour;
    if (sevenDay !== undefined) data.rate_limits.seven_day = sevenDay;
  }
  return data;
}

const UNKNOWN_KEYS = ['known', 'usage', 'ctx'];

function pick(r, keys = UNKNOWN_KEYS) {
  return Object.fromEntries(keys.map((k) => [k, r[k]]));
}

describe('readUsage', () => {
  let dir;
  let n = 0;

  before(() => {
    dir = makeTempDir('neat-usage-read-');
  });

  after(() => removeDir(dir));

  function capture(content, mtime = NOW) {
    n += 1;
    const file = path.join(dir, `capture-${n}.json`);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  test('missing file, directory, non-JSON, array and rate-limit-less object are unknown', () => {
    assert.deepEqual(pick(usage.readUsage(path.join(dir, 'absent.json'), NOW)), { known: false, usage: null, ctx: null });
    assert.deepEqual(pick(usage.readUsage(dir, NOW)), { known: false, usage: null, ctx: null });
    assert.deepEqual(pick(usage.readUsage(capture('not json'), NOW)), { known: false, usage: null, ctx: null });
    assert.deepEqual(pick(usage.readUsage(capture('[1,2]'), NOW)), { known: false, usage: null, ctx: null });
    assert.deepEqual(pick(usage.readUsage(capture('null'), NOW)), { known: false, usage: null, ctx: null });
    const noLimits = usage.readUsage(capture(statusline({ ctx: 40 })), NOW);
    assert.deepEqual(pick(noLimits), { known: false, usage: null, ctx: 40 });
  });

  test('a single valid window gives its percentage; two windows give the maximum', () => {
    const one = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: 72, resets_at: NOW_SEC + 3600 } })), NOW);
    assert.equal(one.known, true);
    assert.equal(one.usage, 72);
    assert.equal(one.fiveHour, 72);
    assert.equal(one.sevenDay, null);
    const both = usage.readUsage(capture(statusline({
      fiveHour: { used_percentage: 72, resets_at: NOW_SEC + 3600 },
      sevenDay: { used_percentage: 85, resets_at: NOW_SEC + 86400 },
    })), NOW);
    assert.deepEqual([both.usage, both.fiveHour, both.sevenDay], [85, 72, 85]);
  });

  test('a window whose resets_at has passed is ignored', () => {
    const past = usage.readUsage(capture(statusline({
      fiveHour: { used_percentage: 95, resets_at: NOW_SEC },
      sevenDay: { used_percentage: 40, resets_at: NOW_SEC + 60 },
    })), NOW);
    assert.deepEqual([past.usage, past.fiveHour, past.sevenDay], [40, null, 40]);
    const allPast = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: 95, resets_at: NOW_SEC - 1 } })), NOW);
    assert.deepEqual(pick(allPast), { known: false, usage: null, ctx: 12 });
  });

  test('a window without resets_at counts only while the file mtime is within 15 minutes', () => {
    assert.equal(usage.MTIME_WINDOW_MS, 15 * 60 * 1000);
    const content = statusline({ fiveHour: { used_percentage: 60 } });
    const fresh = usage.readUsage(capture(content, new Date(NOW.getTime() - 14 * 60 * 1000)), NOW);
    assert.equal(fresh.usage, 60);
    const stale = usage.readUsage(capture(content, new Date(NOW.getTime() - 16 * 60 * 1000)), NOW);
    assert.equal(stale.known, false);
    assert.equal(stale.usage, null);
  });

  test('string, NaN-like, negative or non-number percentages invalidate that window', () => {
    const future = NOW_SEC + 3600;
    for (const bad of ['72', -1, null, true, { v: 1 }]) {
      const r = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: bad, resets_at: future } })), NOW);
      assert.equal(r.known, false, JSON.stringify(bad));
    }
    // JSON has no NaN; a NaN-producing literal is not valid JSON at all.
    assert.equal(usage.readUsage(capture('{"rate_limits":{"five_hour":{"used_percentage":NaN}}}'), NOW).known, false);
    const badResets = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: 50, resets_at: 'soon' } })), NOW);
    assert.equal(badResets.known, false);
    const floatPct = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: 23.5, resets_at: future } })), NOW);
    assert.equal(floatPct.usage, 23.5);
  });

  test('context_window.used_percentage is reported as ctx; null gives null', () => {
    const r = usage.readUsage(capture(statusline({ ctx: 33, fiveHour: { used_percentage: 10, resets_at: NOW_SEC + 60 } })), NOW);
    assert.equal(r.ctx, 33);
    assert.equal(usage.readUsage(capture(statusline({ ctx: null })), NOW).ctx, null);
  });

  test('the result never carries other file content', () => {
    const r = usage.readUsage(capture(statusline({ fiveHour: { used_percentage: 10, resets_at: NOW_SEC + 60 } })), NOW);
    assert.deepEqual(Object.keys(r).sort(), ['ctx', 'fiveHour', 'known', 'sevenDay', 'usage']);
  });

  test('a FIFO or a directory at the capture path is unknown and does not block', { skip: process.platform === 'win32' }, () => {
    const fifo = path.join(dir, 'capture-fifo.json');
    const made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, String(made.stderr));
    const script = `const u = require(${JSON.stringify(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'usage.cjs'))});`
      + `process.stdout.write(JSON.stringify(u.readUsage(process.argv[1])));`;
    const res = spawnSync(process.execPath, ['-e', script, fifo], { encoding: 'utf8', timeout: 5000, env: childEnv() });
    assert.equal(res.signal, null, 'readUsage blocked on a FIFO');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).known, false);
    const sub = path.join(dir, 'capture-dir.json');
    fs.mkdirSync(sub);
    assert.equal(usage.readUsage(sub, NOW).known, false);
  });

  test('an oversized file is unknown', () => {
    const big = JSON.stringify({ pad: 'x'.repeat(usage.MAX_CAPTURE_BYTES), ...statusline({ fiveHour: { used_percentage: 99, resets_at: NOW_SEC + 60 } }) });
    assert.equal(usage.readUsage(capture(big), NOW).known, false);
  });
});

describe('formatPercent', () => {
  test('prints at most one decimal and unknown for non-numbers', () => {
    assert.equal(usage.formatPercent(72), '72%');
    assert.equal(usage.formatPercent(23.5), '23.5%');
    assert.equal(usage.formatPercent(33.333), '33.3%');
    assert.equal(usage.formatPercent(0), '0%');
    assert.equal(usage.formatPercent(null), 'unknown');
    assert.equal(usage.formatPercent(Number.NaN), 'unknown');
  });
});

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

function tmpSiblings(file) {
  const base = `${path.basename(file)}.tmp-`;
  return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(base));
}

describe('writeCapture and cleanupTmp', () => {
  let dir;

  before(() => {
    dir = makeTempDir('neat-usage-write-');
  });

  after(() => removeDir(dir));

  test('creates a 0700 directory and a 0600 file atomically, no tmp left', () => {
    const file = path.join(dir, 'a', 'neat', 'usage.json');
    const bytes = Buffer.from('{"x":1}');
    usage.writeCapture(file, bytes);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.deepEqual(tmpSiblings(file), []);
  });

  test('keeps the mode of an existing directory', () => {
    const sub = path.join(dir, 'existing');
    fs.mkdirSync(sub, { mode: 0o755 });
    fs.chmodSync(sub, 0o755);
    usage.writeCapture(path.join(sub, 'usage.json'), Buffer.from('{}'));
    assert.equal(mode(sub), 0o755);
  });

  test('replaces a symlink entry and leaves its target untouched', () => {
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'keep me');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(target, link);
    usage.writeCapture(link, Buffer.from('{"y":2}'));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(link, 'utf8'), '{"y":2}');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
  });

  test('throws when the parent is a regular file', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    assert.throws(() => usage.writeCapture(path.join(blocker, 'usage.json'), Buffer.from('{}')));
  });

  test('cleanupTmp removes only this file\'s tmp siblings older than 10 minutes', () => {
    const sub = path.join(dir, 'cleanup');
    fs.mkdirSync(sub);
    const file = path.join(sub, 'usage.json');
    const now = new Date('2026-05-01T12:00:00Z');
    const old = new Date(now.getTime() - 11 * 60 * 1000);
    const recent = new Date(now.getTime() - 9 * 60 * 1000);
    const make = (name, t) => {
      const p = path.join(sub, name);
      fs.writeFileSync(p, '');
      fs.utimesSync(p, t, t);
      return p;
    };
    const stale = make('usage.json.tmp-1-aa', old);
    const fresh = make('usage.json.tmp-2-bb', recent);
    const unrelated = make('other.json.tmp-3-cc', old);
    const plain = make('usage.json.bak', old);
    assert.equal(usage.TMP_MAX_AGE_MS, 10 * 60 * 1000);
    usage.cleanupTmp(file, now);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(fresh));
    assert.ok(fs.existsSync(unrelated));
    assert.ok(fs.existsSync(plain));
  });
});

describe('neat usage-capture', () => {
  let cfg;
  let proj;

  before(() => {
    proj = makeTempDir('neat-usage-proj-');
  });

  after(() => removeDir(proj));

  // Fresh config dir per case; raw Buffers in and out.
  function capture(args, input, setup) {
    cfg = makeTempDir('neat-usage-cfg-');
    if (setup) setup(cfg);
    const env = childEnv({ CLAUDE_CONFIG_DIR: cfg, NEAT_PROJECT_DIR: proj });
    const res = spawnSync(process.execPath, [HELPER, 'usage-capture', ...args], { cwd: proj, env, input });
    if (res.error) throw res.error;
    return { status: res.status, stdout: res.stdout, stderr: res.stderr.toString('utf8'), file: path.join(cfg, 'neat', 'usage.json') };
  }

  const JSON_IN = Buffer.from(`{"rate_limits":{"five_hour":{"used_percentage":40,"resets_at":${NOW_SEC + 3600}}}}`);

  function expectPassThrough(res, input) {
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.deepEqual(res.stdout, input);
  }

  test('passes stdin through byte for byte and writes a private capture', () => {
    const res = capture([], JSON_IN);
    expectPassThrough(res, JSON_IN);
    assert.deepEqual(fs.readFileSync(res.file), JSON_IN);
    assert.equal(mode(res.file), 0o600);
    assert.equal(mode(path.dirname(res.file)), 0o700);
    assert.deepEqual(tmpSiblings(res.file), []);
    removeDir(cfg);
  });

  test('--quiet prints nothing and still writes', () => {
    const res = capture(['--quiet'], JSON_IN);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.length, 0);
    assert.deepEqual(fs.readFileSync(res.file), JSON_IN);
    removeDir(cfg);
  });

  test('--path writes to the given absolute file; a relative path writes nothing', () => {
    const target = path.join(proj, 'custom', 'cap.json');
    const res = capture(['--path', target], JSON_IN);
    expectPassThrough(res, JSON_IN);
    assert.deepEqual(fs.readFileSync(target), JSON_IN);
    assert.equal(fs.existsSync(res.file), false);
    removeDir(cfg);
    const rel = capture(['--path', 'rel.json'], JSON_IN);
    expectPassThrough(rel, JSON_IN);
    assert.equal(fs.existsSync(path.join(proj, 'rel.json')), false);
    assert.equal(fs.existsSync(rel.file), false);
    removeDir(cfg);
  });

  test('input that is not a JSON object passes through and writes nothing', () => {
    for (const text of ['not json', '[1]', '', '42']) {
      const input = Buffer.from(text);
      const res = capture([], input);
      expectPassThrough(res, input);
      assert.equal(fs.existsSync(res.file), false, text);
      removeDir(cfg);
    }
  });

  test('an unknown flag passes through and writes nothing', () => {
    const res = capture(['--pth', 'x'], JSON_IN);
    expectPassThrough(res, JSON_IN);
    assert.equal(fs.existsSync(res.file), false);
    removeDir(cfg);
  });

  test('an invalid global config passes through and writes nothing', () => {
    const res = capture([], JSON_IN, (dir) => {
      fs.mkdirSync(path.join(dir, 'neat'));
      fs.writeFileSync(path.join(dir, 'neat', 'config.json'), '{"bogus":1}');
    });
    expectPassThrough(res, JSON_IN);
    assert.equal(fs.existsSync(res.file), false);
    removeDir(cfg);
  });

  test('the global usage.capturePath is honoured', () => {
    const target = path.join(proj, 'from-config.json');
    const res = capture([], JSON_IN, (dir) => {
      fs.mkdirSync(path.join(dir, 'neat'));
      fs.writeFileSync(path.join(dir, 'neat', 'config.json'), JSON.stringify({ usage: { capturePath: target } }));
    });
    expectPassThrough(res, JSON_IN);
    assert.deepEqual(fs.readFileSync(target), JSON_IN);
    removeDir(cfg);
  });

  test('an unwritable target passes through with exit 0 and no stderr', () => {
    const blocker = path.join(proj, 'blocker-file');
    fs.writeFileSync(blocker, '');
    const res = capture(['--path', path.join(blocker, 'usage.json')], JSON_IN);
    expectPassThrough(res, JSON_IN);
    removeDir(cfg);
  });

  test('non-UTF-8 bytes pass through byte-exact', () => {
    const input = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"}')]);
    const res = capture([], input);
    expectPassThrough(res, input);
    removeDir(cfg);
    const raw = Buffer.from([0x80, 0x81, 0x0a, 0xff]);
    const res2 = capture([], raw);
    expectPassThrough(res2, raw);
    assert.equal(fs.existsSync(res2.file), false);
    removeDir(cfg);
  });

  test('help lists usage-capture', () => {
    const res = spawnSync(process.execPath, [HELPER, 'help'], { env: childEnv(), encoding: 'utf8' });
    assert.match(res.stdout, /^neat usage-capture \[--path <file>\] \[--quiet\]$/m);
  });
});
