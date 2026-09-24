import type { RequestReviewersBody, ReviewerSuggestion, User } from '@pierre-review/shared';

// ONE SUGGESTED REVIEWER, ONE REQUEST — the pure half of the Pending card's per-suggestion Assign
// (AttentionCards `RoutingReviewerRow`); pinned by test/reviewerRequest.test.ts. No React, no query
// client: the hook half (keys, refresh rule, cache-read state) lives in hooks/usePrWrites.ts.
//
// ⚠ `kind: 'team'` / `teamSlug` / `teamName` are GITHUB'S OWN TEAMS, never a Limn Workspace.

/** A row's identity: its React key AND the tail of its request's mutation key. The kind prefix keeps
 *  a user and a team with the same name on two rows. */
export function reviewerSuggestionKey(s: ReviewerSuggestion): string {
  return s.kind === 'team'
    ? `team:${s.teamSlug ?? s.teamName ?? ''}`
    : `user:${s.login ?? `#${s.userId ?? ''}`}`;
}

/** The request for THIS reviewer and nobody else, or null when the suggestion names nobody GitHub can
 *  be asked for (the row then renders NO button — hide, never disable). A SYNCED user goes by id: the
 *  route resolves it, drops the author and bots, and STAMPS review_requests locally, so the card leaves
 *  on the next board read. An UNSYNCED user goes by login (nothing stamped; lands on the next sync).
 *  A team goes by its SLUG (GitHub's team_reviewers key), never the org/team label. */
export function reviewerRequestBody(s: ReviewerSuggestion): RequestReviewersBody | null {
  if (s.kind === 'team') return s.teamSlug ? { teamSlugs: [s.teamSlug] } : null;
  if (s.userId != null) return { userIds: [s.userId] };
  if (s.login) return { logins: [s.login] };
  return null;
}

/** Who the button asks, for its accessible name ("Assign @alice", "Assign @acme/core"). */
export function reviewerSuggestionLabel(
  s: ReviewerSuggestion,
  usersById?: Map<number, User>,
): string {
  if (s.kind === 'team') {
    const t = s.teamName ?? s.teamSlug;
    return t ? `@${t}` : 'this team';
  }
  const login = s.login ?? (s.userId != null ? usersById?.get(s.userId)?.githubLogin : undefined);
  return login ? `@${login}` : 'this reviewer';
}

export type ReviewerRequestStatus = 'idle' | 'pending' | 'success' | 'error';
export interface ReviewerRequestView {
  status: ReviewerRequestStatus;
  error: string | null;
}

const REQUEST_FAILED = 'Couldn’t request this reviewer.';

/** A row's state from its attempts in the mutation cache, OLDEST FIRST (the cache's insertion order).
 *  The latest attempt wins, so a retry clears an old failure. */
export function reviewerRequestView(
  attempts: readonly { status: ReviewerRequestStatus; error: unknown }[],
): ReviewerRequestView {
  const latest = attempts[attempts.length - 1];
  if (latest == null) return { status: 'idle', error: null };
  if (latest.status !== 'error') return { status: latest.status, error: null };
  const words = latest.error instanceof Error ? latest.error.message.trim() : '';
  return { status: 'error', error: words !== '' ? words : REQUEST_FAILED };
}
