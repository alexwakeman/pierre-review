// DEPENDENCY + SECURITY DETECTION — the pure rules in security-detect.ts, against real text.
//
// Fixtures (`__fixtures__/security/`) are masked excerpts of real bodies: org and user names are
// `acme` / `alice`, every vendor marker is VERBATIM.
//   • `pr-*.json`    — `{ name, input, expected }`; `input` is exactly what `classifyPrSecurity`
//                      receives (the PR's `bodyText` — the plain-text rendering, NOT the markdown
//                      `body`) and `expected` its full result. Every file is asserted below.
//   • `alert-*.json` — `{ name, author, body }`: one stored comment / thread-root body (markdown, as
//                      `pr_comments.body` / `review_comments.body` hold it). The tests compose them
//                      into rows, because an alert's verdict depends on the rows AROUND it (the same
//                      tool's later comment, the thread's state, whether the author is automation).
// A real PR's `bodyText` costs one GraphQL point for several aliases:
//   gh api graphql -f query='{ a: repository(owner:"O", name:"N") { pullRequest(number: 1) {
//     title headRefName bodyText labels(first:20){ nodes { name } } } } }'
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_ID_PATTERNS,
  canonicalAdvisoryId,
  classifyPrSecurity,
  evaluateSecurityAlerts,
  extractAdvisoryIds,
  stripQuotedReviewerBlocks,
  SECURITY_ALERT_PREFILTER,
  SECURITY_ALERT_RULES,
  type AlertCandidateRow,
  type PrSecurityInput,
  type PrSecuritySignal,
} from './security-detect.js';

const fixturesDir = resolve(import.meta.dirname, '__fixtures__/security');

interface PrFixture {
  name: string;
  input: PrSecurityInput;
  expected: PrSecuritySignal;
}
interface AlertFixture {
  name: string;
  author: string;
  body: string;
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf-8')) as T;
}
const prFixture = (name: string): PrFixture => load<PrFixture>(`pr-${name}.json`);
const alertBody = (name: string): string => load<AlertFixture>(`alert-${name}.json`).body;

describe('classifyPrSecurity — fixtures', () => {
  const files = readdirSync(fixturesDir).filter((f) => f.startsWith('pr-') && f.endsWith('.json'));
  it('has the cases the spec names', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });
  for (const file of files) {
    const fx = load<PrFixture>(file);
    it(fx.name, () => {
      expect(classifyPrSecurity(fx.input)).toEqual(fx.expected);
    });
  }
});

describe('classifyPrSecurity — rule by rule', () => {
  const pr = (over: Partial<PrSecurityInput>): PrSecurityInput => ({
    title: 'Some change',
    headRefName: 'feature/x',
    labels: [],
    bodyText: '',
    ...over,
  });

  it('reads the Dependabot footer however long the body is — detection never sees a capped copy', () => {
    const fx = prFixture('dependabot-security-footer');
    // Past search_index's 4,000-character cap, which is where the real footer sits.
    const padded = { ...fx.input, bodyText: 'x'.repeat(60_000) + fx.input.bodyText };
    expect(classifyPrSecurity(padded).securityFix).toBe('proven');
  });

  it('infers a truncated ecosystem group only when title, branch AND truncation all hold', () => {
    const fx = prFixture('dependabot-group-truncated');
    expect(classifyPrSecurity(fx.input).securityFix).toBe('inferred');
    // Branch named after a DIFFERENT ecosystem than the title.
    expect(
      classifyPrSecurity({ ...fx.input, headRefName: 'dependabot/pip/pip-3d8e1a0fc5' }).securityFix,
    ).toBeNull();
    // A user-named group branch under an ecosystem title.
    expect(
      classifyPrSecurity({ ...fx.input, headRefName: 'dependabot/npm_and_yarn/tools-3d8e1a0fc5' }).securityFix,
    ).toBeNull();
    // A body naming every counted dependency is complete — unless Dependabot says it cut it.
    const complete = prFixture('dependabot-group-complete');
    expect(classifyPrSecurity(complete.input).securityFix).toBeNull();
    const noted = `${complete.input.bodyText}\nDescription has been truncated`;
    expect(classifyPrSecurity({ ...complete.input, bodyText: noted }).securityFix).toBe('inferred');
  });

  it('counts a group body naming fewer dependencies than its title as truncated, and one naming all as complete', () => {
    const swallowed = prFixture('dependabot-group-note-swallowed');
    expect(swallowed.input.bodyText).not.toContain('Description has been truncated');
    expect(classifyPrSecurity(swallowed.input).securityFix).toBe('inferred');
    // The same body under a title that counts what it names is complete — so null.
    const six = swallowed.input.title.replace('with 15 updates', 'with 6 updates');
    expect(classifyPrSecurity({ ...swallowed.input, title: six }).securityFix).toBeNull();
  });

  it('proves Renovate by the -vulnerability branch or a trailing [security], either case', () => {
    expect(classifyPrSecurity(pr({ headRefName: 'renovate/pypi-pygments-vulnerability' }))).toEqual({
      dependencyVendor: 'renovate',
      securityFix: 'proven',
      advisoryIds: [],
    });
    expect(
      classifyPrSecurity(
        pr({ headRefName: 'renovate/anyio-4.x', title: 'chore(deps): update dependency anyio to v4.14.2 [security]' }),
      ).securityFix,
    ).toBe('proven');
    expect(classifyPrSecurity(pr({ headRefName: 'renovate/github-codeql-action-digest' }))).toEqual({
      dependencyVendor: 'renovate',
      securityFix: null,
      advisoryIds: [],
    });
  });

  it('tells a Snyk fix from a Snyk version upgrade', () => {
    expect(classifyPrSecurity(pr({ headRefName: 'snyk-upgrade-0a1b2c3d4e5f', title: '[Snyk] Upgrade lodash from 4.17.20 to 4.17.21' }))).toEqual({
      dependencyVendor: 'snyk',
      securityFix: null,
      advisoryIds: [],
    });
    expect(
      classifyPrSecurity(pr({ title: '[Snyk] Fix for 3 vulnerabilities', headRefName: 'alice/deps' })).securityFix,
    ).toBe('proven');
  });

  it('matches a vendor word only as a prefix — trufflesecurity/trufflehog is nobody\'s marker', () => {
    expect(
      classifyPrSecurity(
        pr({ title: 'Bump trufflesecurity/trufflehog from 3.95.9 to 3.96.0', headRefName: 'ci/trufflesecurity-pin' }),
      ),
    ).toEqual({ dependencyVendor: null, securityFix: null, advisoryIds: [] });
    // Not a prefix either: a branch that merely contains `renovate/`.
    expect(classifyPrSecurity(pr({ headRefName: 'alice/renovate/cleanup' })).dependencyVendor).toBeNull();
  });

  it('never reads ids off a PR that is not a security fix, whatever its text names', () => {
    const r = classifyPrSecurity(pr({ title: 'fix(security): patch CVE-2026-25896', bodyText: 'GHSA-m7jm-9gc2-mpf2' }));
    expect(r).toEqual({ dependencyVendor: null, securityFix: null, advisoryIds: [] });
  });

  it('stops reading a fix PR\'s own ids at the release notes, and only at a heading', () => {
    const fx = prFixture('dependabot-security-footer');
    // The fixture's release notes carry a real GHSA — outside the vendor's own words.
    expect(fx.input.bodyText).toContain('GHSA-c4c3-pg64-4m4v');
    expect(classifyPrSecurity(fx.input).advisoryIds).toEqual([]);
    // Renovate's table cell "pygments (changelog)" precedes its advisory section: not a heading.
    const ren = prFixture('renovate-vulnerability');
    expect(ren.input.bodyText.indexOf('(changelog)')).toBeLessThan(ren.input.bodyText.indexOf('CVE-2026-4539'));
    expect(classifyPrSecurity(ren.input).advisoryIds).toContain('CVE-2026-4539');
  });

  it('cuts at a heading indented with spaces, a tab or a non-breaking space — and only within a line', () => {
    const body = (indent: string) =>
      `This PR will resolve the following CVEs: CVE-2026-1111\n${indent}Release notes\nCVE-2026-2222`;
    for (const indent of ['', '  ', '\t', '\u00a0']) {
      expect(classifyPrSecurity(pr({ title: '[Aikido] x', bodyText: body(indent) })).advisoryIds, JSON.stringify(indent)).toEqual([
        'CVE-2026-1111',
      ]);
    }
  });

  it('sets checkmarx from its label when title, branch and body say nothing', () => {
    expect(classifyPrSecurity(pr({ labels: ['cx-ai-agent'] })).dependencyVendor).toBe('checkmarx');
    expect(classifyPrSecurity(pr({ labels: ['security fix'] })).dependencyVendor).toBeNull();
  });

  it('never infers security for pyup or greenkeeper', () => {
    expect(classifyPrSecurity(pr({ headRefName: 'pyup-scheduled-update-2026-09-01', title: 'Security update' }))).toEqual({
      dependencyVendor: 'pyup',
      securityFix: null,
      advisoryIds: [],
    });
  });

  it('writes a null headRefName as no branch at all', () => {
    expect(classifyPrSecurity(pr({ headRefName: null, title: '[Aikido] Fix 2 security issues in lodash' }))).toEqual({
      dependencyVendor: 'aikido',
      securityFix: 'proven',
      advisoryIds: [],
    });
  });
});

describe('extractAdvisoryIds', () => {
  it('canonicalises: GHSA lowercase groups, ssc- lowercase, the rest uppercase', () => {
    expect(extractAdvisoryIds('cve-2026-1234 ghsa-9QR9-H5GF-34MP rustsec-2024-0001 SSC-0123ABCD-0123-4567-89AB-0123456789AB')).toEqual([
      'CVE-2026-1234',
      'GHSA-9qr9-h5gf-34mp',
      'RUSTSEC-2024-0001',
      'ssc-0123abcd-0123-4567-89ab-0123456789ab',
    ]);
    expect(canonicalAdvisoryId('snyk-js-lodash-567746')).toBe('SNYK-JS-LODASH-567746');
  });

  it('dedupes across spellings, keeping first-seen order by position', () => {
    expect(extractAdvisoryIds('GHSA-9qr9-h5gf-34mp then CVE-2025-66478 then ghsa-9qr9-h5gf-34mp')).toEqual([
      'GHSA-9qr9-h5gf-34mp',
      'CVE-2025-66478',
    ]);
  });

  it('refuses weakness classes, malware and misconfiguration ids', () => {
    expect(extractAdvisoryIds('CWE-79 MAL-2024-1 KSV-001 AVD-AWS-0086 DSA-5000-1')).toEqual([]);
  });

  it('reads a SNYK id with dots and the other allow-listed schemes', () => {
    expect(
      extractAdvisoryIds('SNYK-ALPINE317-OPENSSL-5.1.2-3368755 PYSEC-2024-12 GO-2024-2687 OSV-2020-111 AIKIDO-2026-106840'),
    ).toEqual(['SNYK-ALPINE317-OPENSSL-5.1.2-3368755', 'PYSEC-2024-12', 'GO-2024-2687', 'OSV-2020-111', 'AIKIDO-2026-106840']);
  });

  it('reads SNYK ids in uppercase only — Snyk\'s plugin link is not an advisory', () => {
    // Every Snyk PR-check comment ends with this footer; case-insensitive, it read as an id.
    for (const name of ['snyk-passed', 'snyk-incomplete', 'snyk-failed']) {
      const body = alertBody(name);
      expect(body, name).toContain('snyk-security.snyk-vulnerability-scanner-vs-2022');
      expect(extractAdvisoryIds(body), name).toEqual([]);
    }
    expect(extractAdvisoryIds('snyk-js-lodash-567746')).toEqual([]);
    expect(extractAdvisoryIds('SNYK-JS-LODASH-567746 SNYK-JAVA-ORGAPACHELOGGINGLOG4J-2314720')).toEqual([
      'SNYK-JS-LODASH-567746',
      'SNYK-JAVA-ORGAPACHELOGGINGLOG4J-2314720',
    ]);
  });

  it('caps at 50 distinct ids by default, and at any smaller max', () => {
    const text = Array.from({ length: 60 }, (_, i) => `CVE-2026-${String(10_000 + i)}`).join(' ');
    expect(extractAdvisoryIds(text)).toHaveLength(50);
    expect(extractAdvisoryIds(text, 5)).toEqual(['CVE-2026-10000', 'CVE-2026-10001', 'CVE-2026-10002', 'CVE-2026-10003', 'CVE-2026-10004']);
  });
});

describe('stripQuotedReviewerBlocks', () => {
  it('removes a quoted block with everything nested inside it, and keeps the finding', () => {
    const body = alertBody('coderabbit-web-query-only');
    const stripped = stripQuotedReviewerBlocks(body);
    expect(stripped).not.toContain('GHSA-m7jm-9gc2-mpf2');
    expect(stripped).not.toContain('GHSA-46wh-pxpv-q5gq'); // the Learnings-used quote
    expect(stripped).not.toContain('</details>'); // no half-removed chain left behind
    expect(stripped).toContain('Reject documents whose');
  });

  it('keeps a finding\'s own CVE sentence and its own blocks', () => {
    const body = alertBody('coderabbit-cve-root');
    const stripped = stripQuotedReviewerBlocks(body);
    expect(stripped).toContain('CVE-2026-30827');
    expect(stripped).not.toContain('Script executed');
    const own = '<details>\n<summary>🛡️ Proposed fix</summary>\n\nBump to CVE-free 8.5.2\n</details>';
    expect(stripQuotedReviewerBlocks(own)).toBe(own);
  });

  it('removes a bare Learnt-from paragraph and a fenced one', () => {
    const body = 'Finding.\n\nLearnt from: alice\nLearning: GHSA-46wh-pxpv-q5gq\n\n```\nLearnt from: bob\nCVE-2026-1\n```\nEnd CVE-2026-30827';
    const stripped = stripQuotedReviewerBlocks(body);
    expect(extractAdvisoryIds(stripped)).toEqual(['CVE-2026-30827']);
  });
});

describe('linear on hostile text', () => {
  // Every regex here runs over text anyone can write — a PR body at sync, inside `persistPr`'s
  // transaction, and every comment on read, on every Pending load. Each case below took seconds
  // before its regex was made linear (4.3 s, 1.5 s, 0.5 s…); linear, each takes a few ms. The
  // budget leaves a wide margin either way. 65,536 characters is GitHub's body limit.
  const N = 65_536;
  const BUDGET_MS = 250;
  const time = (f: () => unknown): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const aikido = (bodyText: string): PrSecurityInput => ({ title: '[Aikido] x', headRefName: 'x', labels: [], bodyText });

  it('finds the release-notes heading without re-scanning blank lines', () => {
    for (const [label, body] of [
      ['newlines', '\n'.repeat(N)],
      ['U+2028', '\u2028'.repeat(N)],
      ['U+2029', '\u2029'.repeat(N)],
      ['space + newline', ' \n'.repeat(N / 2)],
      ['nbsp + newline', '\u00a0\n'.repeat(N / 2)],
    ] as const) {
      expect([label, time(() => classifyPrSecurity(aikido(body))) < BUDGET_MS]).toEqual([label, true]);
    }
  });

  it('extracts ids from a wall of every scheme\'s prefix', () => {
    const prefixes = ['CVE-2024-', 'GHSA-', 'RUSTSEC-2024-', 'PYSEC-2024-', 'GO-2024-', 'OSV-2024-', 'SNYK-', 'SNYK-A-', 'AIKIDO-2024-', 'ssc-'];
    // One per scheme, so a new pattern is not silently left out of this test.
    expect(prefixes.filter((p) => !p.startsWith('SNYK-A'))).toHaveLength(ADVISORY_ID_PATTERNS.length);
    for (const p of prefixes) {
      const body = p.repeat(Math.ceil(N / p.length)).slice(0, N);
      expect([p, time(() => extractAdvisoryIds(body)) < BUDGET_MS]).toEqual([p, true]);
    }
  });

  it('strips quoted blocks without re-scanning unclosed tags', () => {
    for (const [label, body] of [
      ['backticks', '`'.repeat(N)],
      ['unclosed <details', '<details'.repeat(8192)],
      ['fence openers', '```a'.repeat(16_000)],
      // Three times GitHub's limit: stored bodies do run longer (117,838 characters on the dev
      // database), and at 65,536 this one's quadratic form still fits the budget.
      ['unclosed <summary>', '<details><summary>'.repeat(3 * 3640)],
    ] as const) {
      expect([label, time(() => stripQuotedReviewerBlocks(body)) < BUDGET_MS]).toEqual([label, true]);
    }
  });

  it('evaluates a person\'s marker-bearing comment and thread roots in bounded time', () => {
    // A Frogbot marker admits ANY author's row, and every thread root is read on its own.
    const wall = 'SNYK-'.repeat(13_000);
    const rows: AlertCandidateRow[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      surface: i === 0 ? 'comment' : 'thread',
      rowId: i + 1,
      prId: 1,
      authorId: 99,
      authorLogin: 'someone',
      body: `Frogbot scanned this pull request. Vulnerable Dependencies ${wall}`,
      createdAt: new Date(0),
      threadId: i === 0 ? null : 100 + i,
      isRoot: i !== 0,
      threadResolved: false,
      threadState: 'untouched',
    }));
    let out: Map<number, unknown> | undefined;
    expect(time(() => (out = evaluateSecurityAlerts(rows, new Set([99]))))).toBeLessThan(BUDGET_MS);
    expect(out!.size).toBe(0);
  });
});

describe('the SQL pre-filter', () => {
  it('admits every alert fixture a rule can fire on, and every clear that supersedes one', () => {
    for (const name of [
      'socket-critical-cve',
      'dependency-review-positive',
      'coderabbit-cve-root',
      'ghas-trivy',
      'frogbot-scan',
      'endor-sca-summary',
      'socket-all-resolved',
      'dependency-review-clean',
    ]) {
      const body = alertBody(name);
      expect(SECURITY_ALERT_PREFILTER.some((s) => body.includes(s)), name).toBe(true);
    }
  });

  it('admits an id of every allow-listed scheme — every alert needs one, so none may be filtered out', () => {
    const oneOfEach = [
      'CVE-2026-1234',
      'GHSA-9qr9-h5gf-34mp',
      'RUSTSEC-2024-0001',
      'PYSEC-2024-12',
      'GO-2024-2687',
      'OSV-2020-111',
      'SNYK-JS-LODASH-567746',
      'AIKIDO-2026-106840',
      'ssc-0123abcd-0123-4567-89ab-0123456789ab',
    ];
    expect(ADVISORY_ID_PATTERNS).toHaveLength(oneOfEach.length);
    for (const id of oneOfEach) {
      expect(extractAdvisoryIds(id), id).toEqual([id]);
      expect(SECURITY_ALERT_PREFILTER.some((s) => id.includes(s)), id).toBe(true);
    }
    // Every rule with a login gate names the tool; the two marker-only rules gate by body alone.
    expect(SECURITY_ALERT_RULES.filter((r) => r.author === null).map((r) => r.source)).toEqual(['frogbot', 'checkmarx']);
  });
});

describe('evaluateSecurityAlerts', () => {
  const SOCKET = 10;
  const GHA = 11;
  const CODERABBIT = 12;
  const GHAS = 13;
  const ENDOR = 14;
  const SNYK = 15;
  const HUMAN = 20;
  const automated: ReadonlySet<number> = new Set([SOCKET, GHA, CODERABBIT, GHAS, ENDOR, SNYK]);
  const LOGIN: Record<number, string> = {
    [SOCKET]: 'socket-security',
    [GHA]: 'github-actions[bot]',
    [CODERABBIT]: 'coderabbitai[bot]',
    [GHAS]: 'github-advanced-security[bot]',
    [ENDOR]: 'endor-labs-pro',
    [SNYK]: 'snyk-io[bot]',
    [HUMAN]: 'alice',
  };
  let seq = 0;
  const row = (
    authorId: number,
    body: string,
    over: Partial<AlertCandidateRow> = {},
  ): AlertCandidateRow => {
    seq += 1;
    return {
      surface: 'comment',
      rowId: seq,
      prId: 1,
      authorId,
      authorLogin: LOGIN[authorId] ?? null,
      body,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, seq)),
      threadId: null,
      isRoot: false,
      threadResolved: false,
      threadState: null,
      ...over,
    };
  };
  const root = (authorId: number, body: string, over: Partial<AlertCandidateRow> = {}): AlertCandidateRow =>
    row(authorId, body, { surface: 'thread', threadId: 500 + seq, isRoot: true, threadState: 'untouched', ...over });
  const alertsOf = (rows: AlertCandidateRow[]) => evaluateSecurityAlerts(rows, automated).get(1) ?? [];

  it('raises a Socket Critical CVE with its GHSA', () => {
    const a = alertsOf([row(SOCKET, alertBody('socket-critical-cve'))]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ source: 'socket', surface: 'comment', authorId: SOCKET, threadId: null });
    expect(a[0]!.advisoryIds).toEqual(['GHSA-9qr9-h5gf-34mp']);
  });

  it('lets the same tool\'s LATER comment clear it ("All alerts resolved")', () => {
    const cve = row(SOCKET, alertBody('socket-critical-cve'));
    const resolved = row(SOCKET, alertBody('socket-all-resolved'));
    expect(alertsOf([cve, resolved])).toEqual([]);
    // Productive: the order is what decides — reversed, the CVE comment is the current one.
    expect(alertsOf([{ ...resolved, createdAt: new Date(0) }, cve])).toHaveLength(1);
  });

  it('lets Socket\'s "All alerts resolved" clear a body that still names a CVE row', () => {
    // The real all-clear names no id, so the id requirement alone would pass the test above. This
    // body keeps the positive row and its GHSA: only the negative marker stops it.
    const cveRow = alertBody('socket-critical-cve');
    const stale = `${alertBody('socket-all-resolved')}\n\n${cveRow}`;
    expect(alertsOf([row(SOCKET, cveRow)])).toHaveLength(1);
    expect(alertsOf([row(SOCKET, stale)])).toEqual([]);
  });

  it('raises nothing for Socket supply-chain alerts that are not CVEs', () => {
    expect(alertsOf([row(SOCKET, alertBody('socket-obfuscated-only'))])).toEqual([]);
  });

  it('reads Socket\'s alerts report and its overview as two comments, whichever was created last', () => {
    for (const overview of ['socket-overview', 'socket-no-dependency-changes']) {
      const before = row(SOCKET, alertBody(overview));
      const report = row(SOCKET, alertBody('socket-critical-cve'));
      // erxes: the overview created four days AFTER the report — once hid the CVE.
      const after = row(SOCKET, alertBody(overview));
      expect(alertsOf([before, report]).map((a) => a.advisoryIds), overview).toEqual([['GHSA-9qr9-h5gf-34mp']]);
      expect(alertsOf([report, after]).map((a) => a.advisoryIds), overview).toEqual([['GHSA-9qr9-h5gf-34mp']]);
      expect(alertsOf([before])).toEqual([]);
    }
    // The report's own clear still clears it, with an overview after it.
    const report = row(SOCKET, alertBody('socket-critical-cve'));
    const resolved = row(SOCKET, alertBody('socket-all-resolved'));
    expect(alertsOf([report, resolved, row(SOCKET, alertBody('socket-overview'))])).toEqual([]);
  });

  it('reads Endor\'s policy summary and its AI security review as two comments', () => {
    const summary = row(ENDOR, alertBody('endor-sca-summary'));
    const review = alertBody('endor-security-review');
    const ids = ['GHSA-rg7c-g689-fr3x', 'GHSA-wqp7-x3pw-xc5r', 'GHSA-82w8-qh3p-5jfq'];
    expect(alertsOf([summary, row(ENDOR, review)]).map((a) => [a.source, a.advisoryIds])).toEqual([['endor', ids]]);
    // A later review that carried Endor's detection sentence would be identified. It must not
    // stand in for the summary…
    const identified = `${review}\nEndor Labs detected 0 issues in this review.`;
    expect(alertsOf([summary, row(ENDOR, identified)]).map((a) => a.source)).toEqual(['endor']);
    // …nor alert in its own right, whatever it names.
    expect(alertsOf([row(ENDOR, `${identified} See GHSA-rg7c-g689-fr3x.`)])).toEqual([]);
  });

  it('reads Dependency Review\'s counts, not its vocabulary', () => {
    expect(alertsOf([row(GHA, alertBody('dependency-review-clean'))])).toEqual([]);
    // Pinned on a body that ALSO carries the positive count and an id: only the clear stops it.
    const positive = alertBody('dependency-review-positive');
    expect(alertsOf([row(GHA, positive.replace('❌ 2 vulnerable package(s)', '✅ 0 vulnerable package(s) ❌ 2 vulnerable package(s)'))])).toEqual([]);
    expect(alertsOf([row(GHA, `${alertBody('dependency-review-clean')}\n${positive}`)])).toEqual([]);
    const a = alertsOf([row(GHA, alertBody('dependency-review-positive'))]);
    expect(a.map((x) => x.source)).toEqual(['dependency_review']);
    expect(a[0]!.advisoryIds).toEqual(['GHSA-9wv6-86v2-598j', 'GHSA-grv7-fg5c-xmjg']);
  });

  it('raises a reviewer\'s own root finding naming a CVE while its thread is live', () => {
    const a = alertsOf([root(CODERABBIT, alertBody('coderabbit-cve-root'))]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ source: 'reviewer', surface: 'thread', advisoryIds: ['CVE-2026-30827'] });
    expect(a[0]!.threadId).not.toBeNull();
  });

  it('clears a thread finding once the thread is resolved or likely addressed', () => {
    const body = alertBody('coderabbit-cve-root');
    expect(alertsOf([root(CODERABBIT, body, { threadResolved: true, threadState: 'resolved' })])).toEqual([]);
    expect(alertsOf([root(CODERABBIT, body, { threadState: 'likely_addressed' })])).toEqual([]);
    expect(alertsOf([root(CODERABBIT, body, { threadState: 'replied_unresolved' })])).toHaveLength(1);
  });

  it('never reads a reply', () => {
    expect(alertsOf([root(CODERABBIT, alertBody('coderabbit-cve-root'), { isRoot: false })])).toEqual([]);
  });

  it('ignores an id that only a quoted web query or learning carries', () => {
    expect(alertsOf([root(CODERABBIT, alertBody('coderabbit-web-query-only'))])).toEqual([]);
  });

  it('consumes every GHAS root, so a CodeQL finding never reaches the reviewer fallback', () => {
    const codeql = alertBody('ghas-codeql');
    expect(alertsOf([root(GHAS, codeql)])).toEqual([]);
    // Productive: the same CodeQL body naming an advisory is still not an alert, because
    // code_scanning identified (consumed) it and only an SCA row is positive.
    expect(alertsOf([root(GHAS, `${codeql}\nSee CVE-2026-1111`)])).toEqual([]);
    // …whereas the reviewer fallback WOULD have raised it for an unclaimed automation author.
    expect(alertsOf([root(CODERABBIT, `${codeql}\nSee CVE-2026-1111`)]).map((a) => a.source)).toEqual(['reviewer']);
  });

  it('raises a Trivy SCA root posted through code scanning', () => {
    const a = alertsOf([root(GHAS, alertBody('ghas-trivy'))]);
    expect(a.map((x) => x.source)).toEqual(['code_scanning']);
    expect(a[0]!.advisoryIds).toEqual(['CVE-2018-18074']);
  });

  it('requires an automation author for every login-gated rule', () => {
    expect(alertsOf([row(HUMAN, alertBody('socket-critical-cve'), { authorLogin: 'socket-security' })])).toEqual([]);
    expect(alertsOf([root(HUMAN, alertBody('coderabbit-cve-root'))])).toEqual([]);
  });

  it('lets a Frogbot marker prove automation whoever posted it', () => {
    const a = alertsOf([row(HUMAN, alertBody('frogbot-scan'))]);
    expect(a.map((x) => x.source)).toEqual(['frogbot']);
    expect(a[0]!.advisoryIds.length).toBeGreaterThan(0);
    expect(a[0]!.advisoryIds.length).toBeLessThanOrEqual(5);
  });

  it('raises for a failed Snyk check only, and only when it names a real advisory', () => {
    // None of Snyk's three real PR-check formats names an id — the footer's plugin link is not one.
    for (const name of ['snyk-passed', 'snyk-incomplete', 'snyk-failed']) {
      expect(alertsOf([row(SNYK, alertBody(name))]), name).toEqual([]);
    }
    const id = '\nSNYK-JS-LODASH-567746';
    expect(alertsOf([row(SNYK, alertBody('snyk-failed') + id)]).map((a) => [a.source, a.advisoryIds])).toEqual([
      ['snyk', ['SNYK-JS-LODASH-567746']],
    ]);
    // The negative and the positive, each pinned on a body that does name one.
    expect(alertsOf([row(SNYK, alertBody('snyk-passed') + id)])).toEqual([]);
    expect(alertsOf([row(SNYK, alertBody('snyk-incomplete') + id)])).toEqual([]);
  });

  it('never lets a person\'s QUOTE of a marker-only tool\'s report stand as that tool\'s alert', () => {
    const scan = alertBody('frogbot-scan');
    const quote = (b: string) => `${b.split('\n').map((l) => `> ${l}`).join('\n')}\n\nthis is fixed`;
    const allClear =
      "[comment]: <> (FrogbotReviewComment)\n\n<div align='center'>\n\n" +
      '[![👍 Frogbot scanned this pull request and did not find any new security issues.](https://raw.githubusercontent.com/jfrog/frogbot/master/resources/v2/noVulnerabilityBannerPR.png)](https://jfrog.com/help/r/jfrog-security-user-guide/shift-left-on-security/frogbot)\n\n</div>';
    // A new all-clear from the tool after a person quoted its report.
    expect(alertsOf([row(GHA, scan), row(HUMAN, quote(scan)), row(GHA, allClear)])).toEqual([]);
    // The tool's sticky comment EDITED in place to the all-clear: its row keeps the older time.
    expect(alertsOf([row(GHA, allClear), row(HUMAN, quote(scan))])).toEqual([]);
    // Checkmarx, the other marker-only rule.
    const cx = '**Checkmarx One – Scan Summary & Details**\n\n| Severity | Issue |\n|---|---|\n| High | CVE-2024-45296 in path-to-regexp |';
    expect(alertsOf([row(HUMAN, cx)]).map((a) => a.source)).toEqual(['checkmarx']);
    expect(alertsOf([row(HUMAN, quote(cx))])).toEqual([]);
    // A thread root quoting the report is not a Frogbot finding either.
    expect(alertsOf([root(HUMAN, quote(scan))])).toEqual([]);
  });

  it('clears a thread resolved on GitHub even before its derived state says so', () => {
    const body = alertBody('coderabbit-cve-root');
    expect(alertsOf([root(CODERABBIT, body, { threadResolved: true, threadState: null })])).toEqual([]);
    expect(alertsOf([root(CODERABBIT, body, { threadState: null })])).toHaveLength(1);
  });

  it('breaks a same-second tie between a tool\'s comments by row id', () => {
    const at = new Date(Date.UTC(2026, 8, 2));
    const cve = row(SOCKET, alertBody('socket-critical-cve'), { createdAt: at, rowId: 1_001 });
    const resolved = row(SOCKET, alertBody('socket-all-resolved'), { createdAt: at, rowId: 1_002 });
    expect(alertsOf([cve, resolved])).toEqual([]);
    expect(alertsOf([{ ...cve, rowId: 1_003 }, resolved])).toHaveLength(1);
  });

  it('never raises for a row with no author', () => {
    expect(alertsOf([row(SOCKET, alertBody('socket-critical-cve'), { authorId: null })])).toEqual([]);
  });

  it('alerts on the rows Postgres\'s case-sensitive LIKE returns, not the extra ones SQLite\'s does', () => {
    // SQLite also returns a finding that names only a lowercase `cve-…`; Postgres never does.
    const lower = 'This version is affected by cve-2026-30827. Upgrade to 8.5.2.';
    expect(alertsOf([root(CODERABBIT, lower)])).toEqual([]);
    expect(alertsOf([root(CODERABBIT, lower.replace('cve-', 'CVE-'))]).map((a) => a.advisoryIds)).toEqual([
      ['CVE-2026-30827'],
    ]);
  });

  it('keys every alert by its own PR and lists them newest first', () => {
    const rows = [
      row(SOCKET, alertBody('socket-critical-cve'), { prId: 1 }),
      root(CODERABBIT, alertBody('coderabbit-cve-root'), { prId: 1 }),
      row(SOCKET, alertBody('socket-critical-cve'), { prId: 2 }),
    ];
    const byPr = evaluateSecurityAlerts(rows, automated);
    expect([...byPr.keys()].sort()).toEqual([1, 2]);
    expect(byPr.get(1)!.map((a) => a.source)).toEqual(['reviewer', 'socket']);
    expect(byPr.get(2)!.every((a) => a.prId === 2)).toBe(true);
  });
});
