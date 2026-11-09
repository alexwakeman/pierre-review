// THE SCRATCH WRITE GUARD (docs/TESTING.md § Scratch stack).
//
// A scratch backend (LIMN_SCRATCH=1, `pnpm dev:scratch`) may READ GitHub with the reader's own token,
// but it must never WRITE anywhere a person would see it: a comment, an approval, a merge, a push, a
// Slack message, a Jira transition. A button pressed in a scratch SPA would otherwise post for real,
// and a copied database carries live auto switches. So, unless LIMN_SCRATCH_GITHUB=write:
//
//   - `installScratchFetchGuard` wraps `globalThis.fetch` (octokit REST + GraphQL, Slack, the
//     trackers all go through it) and answers every write request with a 403 it never sends;
//   - `assertScratchWriteAllowed` is called by the two GitHub write seams that are not a fetch of
//     their own: `limnWrite` (github/write-origin.ts — every exported GitHub write) and the git push
//     (coding/git.ts `pushRef` / `pushForceWithLease`).
//
// What counts as a write (`scratchWriteRefusal`):
//   - GitHub (api / uploads / github.com): any method but GET / HEAD, except a GraphQL POST whose
//     query has no `mutation`;
//   - Slack (`*.slack.com`): any method but GET / HEAD;
//   - Linear: a GraphQL mutation; Notion: PUT / PATCH / DELETE, and a POST other than a search or a
//     database query;
//   - Jira (any host): a non-GET to `/rest/api/<v>/issue…`;
//   - any non-loopback host: PUT / PATCH / DELETE.
// A model call (a POST to Anthropic or OpenAI) and the ML scorer are not writes and pass.
//
// ⚠ It does not see child processes other than `git push`: the `gh` CLI is only used to READ (the
// token, `gh api user`, `gh pr diff`), and the agents run read-only or in the sandbox, whose work
// leaves only through the host push guarded here.
//
// No imports outside `node:*` and this folder: config.ts installs it.
import type { ScratchGithubMode } from './scratch.js';

let mode: ScratchGithubMode | null = null;

/** The active scratch GitHub mode, or null outside a scratch backend. */
export function activeScratchMode(): ScratchGithubMode | null {
  return mode;
}

export class ScratchWriteBlockedError extends Error {
  readonly code = 'SCRATCH_WRITE_BLOCKED';
  constructor(what: string) {
    super(
      `This is a scratch Limn: ${what} was blocked and nothing was sent. ` +
        'Start `pnpm dev:scratch` with `--github write` to allow writes.',
    );
    this.name = 'ScratchWriteBlockedError';
  }
}

/** Throw when a scratch backend without `--github write` is about to write. A no-op otherwise. */
export function assertScratchWriteAllowed(what: string): void {
  if (mode !== null && mode !== 'write') throw new ScratchWriteBlockedError(what);
}

const GITHUB_HOSTS = new Set(['api.github.com', 'uploads.github.com', 'github.com']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/** True when a GraphQL document (or a JSON body holding one) contains a mutation operation. */
export function graphqlHasMutation(body: string): boolean {
  let query = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    const pick = (v: unknown): string =>
      v && typeof v === 'object' && typeof (v as { query?: unknown }).query === 'string'
        ? (v as { query: string }).query
        : '';
    query = Array.isArray(parsed) ? parsed.map(pick).join('\n') : pick(parsed) || body;
  } catch {
    /* a raw document */
  }
  const stripped = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
  return /(^|[^\w$])mutation\b/.test(stripped);
}

/**
 * Why this request is a write a scratch backend must not send, or null when it may go. `body` is
 * the request body as text when it could be read (undefined for no body, null for a body that
 * could not be read — treated as a write wherever the body decides).
 */
export function scratchWriteRefusal(
  url: string,
  method: string,
  body: string | null | undefined,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // a relative URL: never an external write
  }
  const host = u.hostname.toLowerCase();
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return null;
  const what = `${m} ${u.origin}${u.pathname}`;

  if (GITHUB_HOSTS.has(host)) {
    if (m === 'POST' && host === 'api.github.com' && /^\/(api\/)?graphql\/?$/.test(u.pathname)) {
      if (body === undefined) return null;
      if (body === null || graphqlHasMutation(body)) return `a GitHub GraphQL mutation (${what})`;
      return null;
    }
    return `a GitHub write (${what})`;
  }
  if (host === 'slack.com' || host.endsWith('.slack.com')) return `a Slack message (${what})`;
  if (host === 'api.linear.app') {
    if (body === null || (body !== undefined && graphqlHasMutation(body))) return `a Linear write (${what})`;
    return null;
  }
  if (host === 'api.notion.com') {
    if (m === 'POST' && /^\/v1\/(search|(databases|data_sources)\/[^/]+\/query)\/?$/.test(u.pathname)) return null;
    return `a Notion write (${what})`;
  }
  if (/^\/rest\/api\/[^/]+\/issue(\/|$)/.test(u.pathname)) return `a Jira write (${what})`;
  if (!isLoopback(host) && (m === 'PUT' || m === 'PATCH' || m === 'DELETE')) return `a write (${what})`;
  return null;
}

async function readBody(input: unknown, init: RequestInit | undefined): Promise<string | null | undefined> {
  const b = init?.body ?? (input instanceof Request ? (input.body ? input.clone() : undefined) : undefined);
  if (b === undefined || b === null) return undefined;
  if (typeof b === 'string') return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof Request) {
    try {
      return await b.text();
    } catch {
      return null;
    }
  }
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
    const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return new TextDecoder().decode(bytes);
  }
  return null; // a stream or form: unreadable without consuming it
}

let installed: { original: typeof fetch } | null = null;

/**
 * Wrap `globalThis.fetch` so a scratch backend never sends a write (above). `githubMode` 'write'
 * installs nothing. Idempotent; `uninstallScratchFetchGuard` restores the original (tests).
 */
export function installScratchFetchGuard(githubMode: ScratchGithubMode): void {
  mode = githubMode;
  if (githubMode === 'write' || installed) return;
  const original = globalThis.fetch;
  installed = { original };
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const refusal = READ_METHODS.has(method.toUpperCase())
      ? null
      : scratchWriteRefusal(url, method, await readBody(input, init));
    if (refusal) {
      const message = new ScratchWriteBlockedError(refusal).message;
      // eslint-disable-next-line no-console
      console.warn(`[scratch] ${message}`);
      // A 403 the caller reads as a refusal: never retried (isRetryableGithubError), and not a
      // rate limit (no x-ratelimit headers, no "rate limit" words).
      return new Response(JSON.stringify({ message }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'application/json', 'x-limn-scratch-blocked': '1' },
      });
    }
    return original(input, init);
  };
  globalThis.fetch = guarded as typeof fetch;
}

/** Restore the original fetch and leave scratch mode (tests only). */
export function uninstallScratchFetchGuard(): void {
  if (installed) globalThis.fetch = installed.original;
  installed = null;
  mode = null;
}
