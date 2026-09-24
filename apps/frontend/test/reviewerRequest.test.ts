// The Pending card's per-suggestion Assign — `lib/reviewerRequest.ts` (pure) and the request's keys
// and refresh rule in `hooks/usePrWrites.ts`.
//
// WHAT THIS PINS, and why each is worth a test rather than a comment:
//
//   1. ONE REQUEST NAMES ONE REVIEWER. The card used to ask every suggestion at once ("Assign all");
//      each row now asks only its own person or team. A synced user goes by id (the path the route
//      STAMPS locally), an unsynced one by login, a team by its SLUG — never the `org/team` label.
//      A suggestion naming nobody yields no request, and the row renders no button.
//   2. A ROW'S STATE COMES FROM THE MUTATION CACHE, latest attempt first. A Pending tab switch
//      remounts the card, so a per-mount isPending would forget an open request (and offer a second
//      POST) and offer "Assign" for someone already asked.
//   3. THE BOARD REFRESH WAITS FOR THE LAST REQUEST ON THE PR, AND ONLY A SUCCESS TRIGGERS IT. The
//      route stamps the request, so a board refetch retires the card and every sibling row's outcome
//      with it. And the board's three reads — attention-cards, daily-brief, work-plan — move TOGETHER.
//
// Run by hand (the frontend's tests are not in CI):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewerSuggestion, User } from '@pierre-review/shared';
import {
  reviewerRequestBody,
  reviewerRequestView,
  reviewerSuggestionKey,
  reviewerSuggestionLabel,
} from '../src/lib/reviewerRequest.js';
import {
  requestReviewersMutationKey,
  requestReviewersOptions,
} from '../src/hooks/usePrWrites.js';

const user = (login: string | null, userId: number | null): ReviewerSuggestion => ({
  kind: 'user',
  login,
  userId,
  teamSlug: null,
  teamName: null,
  reason: 'Reviewed files here',
  source: 'history',
});
const team = (teamSlug: string | null, teamName: string | null): ReviewerSuggestion => ({
  kind: 'team',
  login: null,
  userId: null,
  teamSlug,
  teamName,
  reason: 'Owns these paths in CODEOWNERS',
  source: 'codeowners',
});

describe('one request names one reviewer', () => {
  it('a synced user goes by id, an unsynced one by login, a team by slug', () => {
    expect(reviewerRequestBody(user('alice', 2))).toEqual({ userIds: [2] });
    expect(reviewerRequestBody(user('carol', null))).toEqual({ logins: ['carol'] });
    // The SLUG is GitHub's team_reviewers key; the `org/team` name is a display label.
    expect(reviewerRequestBody(team('core', 'acme/core'))).toEqual({ teamSlugs: ['core'] });
  });

  it('a suggestion naming nobody GitHub can be asked for yields no request', () => {
    expect(reviewerRequestBody(team(null, 'acme/core'))).toBeNull();
    expect(reviewerRequestBody(user(null, null))).toBeNull();
    expect(reviewerRequestBody(user('', null))).toBeNull();
  });

  it('never asks more than one reviewer (the "Assign all" regression)', () => {
    for (const s of [user('alice', 2), user('carol', null), team('core', 'acme/core')]) {
      const body = reviewerRequestBody(s)!;
      const named =
        (body.userIds?.length ?? 0) + (body.logins?.length ?? 0) + (body.teamSlugs?.length ?? 0);
      expect(named).toBe(1);
    }
  });
});

describe('a row is keyed and labelled by who it asks', () => {
  it('a user and a team with the same name are two rows', () => {
    expect(reviewerSuggestionKey(user('core', 9))).not.toBe(reviewerSuggestionKey(team('core', 'acme/core')));
    expect(reviewerSuggestionKey(user('carol', null))).toBe('user:carol');
    expect(reviewerSuggestionKey(user(null, 4))).toBe('user:#4');
  });

  it('names the person or team in the button', () => {
    expect(reviewerSuggestionLabel(user('alice', 2))).toBe('@alice');
    expect(reviewerSuggestionLabel(team('core', 'acme/core'))).toBe('@acme/core');
    expect(reviewerSuggestionLabel(team('core', null))).toBe('@core');
    const usersById = new Map<number, User>([[4, { id: 4, githubLogin: 'dave' } as User]]);
    expect(reviewerSuggestionLabel(user(null, 4), usersById)).toBe('@dave');
    expect(reviewerSuggestionLabel(user(null, 5), usersById)).toBe('this reviewer');
    expect(reviewerSuggestionLabel(team(null, null))).toBe('this team');
  });
});

describe("a row's state is its latest attempt in the cache", () => {
  const boom = new Error('acme/core is not a collaborator on this repository.');

  it('no attempt is idle', () => {
    expect(reviewerRequestView([])).toEqual({ status: 'idle', error: null });
  });

  it('the latest attempt wins, so a retry clears an old failure', () => {
    expect(
      reviewerRequestView([
        { status: 'error', error: boom },
        { status: 'pending', error: null },
      ]),
    ).toEqual({ status: 'pending', error: null });
    expect(
      reviewerRequestView([
        { status: 'error', error: boom },
        { status: 'success', error: null },
      ]),
    ).toEqual({ status: 'success', error: null });
  });

  it("a failure carries the server's words, or a plain fallback", () => {
    expect(reviewerRequestView([{ status: 'error', error: boom }])).toEqual({
      status: 'error',
      error: 'acme/core is not a collaborator on this repository.',
    });
    const fallback = { status: 'error' as const, error: 'Couldn’t request this reviewer.' };
    expect(reviewerRequestView([{ status: 'error', error: new Error('  ') }])).toEqual(fallback);
    expect(reviewerRequestView([{ status: 'error', error: 'thrown string' }])).toEqual(fallback);
  });
});

describe('request keys', () => {
  it("the PR key is a prefix of every row's key, and rows and PRs are apart", () => {
    expect(requestReviewersMutationKey(7, 'user:alice').slice(0, 2)).toEqual(
      requestReviewersMutationKey(7),
    );
    expect(requestReviewersMutationKey(7, 'user:alice')).not.toEqual(
      requestReviewersMutationKey(7, 'user:carol'),
    );
    expect(requestReviewersMutationKey(7, 'user:alice')).not.toEqual(
      requestReviewersMutationKey(8, 'user:alice'),
    );
  });
});

describe('the board refresh waits for the last request on the PR, and only on success', () => {
  const BOARD = [['attention-cards'], ['daily-brief'], ['work-plan'], ['workspace-insights']];
  const PR_READS = [['pr', 7], ['suggested-reviewers', 7]];

  function deferred(): { promise: Promise<unknown>; resolve: () => void; reject: (e: Error) => void } {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = () => res({ status: 'ok', requestedLogins: [] });
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function harness() {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    const invalidated = (): unknown[] => spy.mock.calls.map((c) => c[0]?.queryKey);
    const start = (reviewerKey: string) => {
      const d = deferred();
      const done = qc
        .getMutationCache()
        .build(qc, { ...requestReviewersOptions(qc, 7, reviewerKey), mutationFn: () => d.promise })
        .execute({})
        .catch(() => undefined);
      return { ...d, done };
    };
    return { qc, spy, invalidated, start };
  }

  afterEach(() => vi.restoreAllMocks());

  it('one success refreshes the PR and the board, with the three board reads together', async () => {
    const { invalidated, start } = harness();
    const a = start('user:alice');
    a.resolve();
    await a.done;
    expect(invalidated()).toEqual([...PR_READS, ...BOARD]);
  });

  it('a success with a sibling in flight holds the board; the last one refreshes it, once', async () => {
    const { invalidated, spy, start } = harness();
    const a = start('user:alice');
    const b = start('user:carol');
    a.resolve();
    await a.done;
    expect(invalidated()).toEqual(PR_READS);
    spy.mockClear();
    b.resolve();
    await b.done;
    expect(invalidated()).toEqual([...PR_READS, ...BOARD]);
  });

  it('a failure refreshes nothing, so the card stays to show the words and the retry', async () => {
    const { invalidated, start } = harness();
    const a = start('team:core');
    a.reject(new Error('acme/core is not a collaborator on this repository.'));
    await a.done;
    expect(invalidated()).toEqual([]);
  });

  it('a success then a sibling failure never refreshes the board', async () => {
    const { invalidated, start } = harness();
    const a = start('user:alice');
    const b = start('team:core');
    a.resolve();
    await a.done;
    b.reject(new Error('nope'));
    await b.done;
    expect(invalidated()).toEqual(PR_READS);
  });
});
