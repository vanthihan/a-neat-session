'use strict';

// Account usage from the Claude Code status line capture.
// The reader extracts only numeric fields (rate-limit windows and context
// percentage) and never throws: a missing, unreadable, malformed or stale
// capture is simply "unknown". The writer is used by `neat usage-capture`.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A window without resets_at counts only while the file is this fresh.
const MTIME_WINDOW_MS = 15 * 60 * 1000;
// Captures larger than this are ignored (a real one is a few KB).
const MAX_CAPTURE_BYTES = 1024 * 1024;
const WINDOWS = Object.freeze(['five_hour', 'seven_day']);
// Orphaned tmp files (the status line cancels in-flight runs) older than this
// are removed.
const TMP_MAX_AGE_MS = 10 * 60 * 1000;
const TMP_MARK = '.tmp-';

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

// Checks the type before opening and opens without blocking, so a FIFO or
// device at the capture path reads as unknown instead of hanging. The second
// check on the open descriptor covers a swap between stat and open.
function readCapture(file) {
  let fd;
  try {
    const pre = fs.statSync(file);
    if (!pre.isFile() || pre.size > MAX_CAPTURE_BYTES) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
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

// Writes `bytes` to `file` atomically: a 0700 parent directory when missing,
// an exclusive 0600 tmp sibling, then rename (which replaces a symlink entry
// instead of writing through it). Throws on failure; the caller swallows.
function writeCapture(file, bytes) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const tmp = `${file}${TMP_MARK}${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Removes `<basename>.tmp-*` siblings of `file` older than TMP_MAX_AGE_MS.
function cleanupTmp(file, now = new Date()) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}${TMP_MARK}`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() && now.getTime() - st.mtimeMs > TMP_MAX_AGE_MS) fs.unlinkSync(p);
    } catch {
      // raced with another run; leave it
    }
  }
}

module.exports = {
  MTIME_WINDOW_MS,
  MAX_CAPTURE_BYTES,
  TMP_MAX_AGE_MS,
  readUsage,
  formatPercent,
  writeCapture,
  cleanupTmp,
};
