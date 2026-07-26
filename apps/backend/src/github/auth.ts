import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const NOT_AUTHED_MESSAGE =
  'gh CLI not authenticated. Run `gh auth login` first, then restart the app.\n' +
  'For org repos behind SSO you may also need:\n' +
  '  gh auth refresh -h github.com -s read:org';

// ---- Token cache ----
// `gh auth token` shells out to a child process that takes 50–300ms (longer when the OS
// keyring prompts or the token is being refreshed), and getAccessToken() calls it for the
// local account on EVERY request that needs a token: every PR-detail hydration, every repo
// search, every write action. Uncached and synchronous, that both forked a process per
// request and BLOCKED the event loop for its whole duration — so a burst of requests pinned
// the server at 100% CPU behind a queue of `gh` processes and the dashboard stopped
// responding.
//
// Caching is safe: local mode has exactly one account and one ambient gh session. The TTL is
// short so a `gh auth refresh` / re-login is picked up without restarting, and the in-flight
// promise collapses a concurrent burst into a single child process.
const TOKEN_TTL_MS = 5 * 60 * 1000;
let cached: { token: string; at: number } | null = null;
let inFlight: Promise<string> | null = null;

/**
 * The gh CLI token, cached with a short TTL. Prefer this everywhere on a request path — it
 * never blocks the event loop.
 */
export async function getGithubTokenAsync(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < TOKEN_TTL_MS) return cached.token;
  // A concurrent burst (e.g. the SPA opening several PRs at once) shares one `gh` invocation
  // rather than forking one process each.
  inFlight ??= (async () => {
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
        encoding: 'utf-8',
      });
      const token = stdout.trim();
      if (!token) throw new Error('empty token');
      cached = { token, at: Date.now() };
      return token;
    } catch {
      throw new Error(NOT_AUTHED_MESSAGE);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Synchronous variant. Kept for the STARTUP path (`cli.ts`'s pre-flight check and
 * `ensureLocalAccount`) and for the few local-only helpers that are not on a request path,
 * where blocking once is fine and threading async through would be churn for no gain.
 * Shares the cache with the async form, so a request path that has already warmed it never
 * forks a process here either.
 *
 * Do NOT call this from a request handler — use `getGithubTokenAsync`.
 */
export function getGithubToken(): string {
  const now = Date.now();
  if (cached && now - cached.at < TOKEN_TTL_MS) return cached.token;
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
    }).trim();
    if (!token) throw new Error('empty token');
    cached = { token, at: Date.now() };
    return token;
  } catch {
    throw new Error(NOT_AUTHED_MESSAGE);
  }
}

/**
 * Drop the cached token. Call after GitHub rejects it with a 401 so the next request
 * re-reads it from `gh` (which may have refreshed it) instead of retrying a dead token for
 * up to the TTL.
 */
export function invalidateGithubToken(): void {
  cached = null;
}
