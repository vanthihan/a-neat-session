'use strict';

// Usage capture reader: per-window validity, staleness, percent formatting.
// Fixtures are synthetic statusline-shaped objects (no real capture values)
// written under temp dirs; nothing here touches the real Claude config dir.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const usage = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'usage.cjs'));

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
