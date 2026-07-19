import type {
  ActiveReviewsResponse,
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
  RepoTeamMetricsResponse,
  TeamMetricsDetailResponse,
  TeamComparisonResponse,
  CommentAssessmentResponse,
  AiUsageResponse,
  SprintReportResponse,
  RetroReportResponse,
  BotWindowKind,
  BotAnalyticsResponse,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorPrsResponse,
  BotDedupResponse,
  BotMuteRule,
  BotMuteRuleInput,
  BotMuteRulesResponse,
  DetectedReviewersResponse,
  ReviewerClassification,
  ReviewerOverrideBody,
  MeResponse,
  MergersResponse,
  MergePrBody,
  MergePrResult,
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
  ProSettings,
  ProSettingsUpdate,
  Repo,
  RepoSearchResponse,
  SuggestedReposResponse,
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
  mergers: () => get<MergersResponse>('/api/mergers'),
  setUserBot: (id: number, isBot: boolean) =>
    fetch(`/api/users/${id}`, jsonBody('PATCH', { isBot })).then((r) =>
      handle<User>(r),
    ),

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
  prFiles: (id: number) => get<PrFilesResponse>(`/api/prs/${id}/files`),
  // Tail of a failed GitHub Actions check's logs (fetched live, never stored).
  checkLogs: (prId: number, jobId: number, tail?: number) =>
    get<CheckLogsResponse>(
      `/api/prs/${prId}/checks/${jobId}/logs${tail ? `?tail=${tail}` : ''}`,
    ),
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
  updatePrBranch: (prId: number, body?: UpdateBranchBody) =>
    fetch(`/api/prs/${prId}/update-branch`, jsonBody('POST', body ?? {})).then((r) =>
      handle<UpdateBranchResult>(r),
    ),
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
  // Cross-org benchmark consent (cloud-only): opt in/out of contributing aggregate weekly
  // review-bot stats. Opting in seeds contributions server-side; opting out deletes them.
  setBenchmarkConsent: (optIn: boolean) =>
    fetch('/api/me/benchmark-consent', jsonBody('POST', { optIn })).then((r) =>
      handle<{ status: string; benchmarkOptIn: boolean }>(r),
    ),
  // Team review-intelligence "Insights" (Pro; teamInsights capability). `scope`
  // ('all'|'none'|'<teamId>') narrows the metrics + cards to a team's repos; omitted = all.
  teamInsights: (scope?: string) =>
    get<TeamInsightsResponse>(withQuery('/api/pro/insights', scopeParam(scope))),
  // The per-metric PR drill-down behind the flow-metric tiles (loaded on tile click).
  teamMetricsDetail: (scope?: string) =>
    get<TeamMetricsDetailResponse>(
      withQuery('/api/pro/insights/metrics-detail', scopeParam(scope)),
    ),
  // The Insights flow-metric header (tiles + trends) for a SINGLE repo — the per-repo console
  // panel. Metrics-only; tiles render non-clickable there.
  repoTeamMetrics: (repoId: number) =>
    get<RepoTeamMetricsResponse>(`/api/pro/insights/repo/${repoId}/metrics`),
  // Cross-team comparison (Insights "Compare" sub-tab; All-Teams scope). One TeamMetrics row
  // per team so the SPA renders a compact metric×team matrix. No scope param — always all teams.
  teamComparison: () =>
    get<TeamComparisonResponse>('/api/pro/insights/team-comparison'),
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
  // The Insights "Retro" (Pro Haiku retrospective narrative of the window; activityDigest cap).
  retroReport: (scope?: string) =>
    get<RetroReportResponse>(withQuery('/api/pro/retro', scopeParam(scope))),
  refreshRetroReport: (scope?: string) =>
    fetch(
      withQuery('/api/pro/retro/refresh', scopeParam(scope)),
      jsonBody('POST'),
    ).then((r) => handle<RetroReportResponse>(r)),
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
  // A single repo's digest (lazy per-repo so a slow Haiku call never blocks the grid).
  repoDigest: (repoId: number) =>
    get<RepoDigest>(`/api/pro/activity/digests/${repoId}`),

  // ---- Comment-validity assessment (Pro; reuses the prSummary capability) ----
  // Retained Haiku assessment of a review thread's root comment (cache read; free).
  threadAssessment: (threadId: number) =>
    get<CommentAssessmentResponse>(`/api/pro/threads/${threadId}/assessment`),
  // Generate / regenerate the assessment (the billing path; credit-gated, $0-on-unchanged).
  assessThread: (threadId: number) =>
    fetch(`/api/pro/threads/${threadId}/assess`, jsonBody('POST')).then((r) =>
      handle<CommentAssessmentResponse>(r),
    ),

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
  // (manual override + auto), volume, and a sample review body — the Settings "Review bots"
  // detected-reviewers table.
  botReviewers: () => get<DetectedReviewersResponse>('/api/bot-reviewers'),
  // Two-way manual override of a reviewer's classification (mark automated / not-a-bot).
  // Returns the new classification.
  setReviewerOverride: (userId: number, body: ReviewerOverrideBody) =>
    fetch(`/api/bot-reviewers/${userId}`, jsonBody('PATCH', body)).then((r) =>
      handle<ReviewerClassification>(r),
    ),
  // Per-vendor bot ROI / utilisation analytics over the chosen window (threads / acted-on %
  // / untouched / verdict / trend). Cost fields come back null — the client overlays cost
  // from /api/pro/settings `bots.cost`.
  botAnalytics: (window: BotWindowKind, scope?: string, repoIds?: number[] | null) => {
    const r = repoIdsParam(repoIds);
    // A repo scope wins over the team scope (the per-repo Bots tab); omit `scope` then.
    const s = r ? '' : scopeParam(scope);
    return get<BotAnalyticsResponse>(
      withQuery(`/api/bot-analytics`, `window=${encodeURIComponent(window)}`, s, r),
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
  // Mute / auto-triage rules (hide or auto-resolve automated-bot threads by vendor / path /
  // severity).
  botMuteRules: () => get<BotMuteRulesResponse>('/api/bot-mute-rules'),
  addBotMuteRule: (input: BotMuteRuleInput) =>
    fetch('/api/bot-mute-rules', jsonBody('POST', input)).then((r) =>
      handle<BotMuteRule>(r),
    ),
  deleteBotMuteRule: (id: number) =>
    fetch(`/api/bot-mute-rules/${id}`, jsonBody('DELETE')).then((r) =>
      handle<void>(r),
    ),
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
