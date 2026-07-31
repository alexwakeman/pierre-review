import type {
  ActiveReviewsResponse,
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
  TeamInsightsResponse,
  AttentionCardsResponse,
  RepoTeamMetricsResponse,
  TeamMetricsDetailResponse,
  TeamMetricsResponse,
  TeamComparisonResponse,
  AiUsageResponse,
  SprintReportResponse,
  BotWindowKind,
  BotAnalyticsResponse,
  BotThemesResponse,
  HumanThemesResponse,
  BotBehaviourResponse,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorPrsResponse,
  BotDedupResponse,
  PrBotBehaviourResponse,
  DetectedReviewersResponse,
  ReviewerClassification,
  ReviewerOverrideBody,
  MeResponse,
  MergersResponse,
  MergePrBody,
  MergePrResult,
  MergeQueueEnqueueBody,
  MergeQueueResult,
  ArmMergeBody,
  ArmedMergeRequest,
  ArmedMergeListResponse,
  BranchStatusResponse,
  AnnotationKind,
  AnnotationRunBody,
  AnnotationRunResponse,
  PrAnnotationsResponse,
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
  SuggestedReviewersResponse,
  PresetPromptKey,
  PresetPromptResponse,
  SprintChatBody,
  SprintChatResponse,
  SprintChatHistoryResponse,
  PinnedPromptsResponse,
  CreatePinnedPromptBody,
  ProSettings,
  ProSettingsUpdate,
  Repo,
  RepoSearchResponse,
  SuggestedReposResponse,
  SearchHitKind,
  SearchResponse,
  Team,
  TeamsResponse,
  ReplyResult,
  ReplyToThreadBody,
  ResolveThreadBody,
  ResolveThreadResult,
  ResolveBotThreadsBody,
  ResolveBotThreadsResult,
  ScopeResolveBotThreadsBody,
  SyncStatus,
  ThreadDetail,
  TimelineResponse,
  User,
  UserContributionStats,
} from '@pierre-review/shared';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
    throw new ApiError(res.status, message);
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

// Build the `scope=` query fragment (no leading `?`/`&`). Omitted for the default 'all' scope
// so the common case stays clean. The wire value is the string form ('all' | 'none' | '<teamId>').
function scopeParam(scope?: string): string {
  return scope && scope !== 'all' ? `scope=${encodeURIComponent(scope)}` : '';
}

// Build the `repoIds=` query fragment (no leading separators) from an id list; omitted when
// empty/absent. Used by the per-repo Bots tab to scope bot analytics to one repo.
function repoIdsParam(repoIds?: number[] | null): string {
  return repoIds && repoIds.length > 0 ? `repoIds=${repoIds.join(',')}` : '';
}

// Build the `teamId=` query fragment for the per-team bot-reviewer routes. OMITTED for the
// NO_TEAM_KEY (0) default, matching the shared contract's "absent = 0" rule and keeping the
// URL byte-identical to the pre-per-team one in the common case (so no cache/log churn for
// accounts with no teams). 0 is a real, selectable key ("No team (default)" — also the
// inheritance root every team falls back to), NOT "unset".
function teamIdParam(teamId?: number | null): string {
  return teamId != null && teamId > 0 ? `teamId=${teamId}` : '';
}

// Join query fragments (already URL-encoded, no leading separators) onto a base path.
function withQuery(base: string, ...parts: (string | undefined)[]): string {
  const qs = parts.filter((p): p is string => Boolean(p)).join('&');
  return qs ? `${base}?${qs}` : base;
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
  // Cross-team full-text search over the local index (PRs/reviews/comments/people). `scope` mirrors
  // the Activity/Insights scope string; `kinds` optionally narrows to hit kinds; paginated.
  search: (opts: {
    q: string;
    scope?: string;
    kinds?: SearchHitKind[];
    limit?: number;
    offset?: number;
  }) => {
    const p = new URLSearchParams({ q: opts.q });
    if (opts.scope) p.set('scope', opts.scope);
    if (opts.kinds && opts.kinds.length > 0) p.set('kinds', opts.kinds.join(','));
    if (opts.limit != null) p.set('limit', String(opts.limit));
    if (opts.offset != null) p.set('offset', String(opts.offset));
    return get<SearchResponse>(`/api/search?${p.toString()}`);
  },
  addRepo: (body: CreateRepoBody) =>
    fetch('/api/repos', jsonBody('POST', body)).then((r) => handle<Repo>(r)),
  // Toggle "Watch for inbox" on a repo (inbox-only; does not affect timeline
  // visibility). Returns the updated repo.
  setRepoInboxWatch: (id: number, inboxWatch: boolean) =>
    fetch(`/api/repos/${id}`, jsonBody('PATCH', { inboxWatch })).then((r) =>
      handle<Repo>(r),
    ),
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

  // ---- Teams (CORE) ----
  listTeams: () => get<TeamsResponse>('/api/teams'),
  createTeam: (name: string) =>
    fetch('/api/teams', jsonBody('POST', { name })).then((r) =>
      handle<{ team: Team }>(r),
    ),
  // Rename and/or replace membership (PATCH accepts { name?, repoIds? }).
  renameTeam: (id: number, body: { name?: string; repoIds?: number[] }) =>
    fetch(`/api/teams/${id}`, jsonBody('PATCH', body)).then((r) =>
      handle<{ team: Team }>(r),
    ),
  // Replace a team's membership with exactly `repoIds` (assign new, remove missing; auto-watch).
  setTeamRepos: (id: number, repoIds: number[]) =>
    fetch(`/api/teams/${id}`, jsonBody('PATCH', { repoIds })).then((r) =>
      handle<{ team: Team }>(r),
    ),
  deleteTeam: (id: number) =>
    fetch(`/api/teams/${id}`, jsonBody('DELETE')).then((r) => handle<void>(r)),
  assignRepoToTeam: (teamId: number, repoId: number) =>
    fetch(`/api/teams/${teamId}/repos`, jsonBody('POST', { repoId })).then((r) =>
      handle<{ team: Team }>(r),
    ),
  unassignRepoFromTeam: (teamId: number, repoId: number) =>
    fetch(`/api/teams/${teamId}/repos/${repoId}`, jsonBody('DELETE')).then((r) =>
      handle<void>(r),
    ),

  listUsers: () => get<User[]>('/api/users'),
  // One contributor's ALL-TIME totals (PRs authored by state, reviews given, comments) for the
  // user popover. `repoIds` narrows to a repo subset — the surrounding PR's repo when the
  // handle was clicked inside one, else the FilterBar-visible set (already team-scope resolved),
  // so the popover's caption matches what the board is showing. Counts only: the caller already
  // has the account-scoped user roster from `listUsers`.
  userStats: (userId: number, repoIds?: number[] | null) =>
    get<UserContributionStats>(
      withQuery(`/api/users/${userId}/stats`, repoIdsParam(repoIds)),
    ),
  mergers: () => get<MergersResponse>('/api/mergers'),
  // `setUserBot` was removed with `PATCH /api/users/:id`: it wrote the GLOBAL users row with
  // no ownership check, so one tenant could permanently reclassify a login for everyone. It
  // had no caller. Bot classification is `setReviewerClassification` below, which writes the
  // account-scoped bot_review_classification table.

  timeline: (search: string) =>
    get<TimelineResponse>(`/api/timeline${search ? `?${search}` : ''}`),
  openPrs: (search: string) =>
    get<OpenPrsResponse>(`/api/open-prs${search ? `?${search}` : ''}`),
  insights: (search: string) =>
    get<InsightsResponse>(`/api/insights${search ? `?${search}` : ''}`),
  repoAnalytics: (repoId: number) =>
    get<RepoAnalytics>(`/api/insights/${repoId}/analytics`),
  pr: (id: number) => get<PrDetail>(`/api/prs/${id}`),
  // Suggested reviewers — a live query (deliberately NOT part of the cached PR detail) so it
  // reflects current state (empties the moment a reviewer is requested).
  suggestedReviewers: (id: number) =>
    get<SuggestedReviewersResponse>(`/api/prs/${id}/suggested-reviewers`),
  thread: (id: number) => get<ThreadDetail>(`/api/threads/${id}`),
  // @mention candidates for a PR, pre-ranked by proximity (self + bots excluded).
  mentionCandidates: (prId: number) =>
    get<User[]>(`/api/prs/${prId}/mention-candidates`),
  // @mention candidates for a whole SCOPE (team / listed repos), for the ad-hoc Insights box.
  // `scope` ('all' | 'none' | 'teams' | '<teamId>') resolves server-side to the account's repos.
  scopeMentionCandidates: (scope?: string) =>
    get<User[]>(withQuery('/api/mention-candidates', scopeParam(scope))),
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
  // Per-repo default-branch head + recent trunk commits with their CI state. `repoIds` scopes
  // it to the visible repo set; omitted = every repo the account watches. Pure DB read off the
  // branch sync — never a live GitHub call.
  branchStatus: (repoIds?: number[] | null) =>
    get<BranchStatusResponse>(withQuery('/api/branch-status', repoIdsParam(repoIds))),
  addReviewComment: (prId: number, body: AddReviewCommentBody) =>
    fetch(`/api/prs/${prId}/review-comment`, jsonBody('POST', body)).then((r) =>
      handle<AddReviewCommentResult>(r),
    ),
  requestReviewers: (prId: number, body: RequestReviewersBody) =>
    fetch(`/api/prs/${prId}/request-reviewers`, jsonBody('POST', body)).then((r) =>
      handle<RequestReviewersResult>(r),
    ),

  // ---- Activity (Workstream 1; CORE, no AI) ----
  // The multi-repo triage aggregate (per watched repo: stats, thread totals,
  // grouped PRs). Respects the active repo filter via the query string. A pure DB
  // read — "Refresh" re-queries this, it never triggers a GitHub sync.
  inbox: (search: string) =>
    get<ActivityResponse>(`/api/activity${search ? `?${search}` : ''}`),
  // The consolidated Feed (the Activity "Feed" entry): one chronological stream across
  // the watched repos (My Turn actionables + the activity feed). Pure DB read. The
  // `search` string carries the active repo/member scope (repoIds/userIds).
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
  // Team review-intelligence "Insights" (Pro; teamInsights capability) — the attention CARDS
  // (+ the sprint report). The flow-metric HEADER moved OUT to the free /api/team-metrics, the
  // Retro panel was deleted, and Compare moved to the free /api/team-metrics/compare.
  teamInsights: (scope?: string) =>
    get<TeamInsightsResponse>(withQuery('/api/pro/insights', scopeParam(scope))),
  // The team flow-metric header (DORA-ish tiles + trends) — CORE/free, now rendered in the Feed.
  teamMetrics: (scope?: string) =>
    get<TeamMetricsResponse>(withQuery('/api/team-metrics', scopeParam(scope))),
  // The attention cards (CORE/free) for the Feed "Needs attention" tab.
  attentionCards: (scope?: string) =>
    get<AttentionCardsResponse>(withQuery('/api/attention', scopeParam(scope))),
  // The per-metric PR drill-down behind the flow-metric tiles (loaded on tile click) — CORE/free
  // too, so a Feed tile opens the drill-down for everyone.
  teamMetricsDetail: (scope?: string) =>
    get<TeamMetricsDetailResponse>(withQuery('/api/team-metrics/detail', scopeParam(scope))),
  // The Insights flow-metric header (tiles + trends) for a SINGLE repo — the per-repo console
  // panel. Metrics-only; tiles render non-clickable there.
  repoTeamMetrics: (repoId: number) =>
    get<RepoTeamMetricsResponse>(`/api/pro/insights/repo/${repoId}/metrics`),
  // Cross-team comparison — one TeamMetrics row per team IN SCOPE, so the SPA renders a compact
  // metric×team matrix. CORE/FREE and served beside the two routes above (it shares their
  // trailing-14d window), NOT the old Pro `/api/pro/insights/team-comparison`: the panel moved
  // out of Insights into the Feed's sub-tab bar, where it must render on every tier.
  //
  // `scope` is now load-bearing and MUST be sent: the route filters to the scope's teams, so two
  // different team selections are two different responses. (The old route took no params — it
  // always returned every team — which is why its query key was unscoped; a caller that keeps
  // that key would serve one selection's columns to another.)
  teamComparison: (scope?: string) =>
    get<TeamComparisonResponse>(withQuery('/api/team-metrics/compare', scopeParam(scope))),
  // Month-to-date AI-usage rollup (credits, split by seam). Covers all account AI spend.
  aiUsage: () => get<AiUsageResponse>('/api/pro/ai-usage'),
  // The Insights "Sprint report" (Pro Haiku summary; activityDigest capability). `scope`
  // ('all' | 'none' | '<teamId>') narrows the report to a team's repos; omitted = all.
  sprintReport: (scope?: string) =>
    get<SprintReportResponse>(
      withQuery('/api/pro/sprint-report', scopeParam(scope)),
    ),
  refreshSprintReport: (scope?: string) =>
    fetch(
      withQuery('/api/pro/sprint-report/refresh', scopeParam(scope)),
      jsonBody('POST'),
    ).then((r) => handle<SprintReportResponse>(r)),
  // (`retroReport` / `refreshRetroReport` were REMOVED with the Insights "Retro" panel and its
  // `/api/pro/retro*` routes. The retrospective is now a quick-question pill in the ad-hoc chat,
  // which needs no route of its own.)
  // Repo-scoped Claude review history (all runs per PR, newest-first). Gated on
  // config.claudeReviewEnabled; the response's `enabled` flag reflects that.
  repoClaudeReviews: (repoId: number) =>
    get<RepoClaudeReviewsResponse>(`/api/repos/${repoId}/claude-reviews`),

  // ---- Pro per-repo digest (Workstream 2; @pierre/pro, flagged) ----
  // Cached per-repo LLM headline digests for the watched repos. Only fetched when
  // pro.activityDigest is true (absent plugin → 404 / enabled:false).
  repoDigests: (search: string, scope?: string) =>
    get<RepoDigestsResponse>(
      withQuery('/api/pro/activity/digests', search, scopeParam(scope)),
    ),
  refreshRepoDigests: (search?: string, scope?: string) =>
    fetch(
      withQuery('/api/pro/activity/digests/refresh', search, scopeParam(scope)),
      jsonBody('POST'),
    ).then((r) => handle<{ status: string }>(r)),
  // ---- Preset prompts (Pro; the routes land in a later phase — stubs against the shape) ----
  // One-click "ask about this scope" answers (Markdown). `scope` ('all' | 'none' | '<teamId>')
  // narrows the question to a team's repos; omitted = all.
  presetPrompt: (key: PresetPromptKey, scope?: string) =>
    get<PresetPromptResponse>(
      withQuery(
        '/api/pro/preset-prompt',
        `key=${encodeURIComponent(key)}`,
        scopeParam(scope),
      ),
    ),
  refreshPresetPrompt: (key: PresetPromptKey, scope?: string) =>
    fetch(
      withQuery(
        '/api/pro/preset-prompt/refresh',
        `key=${encodeURIComponent(key)}`,
        scopeParam(scope),
      ),
      jsonBody('POST'),
    ).then((r) => handle<PresetPromptResponse>(r)),
  // ---- Ad-hoc "Ask about the sprint" chat (Pro Haiku; activityDigest capability) ----
  // A free-text question answered from the sprint snapshot. `scope` narrows to a team's repos.
  sprintChat: (body: SprintChatBody) =>
    fetch('/api/pro/insights/ask', jsonBody('POST', body)).then((r) =>
      handle<SprintChatResponse>(r),
    ),
  // The account's paginated chat history (newest-first; stored answers, free to re-open) SCOPED to
  // the current team context (`scope`).
  sprintChatHistory: (limit: number, offset: number, scope?: string) =>
    get<SprintChatHistoryResponse>(
      withQuery(
        '/api/pro/insights/chat-history',
        `limit=${limit}`,
        `offset=${offset}`,
        scopeParam(scope),
      ),
    ),
  // Saved, re-runnable ad-hoc prompts (server-stored per account + scope).
  pinnedPrompts: (scope?: string) =>
    get<PinnedPromptsResponse>(withQuery('/api/pro/insights/pinned', scopeParam(scope))),
  createPinnedPrompt: (body: CreatePinnedPromptBody) =>
    fetch('/api/pro/insights/pinned', jsonBody('POST', body)).then((r) =>
      handle<{ pinned: PinnedPromptsResponse['prompts'][number] }>(r),
    ),
  deletePinnedPrompt: (id: number) =>
    fetch(`/api/pro/insights/pinned/${id}`, jsonBody('DELETE')).then((r) => handle<void>(r)),
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
  // Every distinct reviewer in the account joined with its automated/human classification
  // (manual override + auto), volume, and a sample review body — the Bots rail's per-team
  // "Settings" tab.
  //
  // `teamId` selects which team's classifications resolve: an explicit row for that team wins,
  // else the team-0 (No team) default, else auto-detection. Absent/0 = NO_TEAM_KEY, i.e. the
  // account default. Each returned row carries `teamId` + `inherited` so the tab can tell a real
  // per-team override from the inherited default; the response echoes the resolved `teamId` so a
  // caller can assert it matches the tab it asked for.
  // `scoped` is OPT-IN and narrows the listing to the reviewers seen in the requested team's OWN
  // repos (at NO_TEAM_KEY: the repos in no team at all), and is what makes `scopedRepoCount` a
  // number instead of null. It must stay opt-in: the four account-wide consumers (the bot colour
  // map, the feed's vendor tag, the Threads-tab vendor filter) need the WHOLE roster, and a
  // narrowed one would silently drop bots from surfaces that aren't about teams at all.
  botReviewers: (teamId?: number | null, scoped = false) =>
    get<DetectedReviewersResponse>(
      withQuery('/api/bot-reviewers', teamIdParam(teamId), scoped ? 'scoped=true' : ''),
    ),
  // Two-way manual override of a reviewer's classification (mark automated / not-a-bot, and set
  // its ReviewerRole). Returns the new classification.
  //
  // The team key rides in the BODY (`ReviewerOverrideBody.teamId`, absent = 0), not the query
  // string, because it is part of the row's identity, not a filter. It MUST be a single team id
  // the account owns — a union scope cannot own an override, and the route 404s an unknown or
  // foreign team rather than writing a row keyed to another tenant's team.
  setReviewerOverride: (userId: number, body: ReviewerOverrideBody) =>
    fetch(`/api/bot-reviewers/${userId}`, jsonBody('PATCH', body)).then((r) =>
      handle<ReviewerClassification>(r),
    ),
  // "Reset to default": drop this reviewer's explicit row for `teamId` so the team falls back to
  // the team-0 default (or, if there is none, to auto-detection). NOT the same as marking them
  // not-a-bot — that would write a fresh override saying "human". 204 → void. Passing 0 would
  // delete the account default itself, which the tab must not offer for an inherited row (the
  // Reset action is disabled there).
  deleteReviewerOverride: (userId: number, teamId: number) =>
    fetch(
      withQuery(`/api/bot-reviewers/${userId}`, teamIdParam(teamId)),
      jsonBody('DELETE'),
    ).then((r) => handle<void>(r)),
  // Per-vendor bot ROI / utilisation analytics over the chosen window (threads / acted-on %
  // / untouched / verdict / trend). Cost is now SERVER-resolved per team on each row
  // (`costMonthlyUsd`/`costInherited`); the old client-side overlay from /api/pro/settings
  // `bots.cost` survives only as a null-filling legacy fallback — see lib/botCost.ts.
  botAnalytics: (window: BotWindowKind, scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    // A repo scope wins over the team scope (the per-repo Bots tab); omit `scope` then.
    const s = r ? '' : scopeParam(scope);
    return get<BotAnalyticsResponse>(
      withQuery(`/api/bot-analytics`, `window=${encodeURIComponent(window)}`, s, r),
    );
  },
  // The Bots "Themes" AI summary (Pro Haiku) — the qualitative read of what the automated
  // reviewers are flagging over the current TEAM scope + window. GET is a pure cache read; the
  // refresh POST is the only billing path. Team-scoped (cross-repo Bots rail), so no repoIds.
  botThemes: (window: BotWindowKind, scope?: string) =>
    get<BotThemesResponse>(
      withQuery(
        '/api/pro/bot-themes',
        `window=${encodeURIComponent(window)}`,
        scopeParam(scope),
      ),
    ),
  botThemesRefresh: (window: BotWindowKind, scope?: string) =>
    fetch(
      withQuery(
        '/api/pro/bot-themes/refresh',
        `window=${encodeURIComponent(window)}`,
        scopeParam(scope),
      ),
      jsonBody('POST'),
    ).then((r) => handle<BotThemesResponse>(r)),
  // The Feed "Discussion themes" AI summary (Pro Haiku) — the HUMAN sibling of bot-themes: what
  // PEOPLE are raising in review, over the current TEAM scope + window. GET is a pure cache read;
  // the refresh POST is the only billing path.
  humanThemes: (window: BotWindowKind, scope?: string) =>
    get<HumanThemesResponse>(
      withQuery('/api/pro/human-themes', `window=${encodeURIComponent(window)}`, scopeParam(scope)),
    ),
  humanThemesRefresh: (window: BotWindowKind, scope?: string) =>
    fetch(
      withQuery('/api/pro/human-themes/refresh', `window=${encodeURIComponent(window)}`, scopeParam(scope)),
      jsonBody('POST'),
    ).then((r) => handle<HumanThemesResponse>(r)),
  // EXPERIMENTAL bot behaviour analytics (TTFR / LoC-to-comments / 24h heatmap / follow-ups).
  // Same window/scope/repoIds wiring as botAnalytics (repo scope wins over team scope).
  botBehaviour: (window: BotWindowKind, scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    const s = r ? '' : scopeParam(scope);
    return get<BotBehaviourResponse>(
      withQuery(`/api/bot-behaviour`, `window=${encodeURIComponent(window)}`, s, r),
    );
  },
  // The exact PR list behind the analytics `totals.botOnlyPrs` count — "only a bot reviewed
  // these". Same window/scope/repoIds wiring as botAnalytics (repo scope wins over team scope),
  // so the caption's number and this list are computed identically server-side.
  botOnlyPrs: (window: BotWindowKind, scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    const s = r ? '' : scopeParam(scope);
    return get<BotOnlyPrsResponse>(
      withQuery(`/api/bot-analytics/bot-only-prs`, `window=${encodeURIComponent(window)}`, s, r),
    );
  },
  // The per-PR drill-down behind one Bot-ROI row: the PRs that one automated reviewer touched in
  // the window (threads/comments/acted-on/untouched/bot-only), most-recent-activity first. `key` is
  // the analytics row identity — `u<userId>` (a single reviewer) or the 'pierre' sentinel.
  botVendorPrs: (key: string, window: BotWindowKind, scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    const s = r ? '' : scopeParam(scope);
    return get<BotVendorPrsResponse>(
      withQuery(
        `/api/bot-analytics/vendor/${encodeURIComponent(key)}/prs`,
        `window=${encodeURIComponent(window)}`,
        s,
        r,
      ),
    );
  },
  // Cross-bot dedup + consensus/conflict clusters for a PR (≥2 automated reviewers of
  // distinct kinds on the same path/line window).
  prBotDedup: (prId: number) => get<BotDedupResponse>(`/api/prs/${prId}/bot-dedup`),
  // Per-PR bot behaviour — each automated reviewer's on-PR timeline + vs-typical comparison.
  prBotBehaviour: (prId: number) =>
    get<PrBotBehaviourResponse>(`/api/prs/${prId}/bot-behaviour`),
  // Scope-wide "clear the stale-bot backlog": the review list of every likely-addressed
  // automated-reviewer thread across the account (or a repo scope), grouped by PR + capped, and
  // the confirm-gated resolve. `repoIds` (the per-repo Bots tab) wins over `scope` server-side.
  resolvableBotThreads: (scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    const s = r ? '' : scopeParam(scope);
    return get<ResolvableThreadPrsResponse>(withQuery('/api/bot-threads/resolvable', s, r));
  },
  // Resolve the explicit reviewed thread ids (server re-derives eligibility ∩ this list). The
  // caller chunks a large selection into ≤500-id POSTs; the response aggregates per chunk.
  scopeResolveBotThreads: (body: ScopeResolveBotThreadsBody) =>
    fetch('/api/bot-threads/resolve', jsonBody('POST', body)).then((r) =>
      handle<ResolveBotThreadsResult>(r),
    ),
};
