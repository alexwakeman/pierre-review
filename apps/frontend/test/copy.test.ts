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
  ticketCopyAllMarkdown,
  ticketHeader,
} from '../src/lib/copy.js';

const CRITERIA = ['Users get a link'];
// Criterion 1 not testable, no out-of-scope line: two issues.
const ISSUES = foldStoryIssues({
  criteria: CRITERIA,
  label: {
    criteria: [{ n: 1, testable: false, bundled: false, dependsOnOtherWork: false }],
    story: { outOfScopeStated: false, dependencyNamed: true, nonCodeWork: false },
  },
});

function body(over: Partial<SprintAssessmentBody> = {}): SprintAssessmentBody {
  return {
    summary: 'This may already be done: src/auth/link.ts sends the link.',
    issues: [{ id: 'unclear_done', text: 'Say how long a link lasts.', ref: { repo: 'acme/web', path: 'src/auth/link.ts' } }],
    revisedCriteria: ['A user receives a link within a minute'],
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
    flagCount: ISSUES.length,
    pullRequests: [],
    repos: { accepted: [], suggested: [] },
    assessment: null,
    replaceTarget: { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'Acceptance Criteria' },
    replaceBase: { hash: '0'.repeat(64), truncated: false },
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
    expect(sprintBulletMarkdown({ id: 'scope_unstated', text: 'Add a line.\nNow.', source: 'code', ref: null })).toBe(
      '**Scope not stated**: Add a line. Now.',
    );
    expect(
      sprintBulletMarkdown({ id: 'unclear_done', text: 'Say how long.', source: 'claude', ref: { repo: 'acme/web', path: 'src/a.ts' } }),
    ).toBe('**Unclear when done**: Say how long. (`src/a.ts` in `acme/web`)');
  });

  it('copy all without an assessment: header, link, one bullet per issue', () => {
    expect(ticketCopyAllMarkdown(ticket(), SPRINT_CHECKS_DEFAULT)).toBe(
      [
        '## ACME-2 — Sign in with a link',
        'https://acme.atlassian.net/browse/ACME-2',
        `- **Unclear when done**: ${storyIssueBullet(ISSUES[0]!)}\n- **Scope not stated**: ${storyIssueBullet(ISSUES[1]!)}`,
      ].join('\n\n'),
    );
  });

  it("copy all with an assessment: the summary, then Claude's sentence replaces the template", () => {
    const md = ticketCopyAllMarkdown(ticket({ assessment: succeeded(body()) }), SPRINT_CHECKS_DEFAULT);
    expect(md).toBe(
      [
        '## ACME-2 — Sign in with a link',
        'https://acme.atlassian.net/browse/ACME-2',
        'This may already be done: src/auth/link.ts sends the link.',
        `- **Unclear when done**: Say how long a link lasts. (\`src/auth/link.ts\` in \`acme/web\`)\n- **Scope not stated**: ${storyIssueBullet(ISSUES[1]!)}`,
      ].join('\n\n'),
    );
  });

  it('copy all follows the checks, and ignores running / outdated runs and unsafe links', () => {
    // The server sends `issues` already filtered; the checks also drop Claude's sentence for an issue
    // switched off.
    const checks = { off: ['scope_unstated' as const], issueTypes: [] };
    const claudeScope = body({ issues: [{ id: 'scope_unstated', text: 'Say it is CSV only.', ref: null }] });
    const off = ticketCopyAllMarkdown(
      ticket({ issues: applyStoryIssueChecks(ISSUES, checks, null), assessment: succeeded(claudeScope) }),
      checks,
    );
    expect(off).not.toContain('Scope not stated');
    expect(off).toContain('Unclear when done');
    // A type the checks do not cover: header, link and summary — no bullets, not even Claude's.
    expect(
      ticketCopyAllMarkdown(ticket({ issueType: 'Bug', issues: [], assessment: succeeded(body()) }), { off: [], issueTypes: ['Story'] }),
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
    const stale = { ...succeeded(body({ issues: [{ id: 'scope_unstated', text: 'Say it is CSV only.', ref: null }] }))!, currency: 'stale' as const };
    const staleMd = ticketCopyAllMarkdown(ticket({ issues: [], assessment: stale }), SPRINT_CHECKS_DEFAULT);
    expect(staleMd).toBe('## ACME-2 — Sign in with a link\n\nhttps://acme.atlassian.net/browse/ACME-2');
    // A javascript: URL is never copied as the ticket link.
    expect(ticketCopyAllMarkdown(ticket({ url: 'javascript:alert(1)' }), SPRINT_CHECKS_DEFAULT)).not.toContain('javascript:');
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
