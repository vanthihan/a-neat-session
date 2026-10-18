'use strict';

// Structural contract for the shipped worker agents (payload/agents/*.md):
// locked model/tool matrix, exact frontmatter keys and the shared report and
// safety contract every worker prompt must state.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, runNode } = require('../support/helpers.cjs');

const AGENTS_DIR = path.join(REPO_ROOT, 'payload', 'agents');
const FRONTMATTER_KEYS = ['name', 'description', 'tools', 'model', 'maxTurns'];
const REPORT_HEADINGS = ['## Status', '## Findings', '## Decisions', '## Open questions', '## Artifacts'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const MAX_DESCRIPTION = 200;

// Every worker declares `model: inherit`: the orchestrator passes the routed
// model per call, and an omitted model (inherit profile) falls back to the
// session model instead of a fixed tier.
const MATRIX = Object.freeze({
  'neat-explorer': { model: 'inherit', tools: 'Read, Grep, Glob, Bash', maxTurns: '30', readOnly: true },
  'neat-researcher': { model: 'inherit', tools: 'WebSearch, WebFetch, Read, Grep, Glob, Write', maxTurns: '30', readOnly: false },
  'neat-implementer': { model: 'inherit', tools: 'Read, Edit, Write, Bash, Grep, Glob', maxTurns: '60', readOnly: false },
  'neat-reviewer': { model: 'inherit', tools: 'Read, Grep, Glob, Bash', maxTurns: '30', readOnly: true },
  'neat-tester': { model: 'inherit', tools: 'Read, Bash', maxTurns: '30', readOnly: true },
  'neat-docs': { model: 'inherit', tools: 'Read, Edit, Write, Grep, Glob', maxTurns: '30', readOnly: false },
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

const ORCHESTRATOR = 'neat-orchestrator';

test('payload/agents holds exactly the six workers and the session orchestrator', () => {
  const files = fs.readdirSync(AGENTS_DIR).sort();
  assert.deepEqual(files, [...Object.keys(MATRIX), ORCHESTRATOR].map((n) => `${n}.md`).sort());
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

function contractOf(body) {
  const m = body.match(/## Contract\n([\s\S]*?)\n## /);
  assert.ok(m, 'missing ## Contract section');
  return m[1];
}

test('every worker shares the same Contract section', () => {
  const contracts = Object.keys(MATRIX).map((n) => contractOf(parseAgent(load(n)).body));
  for (const c of contracts) assert.equal(c, contracts[0]);
});

describe('neat-researcher', () => {
  const { fields, body } = parseAgent(load('neat-researcher'));
  const role = body.slice(body.indexOf('## Role'));

  test('has no shell and no edit tools', () => {
    const tools = toolList(fields);
    for (const t of ['Bash', 'Edit', 'NotebookEdit']) assert.ok(!tools.includes(t), t);
  });

  test('role covers notes, untrusted web content, the search cap and missing web tools', () => {
    assert.match(role, /no shell/);
    assert.match(role, /Grep and Glob tools/);
    assert.match(role, /Write tool/);
    assert.match(role, /run dir/);
    assert.match(role, /untrusted/);
    assert.match(role, /at most 8 web searches/);
    assert.match(role, /`Notes:`/);
    assert.match(role, /source URL/);
    assert.match(role, /`source - finding`/);
    assert.match(role, /`partial`/);
    assert.match(role, /`blocked`/);
  });

  test('role forbids writes outside the run dir and names what the guard checks', () => {
    assert.match(role, /Never write outside the run dir/);
    assert.match(role, /Git hooks and config, permission settings/);
  });
});

test('explorer lists questions the repository cannot answer as research: open questions', () => {
  const { body } = parseAgent(load('neat-explorer'));
  assert.match(body, /`## Open questions`/);
  assert.match(body, /`research: \.\.\.`/);
});

describe('neat-reviewer file names', () => {
  const { body } = parseAgent(load('neat-reviewer'));

  test('review file and report names come from the brief, never fixed names', () => {
    assert.ok(!/review\.md|report-reviewer\.md/.test(body), 'no hardcoded review or report file name');
    const review = body.slice(body.indexOf('## Review file'), body.indexOf('## Report'));
    const report = body.slice(body.indexOf('## Report'));
    assert.match(review, /`Review file:`/);
    assert.match(review, /write \{run id\}/);
    assert.match(review, /`path:line - high\|medium\|low - issue`/);
    assert.match(report, /`Report:`/);
    assert.match(report, /`report ok`/);
  });
});

// Splits a frontmatter tools line on top-level commas, so `Agent(a, b)` stays one entry.
function splitTools(line) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of line) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');

// Subcommand word sequences listed by `neat help` (`neat run new [...]` -> `run new`).
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

const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const ORCHESTRATOR_KEYS = ['name', 'description', 'tools', 'model'];
const ORCHESTRATOR_TOOLS = [
  'Bash',
  `Agent(${Object.keys(MATRIX).join(', ')})`,
  'AskUserQuestion',
  'SendMessage',
];
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
const MAX_ORCHESTRATOR_WORDS = 400;

describe(ORCHESTRATOR, () => {
  const text = load(ORCHESTRATOR);
  const { keys, fields, body } = parseAgent(text);

  test('frontmatter keys are exactly name, description, tools, model', () => {
    assert.deepEqual(keys, ORCHESTRATOR_KEYS);
    assert.equal(fields.name, ORCHESTRATOR);
    assert.equal(fields.model, 'inherit');
  });

  test('description is short, names the installer flag and says it is never a worker', () => {
    assert.ok(fields.description.length <= MAX_DESCRIPTION, `${fields.description.length} chars`);
    assert.ok(fields.description.includes('--orchestrator-default'));
    assert.match(fields.description, /main.session/i);
    assert.match(fields.description, /never .*worker/i);
  });

  test('tools are Bash, Agent limited to the six workers, AskUserQuestion and SendMessage', () => {
    const tools = splitTools(fields.tools);
    assert.deepEqual(tools, ORCHESTRATOR_TOOLS);
    const allow = tools[1].slice('Agent('.length, -1).split(',').map((t) => t.trim());
    assert.deepEqual(allow, Object.keys(MATRIX));
    assert.ok(!allow.includes(ORCHESTRATOR));
    for (const t of FILE_TOOLS) assert.ok(!tools.includes(t), t);
  });

  test('body runs the helper procedure and covers resume, untrusted reports and slash commands', () => {
    assert.ok(body.includes('node {{NEAT_BIN}} procedure'));
    assert.ok(body.includes('/neat:resume'));
    assert.match(body, /untrusted/);
    assert.match(body, /slash commands/i);
    assert.match(body, /task text/);
    assert.match(body, /[Nn]ever read, search or edit repository files/);
    assert.match(body, /never run git/);
  });

  test('every helper call names a subcommand from neat help', () => {
    const known = helpSubcommands();
    const calls = [...body.matchAll(/node \{\{NEAT_BIN\}\}( [^`\n]*)?/g)].map((m) => (m[1] || '').trim());
    assert.ok(calls.length >= 1);
    for (const call of calls) {
      const words = call.split(/\s+/);
      assert.ok(known.some((sub) => sub.split(' ').every((w, i) => words[i] === w)), `unknown helper call: ${call}`);
    }
  });

  test('body is at most 400 words and takes no $ARGUMENTS', () => {
    assert.ok(countWords(body) <= MAX_ORCHESTRATOR_WORDS, `${countWords(body)} words`);
    assert.ok(!text.includes('$ARGUMENTS'));
  });
});
