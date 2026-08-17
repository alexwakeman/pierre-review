// The @mention picker's visible list (MentionTextarea.orderMentionSuggestions).
//
// The property worth pinning: maintainers are hoisted BEFORE the suggestion cap, not
// after. A picker that sorts only the eight rows it already decided to show will drop
// a maintainer who ranks ninth by proximity — silently, and precisely in the busy repos
// where reaching a maintainer matters most. Everything else here is the invariant that
// makes the hoist safe: it's a stable partition, so the server's proximity ranking is
// preserved inside each half.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { MentionCandidate } from '@pierre-review/shared';
import { orderMentionSuggestions } from '../src/components/MentionTextarea.js';

function candidate(
  login: string,
  isMaintainer = false,
  displayName: string | null = null,
): MentionCandidate {
  return {
    id: login.length * 1000 + login.charCodeAt(0),
    githubLogin: login,
    displayName,
    avatarUrl: null,
    isBot: false,
    isMaintainer,
  };
}

const logins = (rows: MentionCandidate[]): string[] => rows.map((r) => r.githubLogin);

describe('orderMentionSuggestions', () => {
  it('hoists maintainers above the rest, preserving proximity order within each half', () => {
    const rows = [
      candidate('author'),
      candidate('reviewer', true),
      candidate('commenter'),
      candidate('lead', true),
    ];
    expect(logins(orderMentionSuggestions(rows, ''))).toEqual([
      'reviewer',
      'lead',
      'author',
      'commenter',
    ]);
  });

  it('keeps a maintainer ranked below the cap — the hoist precedes the slice', () => {
    // Nine candidates, the ONLY maintainer last by proximity. Slicing first would cut
    // them; hoisting first puts them at the top.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => candidate(`dev${i}`)),
      candidate('maintainer', true),
    ];
    const out = orderMentionSuggestions(rows, '', 8);
    expect(out).toHaveLength(8);
    expect(logins(out)[0]).toBe('maintainer');
    expect(logins(out)).not.toContain('dev7'); // the overflow now falls off the BOTTOM
  });

  it('applies the query filter before hoisting (a non-matching maintainer stays out)', () => {
    const rows = [candidate('alice'), candidate('bob', true), candidate('alicia', true)];
    expect(logins(orderMentionSuggestions(rows, 'ali'))).toEqual(['alicia', 'alice']);
  });

  it('matches on display name as well as login, and is case-insensitive', () => {
    const rows = [candidate('zed'), candidate('mk', true, 'Mary Keane')];
    expect(logins(orderMentionSuggestions(rows, 'MARY'))).toEqual(['mk']);
  });

  it('is a no-op ordering when nobody is a maintainer', () => {
    const rows = [candidate('a'), candidate('b'), candidate('c')];
    expect(logins(orderMentionSuggestions(rows, ''))).toEqual(['a', 'b', 'c']);
  });
});
