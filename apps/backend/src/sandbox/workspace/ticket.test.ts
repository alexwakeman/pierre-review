// The session's ticket (ticket.ts): the tracker is read again BEFORE the story is resolved (so the
// resolve sees the fresh rows), the ticket's PRs are handed to the refresh, a failed refresh is the
// stored copy (fresh: false), Fill gaps carries the coverage, and an empty story is refused.
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryBuildInputs } from '../../coding/story-build/inputs.js';
import { readSessionTicket, type SessionTicketSeams } from './ticket.js';

const ctx = {} as AgentContext;
const IDENT = 'jira:https://acme.atlassian.net#ACME-7';

const inputs = (over: Partial<StoryBuildInputs> = {}): StoryBuildInputs => ({
  ident: IDENT,
  ticketKey: 'ACME-7',
  title: 'Refunds',
  url: 'https://acme.atlassian.net/browse/ACME-7',
  story: { title: 'Refund by card', description: 'Refund a paid order.', acceptanceCriteria: '- Refund by card' },
  criteriaSource: 'brief',
  criteria: [{ n: 1, text: 'Refund by card' }],
  comments: [],
  storyHash: 'h',
  empty: false,
  ticketPrs: [{ prId: 9, repoId: 4, number: 31, title: 'Refund API', headSha: 'abc', state: 'open', headRefName: 'refund', byReader: true }],
  cards: [],
  ...over,
});

function seams(over: Partial<SessionTicketSeams> = {}, log: string[] = []): SessionTicketSeams {
  return {
    ticketPrs: async () => {
      log.push('prs');
      return [{ prId: 9, state: 'open' }];
    },
    refresh: async (_a, _w, ident, prs) => {
      log.push(`refresh ${ident} ${prs.map((p) => p.prId).join(',')}`);
      return { points: [{ text: 'Which refund reasons?', source: 'description', fieldName: null }], fresh: true, fetchedAt: '2026-11-07T10:00:00.000Z' };
    },
    inputs: async () => {
      log.push('inputs');
      return inputs();
    },
    repoNames: async () => new Map([[4, 'acme/payments']]),
    ...over,
  };
}

describe('readSessionTicket', () => {
  it('reads the tracker again first, then resolves the story the story view shows', async () => {
    const log: string[] = [];
    const t = await readSessionTicket(ctx, 1, 2, IDENT, { seams: seams({}, log) });
    expect(log).toEqual(['prs', `refresh ${IDENT} 9`, 'inputs']);
    expect(t).toMatchObject({
      key: 'ACME-7',
      title: 'Refund by card',
      criteria: [{ n: 1, text: 'Refund by card' }],
      openPoints: [{ text: 'Which refund reasons?' }],
      prs: [{ fullName: 'acme/payments', number: 31, state: 'open', byReader: true }],
      fresh: true,
      readAt: '2026-11-07T10:00:00.000Z',
      gaps: null,
    });
  });

  it('uses the stored copy when the refresh fails', async () => {
    const t = await readSessionTicket(ctx, 1, 2, IDENT, { seams: seams({ refresh: async () => Promise.reject(new Error('boom')) }) });
    expect(t).toMatchObject({ fresh: false, openPoints: [], readAt: null });
  });

  it('carries the coverage for Fill gaps', async () => {
    const t = await readSessionTicket(ctx, 1, 2, IDENT, {
      seams: seams(),
      coverage: {
        state: 'checked',
        ticketReviewId: 3,
        checkedAt: null,
        criteria: [{ ref: 'AC1', text: 'Refund by card', verdict: 'partly_met', coveredByPrIds: [] }],
        missing: [{ ref: 'M1', text: 'Receipt email' }],
        existingPrs: [],
        note: null,
      },
    });
    expect(t!.gaps).toEqual({ criteria: [{ ref: 'AC1', text: 'Refund by card', verdict: 'partly_met' }], missing: [{ ref: 'M1', text: 'Receipt email' }], note: null });
  });

  it('refuses an empty story or a non-tracker ident', async () => {
    expect(await readSessionTicket(ctx, 1, 2, IDENT, { seams: seams({ inputs: async () => inputs({ empty: true }) }) })).toBeNull();
    expect(await readSessionTicket(ctx, 1, 2, IDENT, { seams: seams({ inputs: async () => null }) })).toBeNull();
  });
});
