'use strict';

// `neat filter` as a child process: short output passes through, long output
// is trimmed to the failure-relevant lines, every byte lands in the run's log,
// bad arguments mean a plain copy, and under pipefail the producer's exit code
// survives even for 50 MB of output.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const { summarize } = require(path.join(LIB, 'output-filter.cjs'));
const rs = require(path.join(LIB, 'run-state.cjs'));

const NOW = new Date('2026-10-18T12:00:00.000Z');
const HEADER = /^\[neat\] output trimmed to failure-relevant lines \((\d+) lines total\); exit code unchanged; full log: (\S+)$/;
const HAS_BASH = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const start = (log) => `[neat] filtering output; full log: ${log}`;

let tmp;
let root;
let runId;
let runDir;
let logN = 0;

before(() => {
  tmp = makeTempDir('neat-filter-');
  root = path.join(tmp, 'proj');
  fs.mkdirSync(root);
  runId = rs.createRun(root, { task: 'filter output', mode: 'gate' }, NOW).id;
  runDir = rs.runDir(root, runId);
});

after(() => removeDir(tmp));

function newLog(kind = 'test') {
  logN += 1;
  return path.join(runDir, 'logs', `${kind}-20261018-120000-${String(logN).padStart(4, '0')}.txt`);
}

function filter(args, input) {
  const res = spawnSync(process.execPath, [HELPER, 'filter', ...args], {
    cwd: root,
    env: childEnv(),
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout.toString('utf8'), stderr: res.stderr.toString('utf8') };
}

function lines(n, at = () => null) {
  return Array.from({ length: n }, (_, i) => at(i) || `line ${i + 1} ok`).join('\n') + '\n';
}

describe('summarizing', () => {
  test('25 short lines pass through cleaned, and the raw bytes are logged', () => {
    const log = newLog();
    const raw = `\u001b[32mgreen\u001b[0m start\nprogress 10%\rprogress 100%\n${lines(23)}`;
    const res = filter([runId, 'test', log], raw);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.equal(res.stdout, `${start(log)}\ngreen start\nprogress 100%\n${lines(23)}`);
    assert.equal(fs.readFileSync(log, 'utf8'), raw);
    assert.equal(fs.statSync(path.dirname(log)).mode & 0o777, 0o700);
  });

  test('500 lines with 3 failures become header, failure lines with context and the tail', () => {
    const log = newLog();
    const fails = new Map([[100, 'FAIL tests/a.test.js'], [250, 'Error: expected 2 to equal 3'], [400, 'not ok 7 - adds']]);
    const raw = lines(500, (i) => fails.get(i));
    const res = filter([runId, 'test', log], raw);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    const out = res.stdout.trimEnd().split('\n');
    assert.equal(out[0], start(log));
    const m = HEADER.exec(out[1]);
    assert.ok(m, out[1]);
    assert.equal(m[1], '500');
    assert.equal(m[2], log);
    for (const [i, text] of fails) {
      const at = out.indexOf(text);
      assert.ok(at > 0, text);
      assert.equal(out[at - 1], `line ${i} ok`);
      assert.equal(out[at + 1], `line ${i + 2} ok`);
      assert.equal(out[at + 2], `line ${i + 3} ok`);
    }
    const sep = out.indexOf('--- last lines ---');
    assert.ok(sep > 0);
    assert.deepEqual(out.slice(sep + 1), Array.from({ length: 10 }, (_, k) => `line ${491 + k} ok`));
    assert.ok(out.length <= 80, `${out.length} lines`);
    assert.ok(res.stdout.length <= 6000, `${res.stdout.length} chars`);
    assert.equal(fs.readFileSync(log, 'utf8'), raw);
  });

  test('many failures stay within 80 lines and 6000 characters', () => {
    const log = newLog();
    const raw = lines(3000, (i) => (i % 3 === 0 ? `Error ${i}: ${'x'.repeat(300)}` : null));
    const res = filter([runId, 'test', log], raw);
    const out = res.stdout.trimEnd().split('\n');
    assert.equal(out[0], start(log));
    assert.ok(HEADER.test(out[1]), out[1]);
    assert.ok(out.length <= 80, `${out.length} lines`);
    assert.ok(res.stdout.length <= 6000, `${res.stdout.length} chars`);
    assert.equal(fs.statSync(log).size, Buffer.byteLength(raw));
  });

  test('summarize trims long output without a failure line to the tail', () => {
    const out = summarize(lines(200), '/x/logs/test-1.txt').trimEnd().split('\n');
    assert.ok(HEADER.test(out[0]), out[0]);
    assert.equal(out[out.length - 1], 'line 200 ok');
    assert.ok(out.length <= 80);
  });

  test('summarize passes short output through', () => {
    assert.equal(summarize('a\nb\n', '/x/logs/test-1.txt'), 'a\nb\n');
    assert.equal(summarize('', '/x/logs/test-1.txt'), '');
  });
});

describe('a command killed before it ends', () => {
  test('the log path is printed before the input ends, so it survives a timeout or interrupt', async () => {
    const log = newLog();
    const child = spawn(process.execPath, [HELPER, 'filter', runId, 'test', log], { cwd: root, env: childEnv() });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.write('running 1 test\n');
    const seen = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30000);
      child.stdout.on('data', () => {
        if (out.includes('\n')) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('close', resolve));
    assert.ok(seen, 'nothing printed while the command was still running');
    assert.equal(out.split('\n')[0], `[neat] filtering output; full log: ${log}`);
    assert.ok(fs.existsSync(log), 'the named log exists');
  });
});

describe('arguments that are refused mean a plain copy and no log', () => {
  const INPUT = 'one\ntwo \u001b[31mred\u001b[0m\n';

  function refused(args) {
    const res = filter(args, INPUT);
    assert.equal(res.status, 0, args.join(' '));
    assert.equal(res.stderr, '');
    assert.equal(res.stdout, INPUT, args.join(' '));
  }

  test('bad run id, unknown kind, wrong log names and places', () => {
    const otherRun = rs.createRun(root, { task: 'other run', mode: 'gate' }, NOW).id;
    const log = newLog();
    refused(['bad-id', 'test', log]);
    refused([runId, 'lint', log.replace('/test-', '/lint-')]);
    refused([runId, 'build', log]);
    refused([runId, 'test', path.join(rs.runDir(root, otherRun), 'logs', 'test-1.txt')]);
    refused([runId, 'test', path.join(runDir, 'test-1.txt')]);
    refused([runId, 'test', `${runDir}/logs/../logs/test-2.txt`]);
    refused([runId, 'test', 'logs/test-3.txt']);
    refused([runId, 'test', path.join(runDir, 'logs', 'test-4.md')]);
    refused([runId, 'test']);
    refused([]);
    assert.ok(!fs.existsSync(log));
  });

  test('a missing run dir', () => {
    const id = '20261018-120000-no-such-run';
    refused([id, 'test', path.join(root, '.neat', 'runs', id, 'logs', 'test-1.txt')]);
    assert.ok(!fs.existsSync(path.join(root, '.neat', 'runs', id)));
  });

  test('a symlinked logs dir or an existing log file', () => {
    const id = rs.createRun(root, { task: 'symlinked logs', mode: 'gate' }, NOW).id;
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(rs.runDir(root, id), 'logs'));
    refused([id, 'test', path.join(rs.runDir(root, id), 'logs', 'test-1.txt')]);
    assert.deepEqual(fs.readdirSync(elsewhere), []);

    const log = newLog();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, 'kept\n');
    refused([runId, 'test', log]);
    assert.equal(fs.readFileSync(log, 'utf8'), 'kept\n');
  });
});

describe('under bash pipefail', { skip: !HAS_BASH && 'bash not available' }, () => {
  const MB = 1024 * 1024;
  let producer;

  before(() => {
    producer = path.join(tmp, 'produce.cjs');
    fs.writeFileSync(producer, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const chunk = Buffer.from(`${'x'.repeat(99)}\\n`.repeat(10486));",
      'const total = Number(process.argv[2]);',
      'let left = total;',
      'while (left > 0) {',
      '  const part = left >= chunk.length ? chunk : chunk.subarray(0, left);',
      '  let off = 0;',
      '  while (off < part.length) {',
      '    try { off += fs.writeSync(1, part, off); } catch (e) { if (e.code !== "EAGAIN") throw e; }',
      '  }',
      '  left -= part.length;',
      '}',
      'process.exitCode = Number(process.argv[3]);',
      '',
    ].join('\n'));
  });

  function pipeline(bytes, code) {
    const log = newLog();
    const cmd = `set -o pipefail; node ${producer} ${bytes} ${code} 2>&1 | node ${HELPER} filter ${runId} test ${log}`;
    const res = spawnSync('bash', ['-c', cmd], { cwd: root, env: childEnv(), encoding: 'utf8', maxBuffer: 8 * MB });
    if (res.error) throw res.error;
    return { ...res, log };
  }

  test('50 MB of output and exit 3: bash exits 3, at most 80 lines, the log holds every byte', () => {
    const res = pipeline(50 * MB, 3);
    assert.equal(res.status, 3, res.stderr);
    assert.equal(res.stderr, '');
    assert.ok(res.stdout.trimEnd().split('\n').length <= 80);
    assert.equal(res.stdout.split('\n')[0], start(res.log));
    assert.ok(HEADER.test(res.stdout.split('\n')[1]), res.stdout.slice(0, 300));
    assert.equal(fs.statSync(res.log).size, 50 * MB);
  });

  test('the same with exit 0: bash exits 0', () => {
    const res = pipeline(MB, 0);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.statSync(res.log).size, MB);
  });
});
