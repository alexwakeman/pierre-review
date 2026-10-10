// Reports → This sprint: the copy helper (lib/copy.ts) — Markdown shapes, HTML escaping, and the
// plain-text fallback.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/copy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sprintChipFix, type SprintAssessmentBody, type SprintTicketRow } from '@pierre-review/shared';
import {
  assessmentSectionMarkdown,
  blocksMarkdown,
  chipFixesMarkdown,
  chipFixMarkdown,
  copyRich,
  markdownToClipboardHtml,
  ticketCopyAllMarkdown,
  ticketHeader,
} from '../src/lib/copy.js';

function body(over: Partial<SprintAssessmentBody> = {}): SprintAssessmentBody {
  return {
    criteria: [
      {
        n: 1,
        criterion: 'Users get a link',
        testableAgainstCode: true,
        landsIn: [{ repo: 'acme/web', path: 'src/auth/link.ts', symbol: 'sendLink' }],
        existing: 'partial',
        note: 'Sending exists.',
      },
    ],
    gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: ['A new column'], edgeCases: ['Expired link'] },
    suggestion: {
      rewrittenCriteria: [{ n: 1, text: 'A user receives a link within a minute' }],
      addedCriteria: ['An expired link says so'],
      split: [{ title: 'Email part', criteria: ['Send it'] }],
      questionsForOwner: ['How long does a link last?'],
      summary: 'Mostly clear.',
    },
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
    criteria: { items: ['Users get a link'], source: 'acceptance_criteria' },
    labels: 'current',
    chips: [
      { id: 'no_persona', criterion: null, fix: sprintChipFix('no_persona', null) },
      {
        id: 'criterion_not_testable',
        criterion: { n: 1, text: 'Users get a link' },
        fix: sprintChipFix('criterion_not_testable', { n: 1, text: 'Users get a link' }),
      },
    ],
    flagCount: 2,
    pullRequests: [],
    repos: { accepted: [], suggested: [] },
    assessment: null,
    replaceTarget: { kind: 'ac_field', fieldId: 'customfield_1', fieldName: 'Acceptance Criteria' },
    replaceBase: { hash: '0'.repeat(64), truncated: false },
    lastWrite: null,
    ...over,
  };
}

function succeeded(b: SprintAssessmentBody): SprintTicketRow['assessment'] {
  return {
    currency: 'current',
    record: {
      id: 1,
      workspaceId: 1,
      ident: 'x',
      model: 'claude-sonnet-5',
      status: 'succeeded',
      phase: null,
      repos: [],
      body: b,
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

  it('chip fixes are bullets naming the chip, the criterion number and its text', () => {
    const t = ticket();
    expect(chipFixMarkdown(t.chips[1]!)).toBe(
      `**Not testable** (criterion 1: "Users get a link"): ${sprintChipFix('criterion_not_testable', { n: 1, text: 'Users get a link' })}`,
    );
    const md = chipFixesMarkdown(t);
    expect(md.startsWith('**What to fix**\n\n- **No persona**: ')).toBe(true);
    expect(md.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(chipFixesMarkdown(ticket({ chips: [] }))).toBe('');
  });

  it('criteria section puts file paths and repos in backticks', () => {
    const md = assessmentSectionMarkdown('criteria', ticket(), body());
    expect(md).toContain('1. Users get a link');
    expect(md).toContain('   - Partly in the code · Testable against the code');
    expect(md).toContain('   - `src/auth/link.ts` in `acme/web` (`sendLink`)');
    expect(md).toContain('   - Sending exists.');
  });

  it('gaps lists only non-empty gaps, empty when none', () => {
    const md = assessmentSectionMarkdown('gaps', ticket(), body());
    expect(md).toBe('**Data or migration impact**\n\n- A new column\n\n**Edge cases**\n\n- Expired link');
    const none = body({ gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: [], edgeCases: [] } });
    expect(assessmentSectionMarkdown('gaps', ticket(), none)).toBe('');
  });

  it('suggestion merges rewritten and added criteria, and the split', () => {
    const md = assessmentSectionMarkdown('suggestion', ticket(), body());
    expect(md).toContain('Mostly clear.');
    expect(md).toContain('**Proposed acceptance criteria**\n\n- A user receives a link within a minute\n- An expired link says so');
    expect(md).toContain('**Proposed split**\n\n- Email part\n  - Send it');
  });

  it('questions section', () => {
    expect(assessmentSectionMarkdown('questions', ticket(), body())).toBe(
      '**Questions for the owner**\n\n- How long does a link last?',
    );
  });

  it('copy all: header, link, fixes, then every assessment section of a SUCCEEDED run', () => {
    const md = ticketCopyAllMarkdown(ticket({ assessment: succeeded(body()) }));
    const order = ['## ACME-2 — Sign in with a link', 'https://acme.atlassian.net/browse/ACME-2', '**What to fix**', '**Criteria against the code**', '**Edge cases**', '**Proposed acceptance criteria**', '**Questions for the owner**'];
    let at = -1;
    for (const o of order) {
      const i = md.indexOf(o);
      expect(i, o).toBeGreaterThan(at);
      at = i;
    }
    // A javascript: URL is never copied as the ticket link.
    expect(ticketCopyAllMarkdown(ticket({ url: 'javascript:alert(1)' }))).not.toContain('javascript:');
    // A running assessment contributes nothing.
    const running = succeeded(body())!;
    running.record = { ...running.record, status: 'running', body: null };
    expect(ticketCopyAllMarkdown(ticket({ assessment: running }))).not.toContain('Criteria against the code');
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
