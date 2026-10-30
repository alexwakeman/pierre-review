import { eq, inArray } from 'drizzle-orm';
import type { ProContext } from './contract.js';
import { proSchemaFor } from './db.js';

// Plugin-side retention: prune the Pro-owned tables for a batch of PR ids the CORE TTL
// sweep is deleting. Core can't name these tables (open-core boundary), so it hands us the
// PR ids via ctx.registerRetention and we clean up our own rows. These tables have no FKs
// to each other, so order is free; each is scoped by pr_id (a global id).
//
//  - ai_pr_analyses      (one row per (account, pr, kind), upserted)
//  - comment_assessments (one row per (account, root comment), upserted; carries pr_id)
//  - pr_comment_annotations (one row per (account, kind, target); carries pr_id — the platform
//                            that generalises comment_assessments + addressed_checks)
//
// ai_fixes and review_learnings are NOT here: they moved to CORE with AI Fix's fixer and Claude
// Review's memory (core migration 0074), and core's own delete paths (deleteRepo, retention's
// deletePrSubtree) and eraseAccountData own them now. ONE owner per table — two would be harmless,
// but zero is the failure that matters, so the list moved in the same change.
//
// workspace_slack_targets and pro_workspace_settings are NOT pruned here either: both are
// per-account CONFIG keyed by (account, workspace) with no pr_id to prune by — the first bounded
// at SLACK_TARGET_WORKSPACE_CAP rows per account, the second at one row per workspace. They are
// deleted only on ERASURE (below), like pro_settings.
//
// repo_digests is NOT pruned here: it's keyed by (account, repo) and upserted — bounded
// (one row per repo), not a per-PR growth surface.
//
// workspace_period_reports is NOT pruned here either, and that is the FEATURE rather than an
// omission. It is keyed by (account, workspace, period, model) — there is no pr_id to prune by —
// and a period report has to OUTLIVE the PRs it was computed from: the whole reason it is stored
// instead of recomputed is that this sweep thins the corpus underneath it, so a report regenerated
// after retention has run reads lower than the copy someone already forwarded. It stays until the
// account is erased (see eraseProByAccountId below), and it is bounded anyway — one row per period
// per model, a handful a month.
export async function pruneProByPrIds(
  ctx: ProContext,
  prIds: number[],
): Promise<void> {
  if (prIds.length === 0) return;
  const pro = proSchemaFor();
  await ctx.db
    .delete(pro.aiPrAnalyses)
    .where(inArray(pro.aiPrAnalyses.prId, prIds))
    .execute();
  await ctx.db
    .delete(pro.commentAssessments)
    .where(inArray(pro.commentAssessments.prId, prIds))
    .execute();
  await ctx.db
    .delete(pro.prCommentAnnotations)
    .where(inArray(pro.prCommentAnnotations.prId, prIds))
    .execute();
  // (The stored Jira tickets left with the issue tracker at apiVersion 23: core's delete paths
  // prune `tracker_tickets` now.)
}

// ---------------------------------------------------------------------------
// Plugin-side ERASURE (GDPR Art. 17). Core's account erasure (db/erase-account.ts) deletes the account and
// every core-owned row, then calls this via ctx.registerAccountErasure — it cannot name these
// tables itself (open-core boundary), and an account deletion that silently left the plugin's
// copies of the same content behind would make the promise in the privacy policy false.
//
// Every table listed here carries `accountId`, so each is one predicate. The list must stay in
// step with db.ts's schema union: a new account-scoped Pro table that is not added here
// survives a deletion the user was told was complete.
//
// Note the difference from pruneProByPrIds above: retention is keyed by PR id and deliberately
// leaves repo_digests alone (bounded, one row per repo). Erasure is keyed by ACCOUNT and must
// take everything, digests included.
// ---------------------------------------------------------------------------
export async function eraseProByAccountId(
  ctx: ProContext,
  accountId: number,
): Promise<void> {
  const pro = proSchemaFor();
  // Ordered only for readability — none of these FK each other.
  const tables = [
    // (ai_fixes + review_learnings: core-owned since core migration 0074 — eraseAccountData.)
    pro.aiPrAnalyses,
    pro.repoDigests,
    pro.commentAssessments,
    pro.addressedChecks,
    // The comment-annotations table (kind × target). DORMANT since the impact note's removal
    // (2026-10-30), still erased. Carries account_id like the two tables above it.
    pro.prCommentAnnotations,
    pro.sprintReports,
    // NOTE: `retroReports` is gone from this list because the table itself is gone (plugin
    // migration 0018 drops `retro_reports`). That is the ONLY sanctioned way to leave this
    // checklist — an account-scoped table that still EXISTS but is missing here silently
    // survives an erasure the user was told was complete.
    pro.presetReports,
    pro.pinnedPrompts,
    pro.sprintChatHistory,
    // The stored period-over-period reports. Account-scoped and NOT PR-keyed, so this list is the
    // ONLY thing that ever deletes them — pruneProByPrIds deliberately leaves them alone (see the
    // note above it). It also holds narrative prose about the account's own work, which is exactly
    // the content an erasure promises to remove.
    pro.workspacePeriodReports,
    pro.botThemeReports,
    pro.humanThemeReports,
    // The ONE synthesis cache (P2.1). Scope-keyed and REGENERABLE (the bot_theme_reports family),
    // so erasure is the only delete path it needs: it has no pr_id grain for pruneProByPrIds, and
    // it ages by STALENESS (the payload hash moves as items churn), not by deletion.
    pro.proSynthesis,
    // The work-plan narration cache. Same family and same reasoning as pro_synthesis directly
    // above: scope-keyed, REGENERABLE, no pr_id grain (the row spans a whole workspace), so it is
    // absent from pruneProByPrIds and erasure is its only delete path. It also holds prose the
    // model wrote about the account's own open work — exactly the content an erasure promises to
    // remove.
    pro.proWorkPlans,
    // The Chronology pointers cache — the work plan's family exactly: scope-keyed, regenerable, no
    // pr_id grain, so erasure is its only delete path. It holds prose about the account's own
    // pull requests, which is what an erasure promises to remove.
    pro.proFlowPointers,
    // The REMOVED Bot Tuning Advisor's three DORMANT tables (recommendations / profiles /
    // config-event anchors) — nothing writes them now, but old installs hold rows, so erasure
    // still covers them. None PR-keyed, so they appear ONLY here, never in pruneProByPrIds.
    pro.advisorRecommendations,
    pro.advisorBotProfiles,
    pro.advisorConfigEvents,
    // The per-WORKSPACE Pro config (plugin 0029 + 0031) — the sprint cadence AND, since 0031, the
    // Jira/Linear tracker's provider + base URL + project keys. It also carries an ON DELETE
    // CASCADE onto core's `workspaces`, so an account deletion would take it anyway — but "a
    // cascade will probably get it" is not the promise the privacy policy makes, and the cascade
    // fires only if core deletes the workspace rows before this hook runs. Listed explicitly, like
    // every other account-scoped table: the ONLY sanctioned way to leave this checklist is for the
    // table to stop existing.
    // ⚠ 0031 WIDENED WHAT THIS ROW HOLDS without adding a table, which is why this entry did not
    // change and is easy to stop thinking about. It now carries a customer's internal Jira/Linear
    // hostname — infrastructure disclosure, not just a number.
    pro.proWorkspaceSettings,
    // The per-WORKSPACE Slack delivery targets (plugin 0030) — and THIS IS THE ONLY PATH THAT CAN
    // REACH THEM. Core's `accountScopedTables()` cannot see plugin tables across the open-core
    // boundary, so an omission here would leave a table holding a live SECRET (the incoming-webhook
    // URL, stored plaintext) behind an account deletion the privacy policy calls complete. Like
    // pro_workspace_settings above it also carries an ON DELETE CASCADE onto core's `workspaces`,
    // and for the same reason that is not the promise: the cascade only fires if core deletes the
    // workspace rows before this hook runs.
    pro.workspaceSlackTargets,
    // The Slack event signals' sent markers (plugin 0040): ids only, but account-scoped.
    pro.slackSignalNotices,
    // (The stored Jira tickets and the acceptance-criteria field choice left with the issue
    // tracker at apiVersion 23 — core's `eraseAccountData` erases `tracker_tickets`,
    // `pro_jira_ac_fields` and `workspace_trackers`.)
    // Last: per-account config — down to the comparison mode, the narration model and the bot
    // toggles. Its seven `slack_*` columns are DORMANT since plugin 0030 and its `sprint_*` +
    // `issue_*` columns since 0031: all twelve still hold whatever was configured before those
    // migrations copied the data out, which is one more reason this delete stays UNCONDITIONAL and
    // is a `delete FROM the table` rather than a narrowed column write. A dormant column is
    // invisible to drizzle; it is not invisible to an erasure promise.
    pro.proSettings,
  ] as const;
  for (const table of tables) {
    // Each delete is independent; one failing table must not abandon the rest of the erasure.
    try {
      await ctx.db
        .delete(table)
        .where(eq((table as unknown as { accountId: never }).accountId, accountId))
        .execute();
    } catch (err) {
      ctx.log.error({ err, accountId }, 'pro erasure: table delete failed');
    }
  }
}
