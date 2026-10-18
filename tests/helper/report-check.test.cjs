'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, makeTempDir, removeDir } = require('../support/helpers.cjs');

const {
  checkReport,
  checkReportFile,
  REPORT_HEADINGS,
  MAX_REPORT_WORDS,
  REPORT_STATUSES,
} = require(path.join(REPO_ROOT, 'payload', 'neat', 'lib', 'report-check.cjs'));

const RUN_ID = '20261018-120000-fix-login';

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

let tmp;
let runDir;

before(() => {
  tmp = makeTempDir('neat-report-');
  runDir = path.join(tmp, '.neat', 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
});

after(() => removeDir(tmp));

function writeReport(name, text) {
  const file = path.join(runDir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('constants pin the contract', () => {
  assert.deepEqual([...REPORT_HEADINGS], [
    '## Status', '## Findings', '## Decisions', '## Open questions', '## Artifacts',
  ]);
  assert.equal(MAX_REPORT_WORDS, 300);
  assert.deepEqual([...REPORT_STATUSES], ['done', 'partial', 'blocked', 'failed']);
});

test('a valid report passes and counts words', () => {
  const res = checkReport(report());
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.deepEqual(res.errors, []);
  assert.equal(res.words, 22);
});

test('301 words is too long, 300 is fine', () => {
  const base = report({ findings: '' });
  const baseWords = base.trim().split(/\s+/).length;
  const fill = (n) => report({ findings: Array(n).fill('w').join(' ') });
  assert.equal(checkReport(fill(300 - baseWords)).ok, true);
  const res = checkReport(fill(301 - baseWords));
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes('too long: 301 words (max 300)'), res.errors.join('\n'));
});

test('an extra heading is unexpected', () => {
  const res = checkReport(`${report()}## Notes\nx\n`);
  assert.ok(res.errors.includes('unexpected heading: ## Notes'));
});

test('a missing heading is reported', () => {
  const res = checkReport(report().replace('## Decisions\n- none\n', ''));
  assert.ok(res.errors.includes('missing heading: ## Decisions'));
});

test('headings out of order are reported', () => {
  const text = '## Findings\nx\n## Status\ndone\n## Decisions\nx\n## Open questions\nx\n## Artifacts\n- none\n';
  const res = checkReport(text);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.startsWith('heading out of order')), res.errors.join('\n'));
});

test('a duplicate heading is reported', () => {
  const res = checkReport(report().replace('## Decisions', '## Findings\nmore\n## Decisions'));
  assert.ok(res.errors.some((e) => e.startsWith('duplicate heading: ## Findings')), res.errors.join('\n'));
});

test('status must be a known value', () => {
  const res = checkReport(report({ status: 'maybe' }));
  assert.ok(res.errors.includes('status must be one of done|partial|blocked|failed'));
});

test('decorated status values are accepted', () => {
  assert.equal(checkReport(report({ status: '**done**' })).ok, true);
  assert.equal(checkReport(report({ status: '- partial' })).ok, true);
  assert.equal(checkReport(report({ status: '`blocked` waiting on input' })).ok, true);
  assert.equal(checkReport(report({ status: '\nfailed' })).ok, true);
});

test('checkReportFile accepts Artifacts `none`', () => {
  const res = checkReportFile(writeReport('report-a.md', report()));
  assert.equal(res.ok, true, res.errors.join('\n'));
});

test('checkReportFile resolves relative artifacts against the report directory', () => {
  fs.writeFileSync(path.join(runDir, 'explore-map.md'), 'a.js:1 - x\n');
  const abs = path.join(runDir, 'explore-map.md');
  const text = report({ artifacts: `- explore-map.md\n- \`${abs}\`` });
  const res = checkReportFile(writeReport('report-b.md', text));
  assert.equal(res.ok, true, res.errors.join('\n'));
});

test('checkReportFile reports a missing artifact', () => {
  const res = checkReportFile(writeReport('report-c.md', report({ artifacts: '- missing.md' })));
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes(`artifact not found: ${path.join(runDir, 'missing.md')}`), res.errors.join('\n'));
});

test('checkReportFile rejects a path outside .neat/runs', () => {
  const outside = path.join(tmp, 'report.md');
  fs.writeFileSync(outside, report());
  const res = checkReportFile(outside);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].startsWith('path outside .neat/runs'), res.errors.join('\n'));
});

test('checkReportFile rejects a run segment with an invalid id', () => {
  const badDir = path.join(tmp, '.neat', 'runs', 'not-a-run');
  fs.mkdirSync(badDir, { recursive: true });
  const file = path.join(badDir, 'report.md');
  fs.writeFileSync(file, report());
  assert.equal(checkReportFile(file).ok, false);
});

test('checkReportFile reports a missing file', () => {
  const res = checkReportFile(path.join(runDir, 'report-nope.md'));
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^report not found: /);
});
