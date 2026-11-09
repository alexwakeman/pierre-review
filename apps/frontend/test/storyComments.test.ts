// THE STORY VIEW'S COMMENTS (docs/FRONTEND.md § The story view → Comments). Pins:
//   1. The newest STORY_COMMENTS_SHOWN are drawn (stored order kept), all on "Show all"; a citation of an
//      older comment opens the list in full.
//   2. "New since the check" marks only comments written after the latest check, and only when the
//      check's state says it missed some.
//   3. The ONE body: the Story section mounts `StoryComments` from the story view's stored read
//      (`useTicketStory`, never a request of its own), and both "As written in …" disclosures leave
//      their copy out — the comments are shown once. A Story check block's disclosure keeps its own.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyComments.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TicketComment } from '@pierre-review/shared';
import { STORY_COMMENTS_SHOWN, citedIsHidden, newSinceCheckIds, shownStoryComments } from '../src/lib/ticketComments.js';

const src = (rel: string): string => readFileSync(join(import.meta.dirname, '../src', rel), 'utf8');

const c = (id: string, createdAt: string): TicketComment => ({ id, author: 'Amy', createdAt, updatedAt: null, body: `Body ${id}` });
const FIVE = [
  c('c1', '2026-11-01T10:00:00Z'),
  c('c2', '2026-11-02T10:00:00Z'),
  c('c3', '2026-11-03T10:00:00Z'),
  c('c4', '2026-11-04T10:00:00Z'),
  c('c5', '2026-11-05T10:00:00Z'),
];

describe('which comments are drawn', () => {
  it('the newest few, oldest first; all on "Show all"; fewer than the cap draws them all', () => {
    expect(STORY_COMMENTS_SHOWN).toBe(3);
    expect(shownStoryComments(FIVE, false).map((x) => x.id)).toEqual(['c3', 'c4', 'c5']);
    expect(shownStoryComments(FIVE, true).map((x) => x.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(shownStoryComments(FIVE.slice(0, 2), false).map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(shownStoryComments([], false)).toEqual([]);
  });

  it('a citation of an older comment opens the list; a shown or unknown one does not', () => {
    expect(citedIsHidden(FIVE, 'c1')).toBe(true);
    expect(citedIsHidden(FIVE, 'c2')).toBe(true);
    expect(citedIsHidden(FIVE, 'c3')).toBe(false);
    expect(citedIsHidden(FIVE, 'nope')).toBe(false);
  });
});

describe('"New since the check"', () => {
  it('only comments after the check, and only when the check missed some', () => {
    const state = { checkedAt: '2026-11-03T12:00:00Z', newComments: 2 };
    expect([...newSinceCheckIds(FIVE, state)]).toEqual(['c4', 'c5']);
    expect(newSinceCheckIds(FIVE, { ...state, newComments: 0 }).size).toBe(0);
    expect(newSinceCheckIds(FIVE, { checkedAt: '2026-11-03T12:00:00Z' }).size).toBe(0);
    expect(newSinceCheckIds(FIVE, { checkedAt: null, newComments: 3 }).size).toBe(0);
    expect(newSinceCheckIds(FIVE, undefined).size).toBe(0);
  });
});

describe('shown once, from the story read', () => {
  const section = src('components/Activity/TicketStorySection.tsx');
  it('the Story section mounts StoryComments from useTicketStory', () => {
    expect(section).toMatch(/<StoryComments comments=\{comments\} newIds=\{newIds\} \/>/);
    expect(section).toMatch(/const comments = storyQ\.data\?\.comments;/);
    // The read is the story view's own key, with no "reviewed → null" gate that would drop the comments.
    expect(section).toMatch(/useTicketStory\(workspaceId, ticket\.ident\)/);
  });
  it('both "As written in …" disclosures leave their copy out; the Story check keeps its own', () => {
    const disclosures = section.match(/<StoryDisclosure[\s\S]*?\/>/g) ?? [];
    expect(disclosures.length).toBe(2);
    for (const d of disclosures) expect(d).toContain('withComments={false}');
    expect(src('components/TicketStory.tsx')).toMatch(/withComments && <TicketComments comments=\{data\.comments\} \/>/);
    expect(src('components/TicketStory.tsx')).toMatch(/withComments = true/);
  });
  it('a citation reaches the open list (the shared listener), and nothing fetches', () => {
    const comments = src('components/TicketComments.tsx');
    expect(comments).toMatch(/export function StoryComments/);
    expect((comments.match(/useCommentCitation\(comments,/g) ?? []).length).toBe(2);
    expect(comments).not.toMatch(/useQuery|fetch\(|api\./);
  });
});
