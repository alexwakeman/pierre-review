// PR detail: Overview + header layout.
//   • PR comments are their own "Comments" tab, right after Overview; Activity is no longer a tab
//     but a collapsed section at the foot of Overview (`?prTab=activity` still parses and means
//     "Overview with that section open").
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
import { ChecksSummary, checksSummaryCounts, PrTicketBranchLine } from '../src/components/ChecksTab.js';
import { ActivitySection } from '../src/components/PrDetail.js';
import { PR_DETAIL_TABS } from '../src/store/filters.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');

describe('PR detail tabs', () => {
  it('lists Comments right after Overview and no Activity tab', () => {
    const s = src('components/PrDetail.tsx');
    // The redesign builds the strip from `tabIds` (fed to the Tabs primitive).
    const strip = s.slice(s.indexOf('const tabIds: Tab[] = [') + 'const tabIds: Tab[] = ['.length);
    expect(strip.length).toBeGreaterThan(0);
    const list = strip.slice(0, strip.indexOf(']'));
    expect(list).toMatch(/'overview',\s*'comments',\s*'changes'/);
    expect(list).not.toContain("'activity'");
  });

  it('?prTab=comments and the legacy ?prTab=activity are both valid URL members', () => {
    expect(PR_DETAIL_TABS).toContain('comments');
    expect(PR_DETAIL_TABS).toContain('activity');
    expect(PR_DETAIL_TABS.indexOf('comments')).toBe(PR_DETAIL_TABS.indexOf('overview') + 1);
  });

  it("'activity' renders Overview with the section open, derived (never written back)", () => {
    const s = src('components/PrDetail.tsx');
    expect(s).toMatch(/tab === 'activity'\s*\?\s*'overview'/);
    expect(s).toContain("const activityOpen = activityOpenLocal || tab === 'activity';");
    expect(s).not.toMatch(/if \(tab === 'activity'\) seedTab/);
    // A PR-comment deep link lands on the Comments tab.
    expect(s).toContain("seedTab('comments')");
  });

  // The redesign's type scale (docs/redesign/DESIGN.md): the meta line is body text (13px), the
  // old 14px `text-sm` is gone. It still names the repo before the author.
  it('the header meta line is body text and names the repo before the author', () => {
    const s = src('components/PrDetail.tsx');
    const at = s.indexOf('data-testid="pr-header-meta"');
    expect(at).toBeGreaterThan(0);
    const block = s.slice(at - 200, at + 2600);
    expect(block).toContain('text-body');
    expect(block).not.toMatch(/className="mt-1 flex items-center gap-2 text-xs/);
    expect(block.indexOf('pr.repoFullName')).toBeLessThan(block.indexOf('<UserName'));
  });
});

describe('ActivitySection', () => {
  it('is collapsed by default: the header only, with a count', () => {
    const html = renderToStaticMarkup(
      createElement(
        ActivitySection,
        { open: false, onToggle: () => {}, count: 3 },
        createElement('ul', { 'data-testid': 'child' }),
      ),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(textOf(html)).toContain('Activity');
    expect(textOf(html)).toContain('3 events');
    expect(html).not.toContain('data-testid="child"');
  });

  it('shows its list when open', () => {
    const html = renderToStaticMarkup(
      createElement(
        ActivitySection,
        { open: true, onToggle: () => {}, count: 1 },
        createElement('ul', { 'data-testid': 'child' }),
      ),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(textOf(html)).toContain('1 event');
    expect(html).toContain('data-testid="child"');
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
    const row = s.slice(s.indexOf('<Row label="Checks">'));
    expect(row.indexOf('<ChecksSummary')).toBeGreaterThan(0);
    expect(row.indexOf('<ChecksSummary')).toBeLessThan(row.indexOf('<ChecksList'));
  });
});

describe('Ticket and branch on one row', () => {
  it('no tracker: the branch alone, with no inline caption', () => {
    const html = renderToStaticMarkup(
      createElement(PrTicketBranchLine, {
        pr: { id: 1, tickets: null, headRefName: 'feat/x', baseRefName: 'main' },
      }),
    );
    expect(textOf(html)).toContain('feat/x → main');
    expect(textOf(html)).not.toContain('Branch');
  });

  it('a tracker with no ticket: "No ticket found" then the branch on the same line', () => {
    const html = renderToStaticMarkup(
      createElement(PrTicketBranchLine, {
        pr: { id: 1, tickets: [], headRefName: 'feat/x', baseRefName: 'main' },
      }),
    );
    const t = textOf(html);
    expect(t.indexOf('No ticket found')).toBeLessThan(t.indexOf('Branch'));
    expect(t.indexOf('Branch')).toBeLessThan(t.indexOf('feat/x'));
  });

  it('ChecksTab renders one shared row, not separate Branch and Ticket rows', () => {
    const s = src('components/ChecksTab.tsx');
    expect(s).not.toContain('<Row label="Branch">');
    expect(s).not.toContain('<Row label="Ticket">');
    expect(s).toContain('<PrTicketBranchLine pr={pr} />');
  });
});
