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
import type { TicketAutoCheckReason } from '@pierre-review/shared';
import { prLabelOf, shortDuration, ticketAutoCheckWords, ticketCurrency } from '../src/lib/ticketReview.js';
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
    // A bare space before a capital or a quote (the model left out the colon): dropped too.
    expect(criterionTextOnly('AC1 Retained area page shows the input', 'AC1')).toBe('Retained area page shows the input');
    expect(criterionTextOnly('AC2 "View" links work', 'AC2')).toBe('"View" links work');
    // …but prose that only STARTS with the ref stays.
    expect(criterionTextOnly('AC1 and AC2 both hold', 'AC1')).toBe('AC1 and AC2 both hold');
  });
});

describe('why it waits', () => {
  it('the automatic story check says when it starts, in one line', () => {
    const now = Date.parse('2026-11-09T16:00:00Z');
    const labelOf = (id: number): string | null => (id === 615 ? 'backend#615' : null);
    const waiting = ticketAutoCheckWords(
      {
        status: 'waiting',
        reason: 'settling',
        startsAt: '2026-11-09T16:01:40Z',
        lastChange: { prId: 615, kind: 'pushed', at: '2026-11-09T15:59:40Z' },
      },
      labelOf,
      now,
    );
    expect(waiting?.label).toBe('Story check starts in 1m 40s — waiting 2 quiet minutes after the last push to backend#615');
    const joined = ticketAutoCheckWords(
      { status: 'waiting', reason: 'settling', startsAt: '2026-11-09T16:00:30Z', lastChange: { prId: 9, kind: 'joined', at: 'x' } },
      labelOf,
      now,
    );
    expect(joined?.label).toBe('Story check starts in 30s — waiting 2 quiet minutes after a PR joined the ticket');
    expect(ticketAutoCheckWords({ status: 'due', reason: null, startsAt: null, lastChange: null }, labelOf, now)?.label).toBe(
      'Story check starts within a minute',
    );
  });

  it('…or why it will not', () => {
    const now = Date.parse('2026-11-09T16:00:00Z');
    const w = (status: 'held' | 'off', reason: TicketAutoCheckReason) =>
      ticketAutoCheckWords({ status, reason, startsAt: null, lastChange: null }, () => null, now)?.label;
    expect(w('held', 'daily_limit')).toBe('Story check starts at 00:00 UTC — the daily limit of automatic checks is reached');
    expect(w('held', 'over_budget')).toBe('No automatic story check — the AI spend limit is reached');
    expect(w('off', 'auto_off')).toBe('No automatic story check — auto review is off in this workspace');
    expect(w('off', 'already_tried')).toBe('No automatic story check — the last one failed on these PRs');
    expect(ticketAutoCheckWords({ status: 'up_to_date', reason: null, startsAt: null, lastChange: null }, () => null, now)).toBeNull();
    expect(ticketAutoCheckWords({ status: 'running', reason: null, startsAt: null, lastChange: null }, () => null, now)).toBeNull();
    expect(ticketAutoCheckWords(undefined, () => null, now)).toBeNull();
  });

  it('a short countdown', () => {
    expect(shortDuration(100_000)).toBe('1m 40s');
    expect(shortDuration(45_000)).toBe('45s');
    expect(shortDuration(120_000)).toBe('2m');
    expect(shortDuration(-5)).toBe('0s');
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
