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
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { aiRunProvider, postedFindingDisplay } from '@pierre-review/shared';
import type {
  AiProviderId,
  ClaudeFindingReminder,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeFollowUpStatus,
  ClaudeReview,
  ClaudeReviewFollowUpRecord,
  ClaudeReviewStanding,
  ClaudeReviewStandingRef,
  ClaudeReviewStandings,
  ClaudeReviewVerdict,
  ClaudeTeamAuthor,
  ClaudeTeamFinding,
  ClaudeTeamPoint,
  ClaudeTeamPointState,
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
    // The reader's latest run that REVIEWED, ms (`TeamLeadOwn.lastReviewedAt`).
    lastReviewedAt?: number | null;
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
  threadJudgements: ReadonlyArray<TeamThreadJudgement> | null;
}

const ms = (iso: string): number => new Date(iso).getTime();

/**
 * One of the reader's thread judgements as the fold reads it. `at` (ms) is when THAT judgement was
 * made (a later Check threads run's, else the review's) and `reviewId` the review it stands on —
 * both absent ⇒ the all-findings fold falls back to `threadJudgedBy`. ⚠ Limn finding threads are
 * INCLUDED: they are hidden from the displayed threads list (thread-judgements.ts
 * `shownThreadAssessments`), and THIS is where their judgement shows — on the finding.
 */
export interface TeamThreadJudgement {
  threadId: number;
  addressed: ClaudeThreadAddressed;
  at?: number;
  reviewId?: number;
}

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

/** The reader's latest full run as the lead rule reads it. */
export interface TeamLeadOwn {
  status: ClaudeReview['status'];
  reviewMode?: ClaudeReview['reviewMode'] | null;
  // When it was done (finished, else created), ms.
  at: number;
  // When the reader's latest run that REVIEWED (succeeded, not a skip) finished, ms — used when this
  // run failed or was a skip, so a failed retry never hands the lead to an OLDER teammate review.
  lastReviewedAt?: number | null;
}

/**
 * THE LEAD RULE (pure), the ONE copy: who heads the PR's review — the AI Review tab
 * (`foldTeamReview`) and the Open PRs column / Pending cards (`getLatestReviewStates`
 * `teammateLead`) both ask it. The NEWEST review leads: a teammate's POSTED review (newest posted at,
 * ms) leads when it is newer than the reader's latest run that SUCCEEDED and was not a skip. A run of
 * the reader's in progress (queued / running) is the newest work and leads; a failed, cancelled or
 * skipped run reviewed nothing, so the reader's latest run that DID review (`lastReviewedAt`) competes
 * instead — none ⇒ the teammate leads. null = nothing on the PR.
 */
export function teamReviewLead(own: TeamLeadOwn | null, newestTeammateAt: number | null): 'own' | 'teammate' | null {
  if (newestTeammateAt == null) return own != null ? 'own' : null;
  if (own == null) return 'teammate';
  if (own.status === 'queued' || own.status === 'running') return 'own';
  const ownReviewed = own.status === 'succeeded' && own.reviewMode !== 'skip';
  const ownAt = ownReviewed ? own.at : (own.lastReviewedAt ?? null);
  return ownAt == null || newestTeammateAt > ownAt ? 'teammate' : 'own';
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

  // The newest review leads (`teamReviewLead`, THE lead rule).
  const newest = byAge[byAge.length - 1] ?? null;
  const lead = teamReviewLead(own, newest != null ? ms(newest.postedAt) : null);

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
  threadJudgements: ReadonlyArray<TeamThreadJudgement> | null,
): Promise<ClaudeTeamReviewView> {
  // The review count: the reader's own succeeded full runs (a skip ran no review), pairs once.
  const ownRuns = await exec
    .select({
      id: cr.id,
      pairId: cr.pairId,
      reviewMode: cr.reviewMode,
      followUp: cr.followUp,
      createdAt: cr.createdAt,
      finishedAt: cr.finishedAt,
      headSha: cr.headSha,
      provider: cr.provider,
      model: cr.model,
      pairConsolidation: cr.pairConsolidation,
      verdict: cr.verdict,
    })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), isNull(cr.kind), eq(cr.status, 'succeeded')))
    .execute();
  const reviewed = ownRuns.filter((r) => r.reviewMode !== 'skip');
  const reviewCount = teamReviewCount(reviewed, teammateReviews);
  const ownReviewed = own != null && own.status === 'succeeded' && own.reviewMode !== 'skip';
  const ownAt = own != null ? ms(own.finishedAt ?? own.createdAt) : 0;

  // The reader's latest run that REVIEWED (the tab's `own` may be a failed or running one): the
  // standings' "you" and the run whose unposted findings still show. A pair is both halves.
  const doneAt = (r: { finishedAt: Date | null; createdAt: Date }): number => (r.finishedAt ?? r.createdAt).getTime();
  const lastRun = [...reviewed].sort((a, b) => doneAt(b) - doneAt(a) || b.id - a.id)[0] ?? null;
  const lastIds = new Set<number>(
    lastRun == null ? [] : lastRun.pairId == null ? [lastRun.id] : reviewed.filter((r) => r.pairId === lastRun.pairId).map((r) => r.id),
  );
  const lastVerdict = (): ClaudeReviewVerdict | null => {
    if (lastRun == null) return null;
    if (own != null && ownReviewed && lastIds.has(own.id)) return own.verdict;
    const pc = reviewed.find((r) => r.id === lastRun.pairId)?.pairConsolidation as { verdict?: ClaudeReviewVerdict | null } | null;
    return pc?.verdict ?? lastRun.verdict ?? null;
  };

  // STANDING VERDICTS (the same fold as the states batch).
  const standings =
    (
      await loadTeamStandingsForPrs(
        exec,
        accountId,
        [prId],
        new Map(
          lastRun != null
            ? [[prId, { reviewId: own != null && lastIds.has(own.id) ? own.id : lastRun.id, verdict: lastVerdict(), at: doneAt(lastRun), headSha: lastRun.headSha }]]
            : [],
        ),
      )
    ).get(prId) ?? undefined;

  // EVERY FINDING: the reader's findings of every reviewing run (merged-away pair duplicates and
  // legacy story findings left out).
  const runOf = new Map(reviewed.map((r) => [r.id, r]));
  const sourceOf = new Map<number, Record<string, string>>();
  for (const r of reviewed) {
    const pc = r.pairConsolidation as { sourceOf?: Record<string, string> } | null;
    if (pc?.sourceOf != null) sourceOf.set(r.id, pc.sourceOf);
  }
  const ownFindingRows =
    reviewed.length === 0
      ? []
      : await exec
          .select({
            id: crf.id,
            reviewId: crf.reviewId,
            path: crf.path,
            line: crf.line,
            severity: crf.severity,
            title: crf.title,
            body: crf.body,
            editedBody: crf.editedBody,
            priorFindingId: crf.priorFindingId,
            postedAt: crf.postedAt,
            included: crf.included,
            githubCommentId: crf.githubCommentId,
            kind: crf.postedCommentKind,
            mergedInto: crf.mergedInto,
            storyIndex: crf.storyIndex,
            side: crf.side,
            suggestion: crf.suggestion,
            postedAuto: crf.postedAuto,
            reminder: crf.reminder,
          })
          .from(crf)
          .where(inArray(crf.reviewId, [...runOf.keys()]))
          .execute();
  const rc = schema.reviewComments;
  const commentIds = ownFindingRows.map((f) => f.githubCommentId).filter((c): c is string => c != null);
  const threadOfComment = new Map<string, number>();
  if (commentIds.length > 0)
    for (const c of await exec
      .select({ databaseId: rc.databaseId, threadId: rc.threadId })
      .from(rc)
      .where(and(eq(rc.prId, prId), inArray(rc.databaseId, commentIds)))
      .execute())
      if (c.databaseId != null) threadOfComment.set(c.databaseId, c.threadId);
  const prUrl = await prUrlOf(exec, accountId, prId);
  const latestOwnIds = lastIds;
  const ownForAll: AllFindingsOwn[] = ownFindingRows
    .filter((f) => f.mergedInto == null && f.storyIndex == null)
    .map((f) => {
      const run = runOf.get(f.reviewId)!;
      const src = sourceOf.get(run.pairId ?? run.id)?.[String(f.id)];
      const providers: AiProviderId[] =
        src === 'both' ? ['claude', 'codex'] : src === 'claude' || src === 'codex' ? [src] : [aiRunProvider(run.provider, run.model)];
      const inline = f.kind !== 'pr_comment';
      return {
        id: f.id,
        reviewId: f.reviewId,
        at: (run.finishedAt ?? run.createdAt).getTime(),
        headSha: run.headSha,
        path: f.path,
        line: f.line ?? null,
        severity: f.severity,
        title: f.title,
        body: f.editedBody ?? f.body,
        priorFindingId: f.priorFindingId ?? null,
        providers,
        posted: f.postedAt != null,
        ignored: !f.included && f.postedAt == null,
        githubCommentId: f.githubCommentId ?? null,
        githubUrl:
          f.githubCommentId == null || prUrl == null
            ? null
            : inline
              ? `${prUrl}#discussion_r${f.githubCommentId}`
              : `${prUrl}#issuecomment-${f.githubCommentId}`,
        threadId: inline && f.githubCommentId != null ? (threadOfComment.get(f.githubCommentId) ?? null) : null,
        side: f.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        suggestion: f.suggestion ?? null,
        postedAt: f.postedAt != null ? f.postedAt.getTime() : null,
        postedCommentKind: f.kind ?? null,
        postedAuto: f.postedAuto === true,
        reminder: f.reminder ?? null,
      };
    });

  const judgements = reviewed
    .filter((r) => r.followUp != null)
    .map((r) => ({
      reviewId: r.id,
      at: (r.finishedAt ?? r.createdAt).getTime(),
      items: ((r.followUp as ClaudeReviewFollowUpRecord | null)?.items ?? []).map((it) => ({
        priorFindingId: it.priorFindingId,
        status: it.status,
      })),
    }));
  const threadIds = [
    ...new Set(
      [...teammateReviews.flatMap((r) => r.findings.map((f) => f.threadId)), ...ownForAll.map((f) => f.threadId)].filter(
        (t): t is number => t != null,
      ),
    ),
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
  const currentThreadJudgements = threadJudgements ?? own?.threadAssessments ?? null;
  const allFindings = foldAllTeamFindings({
    own: ownForAll,
    latestOwnReviewIds: latestOwnIds,
    teammateReviews,
    judgements,
    resolvedThreads: resolved,
    threadJudgements: currentThreadJudgements,
    threadJudgedBy: own != null && ownReviewed ? { reviewId: own.id, at: ownAt } : null,
  });
  const extra = { reviewCount, allFindings, ...(standings != null ? { standings } : {}) };

  if (teammateReviews.length === 0)
    return { lead: own != null ? 'own' : null, teammateReviewId: null, findings: [], alsoRaisedBy: [], ...extra };
  const chainRows = await exec
    .select({ id: crf.id, priorFindingId: crf.priorFindingId, path: crf.path, line: crf.line, title: crf.title })
    .from(crf)
    .innerJoin(cr, eq(cr.id, crf.reviewId))
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), ownRunsOnly(cr.kind)))
    .execute();
  const view = foldTeamReview({
    teammateReviews,
    own:
      own == null
        ? null
        : {
            status: own.status,
            reviewMode: own.reviewMode,
            headSha: own.headSha,
            at: ownAt,
            lastReviewedAt: reviewed.length > 0 ? Math.max(...reviewed.map((r) => (r.finishedAt ?? r.createdAt).getTime())) : null,
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
    judgements,
    resolvedThreads: resolved,
    threadJudgements: currentThreadJudgements,
  });
  return { ...view, ...extra };
}

/** The PR's github.com URL (account-scoped), or null. */
async function prUrlOf(exec: Executor, accountId: number, prId: number): Promise<string | null> {
  const { pullRequests, repos } = schema;
  const row = (
    await exec
      .select({ owner: repos.owner, name: repos.name, number: pullRequests.number })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.id, prId), eq(repos.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  return row ? `https://github.com/${row.owner}/${row.name}/pull/${row.number}` : null;
}

// ── STANDING VERDICTS (docs/CLAUDE-REVIEW.md § Teammates' reviews → Standing verdicts) ───────────────
//
// GitHub's own rule, per Limn reviewer: their latest DECISIVE review (changes requested / approved)
// stands until it is DISMISSED or the same person's later decisive review replaces it; a COMMENTED or
// PENDING review never does. The reviewer's verdict "in force" is that review when it is a Limn review
// (it carries the summary marker); a later decisive review of theirs that is NOT Limn's replaced it.
// The surface shows the STRICTEST in force (a Request changes still standing) and names who reviewed
// last. ⚠ THE ONE FOLD (`teamStandings`, pure): the states batch (Open PRs, Pending) and the AI Review
// tab both read it. Own-only readers (caps, posting, auto holds) never do.

/** One synced GitHub review of a Limn reviewer (`reviews` row). */
export interface StandingGithubReview {
  authorId: number;
  nodeId: string;
  databaseId: string | null;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  submittedAt: number; // ms
  // Its body carries Limn's summary marker.
  limn: boolean;
}

export interface StandingsInput {
  // The reader's GitHub user id(s); empty = unknown (then no GitHub standing of the reader's is read).
  readerUserIds: ReadonlySet<number>;
  // The reader's latest run that REVIEWED (succeeded, not a skip), or null.
  ownLatest: { reviewId: number; verdict: ClaudeReviewVerdict | null; at: number; headSha: string } | null;
  // The reader's runs posted to GitHub: GitHub review databaseId → the run.
  ownPosted: ReadonlyArray<{ githubReviewId: string; reviewId: number; verdict: ClaudeReviewVerdict | null; headSha: string }>;
  // Every teammate review imported on the PR.
  teammates: ReadonlyArray<{
    reviewId: number;
    poster: ClaudeTeammatePoster;
    verdict: ClaudeReviewVerdict | null;
    at: number;
    headSha: string;
    nodeId: string | null;
  }>;
  // Every synced review by the reader and by those teammates (any order).
  github: readonly StandingGithubReview[];
}

const isoOf = (msv: number): string => new Date(msv).toISOString();

/** A reviewer's standing review on GitHub (pure): the newest decisive one, null when dismissed / none. */
export function githubStandingReview(reviews: readonly StandingGithubReview[]): StandingGithubReview | null {
  const sorted = [...reviews].sort((a, b) => b.submittedAt - a.submittedAt || b.nodeId.localeCompare(a.nodeId));
  for (const r of sorted) {
    if (r.state === 'commented' || r.state === 'pending') continue;
    return r.state === 'dismissed' ? null : r;
  }
  return null;
}

/** THE STANDINGS FOLD (pure). */
export function teamStandings(input: StandingsInput): ClaudeReviewStandings {
  const reviewers: ClaudeReviewStanding[] = [];
  const decisive = (r: StandingGithubReview): 'REQUEST_CHANGES' | 'APPROVE' =>
    r.state === 'changes_requested' ? 'REQUEST_CHANGES' : 'APPROVE';
  const newestLimn = (list: readonly StandingGithubReview[]): StandingGithubReview | null =>
    [...list].filter((r) => r.limn).sort((a, b) => b.submittedAt - a.submittedAt)[0] ?? null;

  // The reader.
  const mine = input.github.filter((r) => input.readerUserIds.has(r.authorId));
  const ownStand = githubStandingReview(mine);
  const ownRun = ownStand?.databaseId != null ? input.ownPosted.find((p) => p.githubReviewId === ownStand.databaseId) : undefined;
  const ownInForce: ClaudeReviewStanding['inForce'] =
    ownStand != null && (ownStand.limn || ownRun != null)
      ? {
          you: true,
          poster: null,
          reviewId: ownRun?.reviewId ?? null,
          verdict: decisive(ownStand),
          at: isoOf(ownStand.submittedAt),
          headSha: ownRun?.headSha ?? null,
        }
      : null;
  if (input.ownLatest != null || ownInForce != null) {
    reviewers.push({
      you: true,
      poster: null,
      latest:
        input.ownLatest != null
          ? {
              you: true,
              poster: null,
              reviewId: input.ownLatest.reviewId,
              verdict: input.ownLatest.verdict,
              at: isoOf(input.ownLatest.at),
              headSha: input.ownLatest.headSha,
            }
          : null,
      inForce: ownInForce,
      dismissed: newestLimn(mine)?.state === 'dismissed',
    });
  }

  // Each teammate, newest review first.
  const byPoster = new Map<number, Array<StandingsInput['teammates'][number]>>();
  for (const t of input.teammates) {
    const list = byPoster.get(t.poster.userId) ?? [];
    list.push(t);
    byPoster.set(t.poster.userId, list);
  }
  const mates: ClaudeReviewStanding[] = [];
  for (const [userId, list] of byPoster) {
    const newest = [...list].sort((a, b) => b.at - a.at || b.reviewId - a.reviewId)[0]!;
    const theirs = input.github.filter((r) => r.authorId === userId);
    const stand = githubStandingReview(theirs);
    const row = stand != null ? list.find((t) => t.nodeId != null && t.nodeId === stand.nodeId) : undefined;
    mates.push({
      you: false,
      poster: newest.poster,
      latest: { you: false, poster: newest.poster, reviewId: newest.reviewId, verdict: newest.verdict, at: isoOf(newest.at), headSha: newest.headSha },
      inForce:
        stand != null && (stand.limn || row != null)
          ? {
              you: false,
              poster: newest.poster,
              reviewId: row?.reviewId ?? null,
              verdict: decisive(stand),
              at: isoOf(stand.submittedAt),
              headSha: row?.headSha ?? null,
            }
          : null,
      dismissed: newestLimn(theirs)?.state === 'dismissed',
    });
  }
  mates.sort((a, b) => ms(b.latest!.at) - ms(a.latest!.at));
  reviewers.push(...mates);

  const blocking =
    reviewers
      .map((r) => r.inForce)
      .filter((f): f is NonNullable<typeof f> => f != null && f.verdict === 'REQUEST_CHANGES')
      .sort((a, b) => ms(b.at) - ms(a.at))[0] ?? null;
  const latest =
    reviewers
      .map((r) => r.latest)
      .filter((l): l is ClaudeReviewStandingRef => l != null)
      .sort((a, b) => ms(b.at) - ms(a.at) || (a.you === b.you ? 0 : a.you ? 1 : -1))[0] ?? null;
  return { reviewers, blocking, latest };
}

/** The reader's latest reviewing run per PR, as the standings loader takes it. */
export interface StandingsOwnLatest {
  reviewId: number;
  verdict: ClaudeReviewVerdict | null;
  at: number;
  headSha: string;
}

/**
 * THE STANDINGS OF A BATCH OF PRs (DB only, account-scoped, a fixed number of queries for the whole
 * batch — never one per PR). `ownLatest`: the reader's latest reviewing run per PR (the caller has
 * it). A PR with neither a teammate review nor a posted Limn review of the reader's is absent.
 */
export async function loadTeamStandingsForPrs(
  exec: Executor,
  accountId: number,
  prIds: readonly number[],
  ownLatest: ReadonlyMap<number, StandingsOwnLatest>,
): Promise<Map<number, ClaudeReviewStandings>> {
  const out = new Map<number, ClaudeReviewStandings>();
  if (prIds.length === 0) return out;
  const { users, reviews, accounts, pullRequests, repos } = schema;
  const ids = [...prIds];
  const [mateRows, ownRows] = await Promise.all([
    exec
      .select({
        id: cr.id,
        prId: cr.prId,
        verdict: cr.verdict,
        headSha: cr.headSha,
        postedAt: cr.postedAt,
        createdAt: cr.createdAt,
        nodeId: cr.sourceReviewNodeId,
        userId: users.id,
        login: users.githubLogin,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(cr)
      .innerJoin(pullRequests, eq(pullRequests.id, cr.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .innerJoin(users, eq(users.id, cr.sourceUserId))
      .where(and(inArray(cr.prId, ids), eq(cr.accountId, accountId), eq(repos.accountId, accountId), eq(cr.kind, 'teammate')))
      .execute(),
    exec
      .select({
        id: cr.id,
        prId: cr.prId,
        verdict: cr.verdict,
        userVerdict: cr.userVerdict,
        headSha: cr.headSha,
        postedReviewId: cr.postedReviewId,
        autoPost: cr.autoPost,
      })
      .from(cr)
      .where(and(inArray(cr.prId, ids), eq(cr.accountId, accountId), ownRunsOnly(cr.kind)))
      .execute(),
  ]);
  const ownPosted = new Map<number, Array<StandingsInput['ownPosted'][number]>>();
  for (const r of ownRows) {
    const ap = r.autoPost as { githubReviewId?: string | null; verdict?: { submitted?: ClaudeReviewVerdict } | null } | null;
    const gh = [
      ...(r.postedReviewId != null ? [{ id: r.postedReviewId, verdict: r.userVerdict ?? r.verdict }] : []),
      ...(ap?.githubReviewId != null ? [{ id: String(ap.githubReviewId), verdict: ap.verdict?.submitted ?? 'COMMENT' }] : []),
    ];
    if (gh.length === 0) continue;
    const list = ownPosted.get(r.prId) ?? [];
    for (const g of gh) list.push({ githubReviewId: g.id, reviewId: r.id, verdict: (g.verdict ?? null) as ClaudeReviewVerdict | null, headSha: r.headSha });
    ownPosted.set(r.prId, list);
  }
  const prsWith = new Set<number>([...mateRows.map((r) => r.prId), ...ownPosted.keys()]);
  if (prsWith.size === 0) return out;

  // The reader's GitHub user id(s): the account's login.
  const login = (
    await exec.select({ login: accounts.githubLogin }).from(accounts).where(eq(accounts.id, accountId)).limit(1).execute()
  )[0]?.login;
  const readerUserIds = new Set<number>(
    login
      ? (
          await exec
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.githubLogin}) = ${login.toLowerCase()}`)
            .execute()
        ).map((u) => u.id)
      : [],
  );
  const authorIds = [...new Set([...readerUserIds, ...mateRows.map((r) => r.userId)])];
  const ghRows =
    authorIds.length === 0
      ? []
      : await exec
          .select({
            prId: reviews.prId,
            authorId: reviews.authorId,
            nodeId: reviews.githubNodeId,
            databaseId: reviews.databaseId,
            state: reviews.state,
            submittedAt: reviews.submittedAt,
            limn: sql<number>`coalesce(${reviews.body}, '') like '%pierre:claude-review%'`,
          })
          .from(reviews)
          .where(and(inArray(reviews.prId, [...prsWith]), inArray(reviews.authorId, authorIds)))
          .execute();
  for (const prId of prsWith) {
    const mates = mateRows.filter((r) => r.prId === prId);
    const own = ownLatest.get(prId) ?? null;
    out.set(
      prId,
      teamStandings({
        readerUserIds,
        ownLatest: own,
        ownPosted: ownPosted.get(prId) ?? [],
        teammates: mates.map((r) => ({
          reviewId: r.id,
          poster: { userId: r.userId, login: r.login, displayName: r.displayName, avatarUrl: r.avatarUrl },
          verdict: r.verdict,
          at: (r.postedAt ?? r.createdAt).getTime(),
          headSha: r.headSha,
          nodeId: r.nodeId ?? null,
        })),
        github: ghRows
          .filter((g) => g.prId === prId && g.authorId != null)
          .map((g) => ({
            authorId: g.authorId as number,
            nodeId: g.nodeId,
            databaseId: g.databaseId ?? null,
            state: g.state,
            submittedAt: g.submittedAt.getTime(),
            limn: !!g.limn,
          })),
      }),
    );
  }
  return out;
}

// ── EVERY FINDING ON THE PR (docs/CLAUDE-REVIEW.md § Teammates' reviews → Every finding) ─────────────
//
// One entry per POINT across every review: the reader's runs (a re-raise in the follow-up chain is the
// same point; a pair's halves are named by provider) and every teammate's posted review. Each point's
// state NOW: resolved on GitHub (the thread of its NEWEST raise — a later re-raise reopens it), else the NEWEST judgement of it — the reader's follow-up
// or thread judgement, or a teammate's posted review (`TeammateReviewRecord.judged`, matched by the
// finding comment's databaseId) — else open. A re-raise newer than a judgement keeps it open. The same
// point raised by several reviewers shows ONCE (the reader's entry first), the rest in `alsoRaisedBy`.
// ⚠ Pure (`foldAllTeamFindings`); the loader is `loadTeamReviewView`.

/** One of the reader's own findings, as the all-findings fold reads it. */
export interface AllFindingsOwn {
  id: number;
  reviewId: number;
  // When its review was done (ms) and at which head.
  at: number;
  headSha: string;
  path: string;
  line: number | null;
  severity: ClaudeFindingSeverity;
  title: string;
  body: string;
  priorFindingId: number | null;
  providers: AiProviderId[];
  posted: boolean;
  ignored: boolean;
  githubCommentId: string | null;
  githubUrl: string | null;
  threadId: number | null;
  // For the shared finding card (all optional: a test may leave them out).
  side?: ClaudeFindingSide;
  suggestion?: string | null;
  postedAt?: number | null; // ms
  postedCommentKind?: 'inline' | 'pr_comment' | null;
  postedAuto?: boolean;
  reminder?: ClaudeFindingReminder | null;
}

export interface AllFindingsInput {
  own: readonly AllFindingsOwn[];
  // The reader's latest review's id(s) (both halves of a pair): its unposted findings are shown; an
  // older review's unposted ones were never said and are superseded.
  latestOwnReviewIds: ReadonlySet<number>;
  teammateReviews: readonly ClaudeTeammateReview[];
  // The reader's follow-up judgements, by review (see `TeamFoldInput.judgements`), with `at`.
  judgements: ReadonlyArray<{ reviewId: number; at: number; items: ReadonlyArray<{ priorFindingId: number; status: ClaudeFollowUpStatus }> }>;
  resolvedThreads: ReadonlySet<number>;
  // The reader's current thread judgements, and the review they stand on (for `by`/`at`).
  threadJudgements: ReadonlyArray<TeamThreadJudgement> | null;
  threadJudgedBy: { reviewId: number; at: number } | null;
}

type Judgement = { status: 'addressed' | 'no_longer_applies' | 'open'; by: ClaudeTeamAuthor; at: number; reviewId: number };

const YOU: ClaudeTeamAuthor = { you: true, poster: null };

function judgementOfFollowUp(s: ClaudeFollowUpStatus): Judgement['status'] | null {
  if (s === 'addressed' || s === 'reply_accepted') return 'addressed';
  if (s === 'no_longer_applies') return 'no_longer_applies';
  if (s === 'not_checked') return null;
  return 'open';
}

/** THE ALL-FINDINGS FOLD (pure). */
export function foldAllTeamFindings(input: AllFindingsInput): ClaudeTeamPoint[] {
  const ownById = new Map(input.own.map((f) => [f.id, f]));
  const mates = [...input.teammateReviews].sort((a, b) => ms(a.postedAt) - ms(b.postedAt) || a.reviewId - b.reviewId);
  const mateFinding = new Map<number, { r: ClaudeTeammateReview; f: ClaudeTeammateReview['findings'][number] }>();
  for (const r of mates) for (const f of r.findings) mateFinding.set(f.id, { r, f });

  // The reader's chains: each own finding → the first own finding of its chain.
  const ownRoot = (id: number): number => {
    let cur = id;
    for (let hops = 0; hops < 100; hops += 1) {
      const p = ownById.get(cur)?.priorFindingId;
      if (p == null || !ownById.has(p)) return cur;
      cur = p;
    }
    return cur;
  };
  // The teammate finding a chain leads back to, if any.
  const mateRootOf = (id: number): number | null => {
    const root = ownById.get(ownRoot(id));
    const p = root?.priorFindingId;
    return p != null && mateFinding.has(p) ? p : null;
  };

  // Judgements by GitHub comment id, from every teammate review (newest last).
  const byComment = new Map<string, Judgement[]>();
  for (const r of mates)
    for (const j of r.judged ?? []) {
      const list = byComment.get(j.commentId) ?? [];
      list.push({
        status: j.outcome === 'not_addressed' || j.outcome === 'still_open' ? 'open' : j.outcome,
        by: { you: false, poster: r.poster },
        at: ms(r.postedAt),
        reviewId: r.reviewId,
      });
      byComment.set(j.commentId, list);
    }
  // The reader's follow-up judgements, by the judged finding id.
  const byFinding = new Map<number, Judgement[]>();
  for (const j of input.judgements)
    for (const it of j.items) {
      const st = judgementOfFollowUp(it.status);
      if (st == null) continue;
      const list = byFinding.get(it.priorFindingId) ?? [];
      list.push({ status: st, by: YOU, at: j.at, reviewId: j.reviewId });
      byFinding.set(it.priorFindingId, list);
    }
  const threadJudged = new Map((input.threadJudgements ?? []).map((t) => [t.threadId, t]));

  const stateOf = (
    members: ReadonlyArray<{ id: number; commentId: string | null; threadId: number | null; at: number }>,
    since: number,
  ): ClaudeTeamPointState => {
    // Resolved on GitHub only when the resolved raise is the NEWEST: a later re-raise (`since` is the
    // newest raise) says the point is back, and is judged below like any other.
    if (members.some((m) => m.threadId != null && input.resolvedThreads.has(m.threadId) && m.at >= since)) {
      return { kind: 'resolved_on_github' };
    }
    const events: Judgement[] = [];
    for (const m of members) {
      events.push(...(byFinding.get(m.id) ?? []));
      if (m.commentId != null) events.push(...(byComment.get(m.commentId) ?? []));
      const t = m.threadId != null ? threadJudged.get(m.threadId) : undefined;
      // Dated by the run that made it (a Check threads run newer than the review settles a teammate
      // finding posted after that review), else by the review it stands on.
      const at = t?.at ?? input.threadJudgedBy?.at;
      const reviewId = t?.reviewId ?? input.threadJudgedBy?.reviewId;
      if (t != null && at != null && reviewId != null) {
        const a = t.addressed;
        const st = a === 'addressed' ? 'addressed' : a === 'not_addressed' || a === 'partly_addressed' ? 'open' : null;
        if (st != null) events.push({ status: st, by: YOU, at, reviewId });
      }
    }
    // A re-raise newer than a judgement keeps the point open.
    const last = events.filter((e) => e.at >= since).sort((a, b) => a.at - b.at || a.reviewId - b.reviewId).pop();
    if (last == null || last.status === 'open') return { kind: 'open' };
    return { kind: last.status, by: last.by, at: new Date(last.at).toISOString(), reviewId: last.reviewId };
  };

  // 1. The reader's points: one per chain, shown from its newest raise.
  const chains = new Map<number, AllFindingsOwn[]>();
  for (const f of input.own) {
    if (f.severity === 'praise') continue;
    if (!f.posted && !input.latestOwnReviewIds.has(f.reviewId)) continue;
    const root = ownRoot(f.id);
    const list = chains.get(root) ?? [];
    list.push(f);
    chains.set(root, list);
  }
  type Entry = { point: ClaudeTeamPoint; spot: { path: string; line: number | null; title: string }; mateRoot: number | null; first: number };
  const entries: Entry[] = [];
  for (const list of chains.values()) {
    list.sort((a, b) => a.at - b.at || a.id - b.id);
    const shown = list[list.length - 1]!;
    const postedOne = [...list].reverse().find((m) => m.posted) ?? null;
    const members = list.map((m) => ({ id: m.id, commentId: m.githubCommentId, threadId: m.threadId, at: m.at }));
    entries.push({
      point: {
        findingId: shown.id,
        reviewId: shown.reviewId,
        origin: 'own',
        author: YOU,
        providers: shown.providers,
        path: shown.path,
        line: shown.line,
        severity: shown.severity === 'praise' ? null : shown.severity,
        title: shown.title,
        body: shown.body,
        raisedAt: new Date(list[0]!.at).toISOString(),
        headSha: shown.headSha,
        githubUrl: postedOne?.githubUrl ?? null,
        threadId: postedOne?.threadId ?? null,
        posted: postedOne != null,
        ignored: postedOne == null && list.every((m) => m.ignored),
        state: stateOf(members, shown.at),
        alsoRaisedBy: [],
        side: shown.side ?? 'RIGHT',
        diffAnchorId: diffAnchorIdOf(shown.path),
        suggestion: shown.suggestion ?? null,
        postedAt: postedOne?.postedAt != null ? new Date(postedOne.postedAt).toISOString() : null,
        githubCommentId: postedOne?.githubCommentId ?? null,
        postedCommentKind: postedOne?.postedCommentKind ?? null,
        postedAuto: postedOne?.postedAuto === true,
        reminder: wireReminder(shown.reminder ?? postedOne?.reminder ?? null),
      },
      spot: shown,
      mateRoot: mateRootOf(shown.id),
      first: list[0]!.at,
    });
  }

  // 2. Teammates' findings: folded into a point already listed (the chain leads to it, same thread,
  //    or same spot), else a point of their own.
  for (const r of mates) {
    for (const f of r.findings) {
      const author: ClaudeTeamAuthor = { you: false, poster: r.poster };
      const providers = f.providers ?? [];
      const twin = entries.find(
        (e) =>
          e.mateRoot === f.id ||
          (f.threadId != null && e.point.threadId === f.threadId) ||
          sameSpot(e.spot, f),
      );
      if (twin != null) {
        // A teammate re-raising their own point is not a second voice.
        const named =
          twin.point.author.poster?.userId === r.poster.userId ||
          twin.point.alsoRaisedBy.some((a) => a.poster?.userId === r.poster.userId);
        if (!named) twin.point.alsoRaisedBy.push({ ...author, findingId: f.id, reviewId: r.reviewId, providers });
        continue;
      }
      // Limn posts a finding's text, never its title: split it the way the reader's own card shows one.
      const shown = postedFindingDisplay(f.body, f.title);
      entries.push({
        point: {
          findingId: f.id,
          reviewId: r.reviewId,
          origin: 'teammate',
          author,
          providers,
          path: f.path,
          line: f.line,
          severity: f.severity,
          title: shown.title,
          body: shown.body,
          raisedAt: r.postedAt,
          headSha: r.headSha,
          githubUrl: f.githubUrl,
          threadId: f.threadId,
          posted: true,
          ignored: false,
          state: stateOf(
            [
              { id: f.id, commentId: f.githubCommentId ?? null, threadId: f.threadId, at: ms(r.postedAt) },
              // The reader's chain that follows this finding up judges it too.
              ...input.own.filter((o) => mateRootOf(o.id) === f.id).map((o) => ({ id: o.id, commentId: null, threadId: null, at: o.at })),
            ],
            ms(r.postedAt),
          ),
          alsoRaisedBy: [],
          side: f.side ?? 'RIGHT',
          diffAnchorId: f.diffAnchorId ?? diffAnchorIdOf(f.path),
          suggestion: shown.suggestion,
          postedAt: f.postedAt ?? r.postedAt,
          githubCommentId: f.githubCommentId ?? null,
          postedCommentKind: f.kind,
          postedAuto: false,
          reminder: wireReminder(f.reminder ?? null),
        },
        spot: f,
        mateRoot: f.id,
        first: ms(r.postedAt),
      });
    }
  }
  // Open first; then the newest point first.
  const rank = (p: ClaudeTeamPoint): number => (p.state.kind === 'open' ? 0 : 1);
  return entries
    .sort((a, b) => rank(a.point) - rank(b.point) || b.first - a.first || a.point.findingId - b.point.findingId)
    .map((e) => ({ ...e.point, remindable: teammatePointRemindable(e.point) }));
}

/**
 * A TEAMMATE'S POINT THE READER MAY REMIND (docs/CLAUDE-REVIEW.md § Teammates' reviews → A reminder of a
 * teammate's finding): the teammate raised it (the point is theirs, not folded under the reader's own
 * card), it is still OPEN, and its comment is on GitHub (an id to link). The SPA's button and the
 * route's check read this ONE rule.
 */
export function teammatePointRemindable(
  p: Pick<ClaudeTeamPoint, 'origin' | 'state' | 'githubCommentId'>,
): boolean {
  return p.origin === 'teammate' && p.state.kind === 'open' && p.githubCommentId != null;
}

/** GitHub's "Files changed" anchor of a path (SHA-256, hex) — the reader's own findings use the same. */
function diffAnchorIdOf(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

/** A stored reminder on the wire (its earlier comment ids stay server-side). */
function wireReminder(r: ClaudeFindingReminder | null): ClaudeFindingReminder | null {
  return r == null ? null : { githubCommentId: r.githubCommentId, postedCommentKind: r.postedCommentKind, postedAt: r.postedAt };
}
