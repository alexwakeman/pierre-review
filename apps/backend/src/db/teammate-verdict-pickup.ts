// A TEAMMATE'S VERDICT — which open PRs the reader's Limn should review FIRST because nobody but the
// author has given a Limn verdict at the PR's head (docs/TEAM-REVIEW.md § 4, "A teammate's verdict";
// docs/CLAUDE-REVIEW.md § Auto review → A teammate's verdict). PURE: no database, no clock. The auto
// review candidate read (db/queries.ts `getAutoReviewCandidates`) feeds it the rows it already holds.
//
// TWO REASONS, never the reader's own PR:
//   'author_review'  the PR AUTHOR's own Limn posted a review AT THE CURRENT HEAD. An author cannot
//                    approve their own PR, so that review is never a verdict: another Limn must give
//                    one. `authorVerdict` is what the author's Limn would have sent (the marker's
//                    `ov=`), so "APPROVE" sorts first.
//   'moved'          the head moved past every Limn review on the PR — all of them a TEAMMATE's — and
//                    no Limn verdict exists at the current head. (A PR the READER's Limn reviewed
//                    before is the ordinary moved-head re-review in auto.ts, not this list.)
//
// SETTLED (left out): any run of the reader's at the current head (any status, as for every auto
// candidate: a failed auto run there is the retry path's), a run of the reader's still queued or
// running, or a non-author teammate's Limn review at the current head (that is a verdict).
//
// THE POPULATION FLOOR: only Limn reviews posted at or after `floorMs` (when the workspace switched
// auto review on) count, so switching it on never bills a backlog of old PRs.
//
// ORDER: the author's held APPROVE first, then other author reviews, then moved heads; within each,
// the longest wait first (`waitingSinceMs`), then the PR id.

export type VerdictPickupReason = 'author_review' | 'moved';

export interface VerdictPickupCandidate {
  prId: number;
  headSha: string;
  reason: VerdictPickupReason;
  // 'author_review' only: the verdict the author's own Limn would have sent at this head, if it said.
  authorVerdict: 'APPROVE' | 'REQUEST_CHANGES' | null;
  // The PR's owner (the person, `prOwnerId`).
  authorUserId: number;
  // Since when a verdict has been owed: the author's earliest review at this head, or the newest Limn
  // review at an older head (a lower bound for when the head moved).
  waitingSinceMs: number;
  // The latest start or finish of any run of the READER's on the PR (null: none), for the start rule.
  lastRunAtMs: number | null;
}

export interface VerdictPickupPr {
  id: number;
  // `prOwnerId`: the person Limn opened it for, else its author.
  ownerId: number | null;
  headSha: string | null;
}

export interface VerdictPickupRow {
  prId: number;
  headSha: string;
  // 'own' = a full review of the reader's (kind NULL); 'teammate' = an imported teammate Limn review.
  kind: 'own' | 'teammate';
  status: string;
  createdAtMs: number;
  finishedAtMs: number | null;
  // Teammate rows: who posted it, when, and the marker's `ov=`.
  sourceUserId: number | null;
  postedAtMs: number | null;
  ownPrVerdict?: 'APPROVE' | 'REQUEST_CHANGES' | null;
}

const RANK: Record<string, number> = { author_approve: 0, author_review: 1, moved: 2 };
const rankOf = (c: VerdictPickupCandidate): number =>
  c.reason === 'author_review' ? (c.authorVerdict === 'APPROVE' ? RANK.author_approve! : RANK.author_review!) : RANK.moved!;

/** The PRs owed a teammate's Limn verdict, in pick-up order. Pure. */
export function verdictPickupCandidates(input: {
  prs: readonly VerdictPickupPr[];
  rows: readonly VerdictPickupRow[];
  readerUserId: number | null;
  floorMs: number;
}): VerdictPickupCandidate[] {
  const { readerUserId, floorMs } = input;
  // ⚠ Never the reader's own PR: with no proven reader, nothing is offered.
  if (readerUserId == null) return [];
  const byPr = new Map<number, VerdictPickupRow[]>();
  for (const r of input.rows) {
    const list = byPr.get(r.prId) ?? [];
    list.push(r);
    byPr.set(r.prId, list);
  }
  const out: VerdictPickupCandidate[] = [];
  for (const pr of input.prs) {
    if (pr.ownerId == null || pr.ownerId === readerUserId || !pr.headSha) continue;
    const rows = byPr.get(pr.id) ?? [];
    const own = rows.filter((r) => r.kind === 'own');
    if (own.some((r) => r.status === 'queued' || r.status === 'running')) continue;
    if (own.some((r) => r.headSha === pr.headSha)) continue;
    const posted = rows.filter(
      (r) => r.kind === 'teammate' && r.postedAtMs != null && r.sourceUserId != null && r.sourceUserId !== readerUserId,
    );
    // A non-author teammate's Limn review at the head IS a verdict (their claim line holds the head).
    if (posted.some((r) => r.headSha === pr.headSha && r.sourceUserId !== pr.ownerId)) continue;
    const lastRunAtMs =
      own.length > 0 ? Math.max(...own.map((r) => Math.max(r.createdAtMs, r.finishedAtMs ?? 0))) : null;
    const recent = posted.filter((r) => r.postedAtMs! >= floorMs);
    const authorAtHead = recent
      .filter((r) => r.headSha === pr.headSha && r.sourceUserId === pr.ownerId)
      .sort((a, b) => a.postedAtMs! - b.postedAtMs!);
    if (authorAtHead.length > 0) {
      const newest = authorAtHead[authorAtHead.length - 1]!;
      out.push({
        prId: pr.id,
        headSha: pr.headSha,
        reason: 'author_review',
        authorVerdict: newest.ownPrVerdict ?? null,
        authorUserId: pr.ownerId,
        waitingSinceMs: authorAtHead[0]!.postedAtMs!,
        lastRunAtMs,
      });
      continue;
    }
    // A moved head with only teammates' reviews behind it (the reader's own history is auto.ts's).
    if (own.length > 0) continue;
    const older = recent.filter((r) => r.headSha !== pr.headSha);
    if (older.length === 0) continue;
    out.push({
      prId: pr.id,
      headSha: pr.headSha,
      reason: 'moved',
      authorVerdict: null,
      authorUserId: pr.ownerId,
      waitingSinceMs: Math.max(...older.map((r) => r.postedAtMs!)),
      lastRunAtMs,
    });
  }
  return out.sort((a, b) => rankOf(a) - rankOf(b) || a.waitingSinceMs - b.waitingSinceMs || a.prId - b.prId);
}
