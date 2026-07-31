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
  ReviewerClassification,
  ReviewerOverrideBody,
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
// scope so either change refetches. Cost now arrives SERVER-resolved per team on each row
// (`costMonthlyUsd`/`costPerActedOnUsd`/`costInherited`) — the client no longer overlays it from
// pro_settings except as a null-filling legacy fallback (see lib/botCost.ts). `enabled` lets the
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

// Every distinct reviewer in the account joined with its automated/human classification,
// volume and a sample review body — the per-team Bots "Settings" tab, and (at the account
// default) the per-bot cost picker, the feed's vendor tag and the bot colour map.
//
// `teamId` selects WHICH team's answers to show: an explicit row for that team → the team-0
// default → auto-detection. `null`/absent/0 = NO_TEAM_KEY, the account default — which is the
// right answer for every account-wide consumer, so the existing zero-arg call sites keep working
// and keep meaning what they meant.
//
// The `team:` key prefix is MANDATORY, for the same reason the `repo:`/`scope:` slots below carry
// theirs: repo ids, team ids and this key are all bare integers from independent autoincrements,
// so an un-prefixed slot would let team N alias some other N.
//
// `scoped` narrows the listing to the reviewers with a footprint in the requested team's OWN
// repos (at team 0: the repos in no team), and is what turns `scopedRepoCount` from null into a
// number. It is OPT-IN, taken by exactly one caller — the per-team Settings tab.
//
// ⚠ `scoped` IS IN THE QUERY KEY, and it has to be. The other consumers (useBotColors, FeedView's
// vendor tag, ThreadList's vendor filter) all call this hook at team:0 to mean "the whole account
// roster"; the two responses have the SAME shape and the same team key, so without this slot the
// narrow listing would populate the cache entry those surfaces read and silently shrink their
// roster — a bot losing its colour and its feed tag because someone opened a Settings tab. The
// unscoped key is spelled out ('repos:all') rather than omitted so the distinction is legible in
// the devtools cache list instead of being an absence.
// Exported so the cache-separation rule is testable rather than a comment: a scoped listing and
// an account-wide one must NEVER produce the same key. (test/botReviewerQueryKey.test.ts)
export function detectedReviewersQueryKey(
  teamId?: number | null,
  scoped = false,
): [string, string, string] {
  const key = teamId != null && teamId > 0 ? teamId : 0;
  return ['bot-reviewers', `team:${key}`, scoped ? 'repos:team' : 'repos:all'];
}

export function useDetectedReviewers(
  teamId?: number | null,
  enabled = true,
  opts?: { scoped?: boolean },
) {
  const key = teamId != null && teamId > 0 ? teamId : 0;
  const scoped = opts?.scoped === true;
  return useQuery<DetectedReviewersResponse>({
    queryKey: detectedReviewersQueryKey(teamId, scoped),
    queryFn: () => api.botReviewers(key, scoped),
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
  // A PREFIX, deliberately: editing the team-0 default shifts every team that inherits it, so
  // every ['bot-reviewers', 'team:*'] entry must refetch, not just the one that was edited.
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

// Two-way manual override of a reviewer's classification (mark automated / not-a-bot, set its
// vendor kind/label, set its ReviewerRole). The team key rides in the BODY (`teamId`, absent =
// the account default) because it is part of the row's identity, not a filter.
//
// ⚠ ALSO THE COST-ONLY WRITE PATH, and the two must not be conflated. A body WITHOUT `automated`
// carries no classification opinion (see `buildCostOnlyBody` in lib/botCost.ts) and the server
// leaves automated/kind/source/confidence alone; a body WITH it stamps the row `source: 'manual'`,
// which freezes that reviewer's classification forever. Never add `automated` to a cost edit to
// "be explicit" — the absence IS the contract.
export function useReviewerOverride() {
  const qc = useQueryClient();
  return useMutation<
    ReviewerClassification,
    Error,
    { userId: number; body: ReviewerOverrideBody }
  >({
    mutationFn: ({ userId, body }) => api.setReviewerOverride(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// "Reset to default": drop this reviewer's explicit row for one team so it inherits the account
// default again. NOT the same as "Not a bot", which writes a fresh override saying "human" that
// the team would then be stuck with. Only offered for a row the listing reported as a real team
// override (`inherited === false`) — on an inherited row it deletes nothing and the user cannot
// tell that apart from a reset that worked.
export function useDeleteReviewerOverride() {
  const qc = useQueryClient();
  return useMutation<void, Error, { userId: number; teamId: number }>({
    mutationFn: ({ userId, teamId }) => api.deleteReviewerOverride(userId, teamId),
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
