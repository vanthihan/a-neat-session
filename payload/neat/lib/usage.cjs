'use strict';

// Account usage from the Claude Code status line capture.
// The reader extracts only numeric fields (rate-limit windows and context
// percentage) and never throws: a missing, unreadable, malformed or stale
// capture is simply "unknown". The writer is used by `neat usage-capture`.

const fs = require('node:fs');

// A window without resets_at counts only while the file is this fresh.
const MTIME_WINDOW_MS = 15 * 60 * 1000;
// Captures larger than this are ignored (a real one is a few KB).
const MAX_CAPTURE_BYTES = 1024 * 1024;
const WINDOWS = Object.freeze(['five_hour', 'seven_day']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function percentOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// Percentage of one rate-limit window, or null when it is invalid or expired.
function windowPercent(win, nowSec, fresh) {
  if (!isObject(win)) return null;
  const pct = percentOrNull(win.used_percentage);
  if (pct === null) return null;
  const resets = win.resets_at;
  if (resets === undefined || resets === null) return fresh ? pct : null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  return resets > nowSec ? pct : null;
}

function readCapture(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_CAPTURE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return isObject(data) ? { data, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// { known, usage, fiveHour, sevenDay, ctx } where usage is the maximum valid
// window. `now` is a Date (the run clock).
function readUsage(file, now = new Date()) {
  const unknown = { known: false, usage: null, fiveHour: null, sevenDay: null, ctx: null };
  const capture = readCapture(file);
  if (!capture) return unknown;
  const { data, mtimeMs } = capture;
  const nowMs = now.getTime();
  const ctx = isObject(data.context_window) ? percentOrNull(data.context_window.used_percentage) : null;
  const limits = isObject(data.rate_limits) ? data.rate_limits : {};
  const fresh = nowMs - mtimeMs <= MTIME_WINDOW_MS;
  const [fiveHour, sevenDay] = WINDOWS.map((w) => windowPercent(limits[w], nowMs / 1000, fresh));
  const valid = [fiveHour, sevenDay].filter((v) => v !== null);
  const usage = valid.length > 0 ? Math.max(...valid) : null;
  return { known: usage !== null, usage, fiveHour, sevenDay, ctx };
}

// `72%`, `23.5%` (at most one decimal) or `unknown`.
function formatPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'unknown';
  return `${Math.round(n * 10) / 10}%`;
}

module.exports = { MTIME_WINDOW_MS, MAX_CAPTURE_BYTES, readUsage, formatPercent };
