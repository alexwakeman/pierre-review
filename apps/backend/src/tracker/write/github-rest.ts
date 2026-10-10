// GitHub REST for the sprint write-back (GitHub Issues: a comment, or the issue body). Kept here, not
// in github/client.ts, so the ONE place that writes to a tracker owns its own small helper. The token
// is the ACCOUNT's (`getAccessToken`), handed in per call — never cached here.
//
// Failures throw `GithubWriteError` with the HTTP status (null = the request may have been sent but
// no answer came: a timeout or a dropped connection). Never the response body.

export const GITHUB_WRITE_TIMEOUT_MS = 15_000;

export class GithubWriteError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly kind: 'http' | 'timeout' | 'network',
  ) {
    super(`github write failed: ${kind}${status != null ? ` (${status})` : ''}`);
    this.name = 'GithubWriteError';
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function ghRestSend(
  token: string,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<unknown> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `token ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'Limn',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GITHUB_WRITE_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    throw new GithubWriteError(null, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  if (!res.ok) throw new GithubWriteError(res.status, 'http');
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function ghRestPostFor(token: string, path: string, body: unknown, fetchImpl?: FetchLike): Promise<unknown> {
  return ghRestSend(token, 'POST', path, body, fetchImpl);
}

export function ghRestPatchFor(token: string, path: string, body: unknown, fetchImpl?: FetchLike): Promise<unknown> {
  return ghRestSend(token, 'PATCH', path, body, fetchImpl);
}
