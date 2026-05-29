import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { ghRestGet } from '../github/client.js';

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
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;

  // Load whatever is already cached.
  const cached = db
    .select()
    .from(commitFiles)
    .where(inArray(commitFiles.sha, unique))
    .all();
  for (const row of cached) result.set(row.sha, row.paths);

  const missing = unique.filter((sha) => !result.has(sha));
  for (const sha of missing) {
    try {
      const commit = await ghRestGet<RestCommit>(
        `/repos/${owner}/${name}/commits/${sha}`,
      );
      const paths = (commit.files ?? []).map((f) => f.filename);
      db.insert(commitFiles)
        .values({ sha, paths })
        .onConflictDoUpdate({ target: commitFiles.sha, set: { paths } })
        .run();
      result.set(sha, paths);
    } catch {
      // A missing/forbidden commit shouldn't abort the whole sync; treat as
      // "no known files" (derivation falls back to other signals).
      result.set(sha, []);
    }
  }

  return result;
}
