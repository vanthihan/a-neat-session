'use strict';

// Context window warnings for the orchestrator. `brief`, `run stage` and
// `route` print one extra `context:` line when this session's context
// percentage (from the status line capture) reaches the configured warn or
// critical threshold. The reader never throws: any error means no line, so
// the warning can never make a command fail.

const os = require('node:os');
const { effectiveConfig } = require('./config.cjs');
const { readUsage, formatPercent } = require('./usage.cjs');

// The line for `ctx` percent of the context window, or null below warn or
// when unknown.
function contextLine(cfg, ctx, id) {
  if (typeof ctx !== 'number' || !Number.isFinite(ctx)) return null;
  const { warn, critical } = cfg.context;
  const pct = formatPercent(ctx);
  if (ctx >= critical) {
    return `context: ${pct} (critical ${formatPercent(critical)}): stop after this step and tell the user to run /clear, then /neat:resume ${id}`;
  }
  if (ctx >= warn) {
    return `context: ${pct} (warn ${formatPercent(warn)}): keep going; at ${formatPercent(critical)} stop for /clear and /neat:resume ${id}`;
  }
  return null;
}

// Reads the effective config and this session's capture; null on any error.
function contextLineFor(opts) {
  try {
    const { root, state, env = process.env, now = new Date(), home = os.homedir() } = opts;
    if (!state || typeof state.id !== 'string') return null;
    const cfg = effectiveConfig({ root, env, home, state });
    const { ctx } = readUsage(cfg.usage.capturePath, now, { sessionId: env.CLAUDE_CODE_SESSION_ID });
    return contextLine(cfg, ctx, state.id);
  } catch {
    return null;
  }
}

module.exports = { contextLine, contextLineFor };
