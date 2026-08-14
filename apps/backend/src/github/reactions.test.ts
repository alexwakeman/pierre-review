// fetchReactionsForNodes' RATE-BUDGET contract — the half of this feature that is invisible
// on screen and therefore the half worth pinning.
//
// The reaction lookup is a GitHub-spending path mounted on the hottest surface in the app
// (every comment of every screenful, on the Feed as well as PrDetail). Three properties keep
// it from being the one consumer that ignores the shared per-account budget, and each of them
// fails SILENTLY if it regresses:
//   1. it does not ask when the token is already known to be limited (the cheap-consumer rule
//      `isLimited`, same as the adaptive probe and the PR-refresh poll);
//   2. it FEEDS the budget from the `rateLimit` block the query has always selected, so a
//      sibling sync walk pauses pre-emptively instead of slamming into the 403;
//   3. a limited failure DEGRADES TO EMPTY — a missing decoration beats 502-ing a request the
//      user never knowingly made — while a genuine fault still propagates.
//
// The real `graphqlTolerant` and the real `isRateLimitError` are used deliberately: only the
// client FACTORY is faked, so what is exercised is the actual rethrow/classify chain rather
// than a restatement of it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ gql: vi.fn() }));

vi.mock('./rate-budget.js', () => ({
  isLimited: vi.fn(() => false),
  noteBudget: vi.fn(),
  noteLimited: vi.fn(),
}));

vi.mock('./client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client.js')>();
  return {
    ...actual,
    getGraphqlClientFor: (() => h.gql) as unknown as typeof actual.getGraphqlClientFor,
  };
});

import { isLimited, noteBudget, noteLimited } from './rate-budget.js';
import { fetchReactionsForNodes } from './reactions.js';

const mockIsLimited = vi.mocked(isLimited);
const mockNoteBudget = vi.mocked(noteBudget);
const mockNoteLimited = vi.mocked(noteLimited);

const ACCOUNT = 7;
const RESET_AT = '2026-08-14T12:00:00.000Z';

const nodeResponse = (rateLimit: unknown = { remaining: 4321, resetAt: RESET_AT, cost: 1 }) => ({
  nodes: [
    {
      __typename: 'PullRequestReviewComment',
      id: 'RC_kwabc',
      viewerCanReact: true,
      reactionGroups: [
        { content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 2 } },
        { content: 'EYES', viewerHasReacted: false, reactors: { totalCount: 0 } },
      ],
    },
  ],
  rateLimit,
});

/** The shape GitHub answers with when the GraphQL window is gone (HTTP 200, data null). */
const rateLimitedError = () =>
  Object.assign(new Error('API rate limit exceeded'), {
    errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user' }],
    headers: { 'x-ratelimit-reset': String(Math.floor(Date.parse(RESET_AT) / 1000)) },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockIsLimited.mockReturnValue(false);
  h.gql.mockReset();
  h.gql.mockResolvedValue(nodeResponse());
});

describe('fetchReactionsForNodes — feeding the budget', () => {
  it('reports the selected rateLimit block to the per-account budget on success', async () => {
    const out = await fetchReactionsForNodes('tok', ['RC_kwabc'], { accountId: ACCOUNT });

    expect(out).toEqual([
      {
        nodeId: 'RC_kwabc',
        // The zero group is dropped; only the real one survives.
        groups: [{ content: 'thumbs_up', count: 2, viewerHasReacted: true }],
        viewerCanReact: true,
      },
    ]);
    expect(mockNoteBudget).toHaveBeenCalledWith(ACCOUNT, {
      remaining: 4321,
      resetAt: new Date(RESET_AT),
    });
  });

  // A corrupt/absent reset time must not become an Invalid Date inside a process-wide,
  // shared budget that other walks then compare against.
  it('feeds a null resetAt rather than an Invalid Date when GitHub sends garbage', async () => {
    h.gql.mockResolvedValue(nodeResponse({ remaining: 12, resetAt: 'not-a-date', cost: 1 }));
    await fetchReactionsForNodes('tok', ['RC_kwabc'], { accountId: ACCOUNT });
    expect(mockNoteBudget).toHaveBeenCalledWith(ACCOUNT, { remaining: 12, resetAt: null });
  });

  it('says nothing to the budget when the response carried no rateLimit block', async () => {
    h.gql.mockResolvedValue(nodeResponse(null));
    await fetchReactionsForNodes('tok', ['RC_kwabc'], { accountId: ACCOUNT });
    expect(mockNoteBudget).not.toHaveBeenCalled();
  });
});

describe('fetchReactionsForNodes — consulting the budget', () => {
  it('does not spend a request while the account is already rate-limited', async () => {
    mockIsLimited.mockReturnValue(true);
    const onRateLimited = vi.fn();

    const out = await fetchReactionsForNodes('tok', ['RC_kwabc'], {
      accountId: ACCOUNT,
      onRateLimited,
    });

    expect(out).toEqual([]);
    expect(h.gql).not.toHaveBeenCalled();
    expect(onRateLimited).toHaveBeenCalledWith(null);
  });

  it('never even asks the budget for an empty id list', async () => {
    const out = await fetchReactionsForNodes('tok', [], { accountId: ACCOUNT });
    expect(out).toEqual([]);
    expect(mockIsLimited).not.toHaveBeenCalled();
    expect(h.gql).not.toHaveBeenCalled();
  });
});

describe('fetchReactionsForNodes — a limited failure degrades, it does not error', () => {
  it('returns EMPTY, tells the budget, and does not throw', async () => {
    h.gql.mockRejectedValue(rateLimitedError());
    const onRateLimited = vi.fn();

    const out = await fetchReactionsForNodes('tok', ['RC_kwabc'], {
      accountId: ACCOUNT,
      onRateLimited,
    });

    expect(out).toEqual([]);
    expect(mockNoteLimited).toHaveBeenCalledTimes(1);
    const [account, resumeAt] = mockNoteLimited.mock.calls[0] ?? [];
    expect(account).toBe(ACCOUNT);
    // Read off x-ratelimit-reset by the real classifier — not invented here.
    expect(resumeAt).toEqual(new Date(RESET_AT));
    expect(onRateLimited).toHaveBeenCalledWith(new Date(RESET_AT));
  });

  // The route's 502 stays reserved for real faults: a broken token or a dead network is NOT
  // something to render as "this comment has no reactions".
  it('still propagates a failure that is not a rate limit', async () => {
    h.gql.mockRejectedValue(Object.assign(new Error('401: Bad credentials'), { status: 401 }));

    await expect(
      fetchReactionsForNodes('tok', ['RC_kwabc'], { accountId: ACCOUNT }),
    ).rejects.toThrow(/Bad credentials/);
    expect(mockNoteLimited).not.toHaveBeenCalled();
  });
});
