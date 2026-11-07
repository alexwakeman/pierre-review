// PUSH SUMMARIES (docs/CLAUDE-REVIEW.md § Push summaries; docs/FRONTEND.md § Push summaries).
//
// Each FULL Limn review (not a replies pass) writes ONE short summary of the pushes it covers: what
// changed since the previous full review on the PR, and how that bears on the open findings and
// review threads. No extra model run: it is a field of the review's own result. The run row keeps
// the range it covers — `fromSha` EXCLUSIVE (the previous full review's head; null = the PR's first
// commit) to `toSha` (the reviewed head) — so rapid consecutive pushes are ONE entry.
//
// The PR Activity tab and the Feed place a summary on the commit (or commit run) whose sha is the
// range's `toSha`. A push with no review after it shows nothing. The text is MODEL OUTPUT about
// untrusted code: render it as plain text, never as HTML.

/** One stored summary, as the wire carries it. */
export interface PrPushSummary {
  /** The review run that wrote it (`claude_reviews.id`). */
  reviewId: number;
  /** The previous full review's head, EXCLUSIVE; null = from the PR's first commit. */
  fromSha: string | null;
  /** The reviewed head: the summary sits on this commit. */
  toSha: string;
  /** At most two sentences, or three or four '- ' bullets. Model text: plain text only. */
  text: string;
  /** When the run finished (ISO-8601). */
  at: string;
}

/** `GET /api/prs/:id/push-summaries`. Oldest first. */
export interface PrPushSummariesResponse {
  prId: number;
  summaries: PrPushSummary[];
}

/** The longest summary kept (the server clips; the client never needs to). */
export const PUSH_SUMMARY_MAX_CHARS = 600;

/**
 * One summary per reviewed head: the NEWEST run's (a Claude + Codex pair writes two at one head, a
 * re-run at the same head writes another). Oldest head first.
 */
export function newestPushSummaryPerHead(summaries: readonly PrPushSummary[]): PrPushSummary[] {
  const byHead = new Map<string, PrPushSummary>();
  for (const s of summaries) {
    const cur = byHead.get(s.toSha);
    if (!cur || s.reviewId > cur.reviewId) byHead.set(s.toSha, s);
  }
  return [...byHead.values()].sort((a, b) => a.at.localeCompare(b.at) || a.reviewId - b.reviewId);
}

/** A summary placed on its head commit, with how many of the listed commits its range covers. */
export interface PlacedPushSummary {
  summary: PrPushSummary;
  /** Commits after `fromSha` up to and including `toSha`; null when `fromSha` is not in the list
   *  (a force-push rewrote it), so the count is unknown, never guessed. */
  commitCount: number | null;
}

/**
 * Where each summary sits among a PR's commits: keyed by the HEAD commit's sha (`toSha`). A summary
 * whose head is not among the commits (rewritten by a force-push) is not placed. Commits may come in
 * any order; they are ordered by `at` (ISO-8601), then sha.
 */
export function placePushSummaries(
  commits: ReadonlyArray<{ sha: string; at: string }>,
  summaries: readonly PrPushSummary[],
): Map<string, PlacedPushSummary> {
  const ordered = [...commits].sort((a, b) => a.at.localeCompare(b.at) || a.sha.localeCompare(b.sha));
  const indexOf = new Map<string, number>();
  ordered.forEach((c, i) => {
    if (!indexOf.has(c.sha)) indexOf.set(c.sha, i);
  });
  const out = new Map<string, PlacedPushSummary>();
  for (const s of newestPushSummaryPerHead(summaries)) {
    const to = indexOf.get(s.toSha);
    if (to == null) continue;
    let commitCount: number | null;
    if (s.fromSha == null) commitCount = to + 1;
    else {
      const from = indexOf.get(s.fromSha);
      commitCount = from != null && from < to ? to - from : null;
    }
    out.set(s.toSha, { summary: s, commitCount });
  }
  return out;
}

/** The summaries whose head is one of `shas` (a Feed commit run), newest head per run, oldest first. */
export function pushSummariesForShas(
  shas: ReadonlySet<string> | readonly string[],
  summaries: readonly PrPushSummary[],
): PrPushSummary[] {
  const set = shas instanceof Set ? shas : new Set(shas as readonly string[]);
  return newestPushSummaryPerHead(summaries.filter((s) => set.has(s.toSha)));
}
