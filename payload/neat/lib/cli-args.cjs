'use strict';

// Parses the raw /neat:do argument text into { task, mode, profile }.
// Flags are recognised only as leading tokens or trailing `--mode`/`--profile` pairs;
// everything else is task text, kept byte-exact (inner whitespace included).

const MODES = Object.freeze(['gate', 'auto', 'step']);
const DEFAULT_MODE = 'gate';
const PROFILES = Object.freeze(['adaptive', 'quality', 'balanced', 'budget', 'inherit']);
const DEFAULT_PROFILE = 'adaptive';

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
  return new UsageError(`unknown flag ${token.split('=')[0]} (valid: --mode, --profile; put -- before a task that starts with a flag)`);
}

// Returns a recorder for one value flag (`--mode`, `--profile`): rejects a
// missing value, a value outside `allowed` and a second occurrence.
// `strictTrailing`: a trailing `--flag=<value>` always counts as the flag (an
// invalid value is an error) instead of falling back to task text.
function flagRecorder(flag, allowed, strictTrailing = false) {
  let value = null;
  const choices = allowed.join('|');
  return {
    flag,
    allowed,
    strictTrailing,
    set(v) {
      if (value !== null) throw new UsageError(`duplicate ${flag}`);
      if (v === undefined) throw new UsageError(`${flag} needs a value (use ${choices})`);
      if (!allowed.includes(v)) throw new UsageError(`invalid ${flag} '${v}' (use ${choices})`);
      value = v;
    },
    get: () => value,
  };
}

function recorderFor(flags, token) {
  return flags.find((f) => token === f.flag || token.startsWith(`${f.flag}=`)) || null;
}

// Consumes leading flags; returns { index, stop } where stop means `--` was seen.
function consumeLeading(tokens, flags) {
  let i = 0;
  while (i < tokens.length && tokens[i].value.startsWith('--')) {
    const v = tokens[i].value;
    if (v === '--') return { index: i + 1, stop: true };
    const rec = recorderFor(flags, v);
    if (!rec) throw unknownFlag(v);
    if (v === rec.flag) {
      rec.set(tokens[i + 1] && tokens[i + 1].value);
      i += 2;
    } else {
      rec.set(v.slice(rec.flag.length + 1));
      i += 1;
    }
  }
  return { index: i, stop: false };
}

// Recorder for a trailing `--flag=<value>` token, or null when it is task text.
function trailingEq(flags, token) {
  const rec = recorderFor(flags, token);
  if (!rec || token === rec.flag) return null;
  const value = token.slice(rec.flag.length + 1);
  return rec.strictTrailing || rec.allowed.includes(value) ? { rec, value } : null;
}

// Consumes trailing `--mode <m>` / `--profile <p>` pairs and `--flag=<value>`
// tokens down to (not below) `floor`; returns the new end index. A pair counts
// only when its value is valid. Any other trailing token, even one that looks
// like a flag (`add a --dry-run option`), is task text.
function consumeTrailing(tokens, floor, flags) {
  let j = tokens.length;
  while (j > floor) {
    const last = tokens[j - 1].value;
    const prev = j - 2 >= floor ? tokens[j - 2].value : null;
    const eq = trailingEq(flags, last);
    const pair = flags.find((f) => prev === f.flag && f.allowed.includes(last));
    if (eq) {
      eq.rec.set(eq.value);
      j -= 1;
    } else if (pair) {
      pair.set(last);
      j -= 2;
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
  const mode = flagRecorder('--mode', MODES, true);
  const profile = flagRecorder('--profile', PROFILES);
  const flags = [mode, profile];
  const lead = consumeLeading(tokens, flags);
  const end = lead.stop ? tokens.length : consumeTrailing(tokens, lead.index, flags);
  const task = lead.index < end
    ? stripWrappingQuotes(raw.slice(tokens[lead.index].start, tokens[end - 1].end).trim())
    : '';
  if (task === '') throw new UsageError('task is required');
  // profile stays null when absent: the config files fill it in later.
  return { task, mode: mode.get() || DEFAULT_MODE, profile: profile.get() };
}

module.exports = { parseTaskArgs, UsageError, MODES, DEFAULT_MODE, PROFILES, DEFAULT_PROFILE };
