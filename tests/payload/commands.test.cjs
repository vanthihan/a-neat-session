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
const GUIDES_DIR = path.join(REPO_ROOT, 'payload', 'neat', 'guides');
const HELPER = path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs');
const MAX_GUIDE_WORDS = 300;
const CODEX_GUIDE_MENTIONS = [
  'codex run', 'codex wait', 'codex result', 'codex cancel', 'action=pause', 'action=skip',
  'AskUserQuestion', 'report-invalid', 'background Bash command', 'untrusted',
];
const REVIEW_GUIDE_MENTIONS = [
  'run diff', 'reviewer-2', 'neat-reviewer', 'guide codex', 'review merge', '--fix', 'next=fix', 'next=ask',
  'next=stop', 'next=failed', 'unowned=', 'unparsed=', 'AskUserQuestion', 'untrusted', 'run commit',
];
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
  'must not contain a line NEAT_EOF', 'skipped', 'guide codex', 'target=codex', 'guide review', 'reviewer-2',
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

// Asserts that every `node {{NEAT_BIN}} ...` call in `text` names a subcommand
// listed by `neat help`; returns the number of calls.
function assertKnownHelperCalls(text, known) {
  const calls = [...text.matchAll(BIN_CALL)].map((m) => (m[1] || '').trim());
  for (const call of calls) {
    const words = call.split(/\s+/);
    const ok = known.some((sub) => sub.split(' ').every((w, i) => words[i] === w));
    assert.ok(ok, `unknown helper call: node {{NEAT_BIN}} ${call}`);
  }
  return calls.length;
}

function guideFiles() {
  return fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md')).sort();
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
    assertArgumentsHeredoc(lines, "run new --stdin <<'NEAT_EOF'");
  });

  test('H2 sections are exactly the fourteen sections, in order', () => {
    assert.deepEqual(lines.filter((l) => l.startsWith('## ')), DO_SECTIONS);
  });

  test('every helper call names a subcommand listed by neat help', () => {
    const count = assertKnownHelperCalls(body, helpSubcommands());
    assert.ok(count >= 10, `only ${count} helper calls`);
  });

  test('mentions every worker, the path-only prompt, the gates and the helper safety commands', () => {
    for (const word of DO_MENTIONS) assert.ok(text.includes(word), `missing ${word}`);
  });

  test('never runs git directly and never passes the removed background parameter', () => {
    assert.deepEqual(lines.filter((l) => /^\s*(?:\d+\.\s+|[-*]\s+)?`?git /.test(l)), []);
    assert.ok(!text.includes('run_in_background'));
  });

  test('guard note lines are kept in the Worker loop and shown in Finish', () => {
    const guardStep = lines.find((l) => l.startsWith('5. Guard:'));
    assert.ok(guardStep && guardStep.includes('Keep every `note:` line for Finish'), guardStep);
    const finish = body.slice(body.indexOf('## Finish'));
    assert.match(finish, /^- the guard `note:` lines/m);
  });

  test('the Review section starts the stage and follows the review guide', () => {
    const review = body.slice(body.indexOf('## Review'), body.indexOf('## Test'));
    assert.ok(review.includes('node {{NEAT_BIN}} run stage {id} review'), review);
    assert.ok(review.includes('node {{NEAT_BIN}} guide review'), review);
    assert.ok(!/do not start extra fix work/i.test(body));
  });

  test('Launch maps reviewer-2 to neat-reviewer and Finish shows merged review findings', () => {
    const launch = lines.find((l) => l.startsWith('2. Launch:'));
    assert.match(launch, /`neat-reviewer` for `reviewer-2`/);
    for (const agent of ['neat-implementer', 'neat-docs', 'neat-explorer', 'neat-researcher', 'neat-reviewer', 'neat-tester']) {
      assert.ok(launch.includes(agent), `${agent} missing from Launch`);
    }
    const finish = body.slice(body.indexOf('## Finish'));
    assert.match(finish, /^- up to 3 merged review findings/m);
  });

  test('Launch checks every route line, so workers briefed before the loop still reach the codex guide', () => {
    const launch = lines.find((l) => l.startsWith('2. Launch:'));
    for (const word of ['target=codex', 'action=', 'guide codex', 'before this loop']) {
      assert.ok(launch.includes(word), `${word} missing from Launch`);
    }
    assert.ok(launch.indexOf('guide codex') < launch.indexOf('Agent tool'), 'the route check comes before any launch');
  });

  test(`body is at most ${MAX_BODY_WORDS} words`, () => {
    const words = countWords(body);
    assert.ok(words <= MAX_BODY_WORDS, `${words} words`);
  });
});

// Asserts that $ARGUMENTS appears once, alone on its line, inside a quoted
// heredoc whose opening line ends with `opener`, and never on a `!` line.
function assertArgumentsHeredoc(lines, opener) {
  const at = lines.reduce((acc, line, i) => (line.includes('$ARGUMENTS') ? [...acc, i] : acc), []);
  assert.equal(at.length, 1, `found $ARGUMENTS on ${at.length} lines`);
  const i = at[0];
  assert.equal(lines[i], '$ARGUMENTS');
  assert.ok(lines[i - 1].endsWith(opener), lines[i - 1]);
  assert.equal(lines[i + 1], 'NEAT_EOF');
  assert.deepEqual(lines.filter((l) => l.startsWith('!') && l.includes('$ARGUMENTS')), []);
}

const JOB_COMMANDS = [
  { file: 'result.md', verb: 'result', hint: '"[job-id]"' },
  { file: 'cancel.md', verb: 'cancel', hint: '"<job-id>"' },
];

for (const { file, verb, hint } of JOB_COMMANDS) {
  describe(file, () => {
    const text = load(file);
    const { keys, fields, body } = parseCommand(text);
    const lines = text.split(/\r?\n/);

    test('frontmatter keys are exactly description, argument-hint, allowed-tools, disable-model-invocation', () => {
      assert.deepEqual(keys, ['description', 'argument-hint', 'allowed-tools', 'disable-model-invocation']);
    });

    test('names Codex jobs, is user-invoked only and may only run the helper', () => {
      assert.ok(fields.description.length > 0 && fields.description.length <= MAX_DESCRIPTION);
      assert.match(fields.description, /Codex job/);
      assert.equal(fields['argument-hint'], hint);
      assert.equal(fields['allowed-tools'], 'Bash(node {{NEAT_BIN}} *)');
      assert.equal(fields['disable-model-invocation'], 'true');
    });

    test(`the argument reaches codex ${verb} only through the quoted heredoc`, () => {
      assertArgumentsHeredoc(lines, `node {{NEAT_BIN}} codex ${verb} --stdin <<'NEAT_EOF'`);
      assert.deepEqual(lines.filter((l) => l.startsWith('!')), []);
    });

    test('every helper call names a subcommand listed by neat help', () => {
      assert.ok(assertKnownHelperCalls(body, helpSubcommands()) >= 1);
    });

    test('prints the helper output verbatim and runs nothing else', () => {
      assert.match(body, /verbatim/);
      assert.match(body, /Do not read any files or run other commands/);
      assert.ok(body.includes('NEAT_EOF'));
    });
  });
}

const MAX_RESUME_WORDS = 150;

describe('resume.md', () => {
  const text = load('resume.md');
  const { keys, fields, body } = parseCommand(text);
  const lines = text.split(/\r?\n/);

  test('frontmatter keys are exactly description, argument-hint, allowed-tools, disable-model-invocation', () => {
    assert.deepEqual(keys, ['description', 'argument-hint', 'allowed-tools', 'disable-model-invocation']);
  });

  test('takes an optional run id, is user-invoked only and may run the orchestrator tools', () => {
    assert.ok(fields.description.length > 0 && fields.description.length <= MAX_DESCRIPTION);
    assert.equal(fields['argument-hint'], '"[run-id]"');
    assert.equal(fields['allowed-tools'], 'Bash(node {{NEAT_BIN}} *), Agent, AskUserQuestion, SendMessage');
    assert.equal(fields['disable-model-invocation'], 'true');
  });

  test('$ARGUMENTS appears once, inside the quoted run resume heredoc', () => {
    assertArgumentsHeredoc(lines, "node {{NEAT_BIN}} run resume --stdin <<'NEAT_EOF'");
    assert.ok(body.includes('run id must not contain a line NEAT_EOF'));
  });

  test('loads the procedure, skips Start and continues at the next section', () => {
    assert.ok(body.includes('node {{NEAT_BIN}} procedure'), body);
    for (const word of ['skip Start', '`next:`', '`run=`', 'untrusted']) assert.ok(body.includes(word), `missing ${word}`);
  });

  test('every helper call names a subcommand listed by neat help', () => {
    assert.ok(assertKnownHelperCalls(body, helpSubcommands()) >= 2);
  });

  test(`body is at most ${MAX_RESUME_WORDS} words`, () => {
    assert.ok(countWords(body) <= MAX_RESUME_WORDS, `${countWords(body)} words`);
  });
});

describe('guides', () => {
  test('the codex and review guides ship', () => {
    assert.ok(guideFiles().includes('codex.md'), guideFiles().join(', '));
    assert.ok(guideFiles().includes('review.md'), guideFiles().join(', '));
  });

  test('the review guide covers both reviewers, merge, the bounded fix loop and its stops', () => {
    const text = fs.readFileSync(path.join(GUIDES_DIR, 'review.md'), 'utf8');
    for (const word of REVIEW_GUIDE_MENTIONS) assert.ok(text.includes(word), `missing ${word}`);
  });

  test('neat guide review prints the guide with the absolute helper path', () => {
    const res = runNode([HELPER, 'guide', 'review']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes('{{NEAT_BIN}}'));
    assert.ok(res.stdout.includes(`node ${HELPER} review merge`), res.stdout);
    assert.ok(countWords(res.stdout) <= MAX_GUIDE_WORDS, `${countWords(res.stdout)} words`);
  });

  test('every helper call in a guide names a subcommand listed by neat help', () => {
    const known = helpSubcommands();
    for (const file of guideFiles()) {
      const count = assertKnownHelperCalls(fs.readFileSync(path.join(GUIDES_DIR, file), 'utf8'), known);
      assert.ok(count >= 1, `${file} has no helper call`);
    }
  });

  test(`each guide is at most ${MAX_GUIDE_WORDS} words, without $ARGUMENTS or the background parameter`, () => {
    for (const file of guideFiles()) {
      const text = fs.readFileSync(path.join(GUIDES_DIR, file), 'utf8');
      assert.ok(countWords(text) <= MAX_GUIDE_WORDS, `${file}: ${countWords(text)} words`);
      assert.ok(!text.includes('$ARGUMENTS'), `${file} names $ARGUMENTS`);
      assert.ok(!text.includes('run_in_background'), `${file} names the background parameter`);
    }
  });

  test('the codex guide covers launch, background wait, result, cancel, pause and skip', () => {
    const text = fs.readFileSync(path.join(GUIDES_DIR, 'codex.md'), 'utf8');
    for (const word of CODEX_GUIDE_MENTIONS) assert.ok(text.includes(word), `missing ${word}`);
  });

  test('neat guide codex prints the guide with the absolute helper path', () => {
    const res = runNode([HELPER, 'guide', 'codex']);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes('{{NEAT_BIN}}'));
    assert.ok(res.stdout.includes(`node ${HELPER} codex wait`), res.stdout);
  });

  for (const args of [['nope'], ['../x'], [], ['codex', 'extra']]) {
    test(`neat guide ${args.join(' ') || '(no topic)'} exits 2 and lists the topics`, () => {
      const res = runNode([HELPER, 'guide', ...args]);
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stderr, /topics: .*codex/);
      assert.equal(res.stdout, '');
    });
  }
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
    const posix = mdFiles.map((f) => f.split(path.sep).join('/'));
    for (const guideFile of ['neat/guides/codex.md', 'neat/guides/review.md']) {
      assert.ok(posix.includes(guideFile), mdFiles.join(', '));
    }
  });

  test('installed result and cancel commands name the installed helper', () => {
    const installed = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    for (const { file, verb } of JOB_COMMANDS) {
      const text = fs.readFileSync(path.join(proj, '.claude', 'commands', 'neat', file), 'utf8');
      assert.ok(text.includes(`node ${installed} codex ${verb} --stdin <<'NEAT_EOF'`), text);
      assert.ok(text.includes(`Bash(node ${installed} *)`), text);
      assert.ok(!text.includes('{{NEAT_BIN}}'));
    }
  });

  test('installed resume command names the installed helper', () => {
    const installed = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    const text = fs.readFileSync(path.join(proj, '.claude', 'commands', 'neat', 'resume.md'), 'utf8');
    assert.ok(text.includes(`node ${installed} run resume --stdin <<'NEAT_EOF'`), text);
    assert.ok(text.includes(`node ${installed} procedure`), text);
    assert.ok(!text.includes('{{NEAT_BIN}}'));
  });

  test('the installed helper prints the guide with its own path', () => {
    const installed = path.join(proj, '.claude', 'neat', 'bin', 'neat.cjs');
    const res = runNode([installed, 'guide', 'codex'], { cwd: proj, env: childEnv({ NEAT_PROJECT_DIR: proj }) });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes(`node ${installed} codex run`), res.stdout);
    assert.ok(!res.stdout.includes('{{NEAT_BIN}}'));
  });
});
