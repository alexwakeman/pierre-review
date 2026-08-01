import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotAnalyticsResponse,
  BotBehaviourResponse,
  BotDedupResponse,
  BotOnlyPrsResponse,
  PrBotBehaviourResponse,
  ResolvableThreadPrsResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  RepoReviewerJudgementBody,
  ReviewerCostBody,
  ReviewerIdentityBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME } from './useActivity.js';

// Per-request cap on the scope-wide resolve: the client chunks a larger reviewed selection into
// sequential POSTs so a hundreds-of-threads resolve streams progress instead of one multi-minute
// request. MUST stay ≤ the server's SCOPE_RESOLVE_THREAD_CAP (500) body limit.
const RESOLVE_CHUNK_SIZE = 25;

// The Bots sub-tab UNMOUNTS on every tab / sub-tab switch, so at the default 5-min gcTime its
// queries are evicted after a short absence and reopening shows the BotRoiPanel skeleton +
// refetch. These stay short-stale (60s) so they still background-refresh on reopen — the longer
// gcTime only keeps the last snapshot resident so the charts/table repaint WARM immediately
// instead of blank. Reuses the Activity ceiling (45 min).

// The bot-triage read/write hooks (CORE, deterministic — no AI). Detection, dedup and the
// confirm-gated thread resolve are free-tier; the Bot-ROI analytics panel that consumes
// useBotAnalytics is UI-gated on caps.teamInsights by its component (the route itself is core). Every getter
// is account-scoped server-side; these are plain DB reads that refresh on the sync cadence.

// Per-vendor bot ROI / utilisation analytics over the selected window. Keyed by window +
// scope so either change refetches. Cost arrives SERVER-resolved on each row from the ACTOR's
// `account_reviewers` price (`costMonthlyUsd`/`costPerActedOnUsd`) — account-wide even though the
// row is scoped, so never sum it across rows. The client no longer overlays it from pro_settings
// except as an un-applied legacy pointer (see lib/botCost.ts). `enabled` lets the
// caller gate the fetch. `scope` ('all' | 'none' | '<teamId>') narrows to a team's repos.
export function useBotAnalytics(
  window: BotWindowKind,
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  // A repo scope (the per-repo Bots tab) wins over the team scope, both here and on the wire.
  // NAMESPACE the key slot (`repo:` vs `scope:`) — a bare repoId and a numeric teamId are both
  // plain integer strings (repo/team ids are independent autoincrements), so an un-prefixed slot
  // would let repo N alias team N's cache entry and show the wrong in-account scope.
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<BotAnalyticsResponse>({
    queryKey: ['bot-analytics', window, repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.botAnalytics(window, scope, repoIds),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// EXPERIMENTAL bot BEHAVIOUR analytics (TTFR / LoC-to-comments / 24h heatmap / follow-ups) over
// the selected window. Same window/scope/repoIds resolution + key-namespacing rule as
// useBotAnalytics (repo scope wins over team scope; the `repo:`/`scope:` slot prevents a bare
// repoId aliasing a numeric teamId). CORE / deterministic — the "Behaviour" sub-tab consumes it.
export function useBotBehaviour(
  window: BotWindowKind,
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<BotBehaviourResponse>({
    queryKey: ['bot-behaviour', window, repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.botBehaviour(window, scope, repoIds),
    enabled,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The exact PR list behind the analytics `totals.botOnlyPrs` count ("only a bot reviewed
// these"), served by a dedicated route so the count and its expandable list can't disagree.
// SAME window/scope/repoIds as useBotAnalytics → the same server-side resolution. `enabled`
// gates the fetch so the caller only hits the route when the panel is expanded. The query key
// MUST namespace the scope slot (`repo:` vs `scope:`) exactly like useBotAnalytics — a bare
// repoId and a numeric teamId are both plain integer strings and would otherwise collide.
export function useBotOnlyPrs(
  window: BotWindowKind,
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<BotOnlyPrsResponse>({
    queryKey: ['bot-only-prs', window, repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.botOnlyPrs(window, scope, repoIds),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The bot-reviewer listing: one IDENTITY per actor (kind / label / price — account-wide) plus one
// JUDGEMENT row per (repo, actor) (automated / role — this repo only), plus the repo ids covered.
// Feeds the Bots "Settings" list, the feed's vendor tag, ThreadList's resolve count and the bot
// colour map.
//
// ⚠ CALL IT WITH NO ARGUMENTS FOR THE ACCOUNT-WIDE ROSTER. `scope`/`repoIds` narrow it exactly
// like /api/bot-analytics (repoIds wins when present). The account-wide consumers — useBotColors,
// FeedView's vendor tag, ThreadList's vendor filter — need the WHOLE roster and pass nothing;
// they filter `rows` client-side when they want one repo, which also keeps them on the single
// warm cache entry instead of one per repo.
//
// ⚠ THE SCOPE IS IN THE QUERY KEY, and it has to be. The narrow and wide responses have the SAME
// SHAPE, so without a distinct key a scoped listing would populate the entry those account-wide
// surfaces read and silently shrink their roster — a bot losing its colour and its feed tag
// because someone opened the Settings tab. NAMESPACE the slot (`repo:` vs `scope:`): a bare
// repoId and a numeric teamId are both plain integer strings from independent autoincrements, so
// an un-prefixed slot would let repo N alias team N.
// Exported so the cache-separation rule is testable rather than a comment.
// (test/botReviewerQueryKey.test.ts)
export function detectedReviewersQueryKey(
  scope?: string,
  repoIds?: number[] | null,
): [string, string] {
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return ['bot-reviewers', repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`];
}

export function useDetectedReviewers(
  scope?: string,
  repoIds?: number[] | null,
  enabled = true,
) {
  return useQuery<DetectedReviewersResponse>({
    queryKey: detectedReviewersQueryKey(scope, repoIds),
    queryFn: () => api.botReviewers(scope, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Every query key a reclassification shifts. A reviewer moving in or out of the automated set (or
// between the review / quality_check roles) changes the ROI table, the behaviour analytics, the
// bot-only-PR list, the resolvable backlog, the per-vendor drill-down, the Activity console's
// acted-on stats, the bot feed and each PR's cached detail (its Bots chip + Bot-activity tab).
// The old hook invalidated only two of these, which read as "the setting didn't take".
const RECLASSIFY_INVALIDATE_KEYS = [
  // A PREFIX, deliberately: an identity or price edit is account-wide, so every
  // ['bot-reviewers', 'scope:*' | 'repo:*'] entry must refetch, not just the one on screen. A
  // per-repo judgement edit only moves one entry, but it is cheap to over-invalidate and
  // expensive to under-invalidate (a settings change that "didn't take" until reload).
  'bot-reviewers',
  'bot-analytics',
  'bot-behaviour',
  'bot-only-prs',
  'bot-resolvable',
  'bot-vendor-prs',
  'bot-dedup',
  'pr-bot-behaviour',
  'activity',
  'consolidated-feed',
  'pr',
] as const;

function invalidateReclassify(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of RECLASSIFY_INVALIDATE_KEYS) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

// ── THE THREE WRITE HOOKS, AT TWO GRAINS ────────────────────────────────────────────────────
// One hook per route, deliberately NOT one hook with an optional-field body. The predecessor was
// a single mutation whose body could carry a repo judgement AND a vendor identity AND a price,
// and the failure it produced is worth restating: marking CodeRabbit "not a bot" in ONE repo also
// wrote `kind: null` at the ACTOR grain, so it lost its brand colour and vendor name in every
// other repo — ones the user never touched, with no surface to undo it from. Three hooks means a
// call site has to NAME the grain it is editing. DO NOT MERGE THEM BACK.

// PER REPO: is this actor automated HERE, and is it reviewing or quality-checking HERE.
// `repoId` is required — the row is the object. Stamps the ROW's `source: 'manual'`, which the
// classifier then never re-derives.
//
// ⚠ It carries no kind/label/cost. Naming a vendor and pricing it are the other two hooks.
export function useRepoReviewerJudgement() {
  const qc = useQueryClient();
  // `void` result: the reply body is never read — the invalidation below refetches the listing,
  // which is the only surface any of this renders from. See api.setRepoReviewerJudgement.
  return useMutation<void, Error, { userId: number; body: RepoReviewerJudgementBody }>({
    mutationFn: ({ userId, body }) => api.setRepoReviewerJudgement(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// ACCOUNT-WIDE: who this actor IS — vendor kind and display label. One row per (account, actor),
// so there is nowhere for a divergent copy to live. Stamps `identity_source: 'manual'`, including
// on a clear, or the next classification pass reinstates the kind the user just rejected.
//
// ⚠ It must never carry `automated`/`role`: stamping the row-level `source` from here would
// freeze auto-classification on every one of that actor's repos.
export function useReviewerIdentity() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: number; body: ReviewerIdentityBody }>({
    mutationFn: ({ userId, body }) => api.setReviewerIdentity(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// ── AND THE TWO WAYS BACK TO AUTO, ONE PER GRAIN ────────────────────────────────────────────
// Without these, every write above is PERMANENT: a manual edit pins the row against
// re-derivation, and flipping the value back by hand leaves it pinned on the new value. They are
// two hooks for the same reason the writes are two — their blast radii differ by an order of
// magnitude, and a single hook with an optional repoId would put "this row" and "this bot
// everywhere" one argument apart.

// PER REPO: forget the human judgement on ONE row so detection re-derives it. Offer it only where
// `RepoReviewer.isManualOverride` is true — on an already-auto row it is a no-op that looks like a
// broken button. Touches no identity and no price.
export function useResetRepoReviewerJudgement() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: number; repoId: number }>({
    mutationFn: ({ userId, repoId }) => api.resetRepoReviewerJudgement(userId, repoId),
    // The same invalidation set as a judgement WRITE: the row comes back re-derived, which can
    // move the actor in or out of the automated cohort for that repo, so every downstream surface
    // shifts exactly as it does on a write.
    onSuccess: () => invalidateReclassify(qc),
  });
}

// ACCOUNT-WIDE: forget the human's vendor naming so detection names it again, in every repo.
// Offer it only when `ReviewerIdentity.identitySource === 'manual'`.
//
// ⚠ THE PRICE SURVIVES — it shares the row but is not a classification opinion. The UI must say
// so; "reset" reads as "delete everything" otherwise.
export function useResetReviewerIdentity() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: number }>({
    mutationFn: ({ userId }) => api.resetReviewerIdentity(userId),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// ACCOUNT-WIDE: what this actor costs per month. A number sets (0 is a real price meaning "free"),
// null clears. One subscription, one price — never per repo.
export function useReviewerCost() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: number; body: ReviewerCostBody }>({
    mutationFn: ({ userId, body }) => api.setReviewerCost(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// Cross-bot dedup + consensus/conflict clusters for a PR (≥2 automated reviewers of distinct
// kinds on the same path/line window). Fetched only when a PR id is in hand.
export function usePrBotDedup(prId: number | null, enabled = true) {
  return useQuery<BotDedupResponse>({
    queryKey: ['bot-dedup', prId],
    queryFn: () => api.prBotDedup(prId as number),
    enabled: enabled && prId != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Per-PR bot behaviour (EXPERIMENTAL, CORE): each automated reviewer's on-PR touch timeline +
// how its TTFR / follow-ups compare to that bot's OWN typical. Fetched only when a PR is open
// AND it has bot activity (the caller gates `enabled`), so human-only PRs never hit the route.
export function usePrBotBehaviour(prId: number | null, enabled = true) {
  return useQuery<PrBotBehaviourResponse>({
    queryKey: ['pr-bot-behaviour', prId],
    queryFn: () => api.prBotBehaviour(prId as number),
    enabled: enabled && prId != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}


// The scope-wide review list — every PR with ≥1 `likely_addressed` automated-reviewer thread
// (grouped by PR, UNCAPPED, newest-thread-first, each carrying its full resolvable-thread-id
// list + `totalThreads`). `enabled` gates the fetch (the banner mounts it eagerly — the OSS/no-
// bots path can pass false). No refetchInterval: it refreshes on the resolve invalidation, not a
// poll. The query key MUST namespace the scope slot (`repo:` vs `scope:`) exactly like
// useBotAnalytics — a bare repoId and a numeric teamId are both plain integer strings and would
// otherwise collide.
export function useResolvableBotThreads(
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<ResolvableThreadPrsResponse>({
    queryKey: ['bot-resolvable', repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.resolvableBotThreads(scope, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Resolve a whole reviewed thread-id list scope-wide. One long request would sit for minutes on
// hundreds of GraphQL mutations, so the list is CHUNKED into ≤RESOLVE_CHUNK_SIZE sequential POSTs;
// each chunk's outcome is aggregated and `onProgress` fires after it so the UI can stream
// "Resolving… X/Y". A `shouldStop` predicate is checked BEFORE each chunk so a long resolve-all
// can be halted between chunks (clean — never mid-chunk). The server re-derives eligibility per
// chunk (never blind); a chunk that resolves nothing still counts toward progress. onSettled
// invalidates every surface a resolve shifts (the review list, the analytics/PR lists, the feed).
export function useScopeResolveBotThreads() {
  const qc = useQueryClient();
  return useMutation<
    { resolved: number; failed: number; stopped: boolean },
    Error,
    {
      threadIds: number[];
      repoIds?: number[] | null;
      // The PRs the selected threads belong to (the caller has the grouped list) — each gets
      // its cached PR detail invalidated so the Threads tab reflects the resolves.
      prIds?: number[];
      onProgress?: (done: number, total: number, resolved: number, failed: number) => void;
      // Checked before each chunk — returning true halts the run cleanly between chunks.
      shouldStop?: () => boolean;
    }
  >({
    mutationFn: async ({ threadIds, repoIds, onProgress, shouldStop }) => {
      const total = threadIds.length;
      let resolved = 0;
      let failed = 0;
      let done = 0;
      let stopped = false;
      for (let i = 0; i < threadIds.length; i += RESOLVE_CHUNK_SIZE) {
        if (shouldStop?.()) {
          stopped = true;
          break;
        }
        const chunk = threadIds.slice(i, i + RESOLVE_CHUNK_SIZE);
        const res = await api.scopeResolveBotThreads({
          threadIds: chunk,
          ...(repoIds && repoIds.length > 0 ? { repoIds } : {}),
        });
        resolved += res.resolved;
        failed += res.failed;
        done += chunk.length;
        onProgress?.(done, total, resolved, failed);
      }
      return { resolved, failed, stopped };
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ['bot-resolvable'] });
      void qc.invalidateQueries({ queryKey: ['bot-analytics'] });
      void qc.invalidateQueries({ queryKey: ['bot-only-prs'] });
      void qc.invalidateQueries({ queryKey: ['bot-vendor-prs'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      // Mirror the per-PR resolve hook (usePrWrites.useResolveBotThreads): the Activity
      // console's acted-on stats, the triage queue, and each affected PR's cached detail
      // (+ its thread queries) all shift when threads resolve.
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['thread'] });
      for (const prId of vars.prIds ?? []) {
        void qc.invalidateQueries({ queryKey: ['pr', prId] });
      }
    },
  });
}
