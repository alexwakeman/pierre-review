import { graphql, GraphqlResponseError } from '@octokit/graphql';
import { getGithubToken } from './auth.js';

export type GraphqlClient = typeof graphql;

// True when the partial errors are GitHub's SAML-SSO wall: the token authenticates but isn't
// authorized for the repo owner's org, so the whole `repository` node is forbidden. GitHub's
// message is "Resource protected by organization SAML enforcement. You must grant your OAuth
// token access to this organization." This gates PRs/checks even on PUBLIC repos of a SAML org.
export function isSamlBlock(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.some((e) => {
      // GraphQL exposes a machine-readable flag on the error — the most reliable signal
      // (docs: FORBIDDEN + extensions.saml_failure === true). Fall back to the message text.
      if ((e as { extensions?: { saml_failure?: boolean } }).extensions?.saml_failure === true)
        return true;
      return /saml enforcement|grant your oauth token access/i.test(
        (e as { message?: string }).message ?? '',
      );
    })
  );
}

// A parenthetical hint appended to a partial-GraphQL log. SAML enforcement gets the actionable
// re-auth hint; otherwise, ONLY when the forbidden field is a CI-checks field (so a NOT_FOUND —
// deleted/inaccessible PR — isn't mislabelled). Empty otherwise (the raw errors still get logged).
export function graphqlChecksHint(errors: unknown): string {
  if (isSamlBlock(errors)) {
    return " — the sign-in token isn't authorized for this org's SAML SSO; re-authorize it inside an active SAML session for the org (see docs/GITHUB-AUTH-SETUP.md)";
  }
  const mentionsChecks =
    Array.isArray(errors) &&
    errors.some((e) => {
      const path = (e as { path?: unknown[] }).path;
      const inPath =
        Array.isArray(path) && path.some((p) => /statuscheckrollup|check/i.test(String(p)));
      const inMsg = /check\b|statuscheckrollup/i.test((e as { message?: string }).message ?? '');
      return inPath || inMsg;
    });
  return mentionsChecks
    ? " — the sign-in token can't read CI checks here (GitHub App: install on this org with Checks read; OAuth App: re-authorize; or it's a private repo)"
    : '';
}

// Compact one-line summary of a GraphQL `errors` array for logging.
export function summarizeGraphqlErrors(errors: unknown): string {
  if (!Array.isArray(errors)) return String(errors);
  return errors
    .slice(0, 5)
    .map((e) => {
      const type = (e as { type?: string }).type ?? 'ERROR';
      const path = (e as { path?: unknown[] }).path?.join('.') ?? '?';
      const message = (e as { message?: string }).message ?? '';
      return `${type}@${path}: ${message}`;
    })
    .join(' | ');
}

// Run a GraphQL query, TOLERATING GitHub's *partial* errors. GitHub answers HTTP 200 with a
// non-empty `errors` array AND partial `data` when the token may read most of a query but is
// FORBIDDEN one sub-field — e.g. CI check runs (`statusCheckRollup.contexts`) on a private repo
// the token can't reach, or on a token minted before it was granted the scope to read them. By
// default `@octokit/graphql` THROWS on any such response, throwing away the usable partial data
// — so one un-permitted field would wipe the PR body/comments/reviewers. This returns the
// partial data instead (the forbidden fields arrive as null) and reports the errors via
// `onPartial`. A response with NO usable data (auth failure, rate limit, network) still throws.
export async function graphqlTolerant<T>(
  client: GraphqlClient,
  query: string,
  variables: Record<string, unknown>,
  onPartial?: (errors: unknown) => void,
): Promise<T> {
  try {
    return await client<T>(query, variables);
  } catch (err) {
    if (err instanceof GraphqlResponseError && err.data != null) {
      onPartial?.(err.errors);
      return err.data as T;
    }
    throw err;
  }
}

// True for GitHub failures worth RETRYING: transient upstream/gateway faults (a 5xx
// from GitHub's edge — the fat activity query on a huge repo routinely 502s at nginx)
// and low-level network faults (reset/timeout/DNS). Deliberately NOT ordinary 4xx
// (auth / not-found / rate-limit-with-reset) nor GraphQL partial-data errors — those
// are handled elsewhere (graphqlTolerant) and must not be silently re-attempted. A 502
// arrives as an HTML error page (not GraphQL JSON), so match BOTH a structured status
// (octokit RequestError `.status`) AND the message text as a fallback.
export function isRetryableGithubError(err: unknown): boolean {
  const e = err as {
    status?: number;
    response?: { status?: number };
    code?: string;
    message?: string;
  };
  const status = e.status ?? e.response?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE)$/.test(e.code ?? '')) {
    return true;
  }
  return /\b(50[0234])\b|bad gateway|gateway time-?out|service unavailable|temporarily unavailable|socket hang up|fetch failed|econnreset|etimedout/i.test(
    e.message ?? '',
  );
}

// Classify a GitHub failure as RATE-LIMITED (primary GraphQL/REST exhaustion, or the
// secondary "abuse" limiter) and extract a resume time when the response carried one.
// Deliberately a SEPARATE classifier from isRetryableGithubError: retryable means "try
// again in milliseconds", limited means "pause until the window resets" — the sync's
// budget gate (github/rate-budget.ts + sync-repo.ts) owns that wait, and widening the
// retry predicate would instead hammer a limited token.
//
// Shapes recognised:
//   • GraphQL: `errors[].type === 'RATE_LIMITED'` (GitHub answers HTTP 200, data null —
//     which is why graphqlTolerant RETHROWS it), or a rate-limit message with no usable
//     data. GraphqlResponseError exposes the response headers, so a reset time rides in.
//   • REST: status 429 (Too Many Requests IS the limiter, by definition), or a 403 whose
//     message carries GitHub's rate-limit/abuse wording (a plain 403 forbidden is NOT
//     limited). ghRest attaches `status` + the rate-limit headers onto its thrown Error
//     so this works without re-fetching anything.
//
// resumeAt: `retry-after` (relative seconds — the secondary limiter's header) wins, else
// `x-ratelimit-reset` (epoch seconds), else null (the caller falls back to a default).
export function isRateLimitError(err: unknown): { limited: boolean; resumeAt: Date | null } {
  const e = err as {
    status?: number;
    response?: { status?: number; headers?: Record<string, unknown> };
    headers?: Record<string, unknown>;
    errors?: unknown;
    data?: unknown;
    message?: string;
  };
  const header = (name: string): string | null => {
    const h = e.headers?.[name] ?? e.response?.headers?.[name];
    if (typeof h === 'string' && h.length > 0) return h;
    if (typeof h === 'number') return String(h);
    return null;
  };
  const resumeAt = (): Date | null => {
    const retryAfter = header('retry-after');
    if (retryAfter != null) {
      const secs = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(secs) && secs >= 0) return new Date(Date.now() + secs * 1000);
    }
    const reset = header('x-ratelimit-reset');
    if (reset != null) {
      const epoch = Number.parseInt(reset, 10);
      if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000);
    }
    return null;
  };

  if (
    Array.isArray(e.errors) &&
    e.errors.some((er) => (er as { type?: string }).type === 'RATE_LIMITED')
  ) {
    return { limited: true, resumeAt: resumeAt() };
  }
  const status = e.status ?? e.response?.status;
  if (status === 429) return { limited: true, resumeAt: resumeAt() };
  if (status === 403 && /rate limit|abuse/i.test(e.message ?? '')) {
    return { limited: true, resumeAt: resumeAt() };
  }
  // Message-only fallback (a GraphQL transport variant with neither structured errors nor
  // a status). Guarded on "no usable data" + "no status" so a 4xx/5xx that merely MENTIONS
  // rate limits can't sneak in.
  if (
    status == null &&
    e.errors == null &&
    e.data == null &&
    /rate limit/i.test(e.message ?? '')
  ) {
    return { limited: true, resumeAt: resumeAt() };
  }
  return { limited: false, resumeAt: null };
}

// Run a GitHub call with bounded exponential-backoff retries on TRANSIENT failures
// (see isRetryableGithubError). A single 502 on any page must not abort a multi-page
// backfill of a large repo — without this, adding a big repo (every curated suggestion
// is one) frequently loads only a partial window before the walk dies. Non-retryable
// errors (4xx, GraphQL partial) propagate immediately. Backoff: 500ms, 1s, 2s.
export async function withGithubRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > retries || !isRetryableGithubError(err)) throw err;
      const delayMs = base * 2 ** (attempt - 1);
      opts.onRetry?.(attempt, delayMs, err);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Per-account GitHub clients. There is deliberately NO module-level token /
// client cache: in a multi-tenant (cloud) process a cached token would leak one
// account's credentials into another account's request. The token is ALWAYS
// passed in by the caller (resolved from the owning account), so isolation is
// structural. See auth/account.ts#getAccessToken for where the token comes from.

export function getGraphqlClientFor(token: string): GraphqlClient {
  return graphql.defaults({ headers: { authorization: `token ${token}` } });
}

async function ghRest<T>(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(
      `GitHub REST ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
    // Structured status + the rate-limit headers, so isRateLimitError can classify a REST
    // 403/429 and derive a resume time without message archaeology. Nulls kept as-is —
    // the classifier's header lookup only honours strings.
    Object.assign(err, {
      status: res.status,
      headers: {
        'retry-after': res.headers.get('retry-after'),
        'x-ratelimit-remaining': res.headers.get('x-ratelimit-remaining'),
        'x-ratelimit-reset': res.headers.get('x-ratelimit-reset'),
      },
    });
    throw err;
  }
  return res.json() as Promise<T>;
}

// REST GET (per-commit changed-files etc.) for a specific account's token.
export function ghRestGetFor<T>(token: string, path: string): Promise<T> {
  return ghRest<T>(token, 'GET', path);
}

// Conditional REST GET for the adaptive-sync change probe (Phase 2 — see
// docs/REALTIME-SYNC.md). Sends `If-None-Match: <etag>` when a prior ETag is known and
// returns the status + fresh ETag WITHOUT throwing — a 304 (Not Modified) means nothing
// changed and, crucially, does NOT count against GitHub's primary rate limit. The body is
// drained and discarded (we only care about changed-or-not + the new ETag). A non-2xx /
// non-304 (403/404/network) is reported as `notModified: false` so the caller falls back
// to a full walk rather than silently skipping.
export async function ghRestGetConditional(
  token: string,
  path: string,
  etag: string | null,
): Promise<{ status: number; notModified: boolean; etag: string | null }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(etag ? { 'if-none-match': etag } : {}),
    },
  });
  // Drain the body so the socket is freed (we never read it).
  await res.arrayBuffer().catch(() => {});
  return {
    status: res.status,
    notModified: res.status === 304,
    etag: res.headers.get('etag'),
  };
}

// REST GET returning the raw response TEXT (not JSON), for endpoints with a plain-text
// body — notably the Actions job-logs endpoint, which 302-redirects to a signed
// download URL. fetch follows the redirect automatically AND strips the Authorization
// header on the cross-origin hop, so our token is never sent to the signed URL. Does
// NOT throw on a non-2xx status — returns it so the caller can degrade gracefully
// (logs expire after ~90 days / on a re-run → 404/410; missing actions:read → 403).
export async function ghRestGetText(
  token: string,
  path: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, text };
}

// ADDITIVE (Actions job logs, byte-window viewer): REST GET returning the RAW Response
// WITHOUT reading the body and WITHOUT following redirects (`redirect: 'manual'`), so
// the caller can:
//   (a) read the `location` of the Actions job-logs 302 and issue its OWN byte-`Range`
//       request against the short-lived signed blob URL (which does honour Range), and
//   (b) STREAM + cap a potentially multi-MB body instead of buffering the whole thing.
// The signed URL must NEVER be handed to a client — it is unauthenticated and would
// bypass our per-account ownership check. Nothing here throws on a non-2xx; the caller
// branches on `res.status`. The Authorization header is only ever sent to api.github.com
// because we do not follow the cross-origin hop ourselves.
export async function ghRestGetRaw(
  token: string,
  path: string,
  init?: { signal?: AbortSignal },
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      authorization: `token ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: init?.signal,
  });
}

// REST GET a repo file's RAW contents (Accept: application/vnd.github.raw), NOT throwing
// on a non-2xx — returns the status + body so the caller can branch. Used to fetch a
// repo's CODEOWNERS file (404 when absent → degrade to no CODEOWNERS suggestions) and the
// advisor's bot-config reads. The raw media type returns the file bytes directly (no
// base64/JSON envelope to decode). `ref` (optional) reads at a specific branch/sha —
// omitted, GitHub serves the default branch, which is the config that governs FUTURE
// reviews (the advisor's read point).
export async function ghRestGetContentRaw(
  token: string,
  path: string,
  ref?: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const url = ref
    ? `https://api.github.com${path}?ref=${encodeURIComponent(ref)}`
    : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github.raw',
      'x-github-api-version': '2022-11-28',
    },
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, text };
}

// REST GET one directory's contents listing (the JSON contents API — for a FILE it returns
// an object, for a directory an array). Status-returning like ghRestGetContentRaw: a 404 is
// the ordinary "that directory doesn't exist" outcome (e.g. a repo with no
// .github/workflows/). Entries are name/path/type/size only — file BYTES go through
// ghRestGetContentRaw so there is exactly one place decoding repo-authored content.
export async function ghRestGetContentDir(
  token: string,
  path: string,
  ref?: string,
): Promise<{
  status: number;
  ok: boolean;
  entries: { name: string; path: string; type: 'file' | 'dir'; size: number }[];
}> {
  const url = ref
    ? `https://api.github.com${path}?ref=${encodeURIComponent(ref)}`
    : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    await res.text().catch(() => '');
    return { status: res.status, ok: false, entries: [] };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) {
    // A file path (object body) or an unreadable payload — not a directory listing.
    return { status: res.status, ok: false, entries: [] };
  }
  const entries = body
    .map((e) => {
      const it = e as { name?: unknown; path?: unknown; type?: unknown; size?: unknown };
      if (typeof it.name !== 'string' || typeof it.path !== 'string') return null;
      const type = it.type === 'dir' ? 'dir' : it.type === 'file' ? 'file' : null;
      if (!type) return null;
      return {
        name: it.name,
        path: it.path,
        type,
        size: typeof it.size === 'number' ? it.size : 0,
      } as { name: string; path: string; type: 'file' | 'dir'; size: number };
    })
    .filter((e): e is { name: string; path: string; type: 'file' | 'dir'; size: number } =>
      Boolean(e),
    );
  return { status: res.status, ok: true, entries };
}

// REST GET in GitHub's raw `diff` media type (Accept: application/vnd.github.diff),
// NOT throwing on a non-2xx — returns the status + body so the caller can branch. GitHub
// caps this media type at 20,000 lines and 406s past it (a huge PR), which the caller
// handles by falling back to the per-file endpoint. Mirrors ghRestGetText's non-throwing
// contract.
export async function ghRestGetDiffStatus(
  token: string,
  path: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github.diff',
      'x-github-api-version': '2022-11-28',
    },
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, text };
}

// Throwing variant of the above — the per-account, cloud-ready way to fetch a PR's
// unified diff (vs the local-only `gh pr diff`). Throws on a non-2xx status.
export async function ghRestGetDiff(token: string, path: string): Promise<string> {
  const res = await ghRestGetDiffStatus(token, path);
  if (!res.ok) {
    throw new Error(
      `GitHub REST GET(diff) ${path} -> ${res.status}: ${res.text.slice(0, 300)}`,
    );
  }
  return res.text;
}

// REST PUT returning the parsed STATUS + body WITHOUT throwing on a non-2xx, so the caller can
// map GitHub's meaningful merge / update-branch statuses to structured results (405 not
// mergeable, 409 head-sha mismatch, 422 method disallowed / can't update). Per-account token.
export async function ghRestPutStatus(
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PUT',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (rare on these endpoints) */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// REST PATCH returning status (updating a pull request — e.g. closing it via
// `{ state: 'closed' }`). Mirrors ghRestPutStatus: never throws on a non-2xx, returns the
// status + parsed body so the caller can map GitHub's error to an HTTP response.
export async function ghRestPatchStatus(
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; json: unknown; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (rare on these endpoints) */
  }
  return { status: res.status, ok: res.ok, json, text };
}

// REST POST (submitting a PR review — inline line comments require the REST
// reviews endpoint) for a specific account's token.
export function ghRestPostFor<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  return ghRest<T>(token, 'POST', path, body);
}

// REST POST to an endpoint that returns NO body (201/204 No Content) — e.g. the Actions
// "rerun" / "rerun-failed-jobs" endpoints. Same auth + fail-loud-on-non-2xx as ghRest,
// but does NOT call res.json() (which would throw `Unexpected end of JSON input` on the
// empty success body). Returns nothing.
export async function ghRestPostNoContent(
  token: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub REST POST ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  }
}

// ---- Local-only convenience wrappers ----
// Use the gh CLI token. ONLY for code paths that run in local mode — the Claude
// Review posting path (post-review.ts) and clone-manager.ts, both force-disabled
// in cloud. Caching the gh token is safe because local mode is single-account.
let localToken: string | null = null;
function localGhToken(): string {
  return (localToken ??= getGithubToken());
}

export function ghRestGet<T>(path: string): Promise<T> {
  return ghRestGetFor<T>(localGhToken(), path);
}

export function ghRestPost<T>(path: string, body: unknown): Promise<T> {
  return ghRestPostFor<T>(localGhToken(), path, body);
}
