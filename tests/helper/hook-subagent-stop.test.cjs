'use strict';

// SubagentStop report guard called directly: which agents and messages it
// checks, how it finds the run, the block reason, the retry cap and the
// warning it records, and that it lets the worker stop on any doubt.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const { subagentStop, locateRun, MAX_REJECTIONS } = require(path.join(LIB, 'hook-subagent-stop.cjs'));
const rs = require(path.join(LIB, 'run-state.cjs'));

const NOW = new Date('2026-10-18T12:00:00.000Z');
const HELPER = '/abs/neat/bin/neat.cjs';
const FIX_LINE = 'Fix the report, save it again with the helper, and reply with only the corrected report.';
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);

let tmp;
let root;
let cfgDir;
let env;

beforeEach(() => {
  tmp = makeTempDir('neat-hook-stop-');
  root = path.join(tmp, 'proj');
  cfgDir = path.join(tmp, 'cfg');
  fs.mkdirSync(root);
  fs.mkdirSync(cfgDir);
  env = { NEAT_NOW: NOW.toISOString(), CLAUDE_CONFIG_DIR: cfgDir };
});

afterEach(() => removeDir(tmp));

function report({ status = 'done', findings = '- a.js:1 - note', artifacts = '- none' } = {}) {
  return [
    '## Status', status,
    '## Findings', findings,
    '## Decisions', '- none',
    '## Open questions', '- none',
    '## Artifacts', artifacts,
    '',
  ].join('\n');
}

function newRun(task = 'add a hello function', { at = hoursAgo(1), stage = 'explore' } = {}) {
  const state = rs.createRun(root, { task, mode: 'gate' }, at);
  return rs.saveRun(root, rs.setStage(state, stage), at);
}

let transcriptN = 0;
function transcript(content, { raw } = {}) {
  transcriptN += 1;
  const file = path.join(tmp, `agent-${transcriptN}.jsonl`);
  const first = raw !== undefined ? raw : JSON.stringify({ type: 'user', message: { role: 'user', content } });
  fs.writeFileSync(file, `${first}\n${JSON.stringify({ type: 'assistant', message: { content: 'x' } })}\n`);
  return file;
}

function briefLine(id, worker, base = root) {
  return `Brief: ${path.join(base, '.neat', 'runs', id, `brief-${worker}.md`)}`;
}

function input(message, extra = {}) {
  return {
    hook_event_name: 'SubagentStop',
    agent_type: 'neat-explorer',
    agent_id: 'a1',
    stop_hook_active: false,
    last_assistant_message: message,
    ...extra,
  };
}

function call(message, extra = {}) {
  return subagentStop(input(message, extra), env, { root, helper: HELPER });
}

function blockReason(out) {
  const data = JSON.parse(out);
  assert.deepEqual(Object.keys(data).sort(), ['decision', 'reason']);
  assert.equal(data.decision, 'block');
  return data.reason;
}

const stateOf = (id) => rs.loadRun(root, id);

describe('who and what is checked', () => {
  test('MAX_REJECTIONS is 2', () => {
    assert.equal(MAX_REJECTIONS, 2);
  });

  test('agents outside the six workers are never checked', () => {
    newRun();
    for (const agentType of ['neat-orchestrator', 'general-purpose', undefined, 42]) {
      assert.equal(call('free text', { agent_type: agentType }), '', String(agentType));
    }
  });

  test('a missing, non-string or blank message lets the worker stop', () => {
    newRun();
    for (const message of [undefined, null, 7, '', '   \n\t']) {
      assert.equal(call(message), '', String(message));
    }
  });

  test('every worker agent type is checked', () => {
    newRun();
    for (const agentType of ['neat-explorer', 'neat-researcher', 'neat-implementer', 'neat-reviewer', 'neat-tester', 'neat-docs']) {
      assert.ok(call('free text', { agent_type: agentType, agent_id: agentType }).startsWith('{'), agentType);
    }
  });
});

describe('locateRun', () => {
  test('finds run and worker from a string Brief line in the transcript', () => {
    const { id } = newRun();
    const file = transcript(briefLine(id, 'explorer'));
    assert.deepEqual(locateRun({ agent_transcript_path: file }, env, root), { id, worker: 'explorer' });
  });

  test('finds run and worker from text parts', () => {
    const { id } = newRun();
    const file = transcript([{ type: 'text', text: briefLine(id, 'implementer-T2') }]);
    assert.deepEqual(locateRun({ agent_transcript_path: file }, env, root), { id, worker: 'implementer-T2' });
  });

  test('falls back to the newest active run with an unknown worker', () => {
    newRun('older', { at: hoursAgo(5) });
    const newest = newRun('newest', { at: hoursAgo(1) });
    const { id } = newest;
    const other = makeTempDir('neat-other-');
    try {
      const cases = [
        transcript(briefLine(id, 'explorer', other)),
        transcript(briefLine('bad id', 'explorer')),
        transcript(briefLine(id, 'boss')),
        transcript(briefLine('20261018-110000-missing-run', 'explorer')),
        transcript(null, { raw: 'not json' }),
        transcript(null, { raw: `{"type":"user","message":{"content":"${'x'.repeat(70 * 1024)}"}}` }),
        transcript('Run the bash command: echo hi'),
        path.join(tmp, 'no-such.jsonl'),
        'relative/agent.jsonl',
        tmp,
        undefined,
      ];
      for (const file of cases) {
        assert.deepEqual(locateRun({ agent_transcript_path: file }, env, root), { id, worker: null }, String(file));
      }
    } finally {
      removeDir(other);
    }
  });

  test('a Brief line naming a finished run still identifies it', () => {
    const run = newRun();
    rs.saveRun(root, rs.setStage(run, 'done'), hoursAgo(1));
    const file = transcript(briefLine(run.id, 'tester'));
    assert.deepEqual(locateRun({ agent_transcript_path: file }, env, root), { id: run.id, worker: 'tester' });
  });

  test('no active run and no Brief line gives null', () => {
    assert.equal(locateRun({}, env, root), null);
    const old = newRun('stale', { at: hoursAgo(30) });
    assert.equal(locateRun({}, env, root), null);
    assert.ok(old.id);
  });
});

describe('the report check', () => {
  test('no run located lets the worker stop', () => {
    assert.equal(call('free text'), '');
  });

  test('a valid report lets the worker stop, artifacts resolved in the run dir', () => {
    const { id } = newRun();
    fs.writeFileSync(path.join(rs.runDir(root, id), 'explore-map.md'), 'a.js:1 - x\n');
    assert.equal(call(report()), '');
    assert.equal(call(report({ artifacts: '- explore-map.md' })), '');
    assert.equal(stateOf(id).reportGuard, undefined, 'nothing written for a valid report');
  });

  test('a missing Status heading blocks with the checker errors and the fix line', () => {
    newRun();
    const reason = blockReason(call(report().replace('## Status\ndone\n', '')));
    const lines = reason.split('\n');
    assert.ok(lines.length <= 6, reason);
    assert.equal(lines[0], 'missing heading: ## Status');
    assert.equal(lines[lines.length - 1], FIX_LINE);
  });

  test('a 301-word report blocks naming the word count', () => {
    newRun();
    const base = report({ findings: '' });
    const baseWords = base.trim().split(/\s+/).length;
    const text = report({ findings: Array(301 - baseWords).fill('w').join(' ') });
    const reason = blockReason(call(text));
    assert.ok(reason.split('\n').includes('too long: 301 words (max 300)'), reason);
  });

  test('at most 5 error lines, each at most 160 characters', () => {
    newRun();
    const long = `## ${'Z'.repeat(400)}`;
    const text = ['## A', '## B', '## C', long, 'free text'].join('\n');
    const lines = blockReason(call(text)).split('\n');
    assert.equal(lines.length, 6);
    assert.ok(lines.slice(0, 5).every((l) => l.length <= 160), lines.join('\n'));
    assert.equal(lines[5], FIX_LINE);
  });

  test('a missing artifact blocks', () => {
    const { id } = newRun();
    const reason = blockReason(call(report({ artifacts: '- gone.md' })));
    assert.ok(reason.includes(`artifact not found: ${path.join(rs.runDir(root, id), 'gone.md')}`), reason);
  });
});

describe('retry cap and warnings', () => {
  test('two blocks per agent, then the stop is allowed and a warning recorded', () => {
    const { id } = newRun();
    const file = transcript(briefLine(id, 'explorer'));
    const bad = 'free text';
    const extra = { agent_transcript_path: file };
    assert.ok(blockReason(call(bad, extra)));
    assert.ok(blockReason(call(bad, extra)));
    assert.equal(call(bad, extra), '');
    const state = stateOf(id);
    assert.deepEqual(state.reportGuard, { a1: 3 });
    assert.deepEqual(state.warnings, ['report guard: explorer stopped with an invalid report after 2 rejections']);
    assert.equal(call(bad, extra), '', 'a later invalid stop is allowed too');
    assert.equal(stateOf(id).warnings.length, 1, 'the warning is recorded once');
  });

  test('the counter is per agent id', () => {
    const { id } = newRun();
    assert.ok(blockReason(call('x', { agent_id: 'a1' })));
    assert.ok(blockReason(call('x', { agent_id: 'a1' })));
    assert.ok(blockReason(call('x', { agent_id: 'b2' })), 'another agent starts at 0');
    assert.deepEqual(stateOf(id).reportGuard, { a1: 2, b2: 1 });
  });

  test('an unknown worker is named by its agent type in the warning', () => {
    const { id } = newRun();
    for (let i = 0; i < 3; i += 1) call('x', { agent_type: 'neat-tester', agent_id: 'zz' });
    assert.deepEqual(stateOf(id).warnings, ['report guard: neat-tester stopped with an invalid report after 2 rejections']);
  });

  test('an agent id with odd characters falls back to the worker or agent type as key', () => {
    const { id } = newRun();
    call('x', { agent_id: 'a b/../c' });
    assert.deepEqual(stateOf(id).reportGuard, { 'neat-explorer': 1 });
  });

  test('warnings keep at most 20 entries', () => {
    const run = newRun();
    const old = Array.from({ length: 20 }, (_, i) => `old warning ${i}`);
    rs.saveRun(root, { ...stateOf(run.id), warnings: old }, hoursAgo(1));
    for (let i = 0; i < 3; i += 1) call('x');
    const { warnings } = stateOf(run.id);
    assert.equal(warnings.length, 20);
    assert.equal(warnings[19], 'report guard: neat-explorer stopped with an invalid report after 2 rejections');
    assert.equal(warnings[0], 'old warning 1');
  });
});

describe('handback delivery', () => {
  test('a short plain message is fine when the saved report file passes', () => {
    const { id } = newRun();
    const file = transcript(briefLine(id, 'explorer'));
    const extra = { agent_transcript_path: file };
    assert.ok(blockReason(call('Report delivered.', extra)), 'no report file yet');
    fs.writeFileSync(path.join(rs.runDir(root, id), 'report-explorer.md'), report());
    assert.equal(call('Report delivered.', extra), '');
  });

  test('a message with a heading line is checked as the report itself', () => {
    const { id } = newRun();
    fs.writeFileSync(path.join(rs.runDir(root, id), 'report-explorer.md'), report());
    const file = transcript(briefLine(id, 'explorer'));
    assert.ok(blockReason(call('## Status\ndone', { agent_transcript_path: file })));
  });

  test('an invalid saved report does not excuse a plain message', () => {
    const { id } = newRun();
    fs.writeFileSync(path.join(rs.runDir(root, id), 'report-explorer.md'), 'nothing here');
    const file = transcript(briefLine(id, 'explorer'));
    assert.ok(blockReason(call('Report delivered.', { agent_transcript_path: file })));
  });
});

describe('own errors never block', () => {
  test('a run dir the lock cannot be created in lets the worker stop', { skip: process.getuid && process.getuid() === 0 }, () => {
    const { id } = newRun();
    const dir = rs.runDir(root, id);
    fs.chmodSync(dir, 0o500);
    try {
      assert.equal(call('free text'), '');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  test('a missing root or a broken state lets the worker stop', () => {
    assert.equal(subagentStop(input('free text'), env, { root: null, helper: HELPER }), '');
    const { id } = newRun();
    const file = transcript(briefLine(id, 'explorer'));
    fs.writeFileSync(path.join(rs.runDir(root, id), 'state.json'), '{ broken');
    assert.equal(call('free text', { agent_transcript_path: file }), '');
  });
});
