// The Story section's docs check (lib/storyDocsAlignment.ts): which run is drawn, the button's words,
// and whether the per-criterion notes may sit under the section's own criteria rows.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend storyDocsAlignment
import { describe, expect, it } from 'vitest';
import type { StoryDocsAlignmentRun, StoryDocsAlignmentStatus } from '@pierre-review/shared';
import { clickMessageStale, criteriaMatch, docsButtonLabel, docsChecking, docsProgressText, shownRun } from '../src/lib/storyDocsAlignment.js';

const RESULT = { outcome: 'no_relevant_docs' as const, overall: null, criteria: [], storyParts: [], shortlist: [], dropped: 0 };

function run(status: StoryDocsAlignmentStatus, over: Partial<StoryDocsAlignmentRun> = {}): StoryDocsAlignmentRun {
  return {
    id: 1,
    workspaceId: 2,
    ident: 'jira|https://x.atlassian.net|ABC-1',
    ticketKey: 'ABC-1',
    status,
    error: null,
    current: true,
    staleBecause: [],
    criteriaSource: 'brief',
    criteria: [],
    result: status === 'succeeded' ? RESULT : null,
    costUsd: null,
    createdAt: '2026-10-18T00:00:00.000Z',
    finishedAt: null,
    ...over,
  };
}

describe('shownRun', () => {
  it('draws the newest run when it succeeded', () => {
    const r = run('succeeded', { id: 5 });
    expect(shownRun({ run: r, lastSucceeded: null })?.id).toBe(5);
  });
  it('keeps the last good result while a new run is in flight or failed', () => {
    const good = run('succeeded', { id: 3 });
    expect(shownRun({ run: run('reading', { id: 4 }), lastSucceeded: good })?.id).toBe(3);
    expect(shownRun({ run: run('failed', { id: 4 }), lastSucceeded: good })?.id).toBe(3);
  });
  it('is null when nothing has succeeded', () => {
    expect(shownRun({ run: run('failed'), lastSucceeded: null })).toBeNull();
    expect(shownRun(undefined)).toBeNull();
  });
});

describe('the button and the progress words', () => {
  it('names the first check, a re-check and a check in flight', () => {
    expect(docsButtonLabel({ run: null, lastSucceeded: null }, false)).toBe('Check against docs');
    expect(docsButtonLabel({ run: run('succeeded'), lastSucceeded: null }, false)).toBe('Check docs again');
    expect(docsButtonLabel({ run: run('shortlisting'), lastSucceeded: null }, false)).toBe('Checking…');
    expect(docsButtonLabel({ run: null, lastSucceeded: null }, true)).toBe('Checking…');
  });
  it('a failed run is not in flight', () => {
    expect(docsChecking({ run: run('failed') }, false)).toBe(false);
  });
  it('says which step a run is on', () => {
    expect(docsProgressText('queued', false)).toBe('Waiting to start…');
    expect(docsProgressText('shortlisting', false)).toBe('Choosing sections…');
    expect(docsProgressText('reading', false)).toBe('Reading the docs…');
    expect(docsProgressText('succeeded', false)).toBeNull();
    expect(docsProgressText(null, true)).toBe('Starting…');
  });
});

describe('criteriaMatch', () => {
  const shown = [
    { n: 1, text: 'A refund is issued within 5 days.' },
    { n: 2, text: 'The customer is emailed.' },
  ];
  it('attaches when the source and every criterion match', () => {
    const r = run('succeeded', { criteriaSource: 'brief', criteria: [...shown] });
    expect(criteriaMatch(r, 'brief', shown)).toBe(true);
  });
  it('ignores whitespace and case', () => {
    const r = run('succeeded', { criteria: [{ n: 1, text: '  a refund is  issued within 5 days. ' }] });
    expect(criteriaMatch(r, 'brief', shown)).toBe(true);
  });
  it('never attaches across sources', () => {
    const r = run('succeeded', { criteriaSource: 'brief', criteria: [...shown] });
    expect(criteriaMatch(r, 'review', shown)).toBe(false);
    const t = run('succeeded', { criteriaSource: 'ticket_review', criteria: [...shown] });
    expect(criteriaMatch(t, 'review', shown)).toBe(true);
    expect(criteriaMatch(t, 'brief', shown)).toBe(false);
  });
  it('never attaches a derived run (its list is Claude’s)', () => {
    const r = run('succeeded', { criteriaSource: 'derived', criteria: [...shown] });
    expect(criteriaMatch(r, 'brief', shown)).toBe(false);
    expect(criteriaMatch(r, 'none', shown)).toBe(false);
  });
  it('refuses when a criterion was reworded or the list shrank', () => {
    expect(criteriaMatch(run('succeeded', { criteria: [{ n: 2, text: 'The customer is called.' }] }), 'brief', shown)).toBe(false);
    const three = [...shown, { n: 3, text: 'Logged.' }];
    expect(criteriaMatch(run('succeeded', { criteria: three }), 'brief', shown)).toBe(false);
  });
  it('accepts a text the server clipped with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const r = run('succeeded', { criteria: [{ n: 1, text: `${'x'.repeat(299)}…` }] });
    expect(criteriaMatch(r, 'brief', [{ n: 1, text: long }])).toBe(true);
  });
  it('is false with no shown list or no run', () => {
    expect(criteriaMatch(null, 'brief', shown)).toBe(false);
    expect(criteriaMatch(run('succeeded'), 'review', null)).toBe(false);
  });
});

describe('clickMessageStale', () => {
  it('hides a click answer only once a run created after the click exists', () => {
    const click = Date.parse('2026-10-18T10:00:00Z');
    expect(clickMessageStale(run('queued', { createdAt: '2026-10-18T10:00:05Z' }), click)).toBe(true);
    expect(clickMessageStale(run('failed', { createdAt: '2026-10-18T09:00:00Z' }), click)).toBe(false);
    expect(clickMessageStale(null, click)).toBe(false);
    expect(clickMessageStale(run('queued', { createdAt: '2026-10-18T10:00:05Z' }), 0)).toBe(false);
  });
});
