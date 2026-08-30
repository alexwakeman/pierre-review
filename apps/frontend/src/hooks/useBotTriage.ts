import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotAnalyticsResponse,
  BotBehaviourResponse,
  BotDedupResponse,
  BotOnlyPrsResponse,
  PrBotBehaviourResponse,
  ResolvableThreadPrsResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ReviewerCostBody,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// Per-request cap on the workspace-wide resolve: the client chunks a larger reviewed selection into
// sequential POSTs so a hundreds-of-threads resolve streams progress instead of one multi-minute
// request. MUST stay ≤ the server's SCOPE_RESOLVE_THREAD_CAP (500) body limit.
const RESOLVE_CHUNK_SIZE = 25;

// The Bots sub-tab UNMOUNTS on every tab / sub-tab switch, so at the default 5-min gcTime its
// queries are evicted after a short absence and reopening shows the BotRoiPanel skeleton +
// refetch. These stay short-stale (60s) so they still background-refresh on reopen — the longer
// gcTime only keeps the last snapshot resident so the charts/table repaint WARM immediately
// instead of blank. Reuses the Activity ceiling (45 min).

// The bot-triage read/write hooks — deterministic, no AI on either tier. Every getter is
// account-scoped server-side; these are plain DB reads that refresh on the sync cadence.
//
// ── WHICH OF THESE ARE FREE AND WHICH ARE PAID ──────────────────────────────────────────────────
// FREE (`botTriage`): the reviewer listing + the four write/reset hooks (classification is free so
// an `npx` install can do it), the bot-only-PR list, per-PR dedup and behaviour, and the resolvable
// bot-thread read/resolve pair. Free means free — no `enabled` gate on any of them.
//
// PAID (`botDepth`): `useBotBehaviour` (whose route lives in the plugin), and — since the Bot-ROI
// panel went paid as a whole — the volume family and the per-vendor / flagging drill-downs, whose
// hooks live in useBotVolume.ts, useBotVendorPrs.ts and useBotFlagging.ts. Those routes 402 now, so
// a hook reaching one must gate its `enabled` on the capability or a mounted component will re-fire
// the 402 on its own cadence. `useBotBehaviour` below is the pattern.
//
// ⚠ `useBotAnalytics` IS THE EXCEPTION AND IT IS NOT AN OVERSIGHT — it stays UNGATED because its
// route serves both tiers by NARROWING rather than refusing. Read its own note before adding an
// `enabled: … && botDepth` to it.

// ── THE TWO SCOPE INPUTS, AND WHY THEY ARE SEPARATE SLOTS ───────────────────────────────────────
// `workspaceId` decides the VERDICT — who counts as an automated reviewer, what its vendor and
// price are. `repoIds` only narrows which repos' DATA is measured, and the server intersects it
// with the workspace's membership so it can never reach outside the scope. They answer different
// questions, so they can no longer contradict each other — but they must still occupy DISTINCT key
// slots, because the same repo narrowing under two workspaces is two different answers.
//
// `workspaceId` is the FIRST parameter of every hook here and is required (nullable, not
// optional). That is deliberate: its predecessor's scope argument was OPTIONAL, and the surfaces
// that wanted "everything" simply omitted it — which under a per-workspace model silently reads
// the account's Default. Making it positional and required turns every call site into a tsc error
// rather than something a grep has to find. `null` means "the store has not resolved a workspace
// yet" and holds the query IDLE via `skipToken` — which also narrows the id inside `queryFn`, so
// an unscoped request is unrepresentable rather than merely discouraged.

/** The repo-narrowing key slot: a sorted id list, or 'all' when there is no narrowing. */
export function repoKeySlot(repoIds?: number[] | null): string {
  return repoIds && repoIds.length > 0
    ? [...repoIds].sort((a, b) => a - b).join(',')
    : 'all';
}

// Per-reviewer bot ROI / utilisation analytics over the selected window. Keyed by
// (window, workspace, repo narrowing) so any of the three refetches. Cost arrives SERVER-resolved
// on each row from that reviewer's `workspace_reviewers.monthly_cents` (`costMonthlyUsd` /
// `costPerActedOnUsd`).
//
// ⚠ THE PRICE IS PER WORKSPACE. Within this one response there is exactly one row per actor, so a
// total here is a plain sum — but the same actor's row in another workspace may legitimately hold
// a different number, and nothing may add those together. `enabled` lets the caller gate the fetch.
//
// ── TWO TIERS, ONE RESPONSE: DO NOT GATE THIS HOOK ON `botDepth` ────────────────────────────────
// The ROI table this feeds is paid, but the SAME response carries two free things: the amber "only
// a bot reviewed N open PRs" governance caution (`totals.botOnlyPrs`) and the tuning-suggestions
// box (`suggestions`), both mounted in BotsView OUTSIDE the paid panel. So the ROUTE narrows rather
// than 402s — an unentitled account gets those two fields real and the ROI population withheld
// (`vendors` empty, `ml`/`qualityChecks` absent, the ROI half of `totals` zeroed) — and this hook
// stays open on every tier. A `botDepth` gate here would make the caution and the suggestions
// silently vanish: both read with `?? 0` / `?? []`, so nothing would error, they would just stop
// appearing.
//
// ⚠ THE CLIENT DECIDES WHAT TO DRAW FROM `/api/me`, NEVER BY SNIFFING THIS PAYLOAD. The zeroed
// `totals` fields are a wire artefact of three REQUIRED keys on `BotAnalyticsResponse`, not a
// measurement — the paid consumers (BotRoiPanel and its drill-downs) gate on the capability and
// never render them.
export function useBotAnalytics(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotAnalyticsResponse>({
    queryKey: ['bot-analytics', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    // `skipToken`, not a bare `enabled`: it NARROWS `workspaceId` to a number, so a request with
    // no workspace — which the server answers from the account's DEFAULT — cannot be written.
    queryFn:
      workspaceId == null ? skipToken : () => api.botAnalytics(window, workspaceId, repoIds),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Bot BEHAVIOUR analytics (TTFR / LoC-to-comments / 24h heatmap / follow-ups) over the selected
// window. Same workspace/repoIds resolution and the same two-slot key rule as useBotAnalytics.
// Deterministic compute, but the SURFACE is Pro depth (plan P0.2): the route moved to
// /api/pro/bot-behaviour behind the `botDepth` capability, so this hook gates the fetch on it —
// with botDepth false (OSS: the route doesn't exist; free cloud: it would 402) NOTHING is
// fetched and no error surfaces; consumers simply render nothing. Return shape is unchanged.
// `botUserId` narrows the response to ONE bot (the per-bot depth drill-down tab, plan P1.1/C1) —
// the server admits only ids in the workspace's review-role set, so a stale id yields the empty
// response, never someone else's data. It gets its OWN key slot (`bot:<id>` — the refineQueryKey
// precedent): without it two bots' depth tabs, or a tab and the workspace-wide charts, would
// share one cache entry and silently show each other's data.
export function useBotBehaviour(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
  botUserId?: number | null,
) {
  const { botDepth } = useProCapabilities();
  return useQuery<BotBehaviourResponse>({
    queryKey: [
      'bot-behaviour',
      window,
      workspaceKey(workspaceId),
      repoKeySlot(repoIds),
      botUserId != null ? `bot:${botUserId}` : 'bot:all',
    ],
    queryFn:
      workspaceId == null
        ? skipToken
        : () => api.botBehaviour(window, workspaceId, repoIds, botUserId),
    enabled: enabled && botDepth,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The exact PR list behind the analytics `totals.botOnlyPrs` count ("only a bot reviewed
// these"), served by a dedicated route so the count and its expandable list can't disagree.
// SAME window/workspace/repoIds as useBotAnalytics → the same server-side resolution, and the same
// key shape so the two cannot be scoped differently. `enabled` gates the fetch so the caller only
// hits the route when the panel is expanded.
export function useBotOnlyPrs(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotOnlyPrsResponse>({
    queryKey: ['bot-only-prs', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    queryFn:
      workspaceId == null ? skipToken : () => api.botOnlyPrs(window, workspaceId, repoIds),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// The bot-reviewer listing: ONE `WorkspaceReviewer` row per actor in the workspace, each carrying
// its judgement (automated / role), its identity (kind / label), its price, and the evidence
// behind them (`footprint` + `repoFootprints`). Feeds the Bots "Settings" list, the feed's vendor
// tag, ThreadList's resolve count and the bot colour map. There is no rows/reviewers split any
// more — one grain, one row.
//
// ⚠ FREE ROUTE, PAID COLUMNS. The listing itself must never be gated — it is the identity and
// colour backbone for the whole SPA (feed vendor tags, ThreadList, BotTriageCard, the People
// picker) and it backs the free classification screen. But the PRICE columns
// (`costMonthlyUsd` / `effectiveMonthlyUsd`) arrive null-and-'flat' for an account without
// `botDepth` — the server strips them, so a consumer that shows a price is showing one the account
// is entitled to rather than one the client was trusted to hide.
//
// ⚠ THE WORKSPACE IS THE GRAIN, so it is REQUIRED and it is in the key. Identity used to be
// account-wide, which is why several callers deliberately passed nothing; under this model an
// unscoped call reads whichever workspace the server defaults to, and every colour, vendor name
// and price on screen comes from the wrong scope. There is no "account-wide roster" to ask for.
//
// THREE key segments, because the judgement grain and the display narrowing are now independent
// questions: the workspace decides the verdict, `repoIds` only narrows which footprints are shown.
// The old single slot conflated them, and a scoped listing would populate the entry the unscoped
// consumers read — a bot losing its colour because someone opened the Settings tab.
// Exported so the cache-separation rule is testable rather than a comment.
// (test/botReviewerQueryKey.test.ts)
export function detectedReviewersQueryKey(
  workspaceId: number | null,
  repoIds?: number[] | null,
): [string, string, string] {
  return ['bot-reviewers', workspaceKey(workspaceId), repoKeySlot(repoIds)];
}

export function useDetectedReviewers(
  workspaceId: number | null,
  repoIds?: number[] | null,
  enabled = true,
) {
  return useQuery<DetectedReviewersResponse>({
    queryKey: detectedReviewersQueryKey(workspaceId, repoIds),
    queryFn: workspaceId == null ? skipToken : () => api.botReviewers(workspaceId, repoIds),
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
  // PREFIXES, deliberately — and that is exactly what keeps them correct now that every entry is
  // keyed `[name, 'ws:<id>', …]`. A write is workspace-wide but a user can have several workspaces
  // cached at once (the Compare surface, a tab left open on another scope), and only a prefix
  // sweeps them all. Over-invalidating is cheap; under-invalidating reads as "it didn't take".
  'bot-reviewers',
  'bot-analytics',
  'bot-behaviour',
  'bot-only-prs',
  'bot-resolvable',
  'bot-vendor-prs',
  'bot-vendor-comments',
  // The "what the bots are flagging" drill-down. Its population IS the automated set — the
  // server's label scan filters on `automatedReviewerUserIds`, so marking a login human (or a
  // new one automated) changes every tile's number and every row of every selector's list.
  'bot-flagging',
  'bot-dedup',
  // The per-PR ML label index (['ml-labels', prId]) is deliberately NOT here: it holds stored
  // labels for named targets, which a reclassification does not alter. (The 'bot-severity'
  // rollup key left with GET /api/bot-severity — its fold now rides 'bot-analytics'.)
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

// ── THE WRITE SURFACE: TWO WRITES + TWO RESETS, SPLIT BY MUTABILITY (NOT BY GRAIN) ──────────────
// There is ONE grain now — a `workspace_reviewers` row keyed (account, workspace, actor) — so the
// old three-hook split by grain has nothing left to defend against and collapses. What survives is
// a MUTABILITY difference:
//
//   • `automated` / `role` / `kind` / `label` are RE-DERIVABLE — a wrong write is fixed by the next
//     classification pass or by a reset. They share ONE patch body, keyed by TWO INDEPENDENT
//     provenance flags (`source` for the judgement, `identitySource` for the identity).
//   • `monthlyCents` is derivable by nothing and is money. It keeps its own route so no combined
//     body can address the column at all — the same structural guarantee the two-TABLE split used
//     to provide, with one fewer table.
//
// ⚠ THE PROVENANCE INDEPENDENCE IS NOW THE ONLY THING DOING THE JOB THE TWO TABLES DID. With
// judgement and identity on one row there is no table boundary left to catch a write that stamps
// one flag while the user edited the other — which is exactly the bug ("Not a bot" on one repo
// blanking CodeRabbit's brand colour everywhere) the split existed to kill. Send ONLY the fields
// the user actually edited.
//
// ⚠ EVERY WRITE HERE IS WORKSPACE-WIDE. The old per-repo PATCH could honestly promise "this leaves
// your other repos alone"; nothing here can. A control rendered in a repo-shaped context (the
// per-repo Bots tab, a feed card's "not a bot?") must say so in its copy.

// PATCH /api/bot-reviewers/:userId — the four re-derivable fields of ONE workspace_reviewers row.
// All four are optional (absent = leave alone) but a body carrying NONE of them 400s server-side.
// Returns the re-read row, so a caller can render the result without waiting for the listing.
//
// ⚠ It cannot carry a price: `WorkspaceReviewerPatchBody` has no cost field and the handler's
// `set:` object has no cost key.
export function useSetWorkspaceReviewer() {
  const qc = useQueryClient();
  return useMutation<
    WorkspaceReviewer,
    Error,
    { userId: number; body: WorkspaceReviewerPatchBody }
  >({
    mutationFn: ({ userId, body }) => api.setWorkspaceReviewer(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// PUT /api/bot-reviewers/:userId/cost — what this bot costs IN THIS WORKSPACE. A number sets it
// (0 is a real price meaning "we pay nothing"), null CLEARS it — a column write, never a row
// delete, because the row also carries the judgement and the identity.
//
// ⚠ Price is a per-WORKSPACE fact like everything else on the row. The same actor's rows in other
// workspaces are untouched and may hold different numbers; never sum across workspaces.
export function useSetReviewerCost() {
  const qc = useQueryClient();
  return useMutation<WorkspaceReviewer, Error, { userId: number; body: ReviewerCostBody }>({
    mutationFn: ({ userId, body }) => api.setReviewerCost(userId, body),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// ── AND THE TWO WAYS BACK TO AUTO, ONE PER PROVENANCE FLAG ──────────────────────────────────────
// Without these every write above is PERMANENT: a manual write pins its half against
// re-derivation, and flipping the value back by hand leaves it pinned on the new value. They are
// two hooks because they clear two INDEPENDENT flags — merging them would be the very coupling the
// split exists to prevent.
//
// ⚠ Both are an UPDATE + immediate re-derive server-side, NOT a row delete (the row carries the
// other half and the price), which is why each answers 200 with the re-derived row rather than 204.

// Hand `automated` / `role` / `confidence` / `reasons` back to detection for ONE workspace.
// Offer it only where `WorkspaceReviewer.isManualOverride` is true — on an already-auto row it is
// a no-op that looks like a broken button. Touches no identity and no price.
export function useResetReviewerJudgement() {
  const qc = useQueryClient();
  return useMutation<WorkspaceReviewer, Error, { userId: number; workspaceId: number }>({
    mutationFn: ({ userId, workspaceId }) => api.resetReviewerJudgement(userId, workspaceId),
    // The same invalidation set as a WRITE: the row comes back re-derived, which can move the actor
    // in or out of the automated cohort for the workspace, so every downstream surface shifts
    // exactly as it does on a write.
    onSuccess: () => invalidateReclassify(qc),
  });
}

// Hand `kind` + `label` back to detection for ONE workspace. Offer it only when
// `WorkspaceReviewer.identitySource === 'manual'`.
//
// ⚠ THE PRICE SURVIVES — it shares the row but is not a classification opinion. The UI must say
// so; "reset" reads as "delete everything" otherwise.
export function useResetReviewerIdentity() {
  const qc = useQueryClient();
  return useMutation<WorkspaceReviewer, Error, { userId: number; workspaceId: number }>({
    mutationFn: ({ userId, workspaceId }) => api.resetReviewerIdentity(userId, workspaceId),
    onSuccess: () => invalidateReclassify(qc),
  });
}

// Cross-bot dedup + consensus/conflict clusters for a PR (≥2 automated reviewers of distinct
// kinds on the same path/line window). Fetched only when a PR id is in hand. NO workspace
// parameter: the server derives the judgement scope from the PR's own repo, which is the only
// workspace that can be right for it — so there is nothing here for a caller to get wrong.
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
// Workspace-free for the same reason as usePrBotDedup — the PR names its own scope.
export function usePrBotBehaviour(prId: number | null, enabled = true) {
  return useQuery<PrBotBehaviourResponse>({
    queryKey: ['pr-bot-behaviour', prId],
    queryFn: () => api.prBotBehaviour(prId as number),
    enabled: enabled && prId != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}


// The workspace-wide review list — every PR with ≥1 `likely_addressed` automated-reviewer thread
// (grouped by PR, UNCAPPED, newest-thread-first, each carrying its full resolvable-thread-id
// list + `totalThreads`). `enabled` gates the fetch (the banner mounts it eagerly — the OSS/no-
// bots path can pass false). No refetchInterval: it refreshes on the resolve invalidation, not a
// poll. Same two-slot key rule as useBotAnalytics.
export function useResolvableBotThreads(
  workspaceId: number | null,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<ResolvableThreadPrsResponse>({
    queryKey: ['bot-resolvable', workspaceKey(workspaceId), repoKeySlot(repoIds)],
    queryFn:
      workspaceId == null ? skipToken : () => api.resolvableBotThreads(workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}

// Resolve a whole reviewed thread-id list workspace-wide. One long request would sit for minutes on
// hundreds of GraphQL mutations, so the list is CHUNKED into ≤RESOLVE_CHUNK_SIZE sequential POSTs;
// each chunk's outcome is aggregated and `onProgress` fires after it so the UI can stream
// "Resolving… X/Y". A `shouldStop` predicate is checked BEFORE each chunk so a long resolve-all
// can be halted between chunks (clean — never mid-chunk). The server re-derives eligibility per
// chunk (never blind); a chunk that resolves nothing still counts toward progress. onSettled
// invalidates every surface a resolve shifts (the review list, the analytics/PR lists, the feed).
//
// ⚠ `workspaceId` IS REQUIRED AND IS THE WHOLE POINT. It is the SAME id the listing was fetched
// under, which is what makes "the offer and the resolve agree" structural rather than a
// convention. Its predecessor sent an optional `repoIds` while the listing was resolved from a
// TEAM scope, so a reviewer marked automated only under a per-team override had its threads
// offered and then found ineligible — the route resolved 0 with no error anywhere. One workspace
// id on both sides cannot disagree with itself. (`repoIds` is GONE from the body: the resolve acts
// on ids the user explicitly ticked, and narrowing them a second time could only silently drop
// some of them.)
export function useScopeResolveBotThreads() {
  const qc = useQueryClient();
  return useMutation<
    { resolved: number; failed: number; stopped: boolean },
    Error,
    {
      threadIds: number[];
      workspaceId: number;
      // The PRs the selected threads belong to (the caller has the grouped list) — each gets
      // its cached PR detail invalidated so the Threads tab reflects the resolves.
      prIds?: number[];
      onProgress?: (done: number, total: number, resolved: number, failed: number) => void;
      // Checked before each chunk — returning true halts the run cleanly between chunks.
      shouldStop?: () => boolean;
    }
  >({
    mutationFn: async ({ threadIds, workspaceId, onProgress, shouldStop }) => {
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
        const res = await api.scopeResolveBotThreads({ threadIds: chunk, workspaceId });
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
      // The comments drill-down shows each thread's derivedState, which a resolve just changed.
      void qc.invalidateQueries({ queryKey: ['bot-vendor-comments'] });
      // Same reason for the flagging drill-down: its comment cards and its cluster members both
      // render `derivedState`.
      void qc.invalidateQueries({ queryKey: ['bot-flagging'] });
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
