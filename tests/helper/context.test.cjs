'use strict';

// Context warn/critical line: pure wording plus the never-throwing reader.
// Every env here carries a temp CLAUDE_CONFIG_DIR, so the real ~/.claude
// (global config, usage capture) is never read.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const context = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'context.cjs'));

const ID = '20260501-120000-abcd';
const CFG = { context: { warn: 60, critical: 75 } };
const NOW = new Date('2026-05-01T12:00:00Z');

const dirs = [];
after(() => dirs.forEach(removeDir));

function tmp(prefix) {
  const d = makeTempDir(prefix);
  dirs.push(d);
  return d;
}

describe('contextLine', () => {
  test('unknown or below warn prints nothing', () => {
    assert.equal(context.contextLine(CFG, null, ID), null);
    assert.equal(context.contextLine(CFG, undefined, ID), null);
    assert.equal(context.contextLine(CFG, 0, ID), null);
    assert.equal(context.contextLine(CFG, 59.9, ID), null);
  });

  test('from warn up to critical it says keep going and names the resume command', () => {
    assert.equal(
      context.contextLine(CFG, 63, ID),
      `context: 63% (warn 60%): keep going; at 75% stop for /clear and /neat:resume ${ID}`,
    );
    assert.equal(
      context.contextLine(CFG, 60, ID),
      `context: 60% (warn 60%): keep going; at 75% stop for /clear and /neat:resume ${ID}`,
    );
    assert.match(context.contextLine(CFG, 74.94, ID), /^context: 74\.9% \(warn 60%\): /);
  });

  test('at or above critical it says stop and points to /clear then /neat:resume', () => {
    const line = `context: 78% (critical 75%): stop after this step and tell the user to run /clear, then /neat:resume ${ID}`;
    assert.equal(context.contextLine(CFG, 78, ID), line);
    assert.match(context.contextLine(CFG, 75, ID), /^context: 75% \(critical 75%\): stop after this step/);
    assert.match(context.contextLine(CFG, 100, ID), /^context: 100% \(critical 75%\)/);
  });

  test('warn equal to critical goes straight to critical', () => {
    const cfg = { context: { warn: 50, critical: 50 } };
    assert.match(context.contextLine(cfg, 50, ID), /^context: 50% \(critical 50%\)/);
  });
});

describe('contextLineFor', () => {
  function setup({ capture, project, mtime = NOW } = {}) {
    const root = tmp('neat-ctx-root-');
    const cfgDir = tmp('neat-ctx-cfg-');
    if (capture !== undefined) {
      const file = path.join(cfgDir, 'neat', 'usage.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(capture));
      fs.utimesSync(file, mtime, mtime);
    }
    if (project !== undefined) {
      fs.mkdirSync(path.join(root, '.neat'), { recursive: true });
      fs.writeFileSync(path.join(root, '.neat', 'config.json'), project);
    }
    return { root, home: tmp('neat-ctx-home-'), cfgDir };
  }

  function lineFor(l, sessionId) {
    const env = { CLAUDE_CONFIG_DIR: l.cfgDir };
    if (sessionId !== undefined) env.CLAUDE_CODE_SESSION_ID = sessionId;
    return context.contextLineFor({ root: l.root, state: { id: ID, profile: null }, env, now: NOW, home: l.home });
  }

  const capture = (pct) => ({ session_id: 'sess-a', context_window: { used_percentage: pct } });

  test('reads this session capture through the config thresholds', () => {
    const l = setup({ capture: capture(63) });
    assert.equal(lineFor(l, 'sess-a'), `context: 63% (warn 60%): keep going; at 75% stop for /clear and /neat:resume ${ID}`);
    assert.match(lineFor(setup({ capture: capture(78) }), 'sess-a'), /^context: 78% \(critical 75%\)/);
  });

  test('project thresholds apply', () => {
    const l = setup({ capture: capture(30), project: '{"context":{"warn":10,"critical":20}}' });
    assert.match(lineFor(l, 'sess-a'), /^context: 30% \(critical 20%\)/);
  });

  test('another session, a stale capture or no capture print nothing', () => {
    assert.equal(lineFor(setup({ capture: capture(90) }), 'sess-b'), null);
    assert.equal(lineFor(setup({ capture: capture(90), mtime: new Date(NOW.getTime() - 20 * 60 * 1000) }), 'sess-a'), null);
    assert.equal(lineFor(setup(), 'sess-a'), null);
  });

  test('any error returns null instead of throwing', () => {
    assert.equal(lineFor(setup({ capture: capture(90), project: '{ broken' }), 'sess-a'), null);
    assert.equal(lineFor(setup({ capture: capture(90), project: '{"context":{"warn":"x"}}' }), 'sess-a'), null);
    assert.equal(context.contextLineFor(null), null);
    assert.equal(context.contextLineFor({ root: null, state: null, env: { CLAUDE_CONFIG_DIR: tmp('neat-ctx-x-') } }), null);
  });
});
