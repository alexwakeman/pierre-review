// Reports → This sprint: the copy helper (lib/copy.ts) — Markdown shapes, HTML escaping, and the
// plain-text fallback.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/copy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SPRINT_CHECKS_DEFAULT,
  applyStoryIssueChecks,
  foldStoryIssues,
  storyIssueBullet,
  type SprintAssessmentBody,
  type SprintTicketRow,
} from '@pierre-review/shared';
import {
  blocksMarkdown,
  copyRich,
  markdownToClipboardHtml,
  sprintBulletMarkdown,
  sprintSpecGapLineMarkdown,
  sprintCodeCheckMarkdown,
  ticketCopyAllMarkdown,
  ticketHeader,
} from '../src/lib/copy.js';

const CRITERIA = ['Users get a link'];
// Criterion 1 not testable, one spec gap: one chip issue, and the gap in its own section.
const ALL = foldStoryIssues({
  criteria: CRITERIA,
  label: {
    criteria: [{ n: 1, testable: false, reason: 'no expected result' }],
    story: { dependencies: [], gaps: [{ type: 'rule', text: 'No rule for how long a link lasts' }] },
  },
});
const ISSUES = ALL.filter((i) => i.id !== 'spec_gaps');
const GAPS = ALL.find((i) => i.id === 'spec_gaps')!.gaps;
const GAPS_MD = '**Spec gaps**\n\n- Business rule: No rule for how long a link lasts';

function body(over: Partial<SprintAssessmentBody> = {}): SprintAssessmentBody {
  return {
    mode: 'plan',
    plan: [],
    criterionChecks: [],
    coverage: null,
    summary: 'This may already be done: src/auth/link.ts sends the link.',
    findings: [{ issue: 'unclear_done', rule: 'no_expected_result', quote: null, where: null, text: 'Say how long a link lasts.', suggestion: null, ref: { repo: 'acme/web', path: 'src/auth/link.ts' } }],
    revisedCriteria: ['A user receives a link within a minute'],
    revisedDescription: null,
    ...over,
  };
}

function ticket(over: Partial<SprintTicketRow> = {}): SprintTicketRow {
  return {
    ident: 'jira:https://acme.atlassian.net#ACME-2',
    key: 'ACME-2',
    title: 'Sign in with a link',
    url: 'https://acme.atlassian.net/browse/ACME-2',
    provider: 'jira',
    phase: 'in_progress',
    stage: 'writing',
    status: null,
    issueType: null,
    assignee: null,
    epic: null,
    description: '',
    acceptanceCriteria: '- Users get a link',
    acField: { id: 'customfield_1', name: 'Acceptance Criteria' },
    criteria: { items: CRITERIA, source: 'acceptance_criteria' },
    labels: 'current',
    issues: ISSUES,
    specGaps: GAPS,
    flagCount: ISSUES.length,
    pullRequests: [],
    repos: { accepted: [], suggested: [] },
    assessment: null,
    replaceTarget: { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'Acceptance Criteria' },
    replaceBases: { description: { hash: '0'.repeat(64), truncated: false }, acceptanceCriteria: null },
    lastWrite: null,
    ...over,
  };
}

function succeeded(b: SprintAssessmentBody | null, over: { outdated?: boolean; status?: 'succeeded' | 'running' } = {}): SprintTicketRow['assessment'] {
  return {
    currency: 'current',
    record: {
      id: 1,
      workspaceId: 1,
      ident: 'x',
      model: 'claude-sonnet-5',
      status: over.status ?? 'succeeded',
      mode: 'plan',
      phase: null,
      repos: [],
      body: b,
      outdated: over.outdated ?? false,
      dropped: null,
      error: null,
      costUsd: null,
      numTurns: null,
      createdAt: '2026-10-01T00:00:00Z',
      completedAt: '2026-10-01T00:01:00Z',
    },
  };
}

describe('markdown composers', () => {
  it('ticketHeader is "## KEY — Title" on one line', () => {
    expect(ticketHeader('ACME-2', 'Sign in\nwith a link')).toBe('## ACME-2 — Sign in with a link');
    expect(ticketHeader('ACME-2', '  ')).toBe('## ACME-2');
  });

  it('a bullet is one line: bold issue label, the sentence, the path in backticks', () => {
    expect(sprintBulletMarkdown({ id: 'spec_gaps', text: 'No error copy.\nNow.', source: 'code', ref: null })).toBe(
      '**Spec gaps**: No error copy. Now.',
    );
    expect(
      sprintBulletMarkdown({ id: 'unclear_done', text: 'Say how long.', source: 'claude', ref: { repo: 'acme/web', path: 'src/a.ts' } }),
    ).toBe('**Unclear when done**: Say how long. (`src/a.ts` in `acme/web`)');
  });

  it('copy all without an assessment: header, link, one bullet per issue, then the spec gap (not started only)', () => {
    // Under way: no spec gaps.
    expect(ticketCopyAllMarkdown(ticket(), SPRINT_CHECKS_DEFAULT)).not.toContain('Spec gaps');
    expect(ticketCopyAllMarkdown(ticket({ stage: 'not_started', phase: 'not_started' }), SPRINT_CHECKS_DEFAULT)).toBe(
      [
        '## ACME-2 — Sign in with a link',
        'https://acme.atlassian.net/browse/ACME-2',
        `- **Unclear when done**: ${storyIssueBullet(ISSUES[0]!)}`,
        GAPS_MD,
      ].join('\n\n'),
    );
  });

  it('copy all lists the first two unclear criteria, then "and N more"', () => {
    const unclear = {
      id: 'unclear_done' as const,
      total: 5,
      reasons: ['untestable' as const],
      criteria: [
        { n: 1, reason: 'vague' },
        { n: 3, reason: 'no result' },
        { n: 4, reason: 'x' },
      ],
      blockers: [],
      gaps: [],
    };
    expect(ticketCopyAllMarkdown(ticket({ issues: [unclear] }), SPRINT_CHECKS_DEFAULT)).toContain(
      '- **Unclear when done**: Criterion 1: vague · Criterion 3: no result and 1 more',
    );
  });

  it('one spec gap copies as one line with its type', () => {
    expect(sprintSpecGapLineMarkdown({ text: 'No rule.', type: 'rule', source: 'code', ref: null })).toBe('**Spec gap**: Business rule: No rule.');
    expect(sprintSpecGapLineMarkdown({ text: 'Say it.', type: null, source: 'claude', ref: { repo: 'a/b', path: 'x.ts' } })).toBe(
      '**Spec gap**: Say it. (`x.ts` in `a/b`)',
    );
  });

  it("copy all with an assessment: the summary, then Claude's sentence replaces the template", () => {
    const md = ticketCopyAllMarkdown(ticket({ stage: 'not_started', phase: 'not_started', assessment: succeeded(body()) }), SPRINT_CHECKS_DEFAULT);
    expect(md).toBe(
      [
        '## ACME-2 — Sign in with a link',
        'https://acme.atlassian.net/browse/ACME-2',
        'This may already be done: src/auth/link.ts sends the link.',
        `- **Unclear when done**: Say how long a link lasts. (\`src/auth/link.ts\` in \`acme/web\`)`,
        GAPS_MD,
      ].join('\n\n'),
    );
  });

  it('copy all follows the checks, and ignores running / outdated runs and unsafe links', () => {
    // The server sends `issues` already filtered; the checks also drop Claude's sentence for an issue
    // switched off.
    const checks = { off: ['spec_gaps' as const], issueTypes: [] };
    const claudeScope = body({ findings: [{ issue: 'spec_gaps', rule: 'edge_case', quote: null, where: null, text: 'Say it is CSV only.', suggestion: null, ref: null }] });
    const off = ticketCopyAllMarkdown(
      ticket({ issues: applyStoryIssueChecks(ISSUES, checks, null), assessment: succeeded(claudeScope) }),
      checks,
    );
    expect(off).not.toContain('Spec gaps');
    expect(off).toContain('Unclear when done');
    // A type the checks do not cover: header, link and summary — no bullets, not even Claude's.
    expect(
      ticketCopyAllMarkdown(ticket({ issueType: 'Bug', issues: [], specGaps: [], assessment: succeeded(body()) }), { off: [], issueTypes: ['Story'] }),
    ).toBe(
      '## ACME-2 — Sign in with a link\n\nhttps://acme.atlassian.net/browse/ACME-2\n\nThis may already be done: src/auth/link.ts sends the link.',
    );
    expect(ticketCopyAllMarkdown(ticket({ assessment: succeeded(null, { status: 'running' }) }), SPRINT_CHECKS_DEFAULT)).not.toContain(
      'may already be done',
    );
    expect(ticketCopyAllMarkdown(ticket({ assessment: succeeded(null, { outdated: true }) }), SPRINT_CHECKS_DEFAULT)).not.toContain(
      'may already be done',
    );
    // ⚠ A STALE run puts nothing in Copy all: no summary, no sentence of its own.
    const stale = { ...succeeded(body({ findings: [{ issue: 'spec_gaps', rule: 'edge_case', quote: null, where: null, text: 'Say it is CSV only.', suggestion: null, ref: null }] }))!, currency: 'stale' as const };
    const staleMd = ticketCopyAllMarkdown(ticket({ issues: [], specGaps: [], assessment: stale }), SPRINT_CHECKS_DEFAULT);
    expect(staleMd).toBe('## ACME-2 — Sign in with a link\n\nhttps://acme.atlassian.net/browse/ACME-2');
    // A javascript: URL is never copied as the ticket link.
    expect(ticketCopyAllMarkdown(ticket({ url: 'javascript:alert(1)' }), SPRINT_CHECKS_DEFAULT)).not.toContain('javascript:');
  });

  it('the code check copies its summary and its list: a plan, or each criterion with its pill word and test', () => {
    const plan = body({
      summary: 'Two changes.',
      plan: [
        { repo: 'acme/web', path: 'src/auth/link.ts', newPath: null, change: 'Add an expiry.' },
        { repo: 'acme/web', path: null, newPath: 'src/auth/expired.tsx', change: 'Add a page.' },
        { repo: 'acme/api', path: null, newPath: null, change: 'Store the expiry.' },
      ],
    });
    expect(sprintCodeCheckMarkdown(plan, [])).toBe(
      'Two changes.\n\n- `acme/web` `src/auth/link.ts`: Add an expiry.\n- `acme/web` new `src/auth/expired.tsx`: Add a page.\n- `acme/api`: Store the expiry.',
    );
    const verify = body({
      mode: 'verify',
      summary: 'One of two met.',
      criterionChecks: [
        { n: 1, status: 'met', evidence: 'Sends the link.', ref: { repo: 'acme/web', path: 'src/auth/link.ts' }, tests: { repo: 'acme/web', path: 'test/link.test.ts' } },
        { n: 2, status: 'not_met', evidence: 'No expiry.', ref: null, tests: null },
      ],
      coverage: 'Only criterion 1 has a test.',
    });
    expect(sprintCodeCheckMarkdown(verify, ['Users get a link', 'The link expires'])).toBe(
      [
        'One of two met.',
        '- Criterion 1 “Users get a link” (Met): Sends the link. `src/auth/link.ts` · test `test/link.test.ts`\n- Criterion 2 “The link expires” (Not met): No expiry. · no test found\n\nOnly criterion 1 has a test.',
      ].join('\n\n'),
    );
    // Copy all carries a CURRENT run's list after its summary.
    expect(ticketCopyAllMarkdown(ticket({ issues: [], specGaps: [], assessment: succeeded(plan) }), SPRINT_CHECKS_DEFAULT)).toContain(
      'Two changes.\n\n- `acme/web` `src/auth/link.ts`: Add an expiry.',
    );
  });

  it('blocksMarkdown skips empty blocks', () => {
    expect(blocksMarkdown([{ heading: 'A', markdown: 'x' }, { heading: 'B', markdown: ' ' }, { markdown: 'y' }])).toBe('### A\n\nx\n\ny');
  });
});

describe('markdownToClipboardHtml', () => {
  it('renders headings, lists, bold, code and https links', () => {
    const html = markdownToClipboardHtml('## ACME-2 — Title\n\n**Bold** and `a/b.ts` [link](https://x.test/a?b=1&c=2)\n\n- one\n- two');
    expect(html).toContain('<h2>ACME-2 — Title</h2>');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>a/b.ts</code>');
    expect(html).toContain('<a href="https://x.test/a?b=1&amp;c=2">link</a>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  it('nests lists by indentation and closes every list', () => {
    const html = markdownToClipboardHtml('1. first\n   - `p.ts` in `r`\n   - note\n2. second');
    expect(html).toBe('<ol><li>first<ul><li><code>p.ts</code> in <code>r</code></li><li>note</li></ul></li><li>second</li></ol>');
    const opens = (html.match(/<(ul|ol)>/g) ?? []).length;
    const closes = (html.match(/<\/(ul|ol)>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('escapes HTML — a <script> in ticket text stays text', () => {
    const html = markdownToClipboardHtml('Title <script>alert("x")</script> & <b>\n\n- <img src=x onerror=1>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;');
  });

  it('never links a javascript: URL, and escapes inside code', () => {
    const html = markdownToClipboardHtml('[x](javascript:alert(1)) `<b>`');
    expect(html).not.toContain('href');
    expect(html).toContain('<code>&lt;b&gt;</code>');
  });

  it('keeps fenced code as preformatted text', () => {
    expect(markdownToClipboardHtml('```\n<a> **b**\n```')).toBe('<pre><code>&lt;a&gt; **b**</code></pre>');
  });
});

describe('copyRich', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes text/plain + text/html through ClipboardItem when available', async () => {
    const written: Array<Record<string, Blob>> = [];
    class FakeItem {
      constructor(public items: Record<string, Blob>) {
        written.push(items);
      }
    }
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { clipboard: { write, writeText } });
    expect(await copyRich('**Hi** <x>')).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(Object.keys(written[0]!).sort()).toEqual(['text/html', 'text/plain']);
    expect(await written[0]!['text/plain']!.text()).toBe('**Hi** <x>');
    expect(await written[0]!['text/html']!.text()).toBe('<p><strong>Hi</strong> &lt;x&gt;</p>');
  });

  it('falls back to plain markdown when ClipboardItem is undefined', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyRich('- a')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('- a');
  });

  it('falls back to plain markdown when the rich write is refused', async () => {
    class FakeItem {
      constructor(public items: Record<string, Blob>) {}
    }
    const write = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { clipboard: { write, writeText } });
    expect(await copyRich('x')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('x');
  });

  it('copies nothing for empty text', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyRich('  ')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
