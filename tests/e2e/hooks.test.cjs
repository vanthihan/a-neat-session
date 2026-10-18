'use strict';

// Installed-helper tracer for the context guards: the hook commands are read
// from the settings a local install wrote and spawned without a shell, the
// way Claude Code runs them. Every helper and hook call uses a fixed clock.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const INSTALLER = path.join(REPO_ROOT, 'bin', 'install.cjs');
const NOW = '2026-10-18T12:00:00.000Z';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// The hook command exactly as written in settings, run without a shell: split
// on spaces, `node` replaced by this node binary.
function runHookCommand(command, { projectDir, input, env = {} }) {
  const [node, ...args] = command.split(' ');
  assert.equal(node, 'node');
  const res = spawnSync(process.execPath, args, {
    cwd: projectDir,
    env: childEnv({ CLAUDE_PROJECT_DIR: projectDir, NEAT_NOW: NOW, ...env }),
    input,
    encoding: 'utf8',
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function report(status = 'done') {
  return ['## Status', status, '## Findings', '- a.js:1 - note', '## Decisions', '- none',
    '## Open questions', '- none', '## Artifacts', '- none', ''].join('\n');
}

describe('hooks through a local install', () => {
  let tmp;
  let proj;
  let helper;
  let settings;
  let env;
  let runId;
  let transcriptFile;

  const helperRun = (args, input) => runNode([helper, ...args], { cwd: proj, env, input });
  const commandFor = (event) => settings.hooks[event][0].hooks[0].command;

  before(() => {
    tmp = makeTempDir('neat-hooks-');
    proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    helper = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    env = childEnv({ NEAT_PROJECT_DIR: proj, NEAT_NOW: NOW });
    const res = runNode([INSTALLER, '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    settings = readJson(path.join(proj, '.claude', 'settings.local.json'));
    const created = helperRun(['run', 'new', 'add a hello function']);
    assert.equal(created.status, 0, created.stderr);
    runId = /^id=(\S+)/.exec(created.stdout)[1];
    assert.equal(helperRun(['run', 'stage', runId, 'explore']).status, 0);
    transcriptFile = path.join(tmp, 'agent-a1.jsonl');
    const brief = path.join(proj, '.neat', 'runs', runId, 'brief-explorer.md');
    fs.writeFileSync(transcriptFile, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `Brief: ${brief}` } })}\n`);
  });

  after(() => removeDir(tmp));

  describe('SubagentStop', () => {
    const stop = (message) => runHookCommand(commandFor('SubagentStop'), {
      projectDir: proj,
      input: JSON.stringify({
        hook_event_name: 'SubagentStop',
        agent_type: 'neat-explorer',
        agent_id: 'a1',
        stop_hook_active: false,
        agent_transcript_path: transcriptFile,
        last_assistant_message: message,
      }),
    });

    test('the settings entry names the six workers and the subagent-stop hook', () => {
      assert.deepEqual(settings.hooks.SubagentStop, [{
        matcher: 'neat-explorer|neat-researcher|neat-implementer|neat-reviewer|neat-tester|neat-docs',
        hooks: [{ type: 'command', command: `node ${helper} hook subagent-stop`, timeout: 30 }],
      }]);
    });

    test('a good report passes with empty output', () => {
      const res = stop(report());
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, '');
    });

    test('a bad report is blocked twice, the third stop is allowed with a warning', () => {
      for (let i = 0; i < 2; i += 1) {
        const res = stop('I looked around and everything is fine.');
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.stderr, '');
        const data = JSON.parse(res.stdout);
        assert.equal(data.decision, 'block');
        assert.match(data.reason, /^missing heading: ## Status$/m);
      }
      const third = stop('Still free text.');
      assert.equal(third.status, 0);
      assert.equal(third.stdout, '');
      assert.equal(third.stderr, '');
      const state = readJson(path.join(proj, '.neat', 'runs', runId, 'state.json'));
      assert.deepEqual(state.warnings, ['report guard: explorer stopped with an invalid report after 2 rejections']);
      assert.deepEqual(state.reportGuard, { a1: 3 });
    });
  });
});
