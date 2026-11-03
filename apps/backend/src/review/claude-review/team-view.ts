// THE MERGED REVIEW (docs/CLAUDE-REVIEW.md § Teammates' reviews → One review). The reader's latest
// review and the reviews teammates' Limn POSTED to GitHub read as ONE review:
//   - the NEWEST review leads (its summary and verdict head the AI Review tab);
//   - a teammate's finding stays in the one findings list while its GitHub thread is UNRESOLVED and no
//     later review (the reader's follow-up, or the reader's thread judgement) judged it addressed;
//   - the same point raised by the reader's latest review and a teammate shows ONCE, naming both
//     (linked through `prior_finding_id`, or same path + nearby line + similar title — the dedupe's
//     own fingerprint, `similarTitles`; two PR-level points match on the title alone);
//   - a finding with no GitHub thread (PR-level, or a comment that mapped to no thread) also drops out
//     once the reader's newer review at a DIFFERENT head no longer raises it (it has no other way out);
//   - the reader's follow-up settling its own finding settles a teammate's twin of it (same spot).
// ⚠ Folded HERE ONLY (`foldTeamReview`, pure; `loadTeamReviewView` reads its inputs). The AI Review
// tab, the PR overview and the review count read the result (`ClaudeReviewResponse.teamView`).
// ⚠ Own-only readers (caps, budget, posting, follow-up) never read this: it is a view.
// This module opens NO database at import (the loader takes an executor).
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type {
  ClaudeFindingSeverity,
  ClaudeFollowUpStatus,
  ClaudeReview,
  ClaudeReviewFollowUpRecord,
  ClaudeTeamFinding,
  ClaudeTeammatePoster,
  ClaudeTeammateReview,
  ClaudeTeamReviewCount,
  ClaudeTeamReviewView,
  ClaudeThreadAddressed,
} from '@pierre-review/shared';
import type { Executor } from '../../db/client.js';
import * as schema from '../../db/schema.sqlite.js';
import { ownRunsOnly } from '../../db/teammate-reviews.js';
import { similarTitles } from './settled-by-reply.js';

/** A follow-up status that settles a finding: it drops out of the list. */
const SETTLED: ReadonlySet<ClaudeFollowUpStatus> = new Set(['addressed', 'no_longer_applies', 'reply_accepted']);

/** Two lines this close (or either unknown) are the same spot. */
const NEAR_LINES = 3;

export interface TeamFoldInput {
  // Every teammate review imported on the PR (any order).
  teammateReviews: readonly ClaudeTeammateReview[];
  // The reader's latest full review (any status), or null.
  own: {
    status: ClaudeReview['status'];
    // 'skip' = no review ran: it never competes for the lead or supersedes a finding.
    reviewMode?: ClaudeReview['reviewMode'];
    // The head it reviewed (absent = unknown: it supersedes nothing).
    headSha?: string;
    // When it was done (finished, else created), ms.
    at: number;
    findings: ReadonlyArray<{
      id: number;
      path: string;
      line: number | null;
      title: string;
      severity: ClaudeFindingSeverity;
      priorFindingId: number | null;
    }>;
  } | null;
  // Every one of the reader's own findings on the PR: id → prior_finding_id (the follow-up chain).
  ownChain: ReadonlyMap<number, number | null>;
  // Where each of the reader's own findings sits (id → spot), so a follow-up settling one settles a
  // teammate's twin matched by spot. Absent ⇒ only the chain links.
  ownSpots?: ReadonlyMap<number, { path: string; line: number | null; title: string }>;
  // The follow-up judgements of the reader's own succeeded full reviews, by review id. `at` (ms) is
  // when the judging review ran: a teammate finding posted after it is not settled by spot.
  judgements: ReadonlyArray<{
    reviewId: number;
    at?: number;
    items: ReadonlyArray<{ priorFindingId: number; status: ClaudeFollowUpStatus }>;
  }>;
  // Synced review threads marked resolved on GitHub.
  resolvedThreads: ReadonlySet<number>;
  // The reader's thread judgements as they stand now (latest review + later Check threads).
  threadJudgements: ReadonlyArray<{ threadId: number; addressed: ClaudeThreadAddressed }> | null;
}

const ms = (iso: string): number => new Date(iso).getTime();

function sameSpot(
  a: { path: string; line: number | null; title: string },
  b: { path: string; line: number | null; title: string },
): boolean {
  if (a.path !== b.path) return false;
  // Two PR-level points (no file): the title alone decides.
  if (a.path === '') return similarTitles(a.title, b.title);
  if (a.line != null && b.line != null && Math.abs(a.line - b.line) > NEAR_LINES) return false;
  return similarTitles(a.title, b.title);
}

function addPoster(list: ClaudeTeammatePoster[], p: ClaudeTeammatePoster): void {
  if (!list.some((x) => x.userId === p.userId)) list.push(p);
}

/** THE FOLD (pure). */
export function foldTeamReview(input: TeamFoldInput): ClaudeTeamReviewView {
  const { teammateReviews, own } = input;
  // Oldest first, so the first poster of a point is its canonical entry.
  const byAge = [...teammateReviews].sort((a, b) => ms(a.postedAt) - ms(b.postedAt) || a.reviewId - b.reviewId);
  const teammateIds = new Set<number>();
  for (const r of byAge) for (const f of r.findings) teammateIds.add(f.id);

  // The teammate finding an id leads back to: itself, or the reader's finding chain ending on one.
  const rootOf = (start: number | null): number | null => {
    let cur = start;
    for (let hops = 0; cur != null && hops < 100; hops += 1) {
      if (teammateIds.has(cur)) return cur;
      cur = input.ownChain.get(cur) ?? null;
    }
    return null;
  };

  // The LATEST follow-up judgement of each teammate finding (a later review overrides an earlier one).
  // Through the chain, else through the spot of the reader's own finding the item judged (a twin
  // shown once under the reader's finding is settled with it).
  const judged = new Map<number, ClaudeFollowUpStatus>();
  for (const j of [...input.judgements].sort((a, b) => a.reviewId - b.reviewId)) {
    for (const it of j.items) {
      const root = rootOf(it.priorFindingId);
      if (root != null) {
        judged.set(root, it.status);
        continue;
      }
      const spot = input.ownSpots?.get(it.priorFindingId);
      if (spot == null) continue;
      for (const r of byAge) {
        if (j.at != null && ms(r.postedAt) > j.at) continue;
        for (const f of r.findings) if (sameSpot(spot, f)) judged.set(f.id, it.status);
      }
    }
  }
  // The reader's latest run counts as a REVIEW only when it succeeded and was not a skip.
  const ownReviewed = own != null && own.status === 'succeeded' && own.reviewMode !== 'skip';
  // A threadless finding has no thread to resolve or judge: the reader's newer review at a different
  // head that no longer raises it supersedes it.
  const ownRaises = (f: ClaudeTeammateReview['findings'][number]): boolean =>
    own != null && own.findings.some((o) => o.severity !== 'praise' && (rootOf(o.priorFindingId) === f.id || sameSpot(o, f)));
  const superseded = (r: ClaudeTeammateReview, f: ClaudeTeammateReview['findings'][number]): boolean =>
    f.threadId == null &&
    ownReviewed &&
    own.headSha != null &&
    own.headSha !== r.headSha &&
    own.at > ms(r.postedAt) &&
    !ownRaises(f);
  const threadAddressed = new Map((input.threadJudgements ?? []).map((t) => [t.threadId, t.addressed]));
  const open = (f: { id: number; threadId: number | null }): boolean => {
    if (f.threadId != null && input.resolvedThreads.has(f.threadId)) return false;
    const status = judged.get(f.id);
    // A follow-up judgement names this finding; else the reader's judgement of its thread.
    if (status != null) return !SETTLED.has(status);
    return !(f.threadId != null && threadAddressed.get(f.threadId) === 'addressed');
  };

  // Teammates' open findings, one entry per point (two teammates on the same point fold into one).
  const entries: ClaudeTeamFinding[] = [];
  const entryOf = new Map<number, ClaudeTeamFinding>();
  for (const r of byAge) {
    for (const f of r.findings) {
      if (!open(f) || superseded(r, f)) continue;
      const same = entries.find((e) => (e.threadId != null && e.threadId === f.threadId) || sameSpot(e, f));
      if (same != null) {
        addPoster(same.by, r.poster);
        entryOf.set(f.id, same);
        continue;
      }
      const e: ClaudeTeamFinding = { ...f, reviewId: r.reviewId, postedAt: r.postedAt, by: [r.poster] };
      entries.push(e);
      entryOf.set(f.id, e);
    }
  }

  // The reader's latest review raised the same point: it shows once, naming the teammate(s).
  const alsoRaisedBy: ClaudeTeamReviewView['alsoRaisedBy'] = [];
  const taken = new Set<ClaudeTeamFinding>();
  if (ownReviewed) {
    for (const f of own.findings) {
      if (f.severity === 'praise') continue;
      const root = rootOf(f.priorFindingId);
      const linked = root != null ? entryOf.get(root) : undefined;
      const match =
        linked != null && !taken.has(linked) ? linked : entries.find((e) => !taken.has(e) && sameSpot(e, f));
      if (match == null) continue;
      taken.add(match);
      alsoRaisedBy.push({ findingId: f.id, by: match.by });
    }
  }

  // The newest review leads. A run of the reader's in progress is the newest work; a failed run or a
  // skip reviewed nothing, so any teammate review outranks it.
  const newest = byAge[byAge.length - 1] ?? null;
  let lead: ClaudeTeamReviewView['lead'] = own != null ? 'own' : newest != null ? 'teammate' : null;
  const ownInProgress = own != null && (own.status === 'queued' || own.status === 'running');
  if (own != null && newest != null && !ownInProgress && (!ownReviewed || ms(newest.postedAt) > own.at))
    lead = 'teammate';

  const reviewAt = new Map(byAge.map((r) => [r.reviewId, ms(r.postedAt)]));
  const findings = entries
    .filter((e) => !taken.has(e))
    .map((e, i) => ({ e, i }))
    // Newest review first; within a review, as posted.
    .sort((a, b) => (reviewAt.get(b.e.reviewId) ?? 0) - (reviewAt.get(a.e.reviewId) ?? 0) || a.i - b.i)
    .map(({ e }) => e);

  return {
    lead,
    teammateReviewId: lead === 'teammate' && newest != null ? newest.reviewId : null,
    findings,
    alsoRaisedBy,
  };
}

/**
 * THE REVIEW COUNT (pure): how many Limn reviews have run on the PR so far. `ownRuns` are the reader's
 * own SUCCEEDED full runs (`kind IS NULL`, skips left out); a Claude + Codex pair (one `pairId` on both
 * halves) counts ONCE. Every teammate review counts once, under its poster.
 */
export function teamReviewCount(
  ownRuns: ReadonlyArray<{ id: number; pairId: number | null }>,
  teammateReviews: ReadonlyArray<Pick<ClaudeTeammateReview, 'poster'>>,
): ClaudeTeamReviewCount {
  const own = new Set(ownRuns.map((r) => r.pairId ?? r.id)).size;
  const by = new Map<number, { poster: ClaudeTeammatePoster; count: number }>();
  for (const r of teammateReviews) {
    const e = by.get(r.poster.userId);
    if (e != null) e.count += 1;
    else by.set(r.poster.userId, { poster: r.poster, count: 1 });
  }
  const byTeammate = [...by.values()].sort((a, b) => b.count - a.count || a.poster.login.localeCompare(b.poster.login));
  return { total: own + teammateReviews.length, byTeammate };
}

const cr = schema.claudeReviews;
const crf = schema.claudeReviewFindings;

/**
 * Read the fold's inputs for one PR (account-scoped, DB only) and fold. `own` is the latest full
 * review as the tab shows it; `threadJudgements` the server's current thread judgements.
 */
export async function loadTeamReviewView(
  exec: Executor,
  accountId: number,
  prId: number,
  own: ClaudeReview | null,
  teammateReviews: readonly ClaudeTeammateReview[],
  threadJudgements: ReadonlyArray<{ threadId: number; addressed: ClaudeThreadAddressed }> | null,
): Promise<ClaudeTeamReviewView> {
  // The review count: the reader's own succeeded full runs (a skip ran no review), pairs once.
  const ownRuns = await exec
    .select({ id: cr.id, pairId: cr.pairId, reviewMode: cr.reviewMode })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), isNull(cr.kind), eq(cr.status, 'succeeded')))
    .execute();
  const reviewCount = teamReviewCount(
    ownRuns.filter((r) => r.reviewMode !== 'skip'),
    teammateReviews,
  );
  if (teammateReviews.length === 0)
    return { lead: own != null ? 'own' : null, teammateReviewId: null, findings: [], alsoRaisedBy: [], reviewCount };
  const [chainRows, judgeRows] = await Promise.all([
    exec
      .select({ id: crf.id, priorFindingId: crf.priorFindingId, path: crf.path, line: crf.line, title: crf.title })
      .from(crf)
      .innerJoin(cr, eq(cr.id, crf.reviewId))
      .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), ownRunsOnly(cr.kind)))
      .execute(),
    exec
      .select({ id: cr.id, followUp: cr.followUp, createdAt: cr.createdAt, finishedAt: cr.finishedAt })
      .from(cr)
      .where(
        and(eq(cr.prId, prId), eq(cr.accountId, accountId), isNull(cr.kind), eq(cr.status, 'succeeded'), isNotNull(cr.followUp)),
      )
      .execute(),
  ]);
  const threadIds = [
    ...new Set(teammateReviews.flatMap((r) => r.findings.map((f) => f.threadId)).filter((t): t is number => t != null)),
  ];
  const resolved = new Set<number>();
  if (threadIds.length > 0) {
    const rt = schema.reviewThreads;
    for (const t of await exec
      .select({ id: rt.id, isResolved: rt.isResolved })
      .from(rt)
      .where(and(eq(rt.prId, prId), inArray(rt.id, threadIds)))
      .execute())
      if (t.isResolved) resolved.add(t.id);
  }
  const view = foldTeamReview({
    teammateReviews,
    own:
      own == null
        ? null
        : {
            status: own.status,
            reviewMode: own.reviewMode,
            headSha: own.headSha,
            at: ms(own.finishedAt ?? own.createdAt),
            findings: own.findings.map((f) => ({
              id: f.id,
              path: f.path,
              line: f.line,
              title: f.title,
              severity: f.severity,
              priorFindingId: f.priorFindingId ?? null,
            })),
          },
    ownChain: new Map(chainRows.map((r) => [r.id, r.priorFindingId ?? null])),
    ownSpots: new Map(chainRows.map((r) => [r.id, { path: r.path, line: r.line ?? null, title: r.title }])),
    judgements: judgeRows.map((r) => ({
      reviewId: r.id,
      at: (r.finishedAt ?? r.createdAt).getTime(),
      items: ((r.followUp as ClaudeReviewFollowUpRecord | null)?.items ?? []).map((it) => ({
        priorFindingId: it.priorFindingId,
        status: it.status,
      })),
    })),
    resolvedThreads: resolved,
    threadJudgements: threadJudgements ?? own?.threadAssessments ?? null,
  });
  return { ...view, reviewCount };
}
