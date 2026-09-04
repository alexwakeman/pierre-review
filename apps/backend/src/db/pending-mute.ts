// THE PENDING MUTE (CORE, free, no AI) — "stop these Pending items claiming my turn".
//
// ── WHAT A MUTE IS ───────────────────────────────────────────────────────────────────────────
// A muted repo's "your turn"-shaped rows are downgraded to `relevance: 'none'` (hence
// `personal: false`) inside `getMyTurn`, at the ONE place `personal` is folded from `relevance`.
// From that single write, and with no second predicate anywhere:
//
//   • the Pending card relabels from "Your turn" / "In your repos" to the neutral
//     "Review or reply" (`cardKindLabel`, which reads `relevance`);
//   • the browser notification stops firing for it (`useMyTurnNotifications`, which reads
//     `personal`);
//   • the welcome-back banner, the workspace badges, the "Elsewhere" rows and the
//     "N need your attention" line stop counting it (`myTurnPersonal`, folded off `relevance`);
//   • it moves into the broad "N need review or reply" population (`myTurnOther`);
//   • it ranks lower in the "Do next" head (`RELEVANCE_WEIGHT` in db/work-plan.ts).
//
// ⚠ THE CARD NEVER LEAVES THE BOARD, and the broad `myTurn` count never moves. "That work is
// real, it is just not yours, and hiding it would delete work rather than route it" is the rule
// the Pending board is built on; a mute is a ROUTING gesture inside it, not a filter.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
// ⚠ IT IS NOT THE `repos.inbox_watch` AXIS MIGRATION 0046 DROPPED, and `api/routes/workspaces.ts`
// still carries the rule that killed it ("do not reintroduce a per-repo visibility flag here: the
// workspace IS the scope"). That column was a SECOND VISIBILITY SCOPE on top of membership — it
// decided whether a repo's work appeared AT ALL, so every screen had two axes and no way to say
// which it was obeying. Nothing here changes any screen's population: a muted repo is fully live
// on Feed, Timeline, Activity, Bots and the Pending board. What changes is whether its rows may
// CLAIM THE READER'S TURN and interrupt them. Membership remains the only visibility axis.
//
// ⚠ IT IS NOT THE ORPHANED `bot_mute_rules` TABLE (migration 0029) either. That backed a removed
// feature that HID review threads and RESOLVED them on a timer. This hides nothing and resolves
// nothing.
//
// ── TWO INDEPENDENT FACTS, OR-ed. NEVER A CHAIN. ─────────────────────────────────────────────
//
//     muted(repo) == its workspace's `workspaces.pending_muted`  OR  a `pending_muted_repos` row
//
// Workspace grain alone does not answer the ask (one noisy repo inside a useful workspace);
// repo grain alone makes silencing a 20-repo workspace twenty clicks. `null`-means-inherit is a
// named bug class in this codebase (`workspace_reviewers.monthly_cents`, the Slack target, the
// sprint cadence): it needs a resolver, and "which grain am I reading?" then has to be answered
// at every call site. There is no resolver — there is ONE union, computed here, and clearing
// either half neither reveals nor overwrites the other. It is the `hiddenBotUserIds` shape.
import { and, eq, inArray } from 'drizzle-orm';
import { db, runTransaction, schema } from './client.js';

const { pendingMutedRepos, workspaceRepos, workspaces } = schema;

/**
 * THE ONE READ. Every repo id in this account whose Pending items are muted, by EITHER fact.
 *
 * Account-scoped, never workspace-scoped, and that is what makes the ACCOUNT-WIDE
 * `GET /api/my-turn` — the one the browser-notification watcher reads, deliberately with no
 * `?workspace=` — obey a per-WORKSPACE mute without gaining a scope parameter: a repo belongs to
 * exactly one workspace, so a workspace-grained mute is fully resolvable per repo id.
 *
 * Two indexed selects, unioned in JS rather than in SQL: an `OR` across a join and a second table
 * is a portable-dialect liability for no gain here (both sides are tiny — one row per muted repo,
 * one flag per workspace), and the union is the thing the comment above has to keep saying.
 */
export async function getMutedPendingRepoIds(accountId: number): Promise<Set<number>> {
  const [wsRows, repoRows] = await Promise.all([
    // The WORKSPACE half: every repo whose workspace carries the flag. The join is on BOTH
    // columns because `workspace_repos` carries its own `account_id` — the same pairing the
    // composite FK enforces, so the predicate and the constraint say the same thing.
    db
      .select({ repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, workspaceRepos.workspaceId),
          eq(workspaces.accountId, workspaceRepos.accountId),
        ),
      )
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaces.pendingMuted, true)))
      .execute(),
    // The REPO half: presence is the fact.
    db
      .select({ repoId: pendingMutedRepos.repoId })
      .from(pendingMutedRepos)
      .where(eq(pendingMutedRepos.accountId, accountId))
      .execute(),
  ]);
  const out = new Set<number>();
  for (const r of wsRows) out.add(r.repoId);
  for (const r of repoRows) out.add(r.repoId);
  return out;
}

/**
 * The REPO HALF ALONE, account-scoped, for the settings listing — deliberately NOT the union
 * above. `listWorkspaces` intersects it with each workspace's membership to build
 * `Workspace.mutedRepoIds`, and the settings screen has to render the two switches SEPARATELY:
 * folding the workspace flag in here would hand it one merged set it could not un-mix, and
 * un-ticking a repository would then appear to do nothing. The row carries no workspace id (a
 * repo belongs to exactly one workspace already, and a fact lives at exactly one grain).
 */
export async function repoGrainedPendingMutes(accountId: number): Promise<Set<number>> {
  const rows = await db
    .select({ repoId: pendingMutedRepos.repoId })
    .from(pendingMutedRepos)
    .where(eq(pendingMutedRepos.accountId, accountId))
    .execute();
  return new Set(rows.map((r) => r.repoId));
}

/**
 * THE WRITE, for `PUT /api/workspaces/:id/pending-mute`. Each half is applied ONLY when the
 * caller supplied it (`undefined` = untouched), so one Save can carry either grain or both
 * without a no-op write inventing a value for the other.
 *
 * ⚠ THE REPO SET IS SCOPED TO THIS WORKSPACE'S MEMBERSHIP, AND THAT IS A CORRECTNESS RULE, NOT A
 * VALIDATION NICETY. `mutedRepoIds` is the EXACT muted set within the named workspace: ids in it
 * that the workspace does not hold are IGNORED (never written), and stored rows for repos OUTSIDE
 * this workspace are LEFT ALONE (never deleted). Without the second half, saving workspace A's
 * screen would silently clear every mute the reader had set in workspaces B and C — the "an edit
 * meant for one team travels to every team" failure this modal's grain split exists to prevent.
 *
 * Tenancy is ALSO structural: `repo_id` arrives in a request body, and the composite FK
 * `(repo_id, account_id) → repos(id, account_id)` means a cross-account pair fails in the
 * DATABASE. The membership intersection below is the scope guard; the FK is the tenant guard.
 * Neither substitutes for the other.
 *
 * Returns false when the workspace is not this account's (the route 404s), so ownership is
 * decided here rather than by whichever handler remembered to check.
 */
export async function setWorkspacePendingMute(
  accountId: number,
  workspaceId: number,
  patch: { muted?: boolean; mutedRepoIds?: number[] },
): Promise<boolean> {
  const owned = (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!owned) return false;

  // The workspace's membership — the domain the repo half is allowed to write inside.
  const memberRows =
    patch.mutedRepoIds === undefined
      ? []
      : await db
          .select({ repoId: workspaceRepos.repoId })
          .from(workspaceRepos)
          .where(
            and(
              eq(workspaceRepos.accountId, accountId),
              eq(workspaceRepos.workspaceId, workspaceId),
            ),
          )
          .execute();
  const membership = new Set(memberRows.map((r) => r.repoId));
  const wanted = new Set((patch.mutedRepoIds ?? []).filter((id) => membership.has(id)));
  const toClear = [...membership].filter((id) => !wanted.has(id));

  await runTransaction(async (tx) => {
    if (patch.muted !== undefined) {
      await tx
        .update(workspaces)
        .set({ pendingMuted: patch.muted })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
        .execute();
    }
    if (patch.mutedRepoIds !== undefined) {
      if (toClear.length > 0) {
        await tx
          .delete(pendingMutedRepos)
          .where(
            and(
              eq(pendingMutedRepos.accountId, accountId),
              inArray(pendingMutedRepos.repoId, toClear),
            ),
          )
          .execute();
      }
      for (const repoId of wanted) {
        // The conflict target is the table's ONE unique, (account_id, repo_id). Presence is the
        // fact, so there is nothing to update — DO NOTHING keeps `created_at` as "when the reader
        // muted it" rather than "when they last pressed Save".
        await tx
          .insert(pendingMutedRepos)
          .values({ accountId, repoId })
          .onConflictDoNothing({
            target: [pendingMutedRepos.accountId, pendingMutedRepos.repoId],
          })
          .execute();
      }
    }
  });
  return true;
}
