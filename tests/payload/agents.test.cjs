'use strict';

// Structural contract for the shipped worker agents (payload/agents/*.md):
// locked model/tool matrix, exact frontmatter keys and the shared report and
// safety contract every worker prompt must state.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../support/helpers.cjs');

const AGENTS_DIR = path.join(REPO_ROOT, 'payload', 'agents');
const FRONTMATTER_KEYS = ['name', 'description', 'tools', 'model', 'maxTurns'];
const REPORT_HEADINGS = ['## Status', '## Findings', '## Decisions', '## Open questions', '## Artifacts'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const MAX_DESCRIPTION = 200;

const MATRIX = Object.freeze({
  'neat-explorer': { model: 'haiku', tools: 'Read, Grep, Glob, Bash', maxTurns: '30', readOnly: true },
  'neat-implementer': { model: 'sonnet', tools: 'Read, Edit, Write, Bash, Grep, Glob', maxTurns: '60', readOnly: false },
  'neat-reviewer': { model: 'sonnet', tools: 'Read, Grep, Glob, Bash', maxTurns: '30', readOnly: true },
  'neat-tester': { model: 'sonnet', tools: 'Read, Bash', maxTurns: '30', readOnly: true },
  'neat-docs': { model: 'haiku', tools: 'Read, Edit, Write, Grep, Glob', maxTurns: '30', readOnly: false },
});

// Tiny flat frontmatter parser: lines between the first two `---` lines, `key: value`.
function parseAgent(text) {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], '---', 'file must start with ---');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter must be closed by ---');
  const keys = [];
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z]+):\s*(.*)$/);
    assert.ok(m, `bad frontmatter line: ${line}`);
    keys.push(m[1]);
    fields[m[1]] = m[2].trim();
  }
  return { keys, fields, body: lines.slice(end + 1).join('\n') };
}

function load(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

function toolList(fields) {
  return fields.tools.split(',').map((t) => t.trim());
}

test('payload/agents holds exactly the five workers', () => {
  const files = fs.readdirSync(AGENTS_DIR).sort();
  assert.deepEqual(files, Object.keys(MATRIX).map((n) => `${n}.md`).sort());
});

for (const [name, spec] of Object.entries(MATRIX)) {
  describe(name, () => {
    const text = load(name);
    const { keys, fields, body } = parseAgent(text);

    test('frontmatter keys are exactly name, description, tools, model, maxTurns', () => {
      assert.deepEqual(keys, FRONTMATTER_KEYS);
    });

    test('name equals the file stem and has no colon', () => {
      assert.equal(fields.name, name);
      assert.ok(!fields.name.includes(':'));
    });

    test('description is one short line naming /neat:do', () => {
      assert.ok(fields.description.length > 0);
      assert.ok(fields.description.length <= MAX_DESCRIPTION, `${fields.description.length} chars`);
      assert.ok(fields.description.includes('/neat:do'));
    });

    test('model, tools and maxTurns follow the locked matrix', () => {
      assert.equal(fields.model, spec.model);
      assert.equal(fields.tools, spec.tools);
      assert.equal(fields.maxTurns, spec.maxTurns);
    });

    if (spec.readOnly) {
      test('read-only role has no editing tools', () => {
        const tools = toolList(fields);
        assert.deepEqual(tools.filter((t) => WRITE_TOOLS.includes(t)), []);
      });
    }

    test('body reads its assignment from the Brief path', () => {
      assert.ok(body.includes('Brief:'));
    });

    test('body lists the five report headings in order', () => {
      let from = 0;
      for (const heading of REPORT_HEADINGS) {
        const at = body.indexOf(`\`${heading}\``, from);
        assert.ok(at >= 0, `${heading} missing or out of order`);
        from = at + heading.length;
      }
    });

    test('body states the 300-word limit and SubagentHandback delivery', () => {
      assert.ok(body.includes('300 words'));
      assert.ok(body.includes('SubagentHandback'));
    });

    test('body forbids commits and state-changing git commands', () => {
      assert.match(body, /[Nn]ever commit/);
      assert.match(body, /git commands that change state/);
    });

    test('search guidance matches the tool list', () => {
      const tools = toolList(fields);
      if (tools.includes('Bash')) {
        assert.match(body, /`grep[^`]*` and `find`[^.]*through Bash/);
      } else {
        assert.match(body, /Grep and Glob tools/);
        assert.match(body, /Write tool/);
      }
    });

    test('no install-time placeholders (helper path comes from the brief)', () => {
      assert.ok(!text.includes('{{'));
    });
  });
}
