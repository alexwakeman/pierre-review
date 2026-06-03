import type {
  CreateRepoBody,
  MeResponse,
  MergersResponse,
  MyTurnDismissKind,
  MyTurnResponse,
  OpenPrsResponse,
  PrDetail,
  Repo,
  RepoSearchResponse,
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
  return fetch(url).then((r) => handle<T>(r));
}

function jsonBody(method: string, body?: unknown): RequestInit {
  // Only declare a JSON content-type when we actually send a body. Fastify
  // rejects an empty body that claims `application/json` with a 400, which would
  // break bodyless calls (DELETE repo, POST sync, dismiss).
  if (body === undefined) return { method };
  return {
    method,
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
  pr: (id: number) => get<PrDetail>(`/api/prs/${id}`),
  thread: (id: number) => get<ThreadDetail>(`/api/threads/${id}`),

  me: () => get<MeResponse>('/api/me'),
  myTurn: () => get<MyTurnResponse>('/api/my-turn'),
  dismissMyTurn: (kind: MyTurnDismissKind, refId: number) =>
    fetch('/api/my-turn/dismiss', jsonBody('POST', { kind, refId })).then((r) =>
      handle<{ status: string }>(r),
    ),
  markPrViewed: (id: number, sha?: string) =>
    fetch(`/api/prs/${id}/mark-viewed`, jsonBody('POST', sha ? { sha } : {})).then(
      (r) => handle<{ status: string }>(r),
    ),
  dismissPr: (id: number) =>
    fetch(`/api/prs/${id}/dismiss`, jsonBody('POST')).then((r) =>
      handle<{ status: string }>(r),
    ),
};
