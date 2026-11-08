// LIMN'S OWN WORK IN THE FEED (my-turn.ts `markLimnItems`): an item whose actor is a `limn:` bot, or
// whose body carries a Limn hidden marker, is labelled Limn — and `enrichMyTurn` leaves it out of My Turn.
import { describe, expect, it } from 'vitest';
import type { ConsolidatedFeedItem } from '@pierre-review/shared';
import { markLimnItems } from './my-turn.js';

const item = (o: Partial<ConsolidatedFeedItem>): ConsolidatedFeedItem =>
  ({ id: 'feed:1', isMyTurn: false, myTurnReasons: [], kind: 'pr_comment', actorId: 5, content: null, prId: 1, ...o }) as ConsolidatedFeedItem;

describe('markLimnItems', () => {
  it('labels a limn: bot actor and a body with a Limn marker; leaves a person’s own words', () => {
    const items = [
      item({ id: 'a', actorId: 99 }),
      item({ id: 'b', content: 'Looks good.\n\n<!-- pierre:claude-review v=2 -->' }),
      item({ id: 'c', content: '**Warning** x\n<!-- pierre:claude-review-finding -->' }),
      item({ id: 'd', content: 'I agree with the review.' }),
      item({ id: 'e', content: '> <!-- pierre:claude-review -->\nquoting it' }),
    ];
    markLimnItems(items, new Set([99]));
    expect(items.map((i) => [i.id, i.limn === true])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
      ['e', false],
    ]);
  });
});
