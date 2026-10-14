import { safeExternalUrl } from './ui.js';

/**
 * A PR's GitHub URL from its repo's full name and number — the same spelling the server's
 * `githubUrl` uses (db/queries.ts). The Open PRs cards carry no URL of their own (the lean
 * `TimelinePr`), so the "Copy PR link" button builds it. null when the repo name is unknown (the
 * repos list has not answered) or the result is not an http(s) URL: no button beats a wrong link.
 */
export function githubPrUrl(repoFullName: string | null | undefined, number: number): string | null {
  const name = (repoFullName ?? '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(name) || !Number.isInteger(number) || number <= 0) return null;
  return safeExternalUrl(`https://github.com/${name}/pull/${number}`) ?? null;
}
