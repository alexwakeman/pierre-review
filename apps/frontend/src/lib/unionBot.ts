import type { User, WorkspaceReviewer } from '@pierre-review/shared';

// The CLIENT MIRROR of the server's union bot set (`hiddenBotUserIds` in db/queries.ts) — the set
// the Timeline's "hide bots" and the Feed lens hide.
//
// The rule, per actor:
//   1. The WORKSPACE's stored judgement wins in BOTH directions: `automated` adds the actor, a
//      manual "this is a human" (`isManualOverride` on a non-automated row — the server's
//      `manualHuman`) removes it even where the global flag disagrees.
//   2. Otherwise the wire `User.isBot` — itself the server's workspace-free verdict (users.isBot ∪
//      GitHub types it a Bot ∪ a known vendor login), i.e. exactly the half of the union this
//      judgement layer sits on.
//
// ⚠ THE WORKSPACE IS THE PR'S OWN, never the selected one. A bot judgement is keyed per workspace,
// and a PR can be open from anywhere (a focus tab, a deep link, a restored tab, a search hit).
// Callers resolve it through `Repo.workspaceId` for the PR's repo.
//
// ⚠ Never `u.isBot` alone where the server hides the union — that is a second classifier, and it
// disagrees with the board about every workspace-classified in-house bot and every manual "human".
//
// Pure and exported so the rule is a test, not a comment (test/isolateFilter.test.ts). It is
// BotTriageCard's `isUnionBot`, lifted out. ⚠ That copy and the other inline ones (FeedView,
// PeriodPeopleSection) still exist and should import this instead — four
// spellings of one rule can drift, and a drifted one hides different actors from the server.

/** The union verdict for one actor id. */
export type UnionBotVerdict = (userId: number) => boolean;

export function makeUnionBotVerdict(
  reviewers: readonly WorkspaceReviewer[] | null | undefined,
  usersById: ReadonlyMap<number, User>,
): UnionBotVerdict {
  const byUser = new Map<number, WorkspaceReviewer>();
  for (const r of reviewers ?? []) byUser.set(r.userId, r);
  return (userId: number): boolean => {
    const r = byUser.get(userId);
    if (r != null) {
      if (r.automated) return true;
      // A manual "this is a human" beats the global flag.
      if (r.isManualOverride) return false;
    }
    return usersById.get(userId)?.isBot ?? false;
  };
}
