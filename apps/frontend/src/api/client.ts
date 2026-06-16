import type {
  ActiveReviewsResponse,
  AddReviewCommentBody,
  AddReviewCommentResult,
  ApprovePrBody,
  ApprovePrResult,
  ClaudeKeyResponse,
  ClaudeReview,
  ClaudeReviewListResponse,
  ClaudeReviewModel,
  RequestedReviewMode,
  ClaudeReviewResponse,
  ClaudeReviewStatusResponse,
  ClaudeReviewVerdict,
  CreatePrCommentBody,
  CreatePrCommentResult,
  CreateRepoBody,
  FeedResponse,
  MeResponse,
  MergersResponse,
  DismissedMyTurnResponse,
  MyTurnDismissKind,
  MyTurnResponse,
  InsightsResponse,
  RepoAnalytics,
  OpenPrsResponse,
  PostCommentResult,
  PostReviewPreview,
  PostReviewResult,
  PrDetail,
  PrFilesResponse,
  Repo,
  RepoSearchResponse,
  ReplyResult,
  ReplyToThreadBody,
  ResolveThreadBody,
  ResolveThreadResult,
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

export const api = {
  listRepos: () => get<Repo[]>('/api/repos'),
  searchRepos: (q: string, cursor?: string) =>
    get<RepoSearchResponse>(
      `/api/repos/search?q=${encodeURIComponent(q)}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
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
  thread: (id: number) => get<ThreadDetail>(`/api/threads/${id}`),
  prFiles: (id: number) => get<PrFilesResponse>(`/api/prs/${id}/files`),

  // ---- PR write actions ----
  replyToThread: (threadId: number, body: ReplyToThreadBody) =>
    fetch(`/api/threads/${threadId}/reply`, jsonBody('POST', body)).then((r) =>
      handle<ReplyResult>(r),
    ),
  resolveThread: (threadId: number, body: ResolveThreadBody) =>
    fetch(`/api/threads/${threadId}/resolve`, jsonBody('POST', body)).then((r) =>
      handle<ResolveThreadResult>(r),
    ),
  createPrComment: (prId: number, body: CreatePrCommentBody) =>
    fetch(`/api/prs/${prId}/comment`, jsonBody('POST', body)).then((r) =>
      handle<CreatePrCommentResult>(r),
    ),
  approvePr: (prId: number, body?: ApprovePrBody) =>
    fetch(`/api/prs/${prId}/approve`, jsonBody('POST', body ?? {})).then((r) =>
      handle<ApprovePrResult>(r),
    ),
  addReviewComment: (prId: number, body: AddReviewCommentBody) =>
    fetch(`/api/prs/${prId}/review-comment`, jsonBody('POST', body)).then((r) =>
      handle<AddReviewCommentResult>(r),
    ),

  me: () => get<MeResponse>('/api/me'),
  // Cloud-mode sign-out. 204 No Content; resolves once the session is cleared.
  logout: (): Promise<Response> =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }),
  myTurn: () => get<MyTurnResponse>('/api/my-turn'),
  myTurnDone: () => get<DismissedMyTurnResponse>('/api/my-turn/done'),
  // Watched-repo activity feed (last 14 days, newest first, no commits).
  feed: () => get<FeedResponse>('/api/feed'),
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
};
