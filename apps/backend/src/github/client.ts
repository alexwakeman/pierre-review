import { graphql } from '@octokit/graphql';
import { getGithubToken } from './auth.js';

export type GraphqlClient = typeof graphql;

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
    throw new Error(
      `GitHub REST ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.json() as Promise<T>;
}

// REST GET (per-commit changed-files etc.) for a specific account's token.
export function ghRestGetFor<T>(token: string, path: string): Promise<T> {
  return ghRest<T>(token, 'GET', path);
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

// REST GET returning a resource in GitHub's raw `diff` media type (Accept:
// application/vnd.github.diff) — the per-account, cloud-ready way to fetch a PR's
// unified diff (vs the local-only `gh pr diff`). Throws on a non-2xx status.
export async function ghRestGetDiff(token: string, path: string): Promise<string> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github.diff',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `GitHub REST GET(diff) ${path} -> ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return res.text();
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
