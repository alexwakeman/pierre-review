// THE INPUTS FOLD: the criteria come from where the Story section takes them (latest ticket review,
// even an empty one, else a CURRENT brief, else derived), and the text from the "As written" order.
import { describe, expect, it } from 'vitest';
import type { TicketStoryResponse } from '@pierre-review/shared';
import { criteriaHashOf, resolveStoryDocsInputs, storyHashOf, type StoryDocsInputSeams } from './inputs.js';
import { libraryHashOf, storyDocsFingerprint, storyDocsStaleReasons } from './fingerprint.js';

const IDENT = 'jira:https://acme.atlassian.net#ABC-1';
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx = {} as any;

const sprint = (over: Partial<TicketStoryResponse> = {}): TicketStoryResponse => ({
  workspaceId: 1,
  ident: IDENT,
  found: true,
  ticket: { key: 'ABC-1', title: 'Sprint title', url: null, provider: 'jira', status: null, issueType: null, assignee: null, epic: null, inSprint: true },
  briefState: 'current',
  brief: { summary: 's', criteria: [{ n: 1, text: 'From the brief' }], criteriaDerived: false, references: [], createdAt: '2026-10-01T00:00:00Z' },
  story: { description: 'Sprint text', acceptanceCriteria: '' },
  ...over,
} as TicketStoryResponse);

const seams = (over: Partial<StoryDocsInputSeams> = {}): StoryDocsInputSeams => ({
  latestTicketReview: async () => null,
  ticketReviewTicket: async () => null,
  trackerStory: async () => null,
  sprintStory: async () => sprint(),
  ...over,
});

describe('resolveStoryDocsInputs', () => {
  it('a manual or unparseable ident is refused', async () => {
    expect(await resolveStoryDocsInputs(ctx, 1, 1, 'nope', seams())).toBeNull();
    expect(await resolveStoryDocsInputs(ctx, 1, 1, 'manual:12:abcdef01', seams())).toBeNull();
  });

  it('the ticket review wins, numbered by array position, even when empty', async () => {
    const r = await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams({ latestTicketReview: async () => ({ id: 5, criteria: ['A', 'B'] }) }));
    expect(r).toMatchObject({ criteriaSource: 'ticket_review', criteria: [{ n: 1, text: 'A' }, { n: 2, text: 'B' }], ticketKey: 'ABC-1' });
    const empty = await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams({ latestTicketReview: async () => ({ id: 5, criteria: [] }) }));
    expect(empty).toMatchObject({ criteriaSource: 'ticket_review', criteria: [] });
  });

  it('else a CURRENT brief, else derived', async () => {
    expect(await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams())).toMatchObject({ criteriaSource: 'brief', criteria: [{ n: 1, text: 'From the brief' }] });
    const pending = await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams({ sprintStory: async () => sprint({ briefState: 'pending', brief: null }) }));
    expect(pending).toMatchObject({ criteriaSource: 'derived', criteria: [] });
    expect(pending!.criteriaHash).toBe(criteriaHashOf('derived', []));
  });

  it('the text: tracker story, else the review snapshot, else the sprint text', async () => {
    const tracker = await resolveStoryDocsInputs(
      ctx,
      1,
      1,
      IDENT,
      seams({ trackerStory: async () => ({ title: 'T', description: 'Tracker text', acceptanceCriteria: 'AC' }) }),
    );
    expect(tracker!.story).toEqual({ title: 'T', description: 'Tracker text', acceptanceCriteria: 'AC' });
    const snap = await resolveStoryDocsInputs(
      ctx,
      1,
      1,
      IDENT,
      seams({
        latestTicketReview: async () => ({ id: 5, criteria: ['A'] }),
        ticketReviewTicket: async () => ({ title: 'R', description: 'Review text', acceptanceCriteria: null }),
      }),
    );
    expect(snap!.story.description).toBe('Review text');
    const fallback = await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams());
    expect(fallback!.story).toEqual({ title: 'Sprint title', description: 'Sprint text', acceptanceCriteria: '' });
    expect(fallback!.empty).toBe(false);
  });

  it('nothing to read ⇒ empty', async () => {
    const r = await resolveStoryDocsInputs(ctx, 1, 1, IDENT, seams({ sprintStory: async () => null }));
    expect(r!.empty).toBe(true);
  });
});

describe('fingerprint', () => {
  it('whitespace does not move the story hash; each input names itself when stale', () => {
    expect(storyHashOf({ title: 'a  b', description: 'x\n y', acceptanceCriteria: '' })).toBe(storyHashOf({ title: 'a b', description: 'x y', acceptanceCriteria: '' }));
    const lib1 = libraryHashOf([{ slug: 'a', builtAt: new Date(1000), sectionCount: 2 }, { slug: 'b', builtAt: null, sectionCount: 0 }]);
    const lib2 = libraryHashOf([{ slug: 'a', builtAt: new Date(2000), sectionCount: 2 }]);
    expect(lib1).not.toBe(lib2);
    expect(libraryHashOf([{ slug: 'a', builtAt: 1000, sectionCount: 2 }])).toBe(lib1);
    const h = { storyHash: 's', criteriaHash: 'c', libraryHash: lib1 };
    expect(storyDocsStaleReasons({ ...h, version: 1 }, h, 1)).toEqual([]);
    expect(storyDocsStaleReasons({ ...h, version: 0 }, { ...h, storyHash: 's2', libraryHash: lib2 }, 1)).toEqual(['story', 'library', 'version']);
    expect(storyDocsFingerprint({ ...h, workspaceId: 1, ident: IDENT })).not.toBe(storyDocsFingerprint({ ...h, workspaceId: 2, ident: IDENT }));
  });
});
