// PR detail → Activity tab (components/pr/PrActivityTab.tsx): every comment, review, commit and
// lifecycle event, newest first, on one rail; Limn reviews marked, the newest auto review marked
// "latest"; comment and review bodies are clamped Markdown cards that open in place.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend prActivityTab
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PrDetail } from '@pierre-review/shared';
import {
  activityMarker,
  buildPrActivity,
  isLimnAutoReview,
  isLimnReview,
  PrActivityTab,
  prConversationCount,
} from '../src/components/pr/PrActivityTab.js';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

const AUTO = '<!-- pierre:claude-review v=1 a=x h=abc k=auto p=claude -->';
const MANUAL = '<!-- pierre:claude-review v=1 a=y h=abc k=manual p=claude -->';

function pr(over: Partial<PrDetail> = {}): PrDetail {
  return {
    id: 7,
    repoId: 1,
    authorId: 1,
    openedAt: '2026-11-01T10:00:00.000Z',
    mergedAt: null,
    mergedById: null,
    closedAt: null,
    lastViewedAt: null,
    githubUrl: 'https://github.com/acme/web/pull/7',
    commits: [
      { id: 11, sha: 'a'.repeat(40), authorId: 1, committerId: 1, message: 'Fix the thing\n\nBody', committedAt: '2026-11-01T11:00:00.000Z' },
    ],
    reviews: [
      { id: 21, authorId: 2, state: 'approved', body: null, submittedAt: '2026-11-01T12:00:00.000Z', url: null },
      { id: 22, authorId: 3, state: 'commented', body: `Old auto run\n${AUTO}`, submittedAt: '2026-11-01T13:00:00.000Z', url: null, automatedKind: 'pierre' },
      { id: 23, authorId: 3, state: 'commented', body: `Manual run\n${MANUAL}`, submittedAt: '2026-11-01T14:00:00.000Z', url: null, automatedKind: 'pierre' },
      { id: 24, authorId: 3, state: 'commented', body: `New auto run\n${AUTO}`, submittedAt: '2026-11-01T15:00:00.000Z', url: 'https://github.com/acme/web/pull/7#pullrequestreview-24' },
    ],
    comments: [
      { id: 31, authorId: 2, body: '![Quality Gate](https://sonarcloud.io/badge.svg)\n\nLooks good', createdAt: '2026-11-01T16:00:00.000Z', url: null },
    ],
    lifecycle: [{ type: 'pr_reopened', at: '2026-11-01T10:30:00.000Z', actorId: 1 }],
    users: [],
    threads: [],
    ...over,
  } as unknown as PrDetail;
}

describe('buildPrActivity', () => {
  it('lists every event newest first, the opening last', () => {
    const rows = buildPrActivity(pr());
    expect(rows.map((r) => r.key)).toEqual([
      'comment:31',
      'review:24',
      'review:23',
      'review:22',
      'review:21',
      'commit:11',
      'pr_reopened:2026-11-01T10:30:00.000Z',
      'opened',
    ]);
  });

  it('marks every Limn review, and only the newest AUTO review as latest', () => {
    const rows = buildPrActivity(pr());
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(by('review:22').limn).toBe(true);
    expect(by('review:22').autoLatest).toBe(false);
    expect(by('review:23').limn).toBe(true);
    expect(by('review:23').autoLatest).toBe(false);
    // The marker alone makes it Limn's, with no stored kind.
    expect(by('review:24').limn).toBe(true);
    expect(by('review:24').autoLatest).toBe(true);
    expect(by('review:21').limn).toBe(false);
  });

  it('a review with no body is a line, not a card; a reopen names nobody', () => {
    const rows = buildPrActivity(pr());
    expect(rows.find((r) => r.key === 'review:21')!.body).toBeNull();
    expect(rows.find((r) => r.kind === 'reopened')!.actorId).toBeNull();
  });

  it('merged names the merger; closed names nobody', () => {
    const merged = buildPrActivity(pr({ mergedAt: '2026-11-02T00:00:00.000Z', mergedById: 9 }));
    expect(merged[0]).toMatchObject({ kind: 'merged', actorId: 9 });
    const closed = buildPrActivity(pr({ closedAt: '2026-11-02T00:00:00.000Z' }));
    expect(closed[0]).toMatchObject({ kind: 'closed', actorId: null });
  });

  it('counts the cards for the tab badge', () => {
    expect(prConversationCount(pr())).toBe(4);
  });
});

describe('Limn review detection', () => {
  it('reads the marker, falling back to the auto-post footer for an older post', () => {
    expect(isLimnReview({ automatedKind: null, body: 'plain' })).toBe(false);
    expect(isLimnAutoReview({ automatedKind: 'pierre', body: MANUAL })).toBe(false);
    expect(isLimnAutoReview({ automatedKind: null, body: AUTO })).toBe(true);
    expect(
      isLimnAutoReview({
        automatedKind: 'pierre',
        body: '<!-- pierre:claude-review v=1 -->\n_Posted automatically by Limn’s Claude review._',
      }),
    ).toBe(true);
  });
});

describe('the rail markers', () => {
  it('give each event type its own icon from Icons.tsx', () => {
    const rows = buildPrActivity(pr({ mergedAt: '2026-11-02T00:00:00.000Z', mergedById: 9 }));
    const labels = rows.map((r) => activityMarker(r).label);
    expect(labels).toEqual(
      expect.arrayContaining(['Merged', 'Comment', 'Limn', 'Approved', 'Commit', 'Reopened', 'Opened']),
    );
    const s = src('components/pr/PrActivityTab.tsx');
    expect(s).not.toMatch(/ShowOnTimeline|MagnifierIcon/);
  });
});

describe('PrActivityTab render', () => {
  const render = (selectedCommentId: number | null = null): string =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(PrActivityTab, {
          pr: pr(),
          usersById: new Map(),
          since: null,
          onClearSince: () => {},
          focusEvent: null,
          onEventFocusConsumed: () => {},
          focusKey: null,
          onCommentFocusConsumed: () => {},
          selectedCommentId,
        }),
      ),
    );

  it('puts the composer above the newest entry, and draws Markdown (images included) clamped', () => {
    const html = render();
    expect(html.indexOf('<textarea')).toBeGreaterThan(-1);
    expect(html.indexOf('<textarea')).toBeLessThan(html.indexOf('data-testid="pr-activity-list"'));
    expect(html).toContain('src="https://sonarcloud.io/badge.svg"');
    expect(html).toContain('data-testid="activity-preview"');
    expect(html).toContain('max-h-[7.5rem]');
    // Collapsed: no Reply and no GitHub link on the row.
    expect(html).not.toContain('>Reply<');
    expect(html).not.toContain('View on GitHub');
  });

  it('chips the Limn reviews and the latest auto review', () => {
    const html = render();
    expect(html.match(/data-testid="activity-limn-chip"/g)).toHaveLength(3);
    expect(html.match(/data-testid="activity-auto-latest"/g)).toHaveLength(1);
    expect(html).toContain('Auto review · latest');
  });

  it('opens a selected comment in place, with Reply', () => {
    const html = render(31);
    expect(html).toContain('data-open="true"');
    expect(html).toContain('>Reply<');
  });
});
