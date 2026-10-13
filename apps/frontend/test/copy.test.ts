// Reports → This sprint: the copy helper (lib/copy.ts) — Markdown shapes, HTML escaping, and the
// plain-text fallback.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/copy.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SprintAssessmentBody } from '@pierre-review/shared';
import { blocksMarkdown, copyRich, markdownToClipboardHtml, sprintCodeCheckMarkdown, ticketHeader } from '../src/lib/copy.js';

function body(over: Partial<SprintAssessmentBody> = {}): SprintAssessmentBody {
  return { mode: 'plan', plan: [], criterionChecks: [], coverage: null, summary: 'Summary.', ...over };
}

describe('markdown composers', () => {
  it('ticketHeader is "## KEY — Title" on one line', () => {
    expect(ticketHeader('ACME-2', 'Sign in\nwith a link')).toBe('## ACME-2 — Sign in with a link');
    expect(ticketHeader('ACME-2', '  ')).toBe('## ACME-2');
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
