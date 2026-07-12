import type { ResolveBotThreadsResult } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { setReviewThreadResolved } from '../github/mutations.js';
import { stampThreadResolved } from '../db/queries.js';

// Resolve a batch of already-eligible review threads on GitHub AND stamp them resolved
// locally. This is the ONE place the GitHub `resolveReviewThread` mutation is driven for
// bot-thread triage — shared verbatim by BOTH the manual `POST /api/prs/:id/resolve-bot-
// threads` route and the standing auto-triage scheduled job, so their behaviour can't drift.
//
// Callers own eligibility: both `getResolvableBotThreads` and `getAutoResolveCandidates`
// return ONLY owned + automated-reviewer-originated + `likely_addressed` + unresolved threads
// (with a GitHub node id), so this helper never has to re-derive it. It NEVER merges — it only
// resolves. Sequential (not Promise.all) to stay gentle on the GraphQL rate limit (a bot
// backlog is a handful of threads); per-thread try/catch so one bad thread or a moved head
// never aborts the batch. The token is fetched once per batch from the OWNING account, so a
// bad/absent token throws BEFORE the loop — the caller (route or job) decides how to surface it.
export async function resolveThreadsOnGitHub(
  accountId: number,
  threads: { id: number; threadNodeId: string }[],
): Promise<ResolveBotThreadsResult> {
  const out: ResolveBotThreadsResult = { resolved: 0, failed: 0, results: [] };
  // Empty selection → a no-op (never even fetch a token) — matches the manual route's
  // "stale client list / no eligible threads is a no-op, not an error" contract.
  if (threads.length === 0) return out;

  const token = await getAccessToken(accountId);
  for (const t of threads) {
    try {
      await setReviewThreadResolved(token, t.threadNodeId, true);
      const derivedState = await stampThreadResolved(t.id, true, accountId);
      out.results.push({ threadId: t.id, ok: true, derivedState: derivedState ?? 'resolved' });
      out.resolved += 1;
    } catch {
      out.results.push({ threadId: t.id, ok: false, derivedState: null });
      out.failed += 1;
    }
  }
  return out;
}
