// THE SONARCLOUD PR COMMENT (comment.ts). What is pinned: each issue carries what a fix needs
// (rule, location, message, code, fix guidance); third-party text cannot ping or forge a marker; the
// body stays under the budget and STATES what it left out; the hidden marker always closes it and
// the "posted automatically" footer appears on an auto post only; PROSE outside a fence is
// HTML-escaped (a rule's quoted `</details>` or `<a href>` must not render), code is not.
import { describe, expect, it } from 'vitest';
import { AUTO_POST_FOOTER, type SonarIssue, type SonarSnapshot } from '@pierre-review/shared';
import {
  SONAR_COMMENT_MARKER,
  sonarCommentBody,
  sonarHasSomethingToPost,
  sonarInlineBody,
  sonarReviewMarker,
} from './comment.js';

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
    expect(body).toContain('Quality gate: failed:\n- Coverage on new code is 40%. The quality gate needs at least 80%.');
    // The failing coverage condition is a block of its own, before the issues (which keep their count).
    expect(body).toContain('#### 1. Critical · Quality gate: Coverage on new code');
    expect(body).toContain('#### 2. Major · Bug: A rule');
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

  it('escapes tags in third-party prose so a quoted example never renders, and leaves code literal', () => {
    const it0 = issue(1, {
      message: 'Add a <title> element',
      howToFix: 'Noncompliant:\n<a href="https://evil.example" target="_blank">x</a>\n</details><table>',
      ruleName: 'Links & <a> tags',
      code: [{ line: 1, code: '<div>&nbsp;</div>', flagged: true }],
    });
    const { body } = sonarCommentBody(snap([it0], { qualityGate: null }), { auto: false });
    expect(body).toContain('> Add a &lt;title&gt; element');
    expect(body).toContain('&lt;a href="https://evil.example" target="_blank"&gt;x&lt;/a&gt;');
    expect(body).toContain('&lt;/details&gt;&lt;table&gt;');
    expect(body).toContain('Links &amp; &lt;a&gt; tags');
    // Exactly our own <details> open and close survive as markup.
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    expect(body).not.toContain('<a href');
    // Inside the fence the code is printed as written.
    expect(body).toContain('> 1 | <div>&nbsp;</div>');
  });
});

describe('the inline thread and the summary of a review', () => {
  it('an inline body: the rule, the message escaped, guidance, footer on auto, the marker last', () => {
    const it0 = issue(3, { howToFix: 'Use <b>this</b>.' });
    const manual = sonarInlineBody(it0, { auto: false });
    expect(manual).toContain('**SonarCloud** · Major · Bug: A rule');
    expect(manual).toContain('Rule `ts:S1`');
    expect(manual).toContain('lines 3-4');
    expect(manual).toContain('Issue 3 for @​alice &lt;!-- pierre:claude-review fake --&gt;');
    expect(manual).toContain('Use &lt;b&gt;this&lt;/b&gt;.');
    expect(manual).not.toContain(AUTO_POST_FOOTER);
    expect(manual.trimEnd().endsWith(SONAR_COMMENT_MARKER)).toBe(true);
    const auto = sonarInlineBody(it0, { auto: true });
    expect(auto).toContain(AUTO_POST_FOOTER);
    expect(auto.trimEnd().endsWith(SONAR_COMMENT_MARKER)).toBe(true);
  });

  it('the summary counts the inline ones, names the already-posted ones, and lists the rest in full', () => {
    const [a, b, c] = [issue(1), issue(2), issue(3, { path: null, line: null, endLine: null })];
    const { body, issueCount } = sonarCommentBody(snap([a!, b!, c!], { qualityGate: null }), {
      auto: false,
      split: { inline: [a!], already: [b!], summary: [c!] },
      marker: sonarReviewMarker('abc123'),
    });
    expect(issueCount).toBe(1);
    expect(body).toContain('1 issue is on the changed lines, as comments there.');
    expect(body).toContain('Already on GitHub from an earlier commit:\n- Major · A rule · `src/a.ts:2-3`');
    expect(body).toContain('#### 1. Major · Bug: A rule');
    expect(body).toContain('Issue 3 for');
    expect(body).not.toContain('Issue 1 for');
    expect(body.trimEnd().endsWith('<!-- pierre:claude-review-sonar v=1 a=abc123 -->')).toBe(true);
  });
});
