// THE ONE MATCHER from a POSTED INLINE finding to the local review thread its comment started.
// Shared by auto resolve (which thread to close) and the review read (`ClaudeFinding.threadId`, the
// Changes-tab jump target) — never a second copy, or the two disagree about which thread is ours.
//
// By the stored GitHub comment id when the finding has one (a single post, or a review post whose
// comments were read back), else by the thread's ROOT comment: same file, Limn's provenance (the
// account's own login AND the hidden `<!-- pierre:claude-review` marker) and the finding's text at
// its start. Pure: callers load the rows.
import { resolveFindingBody } from './follow-up.js';

const norm = (t: string): string => t.replace(/\r\n?/g, '\n').trim();
// The same prefix `isLimnPostedComment` reads (db/review-threads-for-review.ts).
const LIMN_MARKER = /<!--\s*pierre:claude-review/i;

/** One synced review-thread comment, as the thread lookup reads it. */
export interface ThreadComment {
  threadId: number;
  databaseId: string | null;
  body: string | null;
  authorLogin: string | null;
  createdAt: number; // ms
}
export interface ThreadRow {
  id: number;
  githubNodeId: string;
  path: string;
  isResolved: boolean;
  // Who resolved it (review_threads.resolved_by_login); absent when the loader did not read it.
  resolvedByLogin?: string | null;
}

/**
 * The local thread a posted inline finding started, or null when nothing matches. `taken` holds
 * threads already claimed by another finding, so two findings never share one thread.
 */
export function findFindingThread<T extends Pick<ThreadRow, 'id' | 'path'>>(
  f: { path: string; body: string; editedBody: string | null; githubCommentId: string | null },
  threads: readonly T[],
  comments: readonly ThreadComment[],
  accountLogin: string | null,
  taken: ReadonlySet<number> = new Set(),
): T | null {
  const byId = new Map(threads.map((t) => [t.id, t]));
  if (f.githubCommentId != null) {
    const c = comments.find((x) => x.databaseId === f.githubCommentId);
    const t = c ? byId.get(c.threadId) : undefined;
    if (t && !taken.has(t.id)) return t;
  }
  if (!accountLogin) return null;
  const text = norm(resolveFindingBody(f));
  if (text === '') return null;
  const roots = new Map<number, ThreadComment>();
  for (const c of comments) {
    const r = roots.get(c.threadId);
    if (!r || c.createdAt < r.createdAt) roots.set(c.threadId, c);
  }
  for (const t of threads) {
    if (t.path !== f.path || taken.has(t.id)) continue;
    const root = roots.get(t.id);
    if (!root || root.authorLogin == null || root.authorLogin.toLowerCase() !== accountLogin.toLowerCase()) continue;
    const body = root.body ?? '';
    if (!LIMN_MARKER.test(body)) continue;
    if (norm(body).startsWith(text)) return t;
  }
  return null;
}
