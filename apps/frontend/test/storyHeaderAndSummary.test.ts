// THE STORY VIEW'S HEADER, SUMMARY AND MISSING ITEMS (2026-10-28, BMD-1086). Pins:
//   1. The summary shows ONLY its leading prose (shared `storySummaryProse`) — an older stored summary
//      (one sentence, then a bullet per criterion, clipped mid-word) reads as that sentence.
//   2. A criterion's own leading ref is dropped ("AC1 AC1: …" never again).
//   3. Why a stale ticket waits, and why a design was not redrawn, in a few words.
//   4. The header is ONE component (`StoryViewHeader`): the currency is said there, never again in the
//      Story card; the missing items are headed in plain words and their M-codes are never drawn.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyHeaderAndSummary.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORY_MISSING_HEADING, criterionTextOnly, storySummaryProse } from '@pierre-review/shared';
import { prLabelOf, ticketCurrency, ticketWaitWords } from '../src/lib/ticketReview.js';
import { autoSkippedLine } from '../src/lib/sequenceDiagrams.js';

const src = (rel: string): string => readFileSync(join(import.meta.dirname, '../src', rel), 'utf8');

describe('the summary', () => {
  it('an older stored summary reads as its leading prose only', () => {
    const stored = [
      'Together the two PRs add the service-template flag, project fixtures in the new shape, and drop-out page listings.',
      'Most of the page-rendering work and the two-job CI are not done.',
      '',
      '- AC1/AC8: "View baseline details" still matches by ref.',
      '- AC10: CI still runs one `npm test` job, not o…',
    ].join('\n');
    expect(storySummaryProse(stored)).toBe(
      'Together the two PRs add the service-template flag, project fixtures in the new shape, and drop-out page listings. Most of the page-rendering work and the two-job CI are not done.',
    );
  });

  it('cuts at a sentence end, never mid-word; a list alone is nothing', () => {
    const long = `${'One short sentence here. '.repeat(40)}trailing`;
    const out = storySummaryProse(long)!;
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith('here.')).toBe(true);
    expect(storySummaryProse('- only\n- bullets')).toBeNull();
    expect(storySummaryProse('# Heading\ntext')).toBeNull();
    expect(storySummaryProse(null)).toBeNull();
  });

  it("drops a criterion's own leading ref", () => {
    expect(criterionTextOnly('AC1: "View baseline details" links to the parent', 'AC1')).toBe('"View baseline details" links to the parent');
    // Never re-cased.
    expect(criterionTextOnly('AC3: baseline pages render', 'AC3')).toBe('baseline pages render');
    expect(criterionTextOnly('AC10: npm test runs as two jobs', 'AC10')).toBe('npm test runs as two jobs');
    // A combined ref, or one that is not the row's own, is the model's numbering: kept.
    expect(criterionTextOnly('AC1/AC8 - links work', 'AC1')).toBe('AC1/AC8 - links work');
    expect(criterionTextOnly('AC5: export works', 'AC4')).toBe('AC5: export works');
    expect(criterionTextOnly('npmTest runs', 'AC4')).toBe('npmTest runs');
    expect(criterionTextOnly('AC2:', 'AC2')).toBe('AC2:');
    expect(criterionTextOnly('AC2: x', null)).toBe('AC2: x');
  });
});

describe('why it waits', () => {
  it('a stale ticket the sweeper holds back says why', () => {
    expect(ticketWaitWords('daily_limit')?.label).toBe('daily limit reached');
    expect(ticketWaitWords('daily_limit')?.title).toContain('00:00 UTC');
    expect(ticketWaitWords('ticket_limit')?.label).toBe('next update tomorrow');
    expect(ticketWaitWords('settling')?.label).toBe('update due soon');
    expect(ticketWaitWords(null)).toBeNull();
    expect(ticketWaitWords(undefined)).toBeNull();
  });

  it('a design a review did not draw says why', () => {
    expect(autoSkippedLine({ autoSkipped: 'daily_limit', diagram: null })).toBe(
      'Not drawn yet: today’s automatic designs are used up. They start again at 00:00 UTC.',
    );
    expect(autoSkippedLine({ autoSkipped: 'redraw_limit', diagram: {} as never })).toBe('Not redrawn: it was already redrawn today.');
    expect(autoSkippedLine({ autoSkipped: null, diagram: null })).toBeNull();
  });
});

describe('the story view wiring', () => {
  it('the header is one row for the title, one for the facts; the currency is said once', () => {
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).toContain('function StoryViewHeader(');
    expect(cards).toContain('data-testid="story-header"');
    expect(cards).toContain('<StoryViewHeader');
    const section = src('components/Activity/TicketStorySection.tsx');
    expect(section).not.toContain('<CurrencyPill');
    // The header names the one PR that changed, as the Story card's pill did.
    expect(cards).toContain('ticketCurrency(state, labelOf)');
  });

  it('one changed PR is named in the currency line', () => {
    const labelOf = prLabelOf([
      { prId: 1, repo: 'acme/api', number: 88 },
      { prId: 2, repo: 'acme/web', number: 412 },
      { prId: 3, repo: null, number: 5 },
    ]);
    const stale = { status: 'stale' as const, staleBecause: ['pr_pushed' as const], changedPrIds: [1], memberCount: 3 };
    expect(ticketCurrency(stale, labelOf)?.label).toBe('api#88 pushed since');
    expect(ticketCurrency({ ...stale, changedPrIds: [3] }, labelOf)?.label).toBe('PR pushed since');
  });

  it('missing items: a plain heading, a title per item, no M-code on screen', () => {
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('STORY_MISSING_HEADING');
    expect(parts).not.toContain('>{item.ref}<');
    expect(STORY_MISSING_HEADING).toBe('Asked for outside the criteria');
  });
});
