'use strict';

// Structural contract for the shipped slash commands (payload/commands/neat/*.md):
// frontmatter keys, the raw-task heredoc, the orchestrator's section order,
// helper subcommands cross-checked against `neat help`, and install rendering.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, childEnv, runNode, makeTempDir, removeDir } = require('../support/helpers.cjs');

const COMMANDS_DIR = path.join(REPO_ROOT, 'payload', 'commands', 'neat');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const MAX_DESCRIPTION = 200;
const MAX_BODY_WORDS = 1500;
const DO_SECTIONS = [
  '## Rules', '## Worker loop', '## Start', '## Explore', '## Classify', '## Research', '## Plan', '## Approve',
  '## Implement', '## Review', '## Test', '## Docs', '## Commit', '## Finish',
];
const DO_MENTIONS = [
  'neat-explorer', 'neat-researcher', 'neat-implementer', 'neat-reviewer', 'neat-tester', 'neat-docs',
  'propose=yes', '--research', 'Brief: ', 'subagent_type', 'AskUserQuestion', 'SendMessage', 'untrusted',
  'run commit', 'plan check', 'run guard', 'run classify', 'gate', 'auto', 'step',
  'must not contain a line NEAT_EOF', 'skipped',
];
const BIN_CALL = /node \{\{NEAT_BIN\}\}( [^`\n]*)?/g;

// Tiny flat frontmatter parser: lines between the first two `---` lines, `key: value`.
function parseCommand(text) {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---', 'file must start with ---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter must be closed by ---');
  const keys = [];
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    assert.ok(m, `bad frontmatter line: ${line}`);
    keys.push(m[1]);
    fields[m[1]] = m[2].trim();
  }
  return { keys, fields, body: lines.slice(end + 1).join('\n') };
}

function load(name) {
  return fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8');
}

// Subcommands from `neat help`: the words after `neat` up to the first `[` or `<` token.
function helpSubcommands() {
  const res = runNode([HELPER, 'help']);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split('\n')
    .filter((line) => line.startsWith('neat '))
    .map((line) => {
      const words = [];
      for (const word of line.split(/\s+/).slice(1)) {
        if (word.startsWith('[') || word.startsWith('<')) break;
        words.push(word);
      }
      return words.join(' ');
    });
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

describe('status.md', () => {
  const { keys, fields } = parseCommand(load('status.md'));

  test('frontmatter keys are exactly description, allowed-tools, disable-model-invocation', () => {
    assert.deepEqual(keys, ['description', 'allowed-tools', 'disable-model-invocation']);
  });

  test('short description and model invocation disabled', () => {
    assert.ok(fields.description.length > 0 && fields.description.length <= MAX_DESCRIPTION);
    assert.equal(fields['disable-model-invocation'], 'true');
  });
});

describe('do.md', () => {
  const text = load('do.md');
  const { keys, fields, body } = parseCommand(text);
  const lines = text.split(/\r?\n/);

  test('frontmatter keys are exactly description, argument-hint, allowed-tools, disable-model-invocation', () => {
    assert.deepEqual(keys, ['description', 'argument-hint', 'allowed-tools', 'disable-model-invocation']);
  });

  test('short description and model invocation disabled', () => {
    assert.ok(fields.description.length > 0 && fields.description.length <= MAX_DESCRIPTION);
    assert.equal(fields['disable-model-invocation'], 'true');
  });

  test('allowed-tools grants the helper, Agent, AskUserQuestion and SendMessage', () => {
    for (const tool of ['Bash(node {{NEAT_BIN}} *)', 'Agent', 'AskUserQuestion', 'SendMessage']) {
      assert.ok(fields['allowed-tools'].includes(tool), `missing ${tool}`);
    }
  });

  test('$ARGUMENTS appears once, inside the quoted run new heredoc', () => {
    const at = lines.reduce((acc, line, i) => (line.includes('$ARGUMENTS') ? [...acc, i] : acc), []);
    assert.equal(at.length, 1, `found $ARGUMENTS on ${at.length} lines`);
    const i = at[0];
    assert.equal(lines[i], '$ARGUMENTS');
    assert.ok(lines[i - 1].endsWith("run new --stdin <<'NEAT_EOF'"), lines[i - 1]);
    assert.equal(lines[i + 1], 'NEAT_EOF');
    assert.deepEqual(lines.filter((l) => l.startsWith('!') && l.includes('$ARGUMENTS')), []);
  });

  test('H2 sections are exactly the fourteen sections, in order', () => {
    assert.deepEqual(lines.filter((l) => l.startsWith('## ')), DO_SECTIONS);
  });

  test('every helper call names a subcommand listed by neat help', () => {
    const known = helpSubcommands();
    const calls = [...body.matchAll(BIN_CALL)].map((m) => (m[1] || '').trim());
    assert.ok(calls.length >= 10, `only ${calls.length} helper calls`);
    for (const call of calls) {
      const words = call.split(/\s+/);
      const ok = known.some((sub) => {
        const subWords = sub.split(' ');
        return subWords.every((w, i) => words[i] === w);
      });
      assert.ok(ok, `unknown helper call: node {{NEAT_BIN}} ${call}`);
    }
  });

  test('mentions every worker, the path-only prompt, the gates and the helper safety commands', () => {
    for (const word of DO_MENTIONS) assert.ok(text.includes(word), `missing ${word}`);
  });

  test('never runs git directly and never passes the removed background parameter', () => {
    assert.deepEqual(lines.filter((l) => /^\s*(?:\d+\.\s+|[-*]\s+)?`?git /.test(l)), []);
    assert.ok(!text.includes('run_in_background'));
  });

  test(`body is at most ${MAX_BODY_WORDS} words`, () => {
    const words = countWords(body);
    assert.ok(words <= MAX_BODY_WORDS, `${words} words`);
  });
});

describe('local install renders every command and agent', () => {
  let proj;

  before(() => {
    proj = makeTempDir('neat-cmds-');
  });

  after(() => removeDir(proj));

  test('no installed .md file keeps the {{NEAT_BIN}} placeholder', () => {
    const env = childEnv({ NEAT_PROJECT_DIR: proj });
    const res = runNode([path.join(REPO_ROOT, 'bin', 'install.cjs'), '--local'], { cwd: proj, env });
    assert.equal(res.status, 0, res.stderr);
    const root = path.join(proj, '.claude');
    const mdFiles = fs.readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 7, `only ${mdFiles.length} .md files installed`);
    const left = mdFiles.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('{{NEAT_BIN}}'));
    assert.deepEqual(left, []);
  });
});
