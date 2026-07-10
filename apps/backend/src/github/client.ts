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

// REST GET a repo file's RAW contents (Accept: application/vnd.github.raw), NOT throwing
// on a non-2xx — returns the status + body so the caller can branch. Used to fetch a
// repo's CODEOWNERS file (404 when absent → degrade to no CODEOWNERS suggestions). The
// raw media type returns the file bytes directly (no base64/JSON envelope to decode).
export async function ghRestGetContentRaw(
  token: string,
  path: string,
): Promise<{ status: number; ok: boolean; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, {
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
