'use strict';

// Parses the raw /neat:do argument text into { task, mode }.
// Flags are recognised only as leading or trailing tokens; everything in
// between is task text, kept byte-exact (inner whitespace included).

const MODES = Object.freeze(['gate', 'auto', 'step']);
const DEFAULT_MODE = 'gate';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

function tokenize(text) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function unknownFlag(token) {
  return new UsageError(`unknown flag ${token.split('=')[0]} (valid: --mode)`);
}

function checkMode(value) {
  if (value === undefined) throw new UsageError(`--mode needs a value (use ${MODES.join('|')})`);
  if (!MODES.includes(value)) throw new UsageError(`invalid --mode '${value}' (use ${MODES.join('|')})`);
  return value;
}

// Returns a recorder that rejects a second --mode.
function modeRecorder() {
  let mode = null;
  return {
    set(value) {
      if (mode !== null) throw new UsageError('duplicate --mode');
      mode = checkMode(value);
    },
    get: () => mode || DEFAULT_MODE,
  };
}

// Consumes leading flags; returns { index, stop } where stop means `--` was seen.
function consumeLeading(tokens, mode) {
  let i = 0;
  while (i < tokens.length && tokens[i].value.startsWith('--')) {
    const v = tokens[i].value;
    if (v === '--') return { index: i + 1, stop: true };
    if (v === '--mode') {
      mode.set(tokens[i + 1] && tokens[i + 1].value);
      i += 2;
    } else if (v.startsWith('--mode=')) {
      mode.set(v.slice('--mode='.length));
      i += 1;
    } else {
      throw unknownFlag(v);
    }
  }
  return { index: i, stop: false };
}

// Consumes trailing flags down to (not below) `floor`; returns the new end index.
function consumeTrailing(tokens, floor, mode) {
  let j = tokens.length;
  while (j > floor) {
    const last = tokens[j - 1].value;
    const prev = j - 2 >= floor ? tokens[j - 2].value : null;
    if (last.startsWith('--mode=')) {
      mode.set(last.slice('--mode='.length));
      j -= 1;
    } else if (prev === '--mode') {
      mode.set(last);
      j -= 2;
    } else if (last === '--mode') {
      checkMode(undefined);
    } else if (last.startsWith('--')) {
      throw unknownFlag(last);
    } else if (prev && prev.startsWith('--') && !prev.includes('=')) {
      throw unknownFlag(prev);
    } else {
      break;
    }
  }
  return j;
}

function stripWrappingQuotes(text) {
  if (text.length < 2) return text;
  const q = text[0];
  if ((q !== '"' && q !== "'") || text[text.length - 1] !== q) return text;
  const inner = text.slice(1, -1);
  return inner.includes(q) ? text : inner.trim();
}

function parseTaskArgs(text) {
  const raw = String(text);
  const tokens = tokenize(raw);
  const mode = modeRecorder();
  const lead = consumeLeading(tokens, mode);
  const end = lead.stop ? tokens.length : consumeTrailing(tokens, lead.index, mode);
  const task = lead.index < end
    ? stripWrappingQuotes(raw.slice(tokens[lead.index].start, tokens[end - 1].end).trim())
    : '';
  if (task === '') throw new UsageError('task is required');
  return { task, mode: mode.get() };
}

module.exports = { parseTaskArgs, UsageError, MODES, DEFAULT_MODE };
