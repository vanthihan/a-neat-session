'use strict';

// `neat filter <run-id> <test|build|install> <log>`: the right-hand side of
// the pipe the PreToolUse hook builds. It writes every input byte to the log
// in the run's logs dir and prints either the short output as it is or a
// header, the failure-relevant lines with a little context and the last
// lines. It always reads its input to the end, never writes to stderr and
// always exits 0: under `set -o pipefail` the command's own exit code is the
// result, and an early exit would kill the command with SIGPIPE.

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const runState = require('./run-state.cjs');

const KINDS = Object.freeze(['test', 'build', 'install']);
const CHUNK = 64 * 1024;
const SHORT_LINES = 40;
const SHORT_CHARS = 2000;
const TAIL_RING = 30;
const TAIL_WITH_MATCHES = 10;
const MAX_MATCH_LINES = 60;
const MAX_MATCH_CHARS = 4000;
const MAX_LINE = 160;
const MAX_TOTAL_CHARS = 6000;
const MAX_PENDING = 64 * 1024;
const CONTEXT_AFTER = 2;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const FAILURE = /\b(?:errors?|fail(?:s|ed|ing|ures?)?|panic(?:ked)?|exception|traceback|assert(?:ion)?|expected|received|not ok)\b|\bERR!|[A-Z][A-Za-z]*(?:Error|Exception)\b|[✗✕×]/i;

// Escape sequences and control characters removed; of carriage-return
// progress updates only the last segment is kept.
function cleanLine(raw) {
  const segments = raw.replace(/\r$/, '').split('\r');
  return segments[segments.length - 1].replace(ANSI, '').replace(CONTROL, '');
}

function cut(line) {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 3)}...` : line;
}

// Bounded-memory summary state: fed decoded text, finished once at EOF.
function createSummarizer(logPath) {
  let pending = '';
  let total = 0;
  let head = [];
  let headChars = 0;
  let isShort = true;
  const tail = [];
  const matched = [];
  let matchedChars = 0;
  let matchesFull = false;
  let before = null;
  let lastTaken = -1;
  let afterLeft = 0;

  function take(line, index) {
    if (index <= lastTaken || matchesFull) return;
    const text = cut(line);
    if (matched.length >= MAX_MATCH_LINES || matchedChars + text.length + 1 > MAX_MATCH_CHARS) {
      matchesFull = true;
      return;
    }
    matched.push(text);
    matchedChars += text.length + 1;
    lastTaken = index;
  }

  function addLine(raw) {
    const line = cleanLine(raw);
    const index = total;
    total += 1;
    if (isShort) {
      head.push(line);
      headChars += line.length + 1;
      if (head.length > SHORT_LINES || headChars > SHORT_CHARS) {
        isShort = false;
        head = [];
      }
    }
    tail.push(line);
    if (tail.length > TAIL_RING) tail.shift();
    if (FAILURE.test(line)) {
      if (before !== null) take(before, index - 1);
      take(line, index);
      afterLeft = CONTEXT_AFTER;
    } else if (afterLeft > 0) {
      take(line, index);
      afterLeft -= 1;
    }
    before = line;
  }

  function push(text) {
    const parts = (pending + text).split('\n');
    pending = parts.pop();
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING / 8);
    for (const raw of parts) addLine(raw);
  }

  function finish() {
    if (pending !== '') addLine(pending);
    pending = '';
    if (total === 0) return '';
    if (isShort) return `${head.join('\n')}\n`;
    const header = `[neat] output trimmed to failure-relevant lines (${total} lines total); exit code unchanged; full log: ${logPath}`;
    const lastLines = (matched.length > 0 ? tail.slice(-TAIL_WITH_MATCHES) : tail).map(cut);
    const out = [header, ...matched, '--- last lines ---', ...lastLines].join('\n');
    return `${out.length > MAX_TOTAL_CHARS ? out.slice(0, out.lastIndexOf('\n', MAX_TOTAL_CHARS)) : out}\n`;
  }

  return { push, finish };
}

// Pure: the summary `neat filter` prints for the whole `text`.
function summarize(text, logPath) {
  const s = createSummarizer(logPath);
  s.push(String(text));
  return s.finish();
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Calls onChunk for every chunk of fd until EOF (retrying EAGAIN).
function drain(fd, onChunk) {
  const buf = Buffer.alloc(CHUNK);
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        sleepMs(5);
        continue;
      }
      return;
    }
    if (n === 0) return;
    onChunk(buf.subarray(0, n));
  }
}

// Writes everything or gives up quietly (a closed reader must not stop the drain).
function makeWriter(fd) {
  let broken = false;
  return (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let off = 0;
    while (!broken && off < bytes.length) {
      try {
        off += fs.writeSync(fd, bytes, off);
      } catch (err) {
        if (err.code === 'EAGAIN') sleepMs(5);
        else broken = true;
      }
    }
  };
}

function isPlainDir(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return Boolean(st) && st.isDirectory() && !st.isSymbolicLink();
}

// The log path when the arguments name `<run dir>/logs/<kind>-...txt` of an
// existing run, else null. Creates the logs dir (0700) when missing.
function validLogPath([runId, kind, log]) {
  if (!runState.isValidRunId(runId) || !KINDS.includes(kind)) return null;
  if (typeof log !== 'string' || !path.isAbsolute(log) || path.normalize(log) !== log) return null;
  if (!new RegExp(`^${kind}-[A-Za-z0-9._-]+\\.txt$`).test(path.basename(log))) return null;
  const logsDir = path.dirname(log);
  const runDir = path.dirname(logsDir);
  const runsDir = path.dirname(runDir);
  const ok = path.basename(logsDir) === 'logs' && path.basename(runDir) === runId
    && path.basename(runsDir) === 'runs' && path.basename(path.dirname(runsDir)) === '.neat';
  if (!ok || !isPlainDir(runDir) || !fs.existsSync(path.join(runDir, 'state.json'))) return null;
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { mode: 0o700 });
  return isPlainDir(logsDir) ? log : null;
}

function openLog(argv) {
  try {
    const log = validLogPath(argv);
    return log ? { log, fd: fs.openSync(log, 'wx', 0o600) } : null;
  } catch {
    return null;
  }
}

function main(argv = []) {
  const write = makeWriter(1);
  const sink = openLog(argv);
  if (!sink) {
    drain(0, write);
    process.exitCode = 0;
    return;
  }
  const writeLog = makeWriter(sink.fd);
  const decoder = new StringDecoder('utf8');
  const summary = createSummarizer(sink.log);
  let summaryOk = true;
  drain(0, (chunk) => {
    writeLog(chunk);
    if (!summaryOk) return;
    try {
      summary.push(decoder.write(chunk));
    } catch {
      summaryOk = false;
    }
  });
  try {
    fs.closeSync(sink.fd);
  } catch {
    // the log is best effort
  }
  let text = '';
  try {
    if (summaryOk) summary.push(decoder.end());
    text = summary.finish();
  } catch {
    text = `[neat] output could not be summarized; full log: ${sink.log}\n`;
  }
  write(text);
  process.exitCode = 0;
}

module.exports = { main, summarize, createSummarizer };
