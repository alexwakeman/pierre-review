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

// REST POST (submitting a PR review — inline line comments require the REST
// reviews endpoint) for a specific account's token.
export function ghRestPostFor<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  return ghRest<T>(token, 'POST', path, body);
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
