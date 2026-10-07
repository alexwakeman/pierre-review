// SETTLED BY A REPLY — an earlier Claude Review finding that was posted to GitHub, answered there
// by someone else, and resolved WITHOUT a code change. The pure half: which findings count, and
// which new findings repeat one. The DB loader is persist.ts `loadSettledByReplyFindings`.
//
// A finding counts as settled when ALL of these hold, on SYNCED data only:
//   1. it was posted as an inline comment and we can find that comment's thread
//      (`findingThread`): the thread's FIRST comment is by the account's own login and is either
//      the finding's stored `githubCommentId`, or (a Post review whose ids were not read back) on the
//      finding's path with a body that STARTS WITH the finding's resolved body — the body
//      post-review.ts `findingCommentBody` puts first. A PR-level comment has no thread and is
//      never settled by this rule;
//   2. the thread is RESOLVED on GitHub;
//   3. someone else REPLIED in it: a later comment whose author is a known login that is NOT the
//      account's own (Limn posts AS the reader, so every comment by that login — every
//      `isLimnPostedComment` one included — is ours) and NOT automation (a bot's auto-reply is not
//      a justification);
//   4. the code did NOT move under it: GitHub does not mark the thread outdated, and no synced
//      commit dated after the finding's comment touched its file. A commit whose files were never
//      synced counts as touching it — we do not know, so the finding stays on the old path.
//
// ⚠ A THREAD RESOLVED WITH NO REPLY IS NOT SETTLED. Resolving is a click, not evidence; it keeps
// the old behaviour (followed up and re-raised while the code says it is open).
// ⚠ A FINDING FIXED IN CODE IS NOT SETTLED EITHER — rule 4 hands it to the follow-up, whose
// "addressed" verdict is the existing path.
//
// What happens to a settled finding: it leaves the follow-up (never sent as a P item, never stored
// on the follow-up record, never in the pane's "Previous review" list), the prompt lists it in a
// fenced block the model is told not to raise again, and a new finding that repeats it
// (`isReraiseOfSettled`: same path, similar title) is dropped in code.

/** One synced comment of a review thread. */
export interface SettleThreadComment {
  databaseId: string | null;
  authorLogin: string | null;
  authorIsBot: boolean;
  body: string;
  createdAt: Date;
}

/** One synced review thread, comments oldest first. */
export interface SettleThread {
  path: string;
  isResolved: boolean;
  derivedState: string;
  isOutdated: boolean;
  comments: SettleThreadComment[];
}

/** One synced commit of the PR. `paths` null = its file list was never synced. */
export interface SettleCommit {
  committedAt: Date;
  paths: readonly string[] | null;
}

/** A posted earlier finding, as the predicate needs it. `body` is the resolved body. */
export interface SettleFinding {
  id: number;
  path: string;
  title: string;
  body: string;
  githubCommentId: string | null;
}

/** A finding the rule settled, with the reply that settled it (shown to the model as data). */
export interface SettledFinding {
  id: number;
  path: string;
  title: string;
  replyAuthor: string;
  reply: string;
}

const norm = (s: string): string => s.replace(/\r\n?/g, '\n').trim();
const sameLogin = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The thread a posted finding opened, or null (rule 1). */
export function findingThread(
  f: SettleFinding,
  threads: readonly SettleThread[],
  accountLogin: string | null,
): SettleThread | null {
  if (!accountLogin) return null;
  const body = norm(f.body);
  let byBody: SettleThread | null = null;
  for (const t of threads) {
    const root = t.comments[0];
    if (!root || !sameLogin(root.authorLogin, accountLogin)) continue;
    if (f.githubCommentId && root.databaseId === f.githubCommentId) return t;
    if (!byBody && body && t.path === f.path && norm(root.body).startsWith(body)) byBody = t;
  }
  return byBody;
}

/**
 * The reply that settles this thread, or null (rules 2–4). Exported for tests; the finding-level
 * entry point is `settledFindings`.
 */
export function settlingReply(
  t: SettleThread,
  accountLogin: string | null,
  commits: readonly SettleCommit[],
  // The finding's own path (the thread's is normally the same; both are checked).
  findingPath: string = t.path,
): SettleThreadComment | null {
  if (!accountLogin) return null;
  if (!t.isResolved && t.derivedState !== 'resolved') return null;
  if (t.isOutdated) return null;
  const root = t.comments[0];
  if (!root) return null;
  const since = root.createdAt.getTime();
  const touched = commits.some(
    (c) =>
      c.committedAt.getTime() > since &&
      (c.paths == null || c.paths.includes(t.path) || c.paths.includes(findingPath)),
  );
  if (touched) return null;
  for (const c of t.comments.slice(1)) {
    if (!c.authorLogin || c.authorIsBot) continue;
    if (sameLogin(c.authorLogin, accountLogin)) continue;
    if (!norm(c.body)) continue;
    return c;
  }
  return null;
}

/** Every finding the rule settles, in input order. */
export function settledFindings(
  findings: readonly SettleFinding[],
  threads: readonly SettleThread[],
  commits: readonly SettleCommit[],
  accountLogin: string | null,
): SettledFinding[] {
  const out: SettledFinding[] = [];
  for (const f of findings) {
    const t = findingThread(f, threads, accountLogin);
    if (!t) continue;
    const reply = settlingReply(t, accountLogin, commits, f.path);
    if (!reply) continue;
    out.push({ id: f.id, path: f.path, title: f.title, replyAuthor: reply.authorLogin!, reply: norm(reply.body) });
  }
  return out;
}

// ---- the re-raise match ----

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'to', 'for', 'is', 'and', 'or', 'with', 'be', 'it']);

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 0 && !STOP.has(w));
}

/** Word-set overlap (Jaccard) at or above which two titles on the same path are "the same point". */
export const SETTLED_TITLE_SIMILARITY = 0.6;

/**
 * Two titles say the same thing: equal once folded (case, quotes, punctuation, filler words), or
 * their word sets overlap at least SETTLED_TITLE_SIMILARITY.
 */
export function similarTitles(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.join(' ') === wb.join(' ')) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let both = 0;
  for (const w of sa) if (sb.has(w)) both += 1;
  return both / (sa.size + sb.size - both) >= SETTLED_TITLE_SIMILARITY;
}

/** The settled finding a new finding repeats (same path, similar title), or null. */
export function isReraiseOfSettled(
  f: { path: string; title: string },
  settled: readonly Pick<SettledFinding, 'id' | 'path' | 'title'>[],
): Pick<SettledFinding, 'id' | 'path' | 'title'> | null {
  return settled.find((s) => s.path === f.path && similarTitles(s.title, f.title)) ?? null;
}

/**
 * Drop every new finding that repeats a settled one. A finding LINKED to a still-open earlier one
 * (`priorFindingId` set) is the follow-up's re-raise of THAT finding and is kept.
 */
export function dropSettledReraises<F extends { path: string; title: string; priorFindingId?: number | null }>(
  findings: readonly F[],
  settled: readonly Pick<SettledFinding, 'id' | 'path' | 'title'>[],
): { kept: F[]; dropped: F[] } {
  const kept: F[] = [];
  const dropped: F[] = [];
  if (settled.length === 0) return { kept: [...findings], dropped };
  for (const f of findings) {
    if (f.priorFindingId == null && isReraiseOfSettled(f, settled)) dropped.push(f);
    else kept.push(f);
  }
  return { kept, dropped };
}
