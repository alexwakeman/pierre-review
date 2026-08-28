import type {
  ActiveReviewsResponse,
  AdvisorBriefResponse,
  AdvisorConfigEventBody,
  AdvisorConfigPrBody,
  AdvisorConfigPrResponse,
  AdvisorPreviewResponse,
  AdvisorDiscoveryResponse,
  AdvisorEffectResponse,
  AdvisorFindingsResponse,
  AdvisorManifestConfirmBody,
  AdvisorProfilePutBody,
  AdvisorRefineBody,
  AdvisorRefineResponse,
  AuthProvidersResponse,
  AddReviewCommentBody,
  AddReviewCommentResult,
  RequestReviewersBody,
  RequestReviewersResult,
  AiFixMergePreview,
  AiFixPushBody,
  AiFixPushResult,
  AiFixRebaseBody,
  AiFixResponse,
  AiFixStatusResponse,
  ApprovePrBody,
  ApprovePrResult,
  CheckLogsResponse,
  CiAnalysisResponse,
  CiRerunBody,
  CiRerunResult,
  FailingCheckInput,
  GenerateFixBody,
  PrSummaryResponse,
  ClaudeKeyResponse,
  ClaudeReview,
  ClaudeReviewListResponse,
  ClaudeReviewModel,
  RequestedReviewMode,
  ClaudeReviewResponse,
  ClaudeReviewStatusResponse,
  ClaudeReviewVerdict,
  ClaudeKeyStatusResponse,
  ReviewBudgetResponse,
  CreatePrCommentBody,
  CreatePrCommentResult,
  CreateRepoBody,
  ConsolidatedFeedResponse,
  WorkspaceInsightsResponse,
  AttentionCardsResponse,
  DailyBriefResponse,
  RepoWorkspaceMetricsResponse,
  WorkspaceMetricsDetailResponse,
  WorkspaceMetricsResponse,
  AiUsageResponse,
  BotWindowKind,
  AutomationOutputResponse,
  BotAnalyticsResponse,
  BotThemesResponse,
  HumanThemesResponse,
  BotBehaviourResponse,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorCommentsResponse,
  BotVendorPrsResponse,
  BotFlaggingSelector,
  BotFlaggingRefine,
  BotFlaggingResponse,
  BotVolumeResponse,
  BotVolumePrsResponse,
  BotVolumeScatterResponse,
  BotVolumePrSort,
  BotDedupResponse,
  PrBotBehaviourResponse,
  DetectedReviewersResponse,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
  ReviewerCostBody,
  MeResponse,
  MlCategory,
  MlSeverity,
  SynthesisFlaggingSelect,
  SynthesisResponse,
  SynthesisScopeKind,
  VendorDisagreeDirection,
  MentionCandidate,
  MergersResponse,
  MergePrBody,
  MergePrResult,
  MergeQueueEnqueueBody,
  MergeQueueResult,
  ArmMergeBody,
  ArmedMergeRequest,
  ArmedMergeListResponse,
  BranchStatusResponse,
  BranchTrendsResponse,
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunResponse,
  PrAnnotationsResponse,
  PrMlLabelsResponse,
  MlEnrichmentStatus,
  ClosePrResult,
  PrMergeOptions,
  UpdateBranchBody,
  UpdateBranchResult,
  DismissedMyTurnResponse,
  MyTurnDismissKind,
  MyTurnResponse,
  ActivityResponse,
  InsightsResponse,
  RepoAnalytics,
  RepoClaudeReviewsResponse,
  RepoDigest,
  RepoDigestsResponse,
  ReviewActionsResponse,
  ReviewLearningsResponse,
  OpenPrsResponse,
  PostCommentResult,
  PostReviewPreview,
  PostReviewResult,
  PrDetail,
  PrFilesResponse,
  PrRefreshBody,
  PrRefreshResponse,
  SuggestedReviewersResponse,
  PresetPromptKey,
  PresetPromptResponse,
  SprintChatBody,
  SprintChatResponse,
  SprintChatHistoryResponse,
  PeriodReportGenerateResponse,
  PeriodReportResponse,
  PersonPeriodResponse,
  PeriodReportsListResponse,
  PinnedPromptsResponse,
  CreatePinnedPromptBody,
  ProSettings,
  ProSettingsUpdate,
  Repo,
  RepoSearchResponse,
  SuggestedReposResponse,
  SearchHitKind,
  SearchResponse,
  Workspace,
  WorkspacesResponse,
  ReactionLookupBody,
  ReactionLookupResponse,
  ReactionWriteBody,
  ReactionWriteResponse,
  ReplyResult,
  ReplyToThreadBody,
  ResolveThreadBody,
  ResolveThreadResult,
  ResolveBotThreadsBody,
  ResolveBotThreadsResult,
  ScopeResolveBotThreadsBody,
  SyncActivityResponse,
  SyncStatus,
  ThreadDetail,
  TimelineResponse,
  User,
  UserContributionStats,
  WorkPlanResponse,
} from '@pierre-review/shared';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    // Seconds from a 429's Retry-After header (null when absent) — lets a poller honor
    // the server's own backoff instead of guessing (see usePrLiveRefresh).
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    const ra = res.headers.get('retry-after');
    throw new ApiError(res.status, message, ra && /^\d+$/.test(ra) ? Number(ra) : null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function get<T>(url: string): Promise<T> {
  // `credentials: 'same-origin'` sends the sealed session cookie in cloud mode;
  // it's harmless (and a no-op) in local mode where there is no cookie.
  return fetch(url, { credentials: 'same-origin' }).then((r) => handle<T>(r));
}

function jsonBody(method: string, body?: unknown): RequestInit {
  // Only declare a JSON content-type when we actually send a body. Fastify
  // rejects an empty body that claims `application/json` with a 400, which would
  // break bodyless calls (DELETE repo, POST sync, dismiss).
  // `credentials: 'same-origin'` carries the session cookie on write paths.
  if (body === undefined) return { method, credentials: 'same-origin' };
  return {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export { ApiError };

// ── THE ONE SCOPE PARAMETER ──────────────────────────────────────────────────────────────────
// `workspace=<id>` (no leading `?`/`&`). A plain positive integer and nothing else: there is no
// sentinel vocabulary left ('all' / 'none' / 'teams' / 'teams:2,4' and the five client
// canonicalisers that produced them are all gone), so there is nothing to canonicalise and
// nothing to parse.
//
// ⚠ IT IS ALWAYS EMITTED, never diffed against a "default" value. The Default workspace's id
// varies per account, so there is no static default to diff against — omitting the parameter means
// "resolve me to whatever Default is", which is a different request, not a shorter spelling of the
// same one. Callers therefore take a REQUIRED `workspaceId: number`; the store holds
// `workspaceId: number | null` and nothing may render workspace-scoped data while it is null.
//
// The server resolves an absent / unparseable / unknown / another tenant's id to the caller's own
// Default workspace (never a 404 — every id yields the same response shape, so it is not an
// existence oracle) and echoes the resolved `workspaceId` back, so a stale stored id self-corrects.
function workspaceParam(workspaceId: number): string {
  return `workspace=${workspaceId}`;
}

// `repoIds=<csv>` — a NARROWING WITHIN the workspace, never a scope in its own right. The server
// intersects it with the workspace's membership (`membership ∩ (repoIds ?? membership)`), so it
// can no longer reach outside the scope and can no longer disagree with it about the verdict:
// `?workspace=` owns "which workspace am I in", this only says "show me fewer of its repos".
//
// ⚠ IT IS EMITTED FOR AN EMPTY ARRAY TOO — `if (ids)`, never `if (ids && ids.length > 0)`. Under
// the old model an empty list was dropped and `null` on the wire meant "every repo in the ACCOUNT",
// so a scope that resolved to no repos was served the whole account: the precise opposite of what
// it asked for. `?workspace=` now closes that hole on its own (an empty workspace's membership is
// `[]` whatever this parameter says), but a builder that drops `[]` is the exact shape of that bug
// and must not be reintroduced — an empty selection is a real narrowing, not the absence of one.
//
// (For completeness: the server's parsers read a VALUE-less `repoIds=` as "no narrowing", the same
// as omitting it. That is not a contradiction — with `?workspace=` also on the wire both readings
// land on the same answer for the only case that can produce an empty array, an empty workspace.
// Do not lean on it: `repoIds=` is not a way to ask for nothing.)
function repoIdsParam(repoIds?: number[] | null): string {
  return repoIds ? `repoIds=${repoIds.join(',')}` : '';
}

// Join query fragments (already URL-encoded, no leading separators) onto a base path.
function withQuery(base: string, ...parts: (string | undefined)[]): string {
  const qs = parts.filter((p): p is string => Boolean(p)).join('&');
  return qs ? `${base}?${qs}` : base;
}

// The synthesis scope on the wire (plan P2.1). One builder for the GET and the POST so the two
// verbs can never address different cache rows; the server canonicalises (fills the 'findings'
// default, drops kind-irrelevant fields) so omitted-vs-explicit spellings land on one row too.
export interface SynthesisRequestParams {
  kind: SynthesisScopeKind;
  window: BotWindowKind;
  workspaceId: number;
  repoIds?: number[] | null;
  botUserId?: number | null;
  direction?: VendorDisagreeDirection | null;
  select?: SynthesisFlaggingSelect | null;
  severities?: MlSeverity[] | null;
  category?: MlCategory | null;
  /** 'person' grain only: the 1:1 subject + the period's real epoch-ms bounds. */
  userId?: number | null;
  fromMs?: number | null;
  toMs?: number | null;
}

function synthesisQueryParts(p: SynthesisRequestParams): (string | undefined)[] {
  return [
    `kind=${encodeURIComponent(p.kind)}`,
    `window=${encodeURIComponent(p.window)}`,
    workspaceParam(p.workspaceId),
    repoIdsParam(p.repoIds),
    p.botUserId != null ? `botUserId=${p.botUserId}` : undefined,
    p.direction ? `direction=${encodeURIComponent(p.direction)}` : undefined,
    p.select ? `select=${encodeURIComponent(p.select)}` : undefined,
    p.severities && p.severities.length > 0
      ? `severities=${encodeURIComponent(p.severities.join(','))}`
      : undefined,
    p.category ? `category=${encodeURIComponent(p.category)}` : undefined,
    p.userId != null ? `userId=${p.userId}` : undefined,
    p.fromMs != null ? `fromMs=${p.fromMs}` : undefined,
    p.toMs != null ? `toMs=${p.toMs}` : undefined,
  ];
}

// The work-plan scope on the wire. ONE builder for the GET (free cached read + `stale` probe)
// and the POST (the billed narration), exactly like the synthesis pair above: the row the POST
// writes and the row the GET reads must be addressable only one way, or a paid generation lands
// in a cache slot the panel never looks at.
//
// `repoIds` is carried for completeness (the server scope is a `BotScope`, and it resolves the
// narrowing as `membership ∩ narrow`), but the Activity console — the only surface that mounts
// this panel — never sends one: the repo picker is Timeline-only, so the plan covers the whole
// workspace. When a caller DOES pass an array it goes through `repoIdsParam`, which emits it
// whenever it EXISTS, empty included — an empty workspace must not widen to the whole account.
export interface WorkPlanRequestParams {
  workspaceId: number;
  repoIds?: number[] | null;
}

function workPlanQueryParts(p: WorkPlanRequestParams): (string | undefined)[] {
  return [workspaceParam(p.workspaceId), repoIdsParam(p.repoIds)];
}

export const api = {
  listRepos: () => get<Repo[]>('/api/repos'),
  searchRepos: (q: string, cursor?: string) =>
    get<RepoSearchResponse>(
      `/api/repos/search?q=${encodeURIComponent(q)}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
  // The viewer's recently-active repositories (first-run onboarding). Detected from GitHub
  // activity; already-added repos filtered out server-side; ordered most-recently-pushed first.
  suggestedRepos: () => get<SuggestedReposResponse>('/api/repos/suggested'),
  // Workspace-wide full-text search over the local index (PRs/reviews/comments/people).
  // `workspaceId` is the scope — the server turns it into repo ids itself, so a caller cannot widen
  // it and an empty workspace searches nothing rather than the whole account. `kinds` optionally
  // narrows to hit kinds; paginated.
  search: (opts: {
    q: string;
    workspaceId: number;
    kinds?: SearchHitKind[];
    limit?: number;
    offset?: number;
  }) => {
    const p = new URLSearchParams({ q: opts.q, workspace: String(opts.workspaceId) });
    if (opts.kinds && opts.kinds.length > 0) p.set('kinds', opts.kinds.join(','));
    if (opts.limit != null) p.set('limit', String(opts.limit));
    if (opts.offset != null) p.set('offset', String(opts.offset));
    return get<SearchResponse>(`/api/search?${p.toString()}`);
  },
  // Adding is the whole decision: the repo lands in a workspace and is immediately live
  // everywhere (Feed, Activity, My Turn, Bots). There is no follow-up per-repo visibility call —
  // `setRepoInboxWatch` and the `PATCH /api/repos/:id` body it wrote are both GONE.
  addRepo: (body: CreateRepoBody) =>
    fetch('/api/repos', jsonBody('POST', body)).then((r) => handle<Repo>(r)),
  deleteRepo: (id: number) =>
    fetch(`/api/repos/${id}`, jsonBody('DELETE')).then((r) => handle<void>(r)),
  syncRepo: (id: number, full = false) =>
    fetch(`/api/repos/${id}/sync${full ? '?full=true' : ''}`, jsonBody('POST')).then(
      (r) => handle<{ status: string }>(r),
    ),
  // Cancel an in-flight sync. Resolves once the backend has stopped the sync and
  // (for an initial-load repo) deleted it. `deleted` says whether it was removed.
  cancelSync: (id: number) =>
    fetch(`/api/repos/${id}/cancel`, jsonBody('POST')).then((r) =>
      handle<{ repoId: number; deleted: boolean }>(r),
    ),
  syncStatus: (id: number) => get<SyncStatus>(`/api/repos/${id}/sync-status`),
  // The account's HEAVY sync work only — full-mode walks (first-sync backfills, deep
  // re-syncs, queued-for-full). Routine incremental ticks are excluded SERVER-side, so
  // the global loading bar polling this never flickers on the 5-minute cron. Account-wide
  // grain (no workspace param), same reasoning as /api/ml-status.
  syncActivity: () => get<SyncActivityResponse>('/api/sync-activity'),

  // ---- Workspaces (CORE) ----
  //
  // A workspace groups an account's repos, and a repo belongs to EXACTLY ONE of them — a database
  // fact (`workspace_repos`, UNIQUE `(account_id, repo_id)`). Two consequences shape this block:
  //
  //   • ASSIGNMENT IS A MOVE, NOT AN ADD. Putting a repo in a workspace takes it out of whatever
  //     workspace it was in; there is no second membership row to create.
  //   • THERE IS NO UN-ASSIGN, and `unassignRepoFromTeam`'s route is GONE (not renamed). "Belongs
  //     to no workspace" is not a state, so removing a repo from a workspace IS moving it to the
  //     account's Default — expressed either by omitting it from a PATCH's `repoIds` (the server
  //     re-homes it) or by POSTing it to the Default workspace's own id.
  //
  // The listing repairs two silent invariants server-side before it answers: every account has a
  // Default row, and every repo has a membership row. So `listWorkspaces()` is also the client's
  // "make the world coherent" call, and the sync effect that resolves a null `workspaceId` reads
  // its `isDefault` row.
  listWorkspaces: () => get<WorkspacesResponse>('/api/workspaces'),
  // Always created with `isDefault: false` — the Default row is auto-created server-side and is the
  // only one that may carry the flag. A duplicate name 400s.
  createWorkspace: (name: string) =>
    fetch('/api/workspaces', jsonBody('POST', { name })).then((r) =>
      handle<{ workspace: Workspace }>(r),
    ),
  // Rename and/or SET the membership (PATCH accepts `{ name?, repoIds? }`). RENAMING THE DEFAULT IS
  // ALLOWED — it is not deletable, which is a different thing.
  renameWorkspace: (id: number, body: { name?: string; repoIds?: number[] }) =>
    fetch(`/api/workspaces/${id}`, jsonBody('PATCH', body)).then((r) =>
      handle<{ workspace: Workspace }>(r),
    ),
  // Replace a workspace's membership with exactly `repoIds`: ids ADDED are MOVED in, ids DROPPED
  // are re-homed to Default.
  //
  // ⚠ MEMBERSHIP IS THE ONLY THING THIS WRITES. A move never changes what a repo covers — every
  // repo is fully live in whichever workspace holds it (Feed, Activity, My Turn, Bots), so there
  // is no second per-repo visibility flag for a re-home to silently flip on or off. That used to
  // be a real hazard: the drop leg deliberately skipped the old `inboxWatch` write so a repo a
  // user had un-watched wasn't re-watched on its way out. The column is gone; the property now
  // holds by construction rather than by omission, and nothing here should start writing per-repo
  // state again.
  setWorkspaceRepos: (id: number, repoIds: number[]) =>
    fetch(`/api/workspaces/${id}`, jsonBody('PATCH', { repoIds })).then((r) =>
      handle<{ workspace: Workspace }>(r),
    ),
  // 204 on success. ⚠ TWO OTHER OUTCOMES THE UI MUST TELL APART: 404 for a foreign/unknown id, and
  // **409 `{error:'DefaultWorkspace'}`** for the default row, which cannot be deleted — it is where
  // new repos land and where a deleted workspace's repos AND reviewer rows (judgements, vendor
  // names, prices) are re-homed. Hide the control on `workspace.isDefault` rather than relying on
  // the 409.
  deleteWorkspace: (id: number) =>
    fetch(`/api/workspaces/${id}`, jsonBody('DELETE')).then((r) => handle<void>(r)),
  // MOVE one repo into this workspace. Membership is the only write (see `setWorkspaceRepos`) —
  // the repo was already fully live wherever it was, and it stays fully live here.
  // To take a repo OUT of a workspace, move it into the Default one — there is no delete route.
  assignRepoToWorkspace: (workspaceId: number, repoId: number) =>
    fetch(`/api/workspaces/${workspaceId}/repos`, jsonBody('POST', { repoId })).then((r) =>
      handle<{ workspace: Workspace }>(r),
    ),

  listUsers: () => get<User[]>('/api/users'),
  // One contributor's ALL-TIME totals (PRs authored by state, reviews given, comments) for the
  // user popover. Counts only: the caller already has the account-scoped user roster from
  // `listUsers`.
  //
  // ⚠ `workspaceId` IS REQUIRED AND IS NOT COSMETIC. The server narrows to
  // `membership ∩ (repoIds ?? membership)`, so a `repoIds` from OUTSIDE the named workspace
  // intersects to nothing and the popover reports all zeros. When the handle was clicked inside a
  // PR, pass that PR's repo AND that repo's OWN workspace (`Repo.workspaceId`) — a PR can be opened
  // from another workspace via `?pr=`, a restored tab or a search hit, and the currently-SELECTED
  // workspace would then be the wrong one. Otherwise pass the active workspace and the
  // FilterBar-visible repo set, which is what the popover's caption says it is showing.
  userStats: (userId: number, workspaceId: number, repoIds?: number[] | null) =>
    get<UserContributionStats>(
      withQuery(
        `/api/users/${userId}/stats`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  mergers: () => get<MergersResponse>('/api/mergers'),
  // `setUserBot` was removed with `PATCH /api/users/:id`: it wrote the GLOBAL users row with
  // no ownership check, so one tenant could permanently reclassify a login for everyone. It
  // had no caller. Bot classification is `setWorkspaceReviewer` below, which writes the
  // account-scoped, per-WORKSPACE `workspace_reviewers` table.

  // ── THE FOUR SEARCH-STRING CONTENT READS ────────────────────────────────────────────────────
  // `timeline` / `openPrs` / `inbox` / `consolidatedFeed` take a pre-built query string rather than
  // named arguments, because their filter surface is wide and lives in the store.
  //
  // ⚠ THE BUILDER MUST PUT `workspace=<id>` IN THAT STRING, and must emit `repoIds` even when the
  // list is EMPTY. These routes used to carry repo ids alone, with `null` meaning "every repo of
  // the account" — which under a workspace scope is two bugs at once: an empty workspace sends no
  // ids and is served the WHOLE ACCOUNT, and two different workspaces both sitting on
  // `repoIds = null` produce the SAME query string, so React Query serves one workspace's data
  // under the other's cache key with no refetch. The cache key must carry `ws:<id>` too — the
  // request being right does not make the key right. The five workspace-scoped content routes are
  // `/api/activity`, `/api/activity/feed`, `/api/timeline`, `/api/open-prs` and
  // `/api/branch-status`; their builders are `buildTimelineSearch` / `buildOpenPrsSearch` in
  // `store/filters.ts`, `activitySearch` in `hooks/useActivity.ts`, and `hooks/
  // {useConsolidatedFeed,useBranchStatus}.ts`.
  timeline: (search: string) =>
    get<TimelineResponse>(`/api/timeline${search ? `?${search}` : ''}`),
  openPrs: (search: string) =>
    get<OpenPrsResponse>(`/api/open-prs${search ? `?${search}` : ''}`),
  // NOT workspace-scoped, deliberately: `/api/insights` is a per-repo snapshot whose caller already
  // names its repos, so there is no scope left for a workspace to decide. `repoIds` only.
  insights: (search: string) =>
    get<InsightsResponse>(`/api/insights${search ? `?${search}` : ''}`),
  repoAnalytics: (repoId: number) =>
    get<RepoAnalytics>(`/api/insights/${repoId}/analytics`),
  pr: (id: number) => get<PrDetail>(`/api/prs/${id}`),
  // Live PR-detail freshness (probe-gated server-side; a quiet poll tick is free). The
  // manual Refresh button passes {wait:true} — an unconditional re-read of GitHub that
  // queues behind any in-flight sync. `{synced:false}` is a report, not an error.
  refreshPr: (id: number, opts?: PrRefreshBody) =>
    fetch(`/api/prs/${id}/refresh`, jsonBody('POST', opts?.wait ? { wait: true } : {})).then(
      (r) => handle<PrRefreshResponse>(r),
    ),
  // Suggested reviewers — a live query (deliberately NOT part of the cached PR detail) so it
  // reflects current state (empties the moment a reviewer is requested).
  suggestedReviewers: (id: number) =>
    get<SuggestedReviewersResponse>(`/api/prs/${id}/suggested-reviewers`),
  thread: (id: number) => get<ThreadDetail>(`/api/threads/${id}`),
  // @mention candidates for a PR, pre-ranked by proximity (self + bots excluded), each
  // flagged `isMaintainer` for this PR's repo.
  mentionCandidates: (prId: number) =>
    get<MentionCandidate[]>(`/api/prs/${prId}/mention-candidates`),
  // @mention candidates for a whole WORKSPACE, for the ad-hoc Insights box — the scope-wide sibling
  // of `mentionCandidates` above, which is one PR's. (The name keeps the word "scope" for that
  // contrast alone; a workspace IS the scope, and there is no other kind left.) The id resolves to
  // the workspace's repos server-side, so a caller cannot widen it and an empty workspace yields no
  // candidates rather than the account's whole roster.
  scopeMentionCandidates: (workspaceId: number) =>
    get<MentionCandidate[]>(withQuery('/api/mention-candidates', workspaceParam(workspaceId))),
  prFiles: (id: number) => get<PrFilesResponse>(`/api/prs/${id}/files`),
  // A WINDOW of a failed GitHub Actions check's logs (fetched live, never stored).
  //
  // Two shapes, mirroring the route: pass `tail` for the legacy "last N lines" open, or an
  // explicit `startByte`/`endByte` range for the scroll-up "load earlier" step (feed back the
  // `startByte` the previous response reported, minus the chunk you want). The response always
  // states the window it actually served plus `hasMore` (more log exists ABOVE it).
  checkLogs: (
    prId: number,
    jobId: number,
    opts?: { tail?: number; startByte?: number; endByte?: number },
  ) => {
    const p = new URLSearchParams();
    if (opts?.tail != null) p.set('tail', String(opts.tail));
    if (opts?.startByte != null) p.set('startByte', String(opts.startByte));
    if (opts?.endByte != null) p.set('endByte', String(opts.endByte));
    const qs = p.toString();
    return get<CheckLogsResponse>(
      `/api/prs/${prId}/checks/${jobId}/logs${qs ? `?${qs}` : ''}`,
    );
  },
  // Re-trigger a GitHub Actions workflow run (needs repo write access).
  rerunCi: (prId: number, body: CiRerunBody) =>
    fetch(`/api/prs/${prId}/ci/rerun`, jsonBody('POST', body)).then((r) =>
      handle<CiRerunResult>(r),
    ),

  // ---- PR write actions ----
  replyToThread: (threadId: number, body: ReplyToThreadBody) =>
    fetch(`/api/threads/${threadId}/reply`, jsonBody('POST', body)).then((r) =>
      handle<ReplyResult>(r),
    ),
  resolveThread: (threadId: number, body: ResolveThreadBody) =>
    fetch(`/api/threads/${threadId}/resolve`, jsonBody('POST', body)).then((r) =>
      handle<ResolveThreadResult>(r),
    ),
  // Bulk-resolve the likely-addressed review-bot threads on a PR (Phase 3 "clear the bot
  // backlog"). The server re-derives eligibility; we send the reviewed thread-id list.
  resolveBotThreads: (prId: number, body: ResolveBotThreadsBody) =>
    fetch(`/api/prs/${prId}/resolve-bot-threads`, jsonBody('POST', body)).then((r) =>
      handle<ResolveBotThreadsResult>(r),
    ),
  createPrComment: (prId: number, body: CreatePrCommentBody) =>
    fetch(`/api/prs/${prId}/comment`, jsonBody('POST', body)).then((r) =>
      handle<CreatePrCommentResult>(r),
    ),
  approvePr: (prId: number, body?: ApprovePrBody) =>
    fetch(`/api/prs/${prId}/approve`, jsonBody('POST', body ?? {})).then((r) =>
      handle<ApprovePrResult>(r),
    ),
  // Merge control (CORE / free tier): the repo's allowed methods + live mergeability, the
  // merge itself, and the update-branch-from-trunk.
  mergeOptions: (prId: number) => get<PrMergeOptions>(`/api/prs/${prId}/merge-options`),
  mergePr: (prId: number, body: MergePrBody) =>
    fetch(`/api/prs/${prId}/merge`, jsonBody('POST', body)).then((r) => handle<MergePrResult>(r)),
  // Close a PR without merging (CORE / free tier). Reversible on GitHub.
  closePr: (prId: number) =>
    fetch(`/api/prs/${prId}/close`, jsonBody('POST', {})).then((r) => handle<ClosePrResult>(r)),
  updatePrBranch: (prId: number, body?: UpdateBranchBody) =>
    fetch(`/api/prs/${prId}/update-branch`, jsonBody('POST', body ?? {})).then((r) =>
      handle<UpdateBranchResult>(r),
    ),

  // ---- Merge queue (GitHub-native) ----
  // Enqueue / dequeue this PR on the repo's merge queue. Only offerable when
  // `mergeOptions().mergeQueue?.enabled` — the routes 400 otherwise rather than guessing.
  enqueueMergeQueue: (prId: number, body?: MergeQueueEnqueueBody) =>
    fetch(`/api/prs/${prId}/merge-queue`, jsonBody('POST', body ?? {})).then((r) =>
      handle<MergeQueueResult>(r),
    ),
  dequeueMergeQueue: (prId: number) =>
    fetch(`/api/prs/${prId}/merge-queue`, jsonBody('DELETE')).then((r) =>
      handle<MergeQueueResult>(r),
    ),

  // ---- Auto-merge (Pierre-side "arm it and walk away") ----
  // Arm: record the intent to merge THIS head once the blockers clear. The server pins the
  // current head SHA as `expectedHeadOid`, so a later push disarms instead of merging code the
  // user never saw. Disarm resolves to void (204).
  armAutoMerge: (prId: number, body: ArmMergeBody) =>
    fetch(`/api/prs/${prId}/auto-merge`, jsonBody('POST', body)).then((r) =>
      handle<ArmedMergeRequest>(r),
    ),
  disarmAutoMerge: (prId: number) =>
    fetch(`/api/prs/${prId}/auto-merge`, jsonBody('DELETE')).then((r) => handle<void>(r)),
  // Every armed (and recently-resolved) intent for the account — the cross-PR "what's queued
  // to land" surface. Pure DB read.
  armedMerges: () => get<ArmedMergeListResponse>('/api/auto-merge'),

  // ---- Default-branch status ("is trunk green?") ----
  // Per-repo default-branch head + recent trunk commits with their CI state, for the active
  // WORKSPACE. Pure DB read off the branch sync — never a live GitHub call.
  //
  // ⚠ THE FIFTH AND LAST OF THE WORKSPACE-SCOPED CONTENT ROUTES, and a `search` passthrough like
  // the other four: the same two rules apply, and `branchStatusSearch` in `hooks/useBranchStatus.ts`
  // owns the builder. `workspace=<id>` must be in the string (without it an EMPTY workspace sends no
  // ids and is served the whole account's trunk strip, and two workspaces on `repoIds = null`
  // collide in one cache slot), and `repoIds` must be emitted even when empty.
  branchStatus: (search: string) =>
    get<BranchStatusResponse>(`/api/branch-status${search ? `?${search}` : ''}`),
  // The two lazy trend series behind an EXPANDED default-branch row (CI failures/day over the
  // retained trunk window, LOC merged/week). One repo, fetched only on expand — deliberately not
  // part of the workspace-scoped branchStatus payload above. Pure DB read; ownership → 404.
  branchTrends: (repoId: number) =>
    get<BranchTrendsResponse>(`/api/branch-trends?repoId=${repoId}`),
  addReviewComment: (prId: number, body: AddReviewCommentBody) =>
    fetch(`/api/prs/${prId}/review-comment`, jsonBody('POST', body)).then((r) =>
      handle<AddReviewCommentResult>(r),
    ),
  requestReviewers: (prId: number, body: RequestReviewersBody) =>
    fetch(`/api/prs/${prId}/request-reviewers`, jsonBody('POST', body)).then((r) =>
      handle<RequestReviewersResult>(r),
    ),

  // ---- Activity (Workstream 1; CORE, no AI) ----
  // The multi-repo triage aggregate (per repo: stats, thread totals, grouped PRs) for the
  // active WORKSPACE. A pure DB read — "Refresh" re-queries this, it never triggers a GitHub sync.
  //
  // ⚠ Its `search` string MUST carry `workspace=<id>` (and `repoIds` even when empty) — see the
  // note above `timeline`. `activitySearch` in `hooks/useActivity.ts` owns this builder.
  inbox: (search: string) =>
    get<ActivityResponse>(`/api/activity${search ? `?${search}` : ''}`),
  // The consolidated Feed (the Activity "Feed" entry): one chronological stream across the
  // workspace's repos, each row flagged `isMyTurn` by participation. Pure DB read. The
  // `search` string carries the workspace + the active repo/member narrowing (`workspace`,
  // `repoIds`, `userIds`, …) — the bots-only path in particular NEEDS the workspace id, since "is
  // this login a bot" is a workspace fact. `hooks/useConsolidatedFeed.ts` owns this builder.
  consolidatedFeed: (search: string) =>
    get<ConsolidatedFeedResponse>(`/api/activity/feed${search ? `?${search}` : ''}`),
  // Mark the Activity Feed as seen (server-side "seen" marker → resets the new-My-Turn count).
  markFeedSeen: () =>
    fetch('/api/activity/feed/mark-seen', jsonBody('POST')).then((r) =>
      handle<{ feedLastSeenAt: string }>(r),
    ),
  // Which GitHub sign-in providers this deployment offers. Read signed-OUT by the SignInGate
  // and signed-IN by the Settings "GitHub App" section (which needs `appSlug` for the install
  // link). Exempt from the cloud auth gate, so it resolves in both states.
  authProviders: () => get<AuthProvidersResponse>('/api/auth/providers'),
  // Cross-org benchmark consent (cloud-only): opt in/out of contributing aggregate weekly
  // review-bot stats. Opting in seeds contributions server-side; opting out deletes them.
  setBenchmarkConsent: (optIn: boolean) =>
    fetch('/api/me/benchmark-consent', jsonBody('POST', { optIn })).then((r) =>
      handle<{ status: string; benchmarkOptIn: boolean }>(r),
    ),
  // Workspace review-intelligence "Insights" (Pro; workspaceInsights capability) — the attention
  // CARDS (+ the sprint report). The flow-metric HEADER moved OUT to the free
  // /api/workspace-metrics, the Retro panel was deleted, and cross-workspace comparison is the
  // Reports "By workspace" axis (carried on `periodReport`).
  workspaceInsights: (workspaceId: number) =>
    get<WorkspaceInsightsResponse>(withQuery('/api/pro/insights', workspaceParam(workspaceId))),
  // The workspace flow-metric header (DORA-ish tiles + trends) — CORE/free, rendered in the Feed.
  workspaceMetrics: (workspaceId: number) =>
    get<WorkspaceMetricsResponse>(withQuery('/api/workspace-metrics', workspaceParam(workspaceId))),
  // The attention cards (CORE/free) for the **Pending** rail entry.
  attentionCards: (workspaceId: number) =>
    get<AttentionCardsResponse>(withQuery('/api/attention', workspaceParam(workspaceId))),
  // The daily brief (CORE/free, counts only — plan P3.1/P3.3). `rollup` adds the per-workspace
  // "Elsewhere" count lines; the Pro narration is a SEPARATE synthesis fetch, never this route.
  dailyBrief: (workspaceId: number, rollup: boolean) =>
    get<DailyBriefResponse>(
      withQuery('/api/daily-brief', workspaceParam(workspaceId), rollup ? 'rollup=1' : undefined),
    ),
  // The per-metric PR drill-down behind the flow-metric tiles (loaded on tile click) — CORE/free
  // too, so a Feed tile opens the drill-down for everyone.
  workspaceMetricsDetail: (workspaceId: number) =>
    get<WorkspaceMetricsDetailResponse>(
      withQuery('/api/workspace-metrics/detail', workspaceParam(workspaceId)),
    ),
  // The Insights flow-metric header (tiles + trends) for a SINGLE repo — the per-repo console
  // panel. Metrics-only; tiles render non-clickable there. The route holds a repo id and resolves
  // that repo's OWN workspace server-side, so it takes no `?workspace=`.
  repoWorkspaceMetrics: (repoId: number) =>
    get<RepoWorkspaceMetricsResponse>(`/api/pro/insights/repo/${repoId}/metrics`),
  // (`workspaceComparison` / `GET /api/workspace-metrics/compare` were DELETED with the "Compare
  // workspaces" rail entry — cross-workspace comparison is the Reports "By workspace" axis now,
  // carried on `periodReport`'s response as the optional `byWorkspace` field.)
  // Month-to-date AI-usage rollup (credits, split by seam). Covers all account AI spend.
  aiUsage: () => get<AiUsageResponse>('/api/pro/ai-usage'),
  // (`sprintReport` / `refreshSprintReport` were REMOVED with `SprintReportCard` (the C7 cut
  // list); the `/api/pro/sprint-report*` plugin routes still exist server-side but have no SPA
  // consumer. `retroReport` / `refreshRetroReport` were REMOVED with the Insights "Retro" panel and its
  // `/api/pro/retro*` routes. The retrospective is now a quick-question pill in the ad-hoc chat,
  // which needs no route of its own.)
  // Repo-scoped Claude review history (all runs per PR, newest-first). Gated on
  // config.claudeReviewEnabled; the response's `enabled` flag reflects that.
  repoClaudeReviews: (repoId: number) =>
    get<RepoClaudeReviewsResponse>(`/api/repos/${repoId}/claude-reviews`),

  // ---- Pro per-repo digest (Workstream 2; @pierre/pro, flagged) ----
  // Cached per-repo LLM headline digests. Only fetched when pro.activityDigest is true (absent
  // plugin → 404 / enabled:false).
  //
  // ⚠ THESE TWO TAKE NO WORKSPACE ID, and that is not an oversight. A digest is a per-REPO object:
  // the routes are keyed by `repoIds` alone and always were — the `scope` fragment the client used
  // to append was read by nothing on the server. The caller passes the repo set it wants (the
  // workspace's repos) and folds the workspace into its own CACHE KEY, which is where the
  // scope actually matters: two workspaces' repo sets must not share a cache slot.
  repoDigests: (search: string) =>
    get<RepoDigestsResponse>(withQuery('/api/pro/activity/digests', search)),
  refreshRepoDigests: (search?: string) =>
    fetch(
      withQuery('/api/pro/activity/digests/refresh', search),
      jsonBody('POST'),
    ).then((r) => handle<{ status: string }>(r)),
  // ---- Preset prompts (Pro) ----
  // One-click "ask about this workspace" answers (Markdown), grounded in that workspace's repos.
  presetPrompt: (key: PresetPromptKey, workspaceId: number) =>
    get<PresetPromptResponse>(
      withQuery(
        '/api/pro/preset-prompt',
        `key=${encodeURIComponent(key)}`,
        workspaceParam(workspaceId),
      ),
    ),
  refreshPresetPrompt: (key: PresetPromptKey, workspaceId: number) =>
    fetch(
      withQuery(
        '/api/pro/preset-prompt/refresh',
        `key=${encodeURIComponent(key)}`,
        workspaceParam(workspaceId),
      ),
      jsonBody('POST'),
    ).then((r) => handle<PresetPromptResponse>(r)),
  // ---- Ad-hoc "Ask about the sprint" chat (Pro Haiku; activityDigest capability) ----
  // A free-text question answered from the workspace's snapshot.
  //
  // ⚠ WIRE ODDITY, DELIBERATE: the workspace rides in the POST BODY as `SprintChatBody.scope`, a
  // STRING holding the workspace id (`String(workspaceId)`) — the field name is frozen in the
  // shared contract. The sentinel vocabulary it used to accept is gone; the plugin parses it with
  // `parseWorkspaceId` and persists `ws:<id>` as the cache `scope_key`, whose prefix is what stops
  // a legacy `'3'` (team 3) aliasing onto workspace 3's different repo set. Absent = the Default.
  sprintChat: (body: SprintChatBody) =>
    fetch('/api/pro/insights/ask', jsonBody('POST', body)).then((r) =>
      handle<SprintChatResponse>(r),
    ),
  // The account's paginated chat history (newest-first; stored answers, free to re-open), scoped to
  // the current workspace.
  sprintChatHistory: (limit: number, offset: number, workspaceId: number) =>
    get<SprintChatHistoryResponse>(
      withQuery(
        '/api/pro/insights/chat-history',
        `limit=${limit}`,
        `offset=${offset}`,
        workspaceParam(workspaceId),
      ),
    ),
  // Saved, re-runnable ad-hoc prompts (server-stored per account + workspace).
  pinnedPrompts: (workspaceId: number) =>
    get<PinnedPromptsResponse>(
      withQuery('/api/pro/insights/pinned', workspaceParam(workspaceId)),
    ),
  createPinnedPrompt: (body: CreatePinnedPromptBody) =>
    fetch('/api/pro/insights/pinned', jsonBody('POST', body)).then((r) =>
      handle<{ pinned: PinnedPromptsResponse['prompts'][number] }>(r),
    ),
  deletePinnedPrompt: (id: number) =>
    fetch(`/api/pro/insights/pinned/${id}`, jsonBody('DELETE')).then((r) => handle<void>(r)),

  // ---- Period-over-period reports (Pro `periodReports`; /api/pro/insights/reports/*) ----
  // A stored, forwardable artifact for ONE completed sprint-cadence period: its window-pure
  // metric vector, a coverage-stable comparison against the prior period, and a refusable
  // forecast. The two GETs are FREE (plain DB reads of an immutable row — a stale row is
  // FLAGGED, never silently regenerated); the two POSTs spend model budget.
  //
  // The period travels as a PATH SEGMENT (`sprint-2026-08-18`) — which is exactly why the key
  // is punctuated with a hyphen rather than the colon the plan sketched. It is still
  // `encodeURIComponent`-wrapped here: the key's shape is a server contract, not something the
  // client gets to assume stays path-safe.
  periodReports: (workspaceId: number) =>
    get<PeriodReportsListResponse>(
      withQuery('/api/pro/insights/reports', workspaceParam(workspaceId)),
    ),
  periodReport: (workspaceId: number, periodKey: string) =>
    get<PeriodReportResponse>(
      withQuery(
        `/api/pro/insights/reports/${encodeURIComponent(periodKey)}`,
        workspaceParam(workspaceId),
      ),
    ),
  // The ONE billing path. `model` is the per-run override of the account default
  // (`pro_settings.report_model`); omitted = whatever the account is configured for. The model is
  // part of the stored row's unique key, so generating Sonnet does NOT destroy the Haiku row —
  // asking for a model you already have back is a $0 cache hit (`generated: false`).
  generatePeriodReport: (
    workspaceId: number,
    periodKey: string,
    body: { model?: string } = {},
  ) =>
    fetch(
      withQuery(
        `/api/pro/insights/reports/${encodeURIComponent(periodKey)}/generate`,
        workspaceParam(workspaceId),
      ),
      jsonBody('POST', body),
    ).then((r) => handle<PeriodReportGenerateResponse>(r)),
  // (`periodReportChat` — the per-report drill-down turn — was removed with the panel's old
  // ReportChat: "Ask about this period" is the ad-hoc chat now, grounded via `sprintChat` with
  // explicit period bounds. The `…/reports/:key/chat` route still serves; nothing here calls it.)
  // The 1:1-prep vector (Pro `periodReports`; plan P4.2): one person, one cadence period, FREE
  // deterministic read. `person: null` covers unknown/foreign/bot ids and off-grid periods in
  // one shape. The narration is NOT on this route — it rides the synthesis pair (kind 'person').
  // `evidence` (the People report) asks the same fold for the receipt rows under the vector
  // (`person.evidence`) — still free and deterministic; the 1:1 section keeps passing nothing.
  personPeriod: (workspaceId: number, userId: number, periodKey: string, evidence?: boolean) =>
    get<PersonPeriodResponse>(
      withQuery(
        `/api/pro/insights/person/${userId}`,
        workspaceParam(workspaceId),
        `period=${encodeURIComponent(periodKey)}`,
        evidence ? 'evidence=1' : undefined,
      ),
    ),
  // A single repo's digest (lazy per-repo so a slow Haiku call never blocks the grid).
  repoDigest: (repoId: number) =>
    get<RepoDigest>(`/api/pro/activity/digests/${repoId}`),

  // ---- "Was this TRULY addressed?" check (Pro; reuses the prSummary capability) ----
  // NOTHING is left here on purpose. The per-item one-offs were all callerless:
  // `threadAssessment`/`assessThread` (the standalone comment-validity panel is gone — its
  // `validity` row is the SAME row the annotations reader returns, so it renders through
  // CommentAnnotations now) and `threadAddressed`/`checkThreadAddressed`/`prCommentAddressed`/
  // `checkPrCommentAddressed` (dead before that change). Their per-item server routes
  // (`/api/pro/{threads,pr-comments}/:id/addressed[/check]`) STAY registered as alternate
  // writers into the same `upsertAnnotation` rows.
  //
  // `prAddressedCheck` went with them, and its removal was NOT cosmetic: the PR-wide sweep it
  // posted to — `POST /api/pro/prs/:id/addressed/check` and its `/stream` twin — was deleted
  // along with the "Check review" bar, so the method was calling a 404. Do not reintroduce a
  // whole-PR batch here: that route was one billed LLM call per thread on a PR built to hold
  // bot-flooded thread counts, which is exactly why it was cut.

  // ---- Comment annotations platform (Pro) ----
  // Every stored AI judgement about this PR's comments/threads, optionally narrowed to
  // certain kinds. A pure cache read (free); the run POST below is the only billing path.
  prAnnotations: (prId: number, kinds?: AnnotationKind[]) =>
    get<PrAnnotationsResponse>(
      withQuery(
        `/api/pro/prs/${prId}/annotations`,
        kinds && kinds.length > 0 ? `kinds=${kinds.join(',')}` : '',
      ),
    ),
  // Generate annotations for the body's explicit `targets` (one comment / one thread — the
  // per-item "Check review" button). This is now the ONLY run path: the SSE twin
  // `…/annotations/run/stream` and the PR-wide sweep that needed its progress events are gone,
  // and `AnnotationRunBody.onlyStale` (the sweep's "re-check stale" control) went with them.
  //
  // Pass `signal` — without it the server's `reply.raw.on('close')` abort never fires, so a
  // cancelled run keeps billing to completion. A fat thread anchor still expands past
  // COMBINED_CHUNK_SIZE into several LLM calls, so this is not hypothetical.
  runPrAnnotations: (prId: number, body: AnnotationRunBody, signal?: AbortSignal) =>
    fetch(`/api/pro/prs/${prId}/annotations/run`, {
      ...jsonBody('POST', body),
      ...(signal ? { signal } : {}),
    }).then((r) => handle<AnnotationRunResponse>(r)),

  // ---- ML severity/category labels (CORE, FREE TIER — not under /api/pro/) ----------------
  // Both are pure DB reads: the model runs in a background worker on the server, never on a
  // request, so neither of these can spend anything. They answer normally on a deployment with
  // no severity-api configured (empty labels / enabled:false) — the SPA's gate is
  // `useMlSeverityEnabled()` off /api/me, not a 404 from here.
  prMlLabels: (prId: number) => get<PrMlLabelsResponse>(`/api/prs/${prId}/ml-labels`),

  // ---- Emoji reactions (CORE, free tier; GitHub-live, nothing stored) ---------------------
  // Both are POSTs. The LOOKUP is a read wearing a mutating verb because it carries a target
  // LIST in its body (the `POST /api/prs/:id/refresh` precedent) — never call it per comment:
  // it exists to be fed by the microtask batcher in hooks/useReactions.ts, which is what keeps
  // a whole Feed page at one request instead of one per comment.
  reactionLookup: (body: ReactionLookupBody) =>
    fetch('/api/reactions/lookup', jsonBody('POST', body)).then((r) =>
      handle<ReactionLookupResponse>(r),
    ),
  // Toggle one reaction (`add:false` removes). The response is the AUTHORITATIVE post-write
  // group set straight off GitHub's mutation payload, so the caller overwrites its optimistic
  // state with it rather than refetching.
  setReaction: (body: ReactionWriteBody) =>
    fetch('/api/reactions', jsonBody('POST', body)).then((r) =>
      handle<ReactionWriteResponse>(r),
    ),
  // (`botSeverity` and its GET /api/bot-severity route were REMOVED — the merged Bots ROI table
  // reads the severity fold off `getBotAnalytics` instead.)
  // Live state of the background scoring worker. NO workspace parameter on purpose — the worker
  // walks every workspace, so this is account-wide (see MlEnrichmentStatus). Polled by the sync
  // UI so "sync complete" is not claimed while the model is still scoring what the walk fetched.
  mlStatus: () => get<MlEnrichmentStatus>('/api/ml-status'),

  // ---- Claude Review learnings / memory (Workstream 3; @pierre/pro, flagged) ----
  // Aggregated retrieval signals shown BEFORE a run (Surface 1). Only fetched when
  // pro.reviewMemory is true.
  reviewLearnings: (prId: number) =>
    get<ReviewLearningsResponse>(`/api/pro/prs/${prId}/review-learnings`),
  // The raw captured action log for one review run (Surface 2).
  reviewActions: (reviewId: number) =>
    get<ReviewActionsResponse>(`/api/pro/claude-reviews/${reviewId}/actions`),

  // ---- Pro per-account settings (packages/pro `pro_settings`; the config modal) ----
  // Sprint window + Slack webhook + AI-update policy + Jira/Linear provider. The Slack
  // webhook URL is write-only (never returned; `slack.configured` reflects storage). Absent
  // plugin → 404. Only fetched when at least one Pro capability is on.
  proSettings: () => get<ProSettings>('/api/pro/settings'),
  updateProSettings: (patch: ProSettingsUpdate) =>
    fetch('/api/pro/settings', jsonBody('PUT', patch)).then((r) =>
      handle<ProSettings>(r),
    ),
  // Send a one-off Slack digest to the account's configured webhook now (the modal's "Send test").
  testSlackDigest: () =>
    fetch('/api/pro/slack/test', jsonBody('POST')).then((r) =>
      handle<{ sent: boolean; message?: string }>(r),
    ),

  me: () => get<MeResponse>('/api/me'),
  // Cloud-mode sign-out. 204 No Content; resolves once the session is cleared.
  logout: (): Promise<Response> =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }),
  myTurn: () => get<MyTurnResponse>('/api/my-turn'),
  myTurnDone: () => get<DismissedMyTurnResponse>('/api/my-turn/done'),
  // "Done" — mark one My Turn entry as handled. The dismissal is STICKY BUT NOT PERMANENT: the
  // server honours it only until newer activity supersedes it (a fresh reply on a dismissed
  // thread brings the item back), which is what makes this a "seen" marker rather than a mute.
  // ⚠ `MyTurnDismissKind` has five members and `MyTurnCardReason` has six — 'your_pr' has NO
  // dismissal kind (opening the PR is its dismissal, via the pr_views marker) and the route's
  // schema rejects it, so a caller must never widen this parameter to the card reason.
  dismissMyTurn: (kind: MyTurnDismissKind, refId: number) =>
    fetch('/api/my-turn/dismiss', jsonBody('POST', { kind, refId })).then((r) =>
      handle<{ status: string }>(r),
    ),
  undismissMyTurn: (kind: MyTurnDismissKind, refId: number) =>
    fetch('/api/my-turn/undismiss', jsonBody('POST', { kind, refId })).then((r) =>
      handle<{ status: string }>(r),
    ),
  markPrViewed: (id: number, sha?: string) =>
    fetch(`/api/prs/${id}/mark-viewed`, jsonBody('POST', sha ? { sha } : {})).then(
      (r) => handle<{ status: string }>(r),
    ),
  markAllViewed: (repoIds?: number[]) =>
    fetch(
      '/api/prs/mark-all-viewed',
      jsonBody('POST', repoIds && repoIds.length > 0 ? { repoIds } : {}),
    ).then((r) => handle<{ status: string; count: number }>(r)),
  dismissPr: (id: number) =>
    fetch(`/api/prs/${id}/dismiss`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),

  // ---- Claude Review ----
  claudeReview: (prId: number) =>
    get<ClaudeReviewResponse>(`/api/prs/${prId}/claude-review`),
  // Store (or clear, with an empty string) a user-supplied Anthropic API key.
  // Write-only: the key is never read back; the response just confirms auth state.
  setClaudeKey: (key: string) =>
    fetch('/api/claude-review/key', jsonBody('PUT', { key })).then((r) =>
      handle<ClaudeKeyResponse>(r),
    ),
  // Non-PR read of whether a local Anthropic key is stored (for the Settings modal).
  claudeKeyStatus: () =>
    get<ClaudeKeyStatusResponse>('/api/claude-review/key'),
  // Set (a number, clamped server-side) or clear (null → operator default) the local
  // per-review budget cap.
  setReviewBudget: (usd: number | null) =>
    fetch('/api/claude-review/budget', jsonBody('PUT', { usd })).then((r) =>
      handle<ReviewBudgetResponse>(r),
    ),
  claudeReviewById: (reviewId: number) =>
    get<ClaudeReview>(`/api/claude-reviews/${reviewId}`),
  generateClaudeReview: (
    prId: number,
    model: ClaudeReviewModel,
    mode: RequestedReviewMode,
  ) =>
    fetch(`/api/prs/${prId}/claude-review`, jsonBody('POST', { model, mode })).then(
      (r) => handle<{ reviewId: number; status: string }>(r),
    ),
  claudeReviewStatus: (prId: number) =>
    get<ClaudeReviewStatusResponse>(`/api/prs/${prId}/claude-review/status`),
  cancelClaudeReview: (prId: number) =>
    fetch(`/api/prs/${prId}/claude-review/cancel`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),
  updateClaudeReview: (
    reviewId: number,
    body: { userBody?: string; userVerdict?: ClaudeReviewVerdict },
  ) =>
    fetch(`/api/claude-reviews/${reviewId}`, jsonBody('PATCH', body)).then((r) =>
      handle<{ status: string }>(r),
    ),
  updateClaudeFinding: (
    findingId: number,
    body: { included?: boolean; editedBody?: string },
  ) =>
    fetch(`/api/claude-findings/${findingId}`, jsonBody('PATCH', body)).then((r) =>
      handle<{ status: string }>(r),
    ),
  postClaudeFinding: (findingId: number) =>
    fetch(`/api/claude-findings/${findingId}/post`, jsonBody('POST')).then((r) =>
      handle<PostCommentResult>(r),
    ),
  activeClaudeReviews: () =>
    get<ActiveReviewsResponse>('/api/claude-reviews/active'),
  // One entry per PR (its most-recent succeeded review) within the timeline
  // window, for the Claude Reviews history modal.
  listAllClaudeReviews: () =>
    get<ClaudeReviewListResponse>('/api/claude-reviews'),
  postClaudeReview: (
    reviewId: number,
    userVerdict: ClaudeReviewVerdict,
    dryRun = false,
  ) =>
    fetch(
      `/api/claude-reviews/${reviewId}/post${dryRun ? '?dryRun=true' : ''}`,
      jsonBody('POST', { userVerdict }),
    ).then((r) =>
      handle<PostReviewPreview | PostReviewResult>(r),
    ),

  // ---- AI Fix (Pro) ----
  aiFixSummary: (prId: number) =>
    get<PrSummaryResponse>(`/api/pro/prs/${prId}/summary`),
  refreshAiFixSummary: (prId: number) =>
    fetch(`/api/pro/prs/${prId}/summary/refresh`, jsonBody('POST')).then((r) =>
      handle<PrSummaryResponse>(r),
    ),
  aiFixCiAnalysis: (prId: number) =>
    get<CiAnalysisResponse>(`/api/pro/prs/${prId}/ci-analysis`),
  refreshAiFixCiAnalysis: (prId: number, checks: FailingCheckInput[]) =>
    fetch(`/api/pro/prs/${prId}/ci-analysis`, jsonBody('POST', { checks })).then(
      (r) => handle<CiAnalysisResponse>(r),
    ),
  aiFix: (prId: number) => get<AiFixResponse>(`/api/pro/prs/${prId}/ai-fix`),
  aiFixStatus: (prId: number) =>
    get<AiFixStatusResponse>(`/api/pro/prs/${prId}/ai-fix/status`),
  startAiFix: (prId: number, body: GenerateFixBody) =>
    fetch(`/api/pro/prs/${prId}/ai-fix`, jsonBody('POST', body)).then((r) =>
      handle<{ fixId: number; status: string }>(r),
    ),
  cancelAiFix: (prId: number) =>
    fetch(`/api/pro/prs/${prId}/ai-fix/cancel`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),
  // Push a fix. `plain` resolves to the full result (200); `merge`/`rebase` resolve to
  // a `{ fixId, status:'queued' }` 202 — the caller then subscribes to …/push/stream.
  pushAiFix: (fixId: number, body: AiFixPushBody) =>
    fetch(`/api/pro/ai-fixes/${fixId}/push`, jsonBody('POST', body)).then((r) =>
      handle<AiFixPushResult | { fixId: number; status: string; strategy: string }>(
        r,
      ),
    ),
  // Preview the fix branch vs the trunk (behind/ahead + conflicts).
  aiFixMergePreview: (fixId: number) =>
    fetch(`/api/pro/ai-fixes/${fixId}/merge-preview`, jsonBody('POST')).then((r) =>
      handle<AiFixMergePreview>(r),
    ),
  // Start a rebase-resolve job (stores a reviewable artifact) → { fixId }.
  startAiFixRebase: (fixId: number, body: AiFixRebaseBody) =>
    fetch(`/api/pro/ai-fixes/${fixId}/rebase`, jsonBody('POST', body)).then((r) =>
      handle<{ fixId: number; status: string }>(r),
    ),
  cancelAiFixRebase: (fixId: number) =>
    fetch(`/api/pro/ai-fixes/${fixId}/rebase/cancel`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),
  cancelAiFixPush: (fixId: number) =>
    fetch(`/api/pro/ai-fixes/${fixId}/push/cancel`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),

  // ---- Bot triage (CORE, deterministic, no AI) ----
  //
  // THE BOT OBJECT IS ONE ROW per `(account, WORKSPACE, actor)` — `workspace_reviewers`. It
  // replaced BOTH `repo_reviewers` (the judgement, per repo) and `account_reviewers` (identity +
  // price, per account): with one workspace as the only scope, all three facts are about the same
  // key, so a second table would key on the identical columns and be joined at every call site.
  //
  //   PATCH /api/bot-reviewers/:userId                        automated / role / kind / label
  //   PUT   /api/bot-reviewers/:userId/cost                    monthlyUsd
  //   DELETE /api/bot-reviewers/:userId/judgement?workspaceId= automated+role back to auto
  //   DELETE /api/bot-reviewers/:userId/identity?workspaceId=  kind+label back to auto, PRICE KEPT
  //
  // ⚠ TWO WRITE ROUTES, SPLIT BY MUTABILITY — NOT BY GRAIN. With one grain the old three-route
  // split has nothing left to defend against, but `automated`/`role`/`kind`/`label` are all
  // RE-DERIVABLE (a wrong write is repaired by the next classification pass or by a reset) while
  // `monthly_cents` is derivable by NOTHING and is money. Cost keeps its own route so that no
  // combined body can address the column at all — the same structural guarantee the two-table split
  // used to provide, with one fewer table. Do not fold it into the PATCH.
  //
  // ⚠ THE TWO PROVENANCE FLAGS ARE STILL INDEPENDENT, and they are now the ONLY thing doing the job
  // the table boundary used to do: `source` owns automated/role/confidence/reasons, `identitySource`
  // owns kind/label. A UI that offers ONE "Reset to auto" for both, or a call that stamps one while
  // the user edited the other, brings back the exact bug the 0042/0043 split existed to kill —
  // inside a single row this time, where no table boundary is left to catch it.
  //
  // ⚠ EVERY WRITE HERE IS WORKSPACE-WIDE. The old per-repo PATCH could honestly promise "this
  // leaves your other repos alone"; nothing here can. A control rendered in a repo-shaped context
  // must say so in its copy.
  //
  // ⚠ READS DEGRADE, WRITES 404. `?workspace=` on a read resolves an unknown/foreign id to the
  // caller's Default. A write NAMES the row it edits, so its `workspaceId` must never silently land
  // somewhere else: the server 404s instead — one status for unknown user / unknown-or-foreign
  // workspace / no footprint there, deliberately, so it is never an existence oracle.

  // The listing: one `WorkspaceReviewer` per actor in the workspace, each carrying its judgement,
  // identity, price and the evidence behind them (including `repoFootprints[]`, the real blast
  // radius of an edit that is workspace-wide by design), plus the repo ids the listing covered.
  //
  // `workspaceId` decides the VERDICT; `repoIds` only narrows which repos' footprints are shown,
  // bounded by the workspace's membership server-side. THEY NO LONGER COMPETE — the old "repoIds
  // WINS, so omit the scope" rule is gone, because they answer different questions and both are
  // sent.
  //
  // ⚠ THE ACCOUNT-WIDE CONSUMERS (the bot colour map, the feed's vendor tag, the Threads-tab vendor
  // filter) MUST NAME A WORKSPACE TOO. Identity is per workspace now: `kind`/`label` set in
  // workspace A do not carry into B. Passing no scope used to mean "the whole roster"; there is no
  // such request any more, and reading an arbitrary workspace's identity is the single most
  // dangerous mistake available on this surface. Scoped and unscoped-by-repo responses must not
  // share a cache key either — see `detectedReviewersQueryKey`, now three segments.
  botReviewers: (workspaceId: number, repoIds?: number[] | null) =>
    get<DetectedReviewersResponse>(
      withQuery('/api/bot-reviewers', workspaceParam(workspaceId), repoIdsParam(repoIds)),
    ),
  // The four RE-DERIVABLE fields of one row. `workspaceId` is REQUIRED and rides in the BODY: the
  // workspace is part of the row's key, not a filter over it. All four value fields are OPTIONAL
  // (absent = leave the stored value alone) but a body carrying NONE of them 400s — an opinion-free
  // patch would stamp a provenance flag on the strength of an empty request and freeze detection.
  //
  // `automated`/`role` stamp `source: 'manual'`; `kind`/`label` stamp `identitySource: 'manual'`.
  // ⚠ A ROLE-ONLY PATCH THEREFORE PINS `automated` TOO. That is the deliberate trade: not stamping
  // it would let the next classification pass re-derive `role` from the login seed and silently
  // revert the edit. The pin is visible (`isManualOverride`) and undoable (the judgement reset).
  //
  // ⚠ IT CANNOT CARRY A PRICE — `WorkspaceReviewerPatchBody` has no cost field and the handler's
  // `set:` object has no cost key.
  //
  // Answers with the written row, so a caller can render the result without waiting for the
  // listing refetch.
  setWorkspaceReviewer: (userId: number, body: WorkspaceReviewerPatchBody) =>
    fetch(`/api/bot-reviewers/${userId}`, jsonBody('PATCH', body)).then((r) =>
      handle<WorkspaceReviewer>(r),
    ),
  // THE WAY BACK TO AUTO for the JUDGEMENT half, in one workspace: hands
  // `automated`/`role`/`confidence`/`reasons` back to detection and re-derives in the same request.
  // It is the only way back — flipping `automated` by hand re-stamps `source: 'manual'`, leaving
  // the row just as pinned.
  //
  // ⚠ AN UPDATE, NOT A ROW DELETE, which is why it answers **200 with the re-derived
  // `WorkspaceReviewer`** and not the old 204: the row also holds the identity and the price, so
  // deleting it would take both with it. `workspaceId` rides in the QUERY STRING because a DELETE
  // body is stripped by enough intermediaries not to be a place for a required field.
  //
  // ⚠ IT TOUCHES NEITHER THE IDENTITY NOR THE PRICE. Different provenance flag, different route.
  // Offer it only where `isManualOverride` is true — resetting an already-auto row does nothing.
  resetReviewerJudgement: (userId: number, workspaceId: number) =>
    fetch(
      `/api/bot-reviewers/${userId}/judgement?workspaceId=${workspaceId}`,
      jsonBody('DELETE'),
    ).then((r) => handle<WorkspaceReviewer>(r)),
  // THE WAY BACK TO AUTO for the IDENTITY half, in one workspace: clears the human-set kind/label,
  // sets `identitySource` back to 'auto', and re-derives immediately (a clear WITHOUT the re-derive
  // would leave the bot nameless and colourless until something else overwrote it, so "Reset name"
  // would read as "delete the vendor"). 200 with the re-derived row.
  //
  // ⚠ IT KEEPS THE PRICE. `monthly_cents` shares this row but is not a classification opinion —
  // say so in the UI copy, because "reset" otherwise reads as "delete everything".
  //
  // ⚠ IT TOUCHES NO JUDGEMENT FIELD. Naming a vendor is not a statement about how it behaves, and
  // stamping `source` from here would freeze auto-classification for the whole workspace.
  //
  // ⚠ ITS BLAST RADIUS IS ONE WORKSPACE, not the account. The same actor's rows elsewhere keep
  // their own names — that is the accepted consequence of the per-workspace grain.
  resetReviewerIdentity: (userId: number, workspaceId: number) =>
    fetch(
      `/api/bot-reviewers/${userId}/identity?workspaceId=${workspaceId}`,
      jsonBody('DELETE'),
    ).then((r) => handle<WorkspaceReviewer>(r)),
  // What this bot costs per month IN THIS WORKSPACE. `monthlyUsd` is REQUIRED and NULLABLE so
  // `undefined` is not a third meaning: a number sets it (0 is a real price — "we pay nothing"),
  // null CLEARS it. PUT, not PATCH: one field, no "leave it alone" state to express.
  //
  // ⚠ CLEARING IS A COLUMN WRITE, NOT A ROW DELETE — the row also carries the judgement and the
  // identity.
  //
  // ⚠ THE PRICE IS PER WORKSPACE, like every other attribute on the row. Editing it here leaves the
  // same actor's rows in other workspaces alone, and they may legitimately hold different numbers;
  // nothing reconciles them and nothing is meant to. The editor's copy says "Price for this
  // Workspace" so the scope of the edit is on screen. Within ONE workspace there is exactly one row
  // per actor, so a total there is a plain sum — ACROSS workspaces it is not a sum at all (six
  // workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six ways, and
  // the app must not assert which), so no surface may add them up.
  //
  // Bounds `[0, 21474836.47]` + `multipleOf 0.01` are enforced server-side: that is the int4-cents
  // ceiling where the dialects stop agreeing (Postgres RAISES `integer out of range`; SQLite
  // accepts it happily), so an out-of-range value 400s rather than succeeding locally and 500ing in
  // cloud.
  setReviewerCost: (userId: number, body: ReviewerCostBody) =>
    fetch(`/api/bot-reviewers/${userId}/cost`, jsonBody('PUT', body)).then((r) =>
      handle<WorkspaceReviewer>(r),
    ),
  // Per-reviewer bot ROI / utilisation analytics over the chosen window (threads / acted-on % /
  // untouched / verdict / trend). Cost is SERVER-resolved onto each row from that actor's row IN
  // THIS WORKSPACE (`costMonthlyUsd`); a null there is FINAL.
  //
  // ⚠ `workspaceId` decides WHO COUNTS AS A BOT, `repoIds` only narrows WHICH DATA IS MEASURED, and
  // both are sent. The old "a repo scope wins, so omit the team scope" rule is gone: they answered
  // the same question at two grains and could disagree, which is what let one screen show two
  // contradictory bot-only answers. The narrowing is bounded by the workspace's membership
  // server-side, so it can never reach outside the scope.
  //
  // ⚠ Never sum `costMonthlyUsd` across workspaces. Within this workspace's rows it is a plain sum.
  //
  // `bounds` (the People report) refines the enum window to a REAL period (epoch ms, half-open)
  // — server-validated: only-together, ordered, span-capped, else 400. It narrows what is
  // MEASURED only; the workspace still decides who counts as a bot.
  botAnalytics: (
    window: BotWindowKind,
    workspaceId: number,
    repoIds?: number[] | null,
    bounds?: { fromMs: number; toMs: number },
  ) =>
    get<BotAnalyticsResponse>(
      withQuery(
        '/api/bot-analytics',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
        bounds ? `fromMs=${bounds.fromMs}` : undefined,
        bounds ? `toMs=${bounds.toMs}` : undefined,
      ),
    ),
  // The AUTHORING half of "what did this automation do" (CORE, free). Bounds are REQUIRED by the
  // route — the caller always knows its period — so there is no rolling-enum overload here.
  botAuthoring: (
    workspaceId: number,
    userId: number,
    bounds: { fromMs: number; toMs: number },
    evidence: boolean,
    repoIds?: number[] | null,
  ) =>
    get<AutomationOutputResponse>(
      withQuery(
        '/api/bot-authoring',
        `userId=${userId}`,
        `fromMs=${bounds.fromMs}`,
        `toMs=${bounds.toMs}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
        evidence ? 'evidence=1' : undefined,
      ),
    ),
  // ── Bot Tuning Advisor (Pro; /api/pro/advisor/*) ─────────────────────────────────────────
  // Workspace-scoped like the Bots rail (never repo-narrowed — the advisor always covers the
  // whole workspace; the config-PR names its target repo explicitly in the body).
  advisorFindings: (workspaceId: number) =>
    get<AdvisorFindingsResponse>(
      withQuery('/api/pro/advisor/findings', workspaceParam(workspaceId)),
    ),
  advisorBrief: (workspaceId: number, botUserId?: number, keys?: string[]) =>
    get<AdvisorBriefResponse>(
      withQuery(
        '/api/pro/advisor/brief',
        workspaceParam(workspaceId),
        botUserId != null ? `botUserId=${botUserId}` : undefined,
        keys && keys.length > 0 ? `keys=${encodeURIComponent(keys.join(','))}` : undefined,
      ),
    ),
  advisorDismiss: (workspaceId: number, dedupeKey: string) =>
    fetch(
      withQuery(
        `/api/pro/advisor/recommendations/${encodeURIComponent(dedupeKey)}/dismiss`,
        workspaceParam(workspaceId),
      ),
      jsonBody('POST'),
    ).then((r) => handle<{ ok: boolean; dedupeKey: string }>(r)),
  advisorFileIssue: (workspaceId: number, dedupeKey: string) =>
    fetch(
      withQuery(
        `/api/pro/advisor/recommendations/${encodeURIComponent(dedupeKey)}/issue`,
        workspaceParam(workspaceId),
      ),
      jsonBody('POST'),
    ).then((r) => handle<{ issueUrl: string }>(r)),
  advisorConfigPr: (workspaceId: number, body: AdvisorConfigPrBody) =>
    fetch(
      withQuery('/api/pro/advisor/config-pr', workspaceParam(workspaceId)),
      jsonBody('POST', body),
    ).then((r) => handle<AdvisorConfigPrResponse>(r)),
  // The config-PR dry-run: same body, nothing written — returns the exact files the PR
  // would commit so the panel can show the generated config before consent.
  advisorPreview: (workspaceId: number, body: AdvisorConfigPrBody) =>
    fetch(
      withQuery('/api/pro/advisor/preview', workspaceParam(workspaceId)),
      jsonBody('POST', body),
    ).then((r) => handle<AdvisorPreviewResponse>(r)),
  advisorRefine: (workspaceId: number, body: AdvisorRefineBody) =>
    fetch(
      withQuery('/api/pro/advisor/refine', workspaceParam(workspaceId)),
      jsonBody('POST', body),
    ).then((r) => handle<AdvisorRefineResponse>(r)),
  advisorEffect: (workspaceId: number, botUserId: number) =>
    get<AdvisorEffectResponse>(
      withQuery(`/api/pro/advisor/bots/${botUserId}/effect`, workspaceParam(workspaceId)),
    ),
  advisorDiscovery: (workspaceId: number, botUserId: number, repoId: number) =>
    get<AdvisorDiscoveryResponse>(
      withQuery(
        `/api/pro/advisor/bots/${botUserId}/discovery`,
        workspaceParam(workspaceId),
        `repoId=${repoId}`,
      ),
    ),
  advisorPutProfile: (botUserId: number, body: AdvisorProfilePutBody) =>
    fetch(`/api/pro/advisor/bots/${botUserId}/profile`, jsonBody('PUT', body)).then((r) =>
      handle<{ workspaceId: number }>(r),
    ),
  advisorConfirmManifest: (botUserId: number, body: AdvisorManifestConfirmBody) =>
    fetch(`/api/pro/advisor/bots/${botUserId}/manifest`, jsonBody('POST', body)).then((r) =>
      handle<{ workspaceId: number }>(r),
    ),
  advisorReportConfigEvent: (body: AdvisorConfigEventBody) =>
    fetch('/api/pro/advisor/config-events', jsonBody('POST', body)).then((r) =>
      handle<{ ok: boolean }>(r),
    ),
  // The Bots "What they're flagging" AI summary (Pro Haiku) — the revived Themes report, merged
  // with the deterministic Bots layer. GET is a pure cache read; the refresh POST is the only
  // billing path. `repoIds` narrows the DATA to the per-repo Bots console tab (membership ∩
  // narrow server-side) — sent whenever the array exists, INCLUDING empty (repoIdsParam).
  botThemes: (window: BotWindowKind, workspaceId: number, repoIds?: number[] | null) =>
    get<BotThemesResponse>(
      withQuery(
        '/api/pro/bot-themes',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  botThemesRefresh: (window: BotWindowKind, workspaceId: number, repoIds?: number[] | null) =>
    fetch(
      withQuery(
        '/api/pro/bot-themes/refresh',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
      jsonBody('POST'),
    ).then((r) => handle<BotThemesResponse>(r)),
  // The Feed "Discussion themes" AI summary (Pro Haiku) — the HUMAN sibling of bot-themes: what
  // PEOPLE are raising in review, over the current WORKSPACE + window. GET is a pure cache read;
  // the refresh POST is the only billing path.
  humanThemes: (window: BotWindowKind, workspaceId: number) =>
    get<HumanThemesResponse>(
      withQuery(
        '/api/pro/human-themes',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
      ),
    ),
  humanThemesRefresh: (window: BotWindowKind, workspaceId: number) =>
    fetch(
      withQuery(
        '/api/pro/human-themes/refresh',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
      ),
      jsonBody('POST'),
    ).then((r) => handle<HumanThemesResponse>(r)),
  // Bot behaviour analytics (TTFR / LoC-to-comments / week×hour heatmap / follow-ups). MOVED to
  // the plugin behind the `botDepth` capability (plan P0.2) — callers gate on it via
  // useProCapabilities, so with botDepth false this is never fetched (in OSS the route does not
  // exist at all). Same window/workspace/repoIds wiring as botAnalytics — both scope parameters
  // are sent. `botUserId` narrows the whole response to ONE bot (the per-bot depth drill-down
  // tab, plan P1.1/C1) — the server admits only ids in the workspace's review-role set.
  botBehaviour: (
    window: BotWindowKind,
    workspaceId: number,
    repoIds?: number[] | null,
    botUserId?: number | null,
  ) =>
    get<BotBehaviourResponse>(
      withQuery(
        '/api/pro/bot-behaviour',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
        botUserId != null ? `botUserId=${botUserId}` : undefined,
      ),
    ),
  // The ONE synthesis endpoint (plan P2.1): GET = the free cached read + stale flag (never
  // generates); POST = the only billing path. One params builder for both verbs so the row the
  // POST writes and the row the GET reads can never be addressed differently. Callers gate on the
  // `activityDigest` capability (useSynthesis) — in OSS the route does not exist at all.
  synthesis: (p: SynthesisRequestParams) =>
    get<SynthesisResponse>(withQuery('/api/pro/synthesis', ...synthesisQueryParts(p))),
  synthesisGenerate: (p: SynthesisRequestParams) =>
    fetch(withQuery('/api/pro/synthesis', ...synthesisQueryParts(p)), jsonBody('POST')).then(
      (r) => handle<SynthesisResponse>(r),
    ),
  // ---- The work plan (Pro): "what should I work on today" ----------------------------------
  // GET = free. It returns the DETERMINISTIC, code-derived worklist (`evidence`) plus any stored
  // narration and a `stale` probe; it never generates and never bills. POST = the only billing
  // path — it writes the Haiku narration over the SAME evidence. Both verbs address the row
  // through `workPlanQueryParts`, so the plan the POST stores is the plan the GET reads back.
  //
  // The panel renders `evidence` with or without a `plan`: the worklist is real data that stands
  // on its own, and the model only annotates it. Callers gate on the `workPlan` capability
  // (useWorkPlan) — in OSS the route does not exist at all, and on free cloud it answers
  // `enabled: false`, which is an answer and not an error.
  workPlan: (p: WorkPlanRequestParams) =>
    get<WorkPlanResponse>(withQuery('/api/pro/work-plan', ...workPlanQueryParts(p))),
  workPlanGenerate: (p: WorkPlanRequestParams) =>
    fetch(withQuery('/api/pro/work-plan', ...workPlanQueryParts(p)), jsonBody('POST')).then((r) =>
      handle<WorkPlanResponse>(r),
    ),
  // The exact PR list behind the analytics `totals.botOnlyPrs` count — "only a bot reviewed these".
  // Same window/workspace/repoIds wiring as botAnalytics, so the caption's number and this list are
  // computed identically server-side.
  botOnlyPrs: (window: BotWindowKind, workspaceId: number, repoIds?: number[] | null) =>
    get<BotOnlyPrsResponse>(
      withQuery(
        '/api/bot-analytics/bot-only-prs',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  // The per-PR drill-down behind one Bot-ROI row: the PRs that one automated reviewer touched in
  // the window (threads/comments/acted-on/untouched/bot-only), most-recent-activity first. `key` is
  // the analytics row identity — `u<userId>` (a single reviewer) or the 'pierre' sentinel.
  //
  // ⚠ It is opened FROM a scoped ROI row, so it MUST be given the SAME workspace and repo set that
  // row was computed at: the header label and the per-PR `botOnly` badge both key on them, and one
  // screen cannot show two contradictory bot-only answers.
  botVendorPrs: (
    key: string,
    window: BotWindowKind,
    workspaceId: number,
    repoIds?: number[] | null,
  ) =>
    get<BotVendorPrsResponse>(
      withQuery(
        `/api/bot-analytics/vendor/${encodeURIComponent(key)}/prs`,
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  // The per-bot COMMENTS drill-down behind the same Bot-ROI row: everything the reviewer said
  // in the window (inline review comments, PR comments, review bodies), each row's ML label
  // shipped INLINE — one request, never the per-PR label index per row. Same scope wiring as
  // botVendorPrs, for the same one-screen-one-answer reason. `bounds` mirrors botAnalytics's
  // (the People report's bot sections cover the real period; server-validated, 400 on garbage).
  botVendorComments: (
    key: string,
    window: BotWindowKind,
    workspaceId: number,
    repoIds?: number[] | null,
    bounds?: { fromMs: number; toMs: number },
  ) =>
    get<BotVendorCommentsResponse>(
      withQuery(
        `/api/bot-analytics/vendor/${encodeURIComponent(key)}/comments`,
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
        bounds ? `fromMs=${bounds.fromMs}` : undefined,
        bounds ? `toMs=${bounds.toMs}` : undefined,
      ),
    ),
  // "What the bots are flagging" — the drill-down behind every tile and chip of the Bots rail's
  // ML totals strip. ONE route, one `select=` discriminator, paginated by an OPAQUE cursor.
  //
  // ⚠ IT MUST BE CALLED WITH THE SAME (window, workspaceId, repoIds) TRIPLE THE STRIP WAS
  // MEASURED AT. The response's `total` is the tile's number by construction — the server re-runs
  // the strip's own windowed label scan and the SAME JS fold, then slices — so a drill-down opened
  // at a different scope would silently contradict the number the user just clicked.
  //
  // The cursor is opaque: feed `nextCursor` back verbatim and never parse it (today it encodes an
  // offset into the folded population, because that population is a JS fold over a JSON column no
  // portable SQL predicate can express; a later keyset switch must not be a wire break).
  botFlagging: (p: {
    selector: BotFlaggingSelector;
    refine: BotFlaggingRefine;
    window: BotWindowKind;
    workspaceId: number;
    repoIds?: number[] | null;
    limit: number;
    cursor?: string | null;
  }) => {
    // Selector-specific fragments. Only the two parameterised arms carry a payload; `findings`,
    // `summaries` and `overlap` are fully described by `select=` alone.
    const selectorParts: string[] =
      p.selector.kind === 'severity'
        ? [`severities=${encodeURIComponent(p.selector.severities.join(','))}`]
        : p.selector.kind === 'category'
          ? [`category=${encodeURIComponent(p.selector.category)}`]
          : [];
    // Refinement. The cell's two halves travel together or not at all (a half-specified cell is
    // not a narrowing the server can honour), and 'none' is a real vendor-axis value meaning
    // "the bot declared nothing" — not an absent parameter.
    //
    // `authorUserIds` is the bot narrowing the inflation index opens: a CSV of `users.id`s (one
    // for a bar, the whole summed set for the card's "View all N →"), declared on the route's
    // schema as a STRING and parsed with `parseIntList` — the `repoIds` precedent.
    //
    // ⚠ `!= null`, NEVER `.length > 0` — the same rule `repoIdsParam` follows. An empty set means
    // "no bots" and must reach the server as a PRESENT-but-empty parameter (which the handler maps
    // to an empty page); dropping the key instead would widen it to every bot, which is exactly
    // the "the button promised 359, the list showed 612" failure this list shape exists to close.
    // It must also be DECLARED on the schema at all: Fastify's `removeAdditional` drops an unknown
    // key silently and answers 200, so the two sides of this parameter are worth keeping in step.
    const refineParts: string[] = [
      p.refine.cell
        ? `cellVendor=${encodeURIComponent(p.refine.cell.vendor)}&cellOurs=${encodeURIComponent(
            p.refine.cell.ours,
          )}`
        : '',
      p.refine.disagree ? `disagree=${encodeURIComponent(p.refine.disagree)}` : '',
      p.refine.authorUserIds != null ? `authorUserIds=${p.refine.authorUserIds.join(',')}` : '',
    ];
    return get<BotFlaggingResponse>(
      withQuery(
        '/api/bot-analytics/flagging',
        `select=${encodeURIComponent(p.selector.kind)}`,
        ...selectorParts,
        ...refineParts,
        `window=${encodeURIComponent(p.window)}`,
        workspaceParam(p.workspaceId),
        repoIdsParam(p.repoIds),
        `limit=${p.limit}`,
        p.cursor ? `cursor=${encodeURIComponent(p.cursor)}` : '',
      ),
    );
  },
  // ── Bot comment VOLUME (CORE, free, deterministic) ────────────────────────────────────────
  // "How much does each bot say on a PR" — the ROI table's per-bot average, and the paginated
  // PR list behind it. Both fold the SAME server-side scan, so the column and the list cannot
  // disagree about a number.
  //
  // ⚠ THE POPULATION IS PRs **MERGED** IN THE WINDOW, open ones excluded (measured: 686 merged vs
  // 997 opened over 180d on one repo here — a ~45% difference). Any caption written against these
  // numbers has to say "merged".
  //
  // ⚠ CALL BOTH WITH THE SAME (window, workspaceId, repoIds) TRIPLE. The drill-down reproduces the
  // column's own number; measured at a different scope it would silently contradict the cell the
  // user just clicked, with nothing on screen saying why.
  botVolume: (window: BotWindowKind, workspaceId: number, repoIds?: number[] | null) =>
    get<BotVolumeResponse>(
      withQuery(
        '/api/bot-analytics/volume',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  // The PR drill-down. `sort` is an ajv ENUM server-side, so an unknown value 400s rather than
  // quietly serving the default order under the other one's caption.
  //
  // ⚠ `authorUserIds` follows the flagging route's rule EXACTLY: `!= null`, NEVER `.length > 0`.
  // An empty set means "no bots" and must reach the server as a PRESENT-but-empty parameter;
  // dropping the key widens it to every bot, which is the "the cell promised 25, the list showed
  // 612" failure. It is declared on the route schema too — Fastify's `removeAdditional` strips an
  // undeclared key silently and answers 200 with the narrowing not applied.
  //
  // The cursor is OPAQUE: feed `nextCursor` back verbatim and never parse it (today an offset into
  // a JS fold; a later keyset switch must not be a wire break).
  botVolumePrs: (p: {
    window: BotWindowKind;
    workspaceId: number;
    repoIds?: number[] | null;
    authorUserIds: number[] | null;
    sort: BotVolumePrSort;
    limit: number;
    cursor?: string | null;
  }) =>
    get<BotVolumePrsResponse>(
      withQuery(
        '/api/bot-analytics/volume/prs',
        `window=${encodeURIComponent(p.window)}`,
        workspaceParam(p.workspaceId),
        repoIdsParam(p.repoIds),
        p.authorUserIds != null ? `authorUserIds=${p.authorUserIds.join(',')}` : '',
        `sort=${encodeURIComponent(p.sort)}`,
        `limit=${p.limit}`,
        p.cursor ? `cursor=${encodeURIComponent(p.cursor)}` : '',
      ),
    ),
  // The Behaviour tab's PR-size-vs-volume chart: the five LOC-bucket means over the WHOLE scope
  // plus one point per SIZED merged PR. Same (window, workspaceId, repoIds) triple as the two
  // above — a third scope would put a differently-measured chart beside the column it explains.
  //
  // ⚠ The response's `buckets` are DENSE (all five present, `prs: 0` and `avgComments: null` on an
  // empty one) and its `unsizedPrs` counts merged PRs that are in NEITHER `points` nor any bucket.
  // Both have to survive into the rendering — see `lib/botVolumeSize.ts`.
  botVolumeScatter: (window: BotWindowKind, workspaceId: number, repoIds?: number[] | null) =>
    get<BotVolumeScatterResponse>(
      withQuery(
        '/api/bot-analytics/volume/scatter',
        `window=${encodeURIComponent(window)}`,
        workspaceParam(workspaceId),
        repoIdsParam(repoIds),
      ),
    ),
  // Cross-bot dedup + consensus/conflict clusters for a PR (≥2 automated reviewers of
  // distinct kinds on the same path/line window).
  prBotDedup: (prId: number) => get<BotDedupResponse>(`/api/prs/${prId}/bot-dedup`),
  // Per-PR bot behaviour — each automated reviewer's on-PR timeline + vs-typical comparison.
  prBotBehaviour: (prId: number) =>
    get<PrBotBehaviourResponse>(`/api/prs/${prId}/bot-behaviour`),
  // Workspace-wide "clear the stale-bot backlog": one row per PR with ≥1 likely-addressed
  // automated-reviewer thread in the scope (uncapped), and the confirm-gated resolve below.
  // `workspaceId` decides who counts as a bot; `repoIds` only narrows which PRs are listed.
  resolvableBotThreads: (workspaceId: number, repoIds?: number[] | null) =>
    get<ResolvableThreadPrsResponse>(
      withQuery('/api/bot-threads/resolvable', workspaceParam(workspaceId), repoIdsParam(repoIds)),
    ),
  // Resolve the explicit reviewed thread ids (the server re-derives eligibility ∩ this list). The
  // caller chunks a large selection into ≤500-id POSTs; the response aggregates per chunk.
  //
  // ⚠ `ScopeResolveBotThreadsBody.workspaceId` IS REQUIRED, AND IT MUST BE THE SAME ID THE LISTING
  // ABOVE WAS FETCHED WITH — that is what makes "the listing and the resolve agree" structural
  // rather than a convention. Its predecessor carried an optional `repoIds` while the listing was
  // resolved from a team scope, so a reviewer marked automated only under a per-team override had
  // its threads offered and then found ineligible: the route resolved 0 with no error anywhere.
  // The body carries no `repoIds` on purpose — the user ticked these ids explicitly, and narrowing
  // them a second time could only silently drop some of them.
  scopeResolveBotThreads: (body: ScopeResolveBotThreadsBody) =>
    fetch('/api/bot-threads/resolve', jsonBody('POST', body)).then((r) =>
      handle<ResolveBotThreadsResult>(r),
    ),
};
