// FAILED CI ON A HEAD — the pure half (ci-failures.ts), shared by the CI review (review/ci-review/,
// whose read step is pinned in ci-review/prepare.test.ts). What this pins:
//   1. The log excerpt is BOUNDED (per line, per check, per block) and centred on the first error.
//   2. Reconcile NEVER INVENTS A CAUSE: one entry per failing check, 'not_checked' with the server's
//      reason for everything Claude was not shown or did not report.
//   3. A check that is not an Actions job is listed 'no_log', and no log read is attempted for it.
//   4. Carry-forward: same head + same job ⇒ the earlier diagnosis, no log read, nothing re-sent.
//
//   pnpm --filter @pierre-review/backend test claude-review/ci-failures
import { describe, expect, it } from 'vitest';
import type { CheckRun, ClaudeCiFailure } from '@pierre-review/shared';
import { MAX_LOG_BYTES } from '../../github/actions-logs.js';
import { failedStepName } from '../../github/commit-checks.js';
import {
  CI_BLOCK_CHARS,
  CI_EXCERPT_CHARS,
  CI_FAILURES_MAX,
  CI_LINE_CHARS,
  CI_LOG_READ_BYTES,
  confidenceOf,
  culpritClass,
  ciStateKind,
  extractFailureExcerpt,
  planCiReview,
  reconcileCiFailures,
  selectCiFailures,
  type CiLogRead,
} from './ci-failures.js';
import { buildUserPrompt } from './prompts.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

const check = (name: string, state: CheckRun['state'], jobId: number | null): CheckRun => ({
  name,
  state,
  url: jobId != null ? `https://github.com/o/r/actions/runs/1/job/${jobId}` : `https://ci.example/${name}`,
  runId: jobId != null ? 1 : null,
  jobId,
});

const ts = (i: number): string => `2026-10-01T10:00:${String(i % 60).padStart(2, '0')}.0000000Z `;

function log(lines: string[]): string {
  return lines.map((l, i) => `${ts(i)}${l}`).join('\n');
}

const read = (c: CheckRun, text: string | null, step: string | null = null): CiLogRead => ({
  check: { checkName: c.name, jobId: c.jobId, url: c.url },
  step,
  log: text == null ? null : { text, windowTruncated: false },
});

const diagnosed = (name: string, jobId: number, head = HEAD): ClaudeCiFailure => ({
  ref: 'F1',
  checkName: name,
  jobId,
  step: 'Run tests',
  url: null,
  sent: true,
  carried: false,
  status: 'diagnosed',
  notCheckedReason: null,
  cause: 'A test asserts the old default',
  explanation: 'The test expects 3; the change makes it 4.',
  category: 'test',
  fixableInPr: true,
  relatedFiles: [{ path: 'src/a.test.ts', line: 12 }],
  assessedAtHead: head,
});

describe('extractFailureExcerpt — bounded, centred on the first error', () => {
  it('strips timestamps and colour codes, keeps the error with its context and the tail', () => {
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => `setup line ${i}`),
      '\u001b[31mFAIL src/a.test.ts > adds\u001b[0m',
      'AssertionError: expected 3 to be 4',
      ...Array.from({ length: 200 }, (_, i) => `cleanup line ${i}`),
      '##[error]Process completed with exit code 1.',
    ];
    const ex = extractFailureExcerpt(log(lines));
    expect(ex.text).not.toMatch(/2026-10-01T/);
    expect(ex.text).not.toMatch(/\u001b/);
    expect(ex.text).toContain('FAIL src/a.test.ts > adds');
    expect(ex.text).toContain('AssertionError: expected 3 to be 4');
    expect(ex.text).toContain('setup line 199'); // context before
    expect(ex.text).not.toContain('setup line 150');
    expect(ex.text).toContain('Process completed with exit code 1'); // the tail
    expect(ex.text).toMatch(/… \d+ lines not shown …/);
    expect(ex.text).toMatch(/^… 192 earlier lines not shown …/);
    expect(ex.windowLines).toBe(lines.length);
  });

  it('prefers a specific error to the runner\'s exit-code line', () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => `noise ${i}`),
      'error TS2345: Argument of type string',
      ...Array.from({ length: 100 }, (_, i) => `more ${i}`),
      '##[error]Process completed with exit code 2.',
    ];
    const ex = extractFailureExcerpt(log(lines));
    expect(ex.text).toContain('error TS2345');
    expect(ex.text).toContain('noise 95');
  });

  it('with no error marker sends the tail alone', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `step ${i}`);
    const ex = extractFailureExcerpt(log(lines));
    expect(ex.text).toContain('step 299');
    expect(ex.text).not.toContain('step 200');
    expect(ex.shownLines).toBe(30);
  });

  it('clips one enormous line and never exceeds the per-check cap', () => {
    const huge = 'x'.repeat(50_000);
    const lines = [
      ...Array.from({ length: 50 }, () => huge),
      `Error: boom ${huge}`,
      ...Array.from({ length: 50 }, () => huge),
    ];
    const ex = extractFailureExcerpt(log(lines));
    for (const l of ex.text.split('\n')) expect(l.length).toBeLessThanOrEqual(CI_LINE_CHARS + 20);
    expect(ex.text.length).toBeLessThanOrEqual(CI_EXCERPT_CHARS + 20);
    expect(ex.text).toContain('Error: boom');
  });

  it('honours a smaller cap', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'y'.repeat(100)}`);
    expect(extractFailureExcerpt(log(lines), { maxChars: 500 }).text.length).toBeLessThanOrEqual(520);
  });
});

describe('selectCiFailures / planCiReview — what is read and sent', () => {
  it('reads only FAILING Actions jobs, at most CI_FAILURES_MAX; a third-party check is no_log', () => {
    const checks = [
      check('lint', 'success', 1),
      check('pending', 'pending', 2),
      check('SonarCloud', 'failure', null),
      ...Array.from({ length: CI_FAILURES_MAX + 2 }, (_, i) => check(`test-${i}`, 'failure', 100 + i)),
      check('errored', 'error', 300),
    ];
    const sel = selectCiFailures(checks, 'FAILURE', HEAD, null);
    expect(sel.state).toBe('failing');
    expect(sel.checkCount).toBe(checks.length);
    expect(sel.toRead).toHaveLength(CI_FAILURES_MAX);
    expect(sel.overCap.map((c) => c.checkName)).toEqual(['test-6', 'test-7', 'errored']);
    expect(sel.noLog.map((c) => c.checkName)).toEqual(['SonarCloud']);
  });

  it('a log that cannot be read is log_unavailable; the block cap moves the rest over_cap', () => {
    const a = check('a', 'failure', 1);
    const b = check('b', 'failure', 2);
    const c = check('c', 'failure', 3);
    const d = check('d', 'failure', 4);
    const sel = selectCiFailures([a, b, c, d], 'FAILURE', HEAD, null);
    const big = log(Array.from({ length: 400 }, (_, i) => `Error: ${i} ${'z'.repeat(300)}`));
    const plan = planCiReview(sel, [read(a, null), read(b, big), read(c, big), read(d, big)]);
    expect(plan.sent.map((s) => s.check.checkName)).toEqual(['b', 'c', 'd'].slice(0, plan.sent.length));
    expect(plan.sent.reduce((n, s) => n + s.excerpt.text.length, 0)).toBeLessThanOrEqual(CI_BLOCK_CHARS);
    expect(plan.unsent.find((u) => u.check.checkName === 'a')?.reason).toBe('log_unavailable');
    expect(plan.sent.map((s) => s.ref)).toEqual(plan.sent.map((_, i) => `F${i + 1}`));
  });

  it('carries a diagnosis made at THIS head for the SAME job — and nothing else', () => {
    const prior = [
      diagnosed('same', 10),
      diagnosed('rerun', 20), // the job was re-run: new id below
      diagnosed('moved', 30, OTHER_HEAD),
      { ...diagnosed('unjudged', 40), status: 'not_checked' as const, notCheckedReason: 'not_reported' as const },
    ];
    const sel = selectCiFailures(
      [check('same', 'failure', 10), check('rerun', 'failure', 21), check('moved', 'failure', 30), check('unjudged', 'failure', 40)],
      'FAILURE',
      HEAD,
      prior,
    );
    expect(sel.carried.map((c) => c.checkName)).toEqual(['same']);
    expect(sel.carried[0]).toMatchObject({ carried: true, sent: false, ref: null, cause: 'A test asserts the old default' });
    expect(sel.toRead.map((c) => c.checkName)).toEqual(['rerun', 'moved', 'unjudged']);
  });

  it('maps the rollup state', () => {
    expect(ciStateKind('SUCCESS')).toBe('passing');
    expect(ciStateKind('ERROR')).toBe('failing');
    expect(ciStateKind('EXPECTED')).toBe('pending');
    expect(ciStateKind(null)).toBe('none');
    expect(ciStateKind('WEIRD')).toBe('unknown');
  });

  it('the read is the whole log, up to the log reader\'s hard cap', () => {
    expect(CI_LOG_READ_BYTES).toBe(MAX_LOG_BYTES);
  });
});

describe('reconcileCiFailures — never invents a cause', () => {
  const a = check('build', 'failure', 1);
  const b = check('test', 'failure', 2);
  const c = check('e2e', 'failure', 3);
  const ext = check('codecov', 'failure', null);
  const sel = selectCiFailures([a, b, c, ext], 'FAILURE', HEAD, null);
  const text = log(['Error: x']);
  const plan = planCiReview(sel, [read(a, text, 'Build'), read(b, text), read(c, text)]);

  it('one entry per failing check; unreported and unsent ones are not_checked with a reason', () => {
    const rec = reconcileCiFailures(plan, [
      { ref: 'f1', cause: '  Type error in add()  ', explanation: 'x', category: 'code', step: 'ignored', fixableInPr: true, relatedFiles: [{ path: 'src/add.ts', line: 3 }, { path: '', line: 1 }, { path: 'src/b.ts', line: -2 }] },
      { ref: 'F1', cause: 'second report', explanation: 'y', category: 'test', fixableInPr: false }, // duplicate: first wins
      { ref: 'F2', cause: 'x', explanation: 'y', category: 'nonsense' as never, fixableInPr: true }, // bad category
      { ref: 'F3', cause: '   ', explanation: 'y', category: 'code', fixableInPr: true }, // no cause
      { ref: 'F9', cause: 'x', explanation: 'y', category: 'code', fixableInPr: true }, // unknown ref
    ]);
    expect(rec.state).toBe('failing');
    expect(rec.failures.map((f) => [f.checkName, f.status, f.notCheckedReason])).toEqual([
      ['build', 'diagnosed', null],
      ['test', 'not_checked', 'not_reported'],
      ['e2e', 'not_checked', 'not_reported'],
      ['codecov', 'not_checked', 'no_log'],
    ]);
    const [build] = rec.failures;
    expect(build).toMatchObject({
      ref: 'F1',
      cause: 'Type error in add()',
      category: 'code',
      fixableInPr: true,
      step: 'Build', // GitHub's own step record beats Claude's
      relatedFiles: [
        { path: 'src/add.ts', line: 3 },
        { path: 'src/b.ts', line: null },
      ],
    });
    for (const f of rec.failures.slice(1)) {
      expect(f.cause).toBeNull();
      expect(f.category).toBeNull();
      expect(f.fixableInPr).toBeNull();
    }
    expect(rec.failures[3]!.url).toBe('https://ci.example/codecov');
  });

  it('nothing reported ⇒ every failure not_checked', () => {
    const rec = reconcileCiFailures(plan, undefined);
    expect(rec.failures.every((f) => f.status === 'not_checked')).toBe(true);
  });

  it('clips long text', () => {
    const rec = reconcileCiFailures(plan, [
      { ref: 'F1', cause: 'c'.repeat(1000), explanation: 'e'.repeat(5000), category: 'unclear', fixableInPr: false },
    ]);
    expect(rec.failures[0]!.cause!.length).toBeLessThanOrEqual(161);
    expect(rec.failures[0]!.explanation!.length).toBeLessThanOrEqual(1001);
  });

  it('green head: [] with the state', () => {
    const rec = reconcileCiFailures(planCiReview(selectCiFailures([check('ok', 'success', 1)], 'SUCCESS', HEAD, null), []), []);
    expect(rec).toEqual({ state: 'passing', checkCount: 1, failures: [] });
  });
});

describe('the PR review no longer diagnoses CI (the CI review does — review/ci-review/)', () => {
  it('the code review prompt never asks for ciFailures', () => {
    const base = {
      repoFullName: 'o/r',
      prNumber: 1,
      title: 't',
      body: null,
      headSha: HEAD,
      baseRef: 'main',
      changedFiles: [],
      excludedFiles: [],
      diff: '',
    };
    expect(buildUserPrompt({ ...base })).not.toMatch(/ciFailures|CI failures/);
  });
});

describe('failedStepName', () => {
  it('names the first failed step by number', () => {
    expect(
      failedStepName({
        steps: [
          { name: 'Checkout', conclusion: 'success', number: 1 },
          { name: 'Lint', conclusion: 'failure', number: 3 },
          { name: 'Build', conclusion: 'failure', number: 2 },
        ],
      }),
    ).toBe('Build');
    expect(failedStepName({ steps: [{ name: 'a', conclusion: 'success', number: 1 }] })).toBeNull();
    expect(failedStepName(null)).toBeNull();
  });
});
