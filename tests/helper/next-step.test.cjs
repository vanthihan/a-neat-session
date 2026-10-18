'use strict';

// The next-step table: one case per row, from plain state objects and facts.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const LIB = path.join(REPO_ROOT, 'payload', 'neat', 'lib');
const { SECTIONS, nextStep, formatNext, runFacts, resumeLines, taskText } = require(path.join(LIB, 'next-step.cjs'));
const rs = require(path.join(LIB, 'run-state.cjs'));

const ID = '20261018-120000-add-hello';
const HELPER = '/abs/neat/bin/neat.cjs';
const PIPELINE = ['explore', 'research', 'plan', 'implement', 'review', 'test', 'docs'];

// A run of type `type` with `selected` stages; `statuses` overrides entries.
function makeState({ stage, mode = 'gate', type = 'feature', selected, statuses = {}, workers = {}, tasks = [], extra = {} }) {
  const chosen = selected || ['explore', 'plan', 'implement', 'review', 'test', 'docs'];
  const stages = PIPELINE.map((name) => ({
    name,
    status: statuses[name] || (chosen.includes(name) ? 'pending' : 'skipped'),
  }));
  return {
    id: ID,
    mode,
    stage,
    ...(type ? { type, selectedStages: chosen } : {}),
    stages,
    workers: Object.entries(workers).map(([name, status]) => ({ name, status })),
    tasks,
    commits: [],
    ...extra,
  };
}

const facts = (reports = [], runningJobs = []) => ({ reports, runningJobs, helper: HELPER });
const T = (id, worker, batch, owns = [`src/${id}.js`]) => ({ id, worker, owns, batch });

describe('nextStep', () => {
  test('SECTIONS maps every pipeline stage to its section', () => {
    assert.deepEqual(Object.keys(SECTIONS), PIPELINE);
    assert.equal(SECTIONS.implement, 'Implement');
    assert.ok(Object.isFrozen(SECTIONS));
  });

  test('created -> Explore', () => {
    const next = nextStep(makeState({ stage: 'created', type: null }), facts());
    assert.deepEqual(next, { section: 'Explore', line: `run stage ${ID} explore, then the Worker loop with W = explorer` });
  });

  test('explore, explorer done, no type -> Classify', () => {
    const state = makeState({ stage: 'explore', type: null, workers: { explorer: 'done' }, extra: { guarded: ['explore'] } });
    assert.deepEqual(nextStep(state, facts(['report-explorer.md'])), {
      section: 'Classify',
      line: `run report show ${ID} explorer, rate the task from it, run classify ${ID} <level>, then stages ${ID} --type <type>`,
    });
  });

  test('explore, explorer not done with its report -> Check step', () => {
    const state = makeState({ stage: 'explore', type: null, workers: { explorer: 'running' } });
    assert.deepEqual(nextStep(state, facts(['report-explorer.md'])), {
      section: 'Explore', line: 'Worker loop step 4 (Check) for explorer',
    });
  });

  test('explore, explorer not done and no report -> relaunch', () => {
    const state = makeState({ stage: 'explore', type: null, workers: { explorer: 'running' } });
    assert.deepEqual(nextStep(state, facts()), {
      section: 'Explore', line: 'Worker loop for explorer (write a new brief and launch it again)',
    });
  });

  test('explore finished with a type -> first selected stage after explore', () => {
    const state = makeState({ stage: 'explore', workers: { explorer: 'done' }, statuses: { explore: 'running' } });
    assert.deepEqual(nextStep(state, facts(['report-explorer.md'])), {
      section: 'Plan', line: `run stage ${ID} plan, then the Plan section`,
    });
    const research = makeState({
      stage: 'explore', workers: { explorer: 'done' }, selected: ['explore', 'research', 'plan', 'implement'],
    });
    assert.equal(nextStep(research, facts()).section, 'Research');
  });

  test('research finished -> next selected stage; not finished -> Research', () => {
    const selected = ['explore', 'research'];
    const done = makeState({
      stage: 'research', type: 'research', selected, workers: { explorer: 'done', researcher: 'done' }, extra: { guarded: ['research'] },
    });
    assert.equal(nextStep(done, facts()).section, 'Commit');
    const running = makeState({ stage: 'research', type: 'research', selected, workers: { researcher: 'running' } });
    assert.deepEqual(nextStep(running, facts()), {
      section: 'Research', line: 'Worker loop for researcher (write a new brief and launch it again)',
    });
  });

  test('plan without recorded tasks -> Plan, reading back the reports it is written from', () => {
    const state = makeState({ stage: 'plan', workers: { explorer: 'done' } });
    assert.deepEqual(nextStep(state, facts()), {
      section: 'Plan',
      line: `run report show ${ID} explorer, write plan.md from the task text and those reports, then plan check ${ID}`,
    });
    const researched = makeState({ stage: 'plan', workers: { explorer: 'done', researcher: 'done' } });
    assert.deepEqual(nextStep(researched, facts()), {
      section: 'Plan',
      line: `run report show ${ID} explorer and report show ${ID} researcher, `
        + `write plan.md from the task text and those reports, then plan check ${ID}`,
    });
  });

  test('plan with tasks: gate and step -> Approve, auto -> next selected stage', () => {
    const tasks = [T('T1', 'implementer', 1)];
    for (const mode of ['gate', 'step']) {
      assert.deepEqual(nextStep(makeState({ stage: 'plan', mode, tasks }), facts()), {
        section: 'Approve', line: `run plan show ${ID} and ask for approval again with its lines; approval is not kept on disk`,
      });
    }
    assert.deepEqual(nextStep(makeState({ stage: 'plan', mode: 'auto', tasks }), facts()), {
      section: 'Implement', line: `run stage ${ID} implement, then the Implement section`,
    });
    const docsOnly = makeState({ stage: 'plan', mode: 'auto', type: 'docs', selected: ['explore', 'plan', 'docs'], tasks });
    assert.equal(nextStep(docsOnly, facts()).section, 'Docs');
  });

  test('implement: the first batch with an unfinished worker', () => {
    const tasks = [T('T1', 'implementer', 1), T('T2', 'implementer', 1), T('T3', 'implementer', 2, ['src/T1.js'])];
    const first = makeState({ stage: 'implement', tasks });
    assert.deepEqual(nextStep(first, facts()), {
      section: 'Implement', line: 'Worker loop with W = implementer-T1 implementer-T2 and G = --tasks T1,T2',
    });
    const second = makeState({
      stage: 'implement', tasks, workers: { 'implementer-T1': 'done', 'implementer-T2': 'done' }, extra: { guarded: ['implement:T1,T2'] },
    });
    assert.deepEqual(nextStep(second, facts()), {
      section: 'Implement', line: 'Worker loop with W = implementer-T3 and G = --tasks T3',
    });
  });

  test('implement: every unfinished worker of the batch has a report -> Check step', () => {
    const tasks = [T('T1', 'implementer', 1), T('T2', 'implementer', 1)];
    const state = makeState({ stage: 'implement', tasks, workers: { 'implementer-T1': 'done', 'implementer-T2': 'running' } });
    assert.deepEqual(nextStep(state, facts(['report-implementer-T2.md'])), {
      section: 'Implement', line: 'Worker loop step 4 (Check) with W = implementer-T2 and G = --tasks T1,T2',
    });
  });

  test('implement: all batches done -> next selected stage', () => {
    const tasks = [T('T1', 'implementer', 1)];
    const state = makeState({ stage: 'implement', tasks, workers: { 'implementer-T1': 'done' }, extra: { guarded: ['implement:T1'] } });
    assert.deepEqual(nextStep(state, facts()), { section: 'Review', line: `run stage ${ID} review, then the Review section` });
  });

  test('docs works like implement with the docs batches', () => {
    const tasks = [T('T1', 'implementer', 1), T('D1', 'docs', 1), T('D2', 'docs', 1)];
    const state = makeState({ stage: 'docs', tasks, workers: { 'implementer-T1': 'done', 'docs-D1': 'done' } });
    assert.deepEqual(nextStep(state, facts()), {
      section: 'Docs', line: 'Worker loop with W = docs-D2 and G = --tasks D1,D2',
    });
    const done = makeState({ stage: 'docs', tasks, workers: { 'docs-D1': 'done', 'docs-D2': 'done' }, extra: { guarded: ['docs:D1,D2'] } });
    assert.equal(nextStep(done, facts()).section, 'Commit');
  });

  test('review: finished, merge ready, or from the start', () => {
    const finished = makeState({
      stage: 'review', workers: { reviewer: 'done', 'reviewer-2': 'done' }, extra: { review: { fixTasks: [] } },
    });
    assert.deepEqual(nextStep(finished, facts()), { section: 'Test', line: `run stage ${ID} test, then the Test section` });
    const merge = makeState({ stage: 'review', workers: { reviewer: 'done', 'reviewer-2': 'report-invalid' } });
    assert.deepEqual(nextStep(merge, facts(['report-reviewer-2.md', 'report-reviewer.md'])), {
      section: 'Review', line: `guide review step 3 (review merge ${ID})`,
    });
    const fixes = makeState({
      stage: 'review', workers: { reviewer: 'done', 'reviewer-2': 'done' }, extra: { review: { fixTasks: ['T1'] } },
    });
    assert.deepEqual(nextStep(fixes, facts(['report-reviewer.md'])), { section: 'Review', line: 'guide review from step 1' });
  });

  test('review: both reports present but a reviewer not checked -> Check those reviewers before the merge', () => {
    const reports = facts(['report-reviewer-2.md', 'report-reviewer.md']);
    for (const mode of ['gate', 'auto']) {
      const both = makeState({ stage: 'review', mode, workers: { reviewer: 'running', 'reviewer-2': 'running' } });
      assert.deepEqual(nextStep(both, reports), { section: 'Review', line: 'Worker loop step 4 (Check) with W = reviewer reviewer-2' });
    }
    const one = makeState({ stage: 'review', workers: { reviewer: 'done', 'reviewer-2': 'running' } });
    assert.deepEqual(nextStep(one, reports), { section: 'Review', line: 'Worker loop step 4 (Check) with W = reviewer-2' });
  });

  test('review: a critical finding no task owns -> merge again for the decision, never on to Test', () => {
    const workers = { reviewer: 'done', 'reviewer-2': 'done' };
    const reports = facts(['report-reviewer-2.md', 'report-reviewer.md']);
    for (const mode of ['gate', 'auto', 'step']) {
      const state = makeState({ stage: 'review', mode, workers, extra: { review: { fixTasks: [], unownedCritical: 1 } } });
      assert.deepEqual(nextStep(state, reports), { section: 'Review', line: `guide review step 3 (review merge ${ID})` }, mode);
    }
    const clean = makeState({ stage: 'review', workers, extra: { review: { fixTasks: [], unownedCritical: 0 } } });
    assert.equal(nextStep(clean, reports).section, 'Test');
  });

  test('test: done -> next stage; report -> Check; else Test', () => {
    assert.equal(nextStep(makeState({ stage: 'test', workers: { tester: 'done' }, extra: { guarded: ['test'] } }), facts()).section, 'Docs');
    assert.deepEqual(nextStep(makeState({ stage: 'test', workers: { tester: 'running' } }), facts(['report-tester.md'])), {
      section: 'Test', line: 'Worker loop step 4 (Check) for tester',
    });
    assert.deepEqual(nextStep(makeState({ stage: 'test' }), facts()), {
      section: 'Test', line: 'Worker loop for tester (write a new brief and launch it again)',
    });
  });

  test('all selected stages done: Commit in gate and auto without commits, else Finish', () => {
    const selected = ['explore', 'implement', 'test'];
    const base = { stage: 'test', type: 'small-fix', selected, workers: { tester: 'done' }, extra: { guarded: ['test'] } };
    const commit = { section: 'Commit', line: `the Commit section (run commit ${ID})` };
    const finish = {
      section: 'Finish',
      line: `run stage ${ID} done, then the Finish section (report show ${ID} <worker> for each report you have not seen)`,
    };
    assert.deepEqual(nextStep(makeState({ ...base, mode: 'gate' }), facts()), commit);
    assert.deepEqual(nextStep(makeState({ ...base, mode: 'auto' }), facts()), commit);
    assert.deepEqual(nextStep(makeState({ ...base, mode: 'step' }), facts()), {
      section: 'Finish', line: `Worker loop step 6 (ask: Stage test finished. Continue?); on Continue ${finish.line}`,
    });
    const committed = makeState({ ...base, mode: 'gate', extra: { ...base.extra, commits: [{ sha: 'abc' }] } });
    assert.deepEqual(nextStep(committed, facts()), finish);
  });

  test('a finished batch whose Guard step never passed -> Guard for that batch first', () => {
    const tasks = [T('T1', 'implementer', 1), T('T2', 'implementer', 1), T('T3', 'implementer', 2, ['src/T1.js'])];
    const workers = { 'implementer-T1': 'done', 'implementer-T2': 'done' };
    assert.deepEqual(nextStep(makeState({ stage: 'implement', tasks, workers }), facts()), {
      section: 'Implement', line: 'Worker loop step 5 (Guard) with G = --tasks T1,T2',
    });
    const otherStage = makeState({ stage: 'implement', tasks, workers, extra: { guarded: ['review:T1,T2'] } });
    assert.equal(nextStep(otherStage, facts()).line, 'Worker loop step 5 (Guard) with G = --tasks T1,T2');
    const last = makeState({ stage: 'docs', tasks: [T('D1', 'docs', 1)], workers: { 'docs-D1': 'done' } });
    assert.deepEqual(nextStep(last, facts()), { section: 'Docs', line: 'Worker loop step 5 (Guard) with G = --tasks D1' });
  });

  test('a single worker done but not guarded -> its Guard step, with no G', () => {
    const explore = makeState({ stage: 'explore', type: null, workers: { explorer: 'done' } });
    assert.deepEqual(nextStep(explore, facts(['report-explorer.md'])), {
      section: 'Explore', line: 'Worker loop step 5 (Guard) for explorer, with no G',
    });
    const tester = makeState({ stage: 'test', workers: { tester: 'done' } });
    assert.deepEqual(nextStep(tester, facts()), { section: 'Test', line: 'Worker loop step 5 (Guard) for tester, with no G' });
    const classified = makeState({ stage: 'explore', workers: { explorer: 'done' } });
    assert.equal(nextStep(classified, facts()).section, 'Plan');
  });

  test('step mode asks to continue again and commits a batch stage unless its commit is recorded', () => {
    const tasks = [T('T1', 'implementer', 1)];
    const base = { stage: 'implement', mode: 'step', tasks, workers: { 'implementer-T1': 'done' } };
    const guardedOnly = makeState({ ...base, extra: { guarded: ['implement:T1'] } });
    assert.deepEqual(nextStep(guardedOnly, facts()), {
      section: 'Review',
      line: `Worker loop step 6 (ask: Stage implement finished. Continue?); on Continue run commit ${ID}, then `
        + `run stage ${ID} review, then the Review section`,
    });
    const committed = makeState({ ...base, extra: { guarded: ['implement:T1'], commits: [{ sha: 'abc', stage: 'implement' }] } });
    assert.deepEqual(nextStep(committed, facts()), { section: 'Review', line: `run stage ${ID} review, then the Review section` });
    const explore = makeState({ stage: 'explore', mode: 'step', type: null, workers: { explorer: 'done' }, extra: { guarded: ['explore'] } });
    const next = nextStep(explore, facts());
    assert.equal(next.section, 'Classify');
    assert.ok(next.line.startsWith('Worker loop step 6 (ask: Stage explore finished. Continue?); on Continue run report show '), next.line);
  });

  test('done and cancelled runs have nothing to resume', () => {
    for (const stage of ['done', 'cancelled']) {
      assert.deepEqual(nextStep(makeState({ stage }), facts()), {
        section: null, line: `run finished (stage=${stage}); nothing to resume`,
      });
    }
  });

  test('a running Codex job comes first, and the next step is computed again after it', () => {
    const state = makeState({ stage: 'test', workers: { tester: 'running' } });
    const next = nextStep(state, facts([], ['job-a1', 'job-b2']));
    assert.deepEqual(next, {
      section: 'Test',
      line: `first run node ${HELPER} codex wait job-a1 job-b2, then codex result <job> for each of those jobs, `
        + `then run resume ${ID} for the next step`,
    });
    assert.ok(!next.line.includes('launch it again'), next.line);
  });

  test('task ids that are not T<n> or D<n> are never printed', () => {
    const tasks = [T('T1;rm -rf x', 'implementer', 1), T('T2', 'implementer', 1)];
    const next = nextStep(makeState({ stage: 'implement', tasks }), facts());
    assert.ok(!next.line.includes('rm -rf'), next.line);
  });

  test('formatNext prints `next: <Section> - <line>` or the bare finished line', () => {
    assert.equal(formatNext({ section: 'Plan', line: 'x' }), 'next: Plan - x');
    assert.equal(formatNext({ section: null, line: 'run finished (stage=done); nothing to resume' }),
      'run finished (stage=done); nothing to resume');
  });
});

describe('runFacts', () => {
  test('lists the report files and the running Codex jobs of the run', () => {
    const root = makeTempDir('neat-next-');
    try {
      const state = rs.createRun(root, { task: 'facts', mode: 'gate' }, new Date('2026-10-18T12:00:00Z'));
      const dir = rs.runDir(root, state.id);
      fs.writeFileSync(path.join(dir, 'brief-explorer.md'), 'x');
      fs.writeFileSync(path.join(dir, 'report-tester.md'), 'x');
      fs.writeFileSync(path.join(dir, 'report-explorer.md'), 'x');
      const f = runFacts(root, state);
      assert.deepEqual(f.reports, ['report-explorer.md', 'report-tester.md']);
      assert.deepEqual(f.runningJobs, []);
      assert.equal(f.helper, path.join(REPO_ROOT, 'payload', 'neat', 'bin', 'neat.cjs'));
    } finally {
      removeDir(root);
    }
  });

  test('leaves out a report older than its worker\'s current brief (an earlier round\'s report)', () => {
    const root = makeTempDir('neat-next-');
    try {
      const state = rs.createRun(root, { task: 'facts', mode: 'gate' }, new Date('2026-10-18T12:00:00Z'));
      const dir = rs.runDir(root, state.id);
      const at = (name, sec) => {
        fs.writeFileSync(path.join(dir, name), 'x');
        fs.utimesSync(path.join(dir, name), sec, sec);
      };
      at('report-reviewer.md', 1000);
      at('brief-reviewer.md', 2000);
      at('brief-reviewer-2.md', 2000);
      at('report-reviewer-2.md', 3000);
      assert.deepEqual(runFacts(root, state).reports, ['report-reviewer-2.md']);
      const review = { ...state, stage: 'review', workers: [{ name: 'reviewer', status: 'running' }, { name: 'reviewer-2', status: 'running' }] };
      assert.equal(nextStep(review, runFacts(root, review)).line, 'guide review from step 1');
    } finally {
      removeDir(root);
    }
  });

  test('reads each report\'s status word; a report without one is invalid', () => {
    const root = makeTempDir('neat-next-');
    try {
      const state = rs.createRun(root, { task: 'facts', mode: 'gate' }, new Date('2026-10-18T12:00:00Z'));
      const dir = rs.runDir(root, state.id);
      fs.writeFileSync(path.join(dir, 'report-explorer.md'), '## Status\n\ndone - mapped\n\n## Findings\n- x\n');
      fs.writeFileSync(path.join(dir, 'report-tester.md'), '## Status\n- **failed**: 2 tests\n');
      fs.writeFileSync(path.join(dir, 'report-reviewer.md'), 'no headings at all');
      fs.writeFileSync(path.join(dir, 'report-not-a-worker.md'), '## Status\ndone\n');
      assert.deepEqual(runFacts(root, state).statuses, { explorer: 'done', tester: 'failed', reviewer: 'invalid' });
    } finally {
      removeDir(root);
    }
  });
});

describe('resumeLines', () => {
  const DIR = '/p/.neat/runs/x';

  test('prints the task text, the report statuses and the plan batches the next section needs', () => {
    const tasks = [T('T1', 'implementer', 0), T('T2', 'implementer', 1, ['src/T1.js'])];
    const state = makeState({
      stage: 'implement', tasks, workers: { explorer: 'done', 'implementer-T1': 'done' },
      extra: { task: 'add a hello function\nand test it', guarded: ['implement:T1'] },
    });
    const lines = resumeLines(state, { ...facts(), statuses: { explorer: 'done', 'implementer-T1': 'partial' } }, DIR);
    assert.deepEqual(lines.slice(0, 6), [
      `run=${ID} mode=gate stage=implement type=feature dir=${DIR}`,
      'task: add a hello function / and test it',
      'workers: done=explorer,implementer-T1 running=none failed=none',
      'reports: explorer=done implementer-T1=partial',
      'plan: stages=explore,plan,implement,review,test,docs implement=[T1] [T2] docs=none',
      'next: Implement - Worker loop with W = implementer-T2 and G = --tasks T2',
    ]);
    assert.ok(lines[6].includes(`report show ${ID} <worker>`), lines[6]);
    assert.ok(lines.length <= 7);
  });

  test('without reports or a checked plan it says none and prints no plan line', () => {
    const state = makeState({ stage: 'explore', type: null, extra: { task: 'x' } });
    const lines = resumeLines(state, facts(), DIR);
    assert.ok(lines.includes('reports: none'), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('plan: ')), lines.join('\n'));
  });

  test('taskText strips escape sequences and control characters, joins lines and caps the length', () => {
    assert.equal(taskText('fix \u001b[31mred\u001b[0m\r\n  bug\u0007 \n\n'), 'fix red / bug');
    assert.equal(taskText(undefined), '');
    const long = taskText('a'.repeat(5000));
    assert.ok(long.startsWith('a'.repeat(2000)) && long.endsWith(' [cut; full text in state.json]'), long.slice(-40));
  });
});
