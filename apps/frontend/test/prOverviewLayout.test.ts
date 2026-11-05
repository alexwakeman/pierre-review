// PR detail: Overview + header layout.
//   • The strip starts Overview · Activity · Threads · Changes. Activity holds the conversation (the
//     old Comments tab, whose `?prTab=comments` reads as Activity); Overview has no Activity section.
//   • The Checks row is ONE collapsed summary line (the Default branches strip's pills).
//   • Ticket and branch share one row.
//   • The header's meta line is 14px, repo before author.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChecksSummary, checksSummaryCounts, PrTicketLine } from '../src/components/ChecksTab.js';
import { PR_DETAIL_TABS } from '../src/store/filters.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');

describe('PR detail tabs', () => {
  it('lists Activity, Threads, Changes right after Overview; no Comments tab', () => {
    const s = src('components/PrDetail.tsx');
    // The redesign builds the strip from `tabIds` (fed to the Tabs primitive).
    const strip = s.slice(s.indexOf('const tabIds: Tab[] = [') + 'const tabIds: Tab[] = ['.length);
    expect(strip.length).toBeGreaterThan(0);
    const list = strip.slice(0, strip.indexOf(']'));
    expect(list).toMatch(/'overview',\s*'activity',\s*'threads',\s*'changes'/);
    expect(list).not.toContain("'comments'");
    expect(PR_DETAIL_TABS as readonly string[]).not.toContain('comments');
  });

  it('Activity is a screen of its own; Overview carries no Activity section', () => {
    const s = src('components/PrDetail.tsx');
    expect(s).not.toMatch(/tab === 'activity'\s*\?\s*'overview'/);
    expect(s).not.toContain('ActivitySection');
    expect(s).toContain("effectiveTab === 'activity' ? (");
    // A PR-comment deep link lands on Activity.
    expect(s).toContain("seedTab('activity')");
    expect(s).not.toContain("seedTab('comments')");
  });

  // The redesign's type scale (docs/redesign/DESIGN.md): the meta line is body text (13px), the
  // old 14px `text-sm` is gone. It still names the repo before the author.
  it('the header meta line is body text and names the repo before the author', () => {
    const s = src('components/PrDetail.tsx');
    const at = s.indexOf('data-testid="pr-header-meta"');
    expect(at).toBeGreaterThan(0);
    const block = s.slice(at - 200, s.indexOf('data-testid="pr-header-review-line"'));
    expect(block).toContain('text-body');
    expect(block).not.toMatch(/className="mt-1 flex items-center gap-2 text-xs/);
    expect(block.indexOf('pr.repoFullName')).toBeLessThan(block.indexOf('<UserName'));
  });

  // Three lines: title, then state (a pill) · CI · repo · author · opened, then the review line —
  // GitHub's review decision FIRST, then size, reach, chips and the flags.
  it('the state is a pill, and a third line starts with the review decision', () => {
    const s = src('components/PrDetail.tsx');
    const meta = s.indexOf('data-testid="pr-header-meta"');
    const line3 = s.indexOf('data-testid="pr-header-review-line"');
    expect(meta).toBeGreaterThan(0);
    expect(line3).toBeGreaterThan(meta);
    const line2 = s.slice(meta, line3);
    expect(line2).toContain('data-testid="pr-header-state"');
    expect(line2).toMatch(/rounded-ui bg-ui-raise px-1\.5 py-0\.5/);
    expect(line2).toContain('opened {relativeTime(pr.openedAt)}');
    // Everything after "opened" moved down.
    expect(line2).not.toContain('<BlastRadiusChip');
    expect(line2).not.toContain('Stalled');
    const rest = s.slice(line3);
    expect(rest.indexOf('<ReviewDecisionPill')).toBeGreaterThan(0);
    expect(rest.indexOf('<ReviewDecisionPill')).toBeLessThan(rest.indexOf('<BlastRadiusChip'));
    // Always rendered: the pill always says something.
    expect(s).not.toContain('headerLine3');
  });
});

describe('Overview sections', () => {
  it('runs Can it land → AI review → Checks → People → About, with no Meta row', () => {
    const s = src('components/ChecksTab.tsx');
    const body = s.slice(s.indexOf('export function ChecksTab('));
    const order = [
      '<Section title="Can it land">',
      '<Row label="Status">',
      '<Row label="Actions">',
      '{aiReview}',
      '<Section title="Checks">',
      '<Section title="People">',
      '<Row label="Reviews">',
      '<Section title="About">',
      '<Row label="Ticket">',
      '<Row label="Merged by">',
      '<PrSummary',
    ];
    const at = order.map((m) => body.indexOf(m));
    for (const [i, a] of at.entries()) expect(a, order[i]).toBeGreaterThan(0);
    for (let i = 1; i < at.length; i++) expect(at[i], order[i]).toBeGreaterThan(at[i - 1]!);
    expect(body).not.toContain('<Row label="Meta">');
    // The narrow label column and the width cap.
    expect(s).toContain('sm:w-20 sm:pt-0.5');
    expect(s).not.toContain('sm:w-28');
    expect(body).toContain('max-w-[46rem]');
    // Only an open CI log's text box reaches past the cap, through the outer size container.
    expect(body).toContain('[container-type:inline-size]');
    expect(body).not.toContain('max-w-none');
    expect(readFileSync(new URL('../src/components/CheckList.tsx', import.meta.url), 'utf8')).toContain('w-[calc(100cqw-2rem)]');
  });

  it('the AI review is its own card on the AI surface, with a real heading', () => {
    const card = src('components/pr/PrOverviewAiReview.tsx');
    expect(card).toMatch(/border-ai-border bg-ai-surface/);
    const ai = src('components/Activity/OpenPrsAiReview.tsx');
    expect(ai).toMatch(/<SparkleIcon[^>]*text-ai-signal[^>]*\/>\s*AI review/);
  });
});

describe('Check rows with a log', () => {
  it('the name opens the log; a separate small link goes to GitHub', () => {
    const s = src('components/CheckList.tsx');
    const split = s.slice(s.indexOf('An Actions check carries BOTH affordances'));
    const nameBtn = split.indexOf('{check.name}\n        </button>');
    expect(nameBtn).toBeGreaterThan(0);
    const link = split.indexOf('<ExternalLinkIcon size={11} />');
    expect(link).toBeGreaterThan(nameBtn);
    // The name's button toggles the same log the row's button does.
    expect(split.slice(0, nameBtn)).toContain('onClick={toggle}');
  });
});

describe('Checks summary', () => {
  it('counts passed / failing (failure + error) / running, total includes the rest', () => {
    expect(
      checksSummaryCounts([
        { state: 'success' },
        { state: 'success' },
        { state: 'failure' },
        { state: 'error' },
        { state: 'pending' },
        { state: 'skipped' },
      ]),
    ).toEqual({ passed: 2, failing: 2, running: 1, total: 6 });
  });

  it('arrives collapsed, one pill per state that exists', () => {
    const html = renderToStaticMarkup(
      createElement(
        ChecksSummary,
        { checks: [{ state: 'success' }, { state: 'failure' }] },
        createElement('div', { 'data-testid': 'list' }),
      ),
    );
    const t = textOf(html);
    expect(html).toContain('aria-expanded="false"');
    expect(t).toContain('1 passed');
    expect(t).toContain('1 failing');
    expect(t).not.toContain('running');
    expect(t).toContain('2 checks');
    expect(html).not.toContain('data-testid="list"');
  });

  it('says "all N passed" when every check passed', () => {
    const html = renderToStaticMarkup(
      createElement(ChecksSummary, { checks: [{ state: 'success' }, { state: 'success' }] }),
    );
    expect(textOf(html)).toContain('all 2 passed');
  });

  it('the Checks row wraps the list in the summary', () => {
    const s = src('components/ChecksTab.tsx');
    const row = s.slice(s.indexOf('<Section title="Checks">'));
    expect(row.indexOf('<ChecksSummary')).toBeGreaterThan(0);
    expect(row.indexOf('<ChecksSummary')).toBeLessThan(row.indexOf('<ChecksList'));
  });
});

describe('Ticket and branch on separate rows', () => {
  it('no tracker: no ticket line', () => {
    const html = renderToStaticMarkup(createElement(PrTicketLine, { pr: { id: 1, tickets: null } }));
    expect(html).toBe('');
  });

  it('a tracker with no ticket: "No ticket found", no branch', () => {
    const html = renderToStaticMarkup(createElement(PrTicketLine, { pr: { id: 1, tickets: [] } }));
    const t = textOf(html);
    expect(t).toContain('No ticket found');
    expect(t).not.toContain('Branch');
  });

  it('ChecksTab renders a Ticket row, then its own Branch row', () => {
    const s = src('components/ChecksTab.tsx');
    expect(s.indexOf('<Row label="Ticket">')).toBeGreaterThan(0);
    expect(s.indexOf('<Row label="Ticket">')).toBeLessThan(s.indexOf('<Row label="Branch">'));
    expect(s).toContain('pr.headRefName != null && (');
  });
});
