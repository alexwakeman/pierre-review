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

  // Fetch cache misses with bounded concurrency. These REST calls dominate
  // sync latency on a PR that just got several commits addressing threads;
  // running them serially blocks the whole page loop. SHAs are immutable and
  // the cache is idempotent, so parallelism is safe.
  const missing = unique.filter((sha) => !result.has(sha));
  const CONCURRENCY = 5;
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
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchOne));
  }

  return result;
}
