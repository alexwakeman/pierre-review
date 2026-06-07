import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ghRestGetFor } from '../github/client.js';

const { commitFiles } = schema;

interface RestCommit {
  files?: { filename: string }[];
}

/**
 * Resolve changed-file paths for the given commit SHAs, using the permanent
 * `commit_files` cache and filling misses via REST. SHAs are immutable, so the
 * cache never expires — re-syncs are free.
 */
export async function ensureCommitFiles(
  owner: string,
  name: string,
  shas: string[],
  token: string,
  concurrency = 10,
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
    } catch {
      // A missing/forbidden commit shouldn't abort the whole sync; treat as
      // "no known files" (derivation falls back to other signals).
      result.set(sha, []);
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < missing.length) {
      const sha = missing[next++]!;
      await fetchOne(sha);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), missing.length) }, worker),
  );

  return result;
}
