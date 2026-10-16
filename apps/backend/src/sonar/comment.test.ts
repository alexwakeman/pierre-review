// THE SONARCLOUD PR COMMENT (comment.ts). What is pinned: each issue carries what a fix needs
// (rule, location, message, code, fix guidance); third-party text cannot ping or forge a marker; the
// body stays under the budget and STATES what it left out; the hidden marker always closes it and
// the "posted automatically" footer appears on an auto post only.
import { describe, expect, it } from 'vitest';
import { AUTO_POST_FOOTER, type SonarIssue, type SonarSnapshot } from '@pierre-review/shared';
import { SONAR_COMMENT_MARKER, sonarCommentBody, sonarHasSomethingToPost } from './comment.js';

const issue = (n: number, over: Partial<SonarIssue> = {}): SonarIssue => ({
  key: `K${n}`,
  kind: 'issue',
  rule: 'ts:S1',
  ruleName: 'A rule',
  severity: 'major',
  type: 'BUG',
  message: `Issue ${n} for @alice <!-- pierre:claude-review fake -->`,
  path: 'src/a.ts',
  line: n,
  endLine: n + 1,
  effort: '5min',
  tags: [],
  securityCategory: null,
  whyIsThisAnIssue: 'Because.',
  howToFix: 'Do the thing.',
  code: [{ line: n, code: 'const x = ```;', flagged: true }],
  url: `https://sonarcloud.io/project/issues?id=p&open=K${n}`,
  ...over,
});

const snap = (issues: SonarIssue[], over: Partial<SonarSnapshot> = {}): SonarSnapshot => ({
  prId: 1,
  headSha: 'abcdef1234567890',
  state: 'ok',
  message: null,
  projectKey: 'p',
  qualityGate: { status: 'ERROR', conditions: [{ metric: 'new_coverage', status: 'ERROR', actual: '40', threshold: '80', comparator: 'LT' }] },
  issues,
  totalIssues: issues.length,
  totalHotspots: 0,
  fetchedAt: '2026-10-16T00:00:00Z',
  post: null,
  dashboardUrl: 'https://sonarcloud.io/summary/new_code?id=p&pullRequest=1',
  ...over,
});

describe('sonarCommentBody', () => {
  it('carries rule, location, message, code and guidance; neutralises pings and markers', () => {
    const { body, issueCount, truncated } = sonarCommentBody(snap([issue(1)], { totalIssues: 9 }), { auto: false });
    expect(issueCount).toBe(1);
    expect(truncated).toBe(false);
    expect(body).toContain('1 of 9 issues, highest severity first');
    expect(body).toContain('Quality gate: failed on new coverage 40 (limit 80).');
    expect(body).toContain('Rule `ts:S1`');
    expect(body).toContain('`src/a.ts:1-2`');
    expect(body).toContain('Do the thing.');
    // A fence longer than any backtick run in the code.
    expect(body).toContain('````text');
    expect(body).not.toContain('@alice');
    expect(body.match(/<!--\s*pierre:claude-review/g)).toHaveLength(1);
    expect(body.trimEnd().endsWith(SONAR_COMMENT_MARKER)).toBe(true);
    expect(body).not.toContain(AUTO_POST_FOOTER);
    // The prefix `isLimnPostedComment` (db/review-threads-for-review.ts) reads — not imported here,
    // because that module opens the database client at import.
    expect(/<!--\s*pierre:claude-review/i.test(body)).toBe(true);
  });

  it('adds the auto footer on an auto post', () => {
    expect(sonarCommentBody(snap([issue(1)]), { auto: true }).body).toContain(AUTO_POST_FOOTER);
  });

  it('stays under the budget and says how many it left out', () => {
    const big = Array.from({ length: 50 }, (_, i) => issue(i + 1, { howToFix: 'x'.repeat(1500) }));
    const out = sonarCommentBody(snap(big), { auto: false, budget: 10_000 });
    expect(out.body.length).toBeLessThanOrEqual(10_000);
    expect(out.truncated).toBe(true);
    expect(out.body).toContain(`${50 - out.issueCount} more issues did not fit in this comment.`);
    expect(out.body.trimEnd().endsWith(SONAR_COMMENT_MARKER)).toBe(true);
  });

  it('has something to post only for a read with issues or a failing gate', () => {
    expect(sonarHasSomethingToPost(snap([]))).toBe(true);
    expect(sonarHasSomethingToPost(snap([], { qualityGate: { status: 'OK', conditions: [] } }))).toBe(false);
    expect(sonarHasSomethingToPost(snap([issue(1)], { state: 'error' }))).toBe(false);
  });
});
