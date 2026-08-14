import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ghRestGetFor, isRateLimitError } from '../github/client.js';
import { noteLimited } from '../github/rate-budget.js';

const { commitFiles } = schema;

interface RestCommit {
  files?: { filename: string }[];
}

/**
 * Resolve changed-file paths for the given commit SHAs, using the permanent
 * `commit_files` cache and filling misses via REST. SHAs are immutable, so the
 * cache never expires — re-syncs are free.
 *
 * `accountId` (optional — the sync walk passes it) lets a RATE-LIMITED failure feed the
 * account's budget (github/rate-budget.ts) and stop the fan-out early; see the catch below.
 */
export async function ensureCommitFiles(
  owner: string,
  name: string,
  shas: string[],
  token: string,
  concurrency = 10,
  accountId?: number,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;

  // Load whatever is already cached.
  const cached = await db
    .select()
    .from(commitFiles)
    .where(inArray(commitFiles.sha, unique))
    .execute();
  for (const row of cached) result.set(row.sha, row.paths);

  // Fetch cache misses through one continuously-saturated worker pool. These
  // REST calls dominate sync latency; the caller now hands us a whole page's
  // worth of misses at once (rather than per-PR waves), so a fixed set of
  // workers each pull the next SHA the instant they finish — keeping `concurrency`
  // requests in flight the whole time. SHAs are immutable and the cache upsert is
  // idempotent, so order doesn't matter.
  const missing = unique.filter((sha) => !result.has(sha));
  // Flipped when a fetch comes back RATE-LIMITED: the remaining misses are doomed on this
  // token right now, so the workers stop pulling new SHAs (nothing is cached for the
  // unfetched ones — the map read degrades to "no known files" and the next sync retries
  // them). The limit is noted on the account's budget so the page loop's gate pauses
  // before spending more.
  let limited = false;
  const fetchOne = async (sha: string): Promise<void> => {
    try {
      const commit = await ghRestGetFor<RestCommit>(
        token,
        `/repos/${owner}/${name}/commits/${sha}`,
      );
      const paths = (commit.files ?? []).map((f) => f.filename);
      await db
        .insert(commitFiles)
        .values({ sha, paths })
        .onConflictDoUpdate({ target: commitFiles.sha, set: { paths } })
        .execute();
      result.set(sha, paths);
    } catch (err) {
      const rl = isRateLimitError(err);
      if (rl.limited) {
        limited = true;
        if (accountId != null) noteLimited(accountId, rl.resumeAt);
      }
      // A missing/forbidden commit shouldn't abort the whole sync; treat as
      // "no known files" (derivation falls back to other signals). Nothing is cached, so
      // a rate-limited SHA is re-fetched by a later sync.
      result.set(sha, []);
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!limited && next < missing.length) {
      const sha = missing[next++]!;
      await fetchOne(sha);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), missing.length) }, worker),
  );

  return result;
}
