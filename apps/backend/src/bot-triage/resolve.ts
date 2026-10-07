import type { ResolveBotThreadsResult } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { setReviewThreadResolved } from '../github/mutations.js';
import { stampThreadResolved } from '../db/queries.js';
import { notePrChangedForPrs } from '../sync/pr-settle.js';

// Resolve a batch of already-eligible review threads on GitHub AND stamp them resolved
// locally. This is the ONE place the GitHub `resolveReviewThread` mutation is driven for
// bot-thread triage — shared verbatim by the manual per-PR `POST /api/prs/:id/resolve-bot-
// threads` route and the workspace-wide `POST /api/bot-threads/resolve`, so their behaviour
// can't drift. Both are strictly user-initiated + confirm-gated — there is no automatic/cron
// resolve of BOT threads. The ONE automatic resolve anywhere is review/claude-review/
// auto-resolve.ts, a deliberate exception scoped to LIMN'S OWN finding threads (posted by the
// reader through Limn, marker-stamped), behind a per-workspace switch that is OFF by default.
//
// Callers own eligibility: `getResolvableBotThreads` (per-PR — the workspace comes from the PR's
// own repo, via `botScopeForPr`) / `getResolvableBotThreadsForScope` (workspace-wide — takes the
// `BotScope` the route built with `resolveWorkspaceScope`) return ONLY owned + automated-reviewer-
// originated + `likely_addressed` + unresolved threads (with a GitHub node id), so this helper
// never has to re-derive it.
//
// ⚠ THE CALLER'S RE-DERIVATION MUST RUN AT THE SAME WORKSPACE THE LISTING OFFERED FROM. "Is this
// login a bot" is answered once per workspace, so a listing resolved at workspace A and a resolve
// re-derived at workspace B disagree about which threads are bot threads — the listing offers a
// backlog and the resolve then finds nothing eligible, returning 0 with no error anywhere. That
// was a real, already-closed gap and it must not reopen: `ScopeResolveBotThreadsBody.workspaceId`
// is what makes the two sides structurally the same scope, and this helper cannot check it — by
// the time threads reach here the judgement has already been made.
//
// It NEVER merges — it only resolves. Sequential (not Promise.all) to stay gentle on the GraphQL
// rate limit (a bot backlog is a handful of threads); per-thread try/catch so one bad thread or a
// moved head never aborts the batch. The token is fetched once per batch from the OWNING account,
// so a bad/absent token throws BEFORE the loop — the caller (route or job) decides how to surface it.
//
// Each thread names its PR (`prId`, from the caller's own eligibility read) so the helper can raise
// the SPA change signal for every repo it stamped, ONCE, before the route replies — the stamps move
// the Pending thread cards, and no walk will report them (sync/pr-settle.ts `notePrChangedForPrs`).
export async function resolveThreadsOnGitHub(
  accountId: number,
  threads: { id: number; threadNodeId: string; prId: number }[],
): Promise<ResolveBotThreadsResult> {
  const out: ResolveBotThreadsResult = { resolved: 0, failed: 0, results: [] };
  // Empty selection → a no-op (never even fetch a token) — matches the manual route's
  // "stale client list / no eligible threads is a no-op, not an error" contract.
  if (threads.length === 0) return out;

  const token = await getAccessToken(accountId);
  const stampedPrIds = new Set<number>();
  for (const t of threads) {
    try {
      await setReviewThreadResolved(token, t.threadNodeId, true);
      const derivedState = await stampThreadResolved(t.id, true, accountId);
      out.results.push({ threadId: t.id, ok: true, derivedState: derivedState ?? 'resolved' });
      out.resolved += 1;
      stampedPrIds.add(t.prId);
    } catch {
      out.results.push({ threadId: t.id, ok: false, derivedState: null });
      out.failed += 1;
    }
  }
  // Never throws, and a no-op when nothing was stamped.
  await notePrChangedForPrs(accountId, [...stampedPrIds]);
  return out;
}
